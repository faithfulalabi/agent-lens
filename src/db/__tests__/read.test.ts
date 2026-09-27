// Task 4.2 shape, correctness and pagination for `db/read.ts`. The
// `EXPLAIN QUERY PLAN` half lives in `read-plan.test.ts`, split out because it
// is the acceptance criterion people will want to read on its own.
//
// Every shape assertion is SET EQUALITY on the key set, never containment:
// `schema.test.ts:5-11` records that containment is provably blind to a dropped
// field, which is the exact failure this schema has already had once.

import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countUnprojected,
  readDriftRows,
  readEventArchivePath,
  readEventContentRow,
  readEventPage,
  readEventsByIds,
  readRunningEventIds,
  readProjects,
  readSessionHeader,
  readSessionList,
  readTurns,
  readWarmableIds,
  searchEvents,
  type SessionRow,
} from '../read.js';
import { PROJECTOR_VERSION } from '../../transcript/version.js';
import type { Page } from '../../shared/api.js';
import { openCache, seedProjection, seedSessionRow, seedSidecarRow } from './fixtures/index.js';
import {
  EVENT_ROW_KEYS,
  SEARCH_HIT_KEYS,
  SESSION_ROW_KEYS,
  TURN_ROW_KEYS,
} from './fixtures/shapes.js';

const READ_TS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'read.ts');
const SOURCE = readFileSync(READ_TS, 'utf8');

let db: DatabaseSync;

beforeEach(() => {
  db = openCache();
});

// The spec's field lists, transcribed. A key added to `read.ts` and not to the
// spec — or the reverse — reds here rather than reaching the UI.

/** The coordinates `GET /api/events/:id/content` dispatches on (`:334-345`). */
const EVENT_CONTENT_KEYS = [
  'id',
  'session_id',
  'block_index',
  'input',
  'input_bytes',
  'input_storage',
  'text',
  'text_bytes',
  'output_storage',
  'spill_path',
  'spill_bytes',
  'src_offset',
  'src_len',
  'result_offset',
  'result_len',
  'result_block',
].sort();

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

const PAGE = { limit: 50, offset: 0 };

/** One session with a projection: two turns, three events, FTS populated. */
function seedFull(id = 'sess-full'): string {
  seedSessionRow(db, { id });
  seedProjection(db, id, {
    turns: [
      { seq: 1, first_seq: 1, last_seq: 2 },
      { seq: 2, kind: 'slash_command', first_seq: 3, last_seq: 3 },
    ],
    events: [
      { id: 'e1', seq: 1, turn_seq: 1, text: 'the quick brown fox' },
      {
        id: 'e2',
        seq: 2,
        turn_seq: 1,
        kind: 'tool_call',
        name: 'Grep',
        input: '{"pattern":"quick"}',
      },
      { id: 'e3', seq: 3, turn_seq: 2, text: 'a second turn' },
    ],
  });
  return id;
}

describe('AC1 — the eight query families return the spec shapes', () => {
  it('1. readSessionList rows carry exactly SessionRow, minus the server-stamped `live`', () => {
    seedSessionRow(db, { id: 's1' });
    const page = readSessionList(db, PAGE);
    expect(page.items).toHaveLength(1);
    expect(keysOf(page.items[0]!)).toEqual(SESSION_ROW_KEYS);
  });

  it('1b. models and sub_models reach the wire as id arrays, never [id, calls] pairs (Task 0.17)', () => {
    const parent = seedSessionRow(db, { id: 's1' });
    db.prepare('UPDATE sessions SET models = ?, sub_models = ? WHERE id = ?').run(
      '[["claude-opus-5-5",160],["claude-fable-5-1",67]]',
      '[["claude-haiku-4-5",9]]',
      parent,
    );
    seedSessionRow(db, { id: 's2' });

    const byId = new Map(readSessionList(db, PAGE).items.map((row) => [row.id, row]));
    expect(byId.get('s1')!.models).toEqual(['claude-opus-5-5', 'claude-fable-5-1']);
    expect(byId.get('s1')!.sub_models).toEqual(['claude-haiku-4-5']);
    // The DDL default, not a missing key: an unrolled session is an empty list.
    expect(byId.get('s2')!.models).toEqual([]);
    expect(byId.get('s2')!.sub_models).toEqual([]);
    // The detail header shares the list's columns and its parser.
    expect(readSessionHeader(db, parent)!.models).toEqual(['claude-opus-5-5', 'claude-fable-5-1']);
  });

  it('2. readProjects returns { path, session_count, last_activity_at } (:288-290)', () => {
    seedSessionRow(db, { id: 's1', project_path: '/a' });
    seedSessionRow(db, { id: 's2', project_path: '/a' });
    seedSessionRow(db, { id: 's3', project_path: '/b' });

    const { items } = readProjects(db);
    expect(items.map((p) => p.path).sort()).toEqual(['/a', '/b']);
    expect(keysOf(items[0]!)).toEqual(['last_activity_at', 'path', 'session_count']);
    expect(items.find((p) => p.path === '/a')?.session_count).toBe(2);
  });

  it('2b. projects order by the GROUP max, not by any one row’s last_activity_at', () => {
    // `ORDER BY last_activity_at` is ambiguous to read: the name is both a
    // column and the alias of `max(last_activity_at)`. SQLite resolves it to the
    // ALIAS, so `/new` wins on its newest row rather than on its oldest one.
    seedSessionRow(db, {
      id: 'a',
      project_path: '/old',
      last_activity_at: '2026-01-02T00:00:00.000Z',
    });
    seedSessionRow(db, {
      id: 'b',
      project_path: '/new',
      last_activity_at: '2026-01-01T00:00:00.000Z',
    });
    seedSessionRow(db, {
      id: 'c',
      project_path: '/new',
      last_activity_at: '2026-12-31T00:00:00.000Z',
    });

    const { items } = readProjects(db);
    expect(items.map((p) => p.path)).toEqual(['/new', '/old']);
    expect(items[0]!.last_activity_at).toBe('2026-12-31T00:00:00.000Z');
  });

  it('3. readSessionHeader is SessionRow + cwd + projection, and omits the sidecar keys', () => {
    const id = seedFull();
    const header = readSessionHeader(db, id)!;

    expect(keysOf(header)).toEqual([...SESSION_ROW_KEYS, 'cwd', 'projection'].sort());
    expect(header.cwd).toBe(header.project_path);
    expect(header.projection).toEqual({
      state: 'ready',
      projector_version: 1,
      projected_at: '2026-08-14T09:05:00.000Z',
      drift: {
        unknown_line_types: {},
        unknown_block_types: {},
        unjoined_tool_uses: 0,
        unresolved_spills: 0,
      },
    });
    expect(readSessionHeader(db, 'no-such-session')).toBeUndefined();
  });

  it('3b. a sidecar header carries the four optional keys, a parent carries none', () => {
    const parent = seedSessionRow(db, { id: 'parent' });
    const child = seedSidecarRow(db, parent, { id: 'child' });

    const sidecar = readSessionHeader(db, child)!;
    expect(keysOf(sidecar)).toEqual(
      [
        ...SESSION_ROW_KEYS,
        'cwd',
        'projection',
        'agent_type',
        'agent_description',
        'spawn_depth',
        'parent_session_id',
      ].sort(),
    );
    expect(sidecar.parent_session_id).toBe(parent);
    expect(sidecar.spawn_depth).toBe(1);
  });

  it('3c. a failed projection publishes `error`; a clean one omits the key entirely', () => {
    seedSessionRow(db, { id: 'bad', projection_state: 'failed', projection_error: 'boom' });
    expect(readSessionHeader(db, 'bad')!.projection.error).toBe('boom');
    expect('error' in readSessionHeader(db, seedFull())!.projection).toBe(false);
  });

  it('4. readTurns returns every turn in seq order with exactly TurnRow (:314-317)', () => {
    const id = seedFull();
    const turns = readTurns(db, id);
    expect(turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(keysOf(turns[0]!)).toEqual(TURN_ROW_KEYS);
  });

  it('5. readEventPage returns EventRow items plus the live-tail cursor (:318-328)', () => {
    const id = seedFull();
    const page = readEventPage(db, id, { from_seq: 0, limit: 50 });
    expect(page.items.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(keysOf(page.items[0]!)).toEqual(EVENT_ROW_KEYS);
    expect(page).toMatchObject({ next_seq: 4, has_more: false });
  });

  it('6. readEventContentRow returns the resolver coordinates (:334-345)', () => {
    seedFull();
    const row = readEventContentRow(db, 'e2')!;
    expect(keysOf(row)).toEqual(EVENT_CONTENT_KEYS);
    expect(row.input_storage).toBe('inline');
    expect(readEventContentRow(db, 'no-such-event')).toBeUndefined();
  });

  it('6b. readEventArchivePath answers for a session, a sidecar, and nothing else', () => {
    const id = seedFull();
    const parent = readEventArchivePath(db, id)!;
    expect(keysOf(parent)).toEqual(['archive_path', 'parent_session_id']);
    expect(parent.archive_path).toBe(join('/Users/dev/.agent-lens/archive', `${id}.jsonl`));
    // A top-level session is the row with no parent — the `idx_sessions_recent`
    // predicate the list depends on.
    expect(parent.parent_session_id).toBeNull();

    // A sidecar IS a `sessions` row, so one lookup answers for both.
    const kid = seedSidecarRow(db, id, { id: 'kid-session' });
    expect(readEventArchivePath(db, kid)).toEqual({
      archive_path: join('/Users/dev/.agent-lens/archive', `${kid}.jsonl`),
      parent_session_id: id,
    });

    expect(readEventArchivePath(db, 'no-such-session')).toBeUndefined();
  });

  it('7. searchEvents returns SearchHit rows joined to their session (:349-354)', () => {
    const id = seedFull();
    const hits = searchEvents(db, { q: 'quick', limit: 50 });
    expect(hits.map((h) => h.event_id).sort()).toEqual(['e1', 'e2']);
    expect(keysOf(hits[0]!)).toEqual(SEARCH_HIT_KEYS);
    expect(hits[0]!.session_id).toBe(id);
    expect(hits[0]!.session_title).toBe(`title of ${id}`);

    // `session=` scopes to one session — the in-session search, day one.
    const other = seedSessionRow(db, { id: 'other' });
    seedProjection(db, other, {
      turns: [{ seq: 1 }],
      events: [{ id: 'x1', seq: 1, text: 'quick elsewhere' }],
    });
    expect(searchEvents(db, { q: 'quick', limit: 50 })).toHaveLength(3);
    expect(
      searchEvents(db, { q: 'quick', session: other, limit: 50 }).map((h) => h.event_id),
    ).toEqual(['x1']);
  });

  it('7b. countUnprojected counts pending sessions only — `empty` is a tombstone', () => {
    seedSessionRow(db, { id: 'ready-1', projection_state: 'ready' });
    seedSessionRow(db, { id: 'empty-1', projection_state: 'empty' });
    seedSessionRow(db, { id: 'none-1', projection_state: 'none' });
    seedSessionRow(db, { id: 'failed-1', projection_state: 'failed' });
    expect(countUnprojected(db)).toBe(2);
  });

  it('7c. readWarmableIds is the state x version matrix, row by row', () => {
    // ★ THE ENDPOINT'S WHOLE PREDICATE, executable. `POST /api/warm` is the only
    // bulk re-warm the system has, and a version-stale row — `'ready'` with an
    // older `projector_version` — is invisible to `countUnprojected`, never
    // revisited by the sweep's second wave (`rollup_state` only goes
    // `'own'` -> `'complete'`), and never seen by the live tick, whose candidates
    // are sessions whose file moved. `render-gate/index.ts:737` measured 287 of
    // 293 real rows in exactly that state.
    const stale = PROJECTOR_VERSION - 1;
    seedSessionRow(db, { id: 'none-cur', projection_state: 'none' });
    seedSessionRow(db, { id: 'failed-cur', projection_state: 'failed' });
    seedSessionRow(db, {
      id: 'ready-cur',
      projection_state: 'ready',
      projector_version: PROJECTOR_VERSION,
    });
    seedSessionRow(db, { id: 'ready-stale', projection_state: 'ready', projector_version: stale });
    seedSessionRow(db, { id: 'ready-null', projection_state: 'ready' });
    seedSessionRow(db, {
      id: 'empty-cur',
      projection_state: 'empty',
      projector_version: PROJECTOR_VERSION,
    });
    seedSessionRow(db, { id: 'empty-stale', projection_state: 'empty', projector_version: stale });
    // `seedSessionRow` defaults the version to 1 and `?? ` cannot pass NULL, so
    // the never-projected row is written here. It is the case `!=` would drop.
    db.prepare(`UPDATE sessions SET projector_version = NULL WHERE id = ?`).run('ready-null');

    expect([...readWarmableIds(db)].sort()).toEqual([
      'empty-stale',
      'failed-cur',
      'none-cur',
      'ready-null',
      'ready-stale',
    ]);
    // `none-cur` and `failed-cur` carry the CURRENT version, so they are selected
    // by the state limb alone — without it the two would drop out silently.
    expect(readWarmableIds(db)).toContain('none-cur');
    // A superset of the search denominator, never equal to it: that is the
    // difference the endpoint exists for.
    expect(readWarmableIds(db).length).toBeGreaterThan(countUnprojected(db));
  });

  it('7d. readWarmableIds skips `empty` at the current version — a tombstone is projected', () => {
    // The rot direction of 7c: `empty` means the file projected nothing, which is
    // a finished projection. Only a stale version brings one back.
    seedSessionRow(db, {
      id: 'empty-cur',
      projection_state: 'empty',
      projector_version: PROJECTOR_VERSION,
    });
    expect(readWarmableIds(db)).toEqual([]);
    db.prepare(`UPDATE sessions SET projector_version = ? WHERE id = ?`).run(
      PROJECTOR_VERSION - 1,
      'empty-cur',
    );
    expect(readWarmableIds(db)).toEqual(['empty-cur']);
  });

  it('7e. readWarmableIds is newest-first, with id DESC breaking a tie', () => {
    seedSessionRow(db, { id: 'a-old', last_activity_at: '2026-08-14T09:00:00.000Z' });
    seedSessionRow(db, { id: 'b-new', last_activity_at: '2026-08-14T11:00:00.000Z' });
    seedSessionRow(db, { id: 'c-new', last_activity_at: '2026-08-14T11:00:00.000Z' });
    // All three are `ready@1` against a projector at 5, so all three are warmable
    // and the assertion is about order alone.
    expect(readWarmableIds(db)).toEqual(['c-new', 'b-new', 'a-old']);
  });

  it('8. readDriftRows selects raw rows — the aggregation is the mapper’s (Q4)', () => {
    seedSessionRow(db, { id: 'clean' });
    seedSessionRow(db, {
      id: 'drifted',
      harness_version: '2.2.0',
      drift_json: '{"unjoined_tool_uses":3,"unknown_line_types":{"weird":2}}',
    });
    seedSessionRow(db, { id: 'pending', projection_state: 'none' });

    const rows = readDriftRows(db);
    expect(rows.map((r) => r.id).sort()).toEqual(['clean', 'drifted']);
    expect(keysOf(rows[0]!)).toEqual(['drift_json', 'harness_version', 'id', 'title']);
    expect(rows.find((r) => r.id === 'drifted')?.drift_json).toContain('unjoined_tool_uses');
  });
});

describe('AC1 — Page<T> identity, sub_* pinning, and the snippet column index', () => {
  it('2. readSessionList returns exactly {items, limit, offset, has_more} — no `total`', () => {
    seedSessionRow(db, { id: 's1' });
    // The `satisfies` is the type-level half: an extra key such as `total` on
    // the return type would fail to compile here rather than at the UI.
    const page = readSessionList(db, { limit: 5, offset: 0 }) satisfies Page<SessionRow>;
    expect(keysOf(page)).toEqual(['has_more', 'items', 'limit', 'offset']);
  });

  it('3. the sub_* rollups are present and ZERO today, never absent (write.ts:513-516)', () => {
    // Pins today's truth so task 4.1's second wave lands as a visible diff. No
    // assertion here may expect a NON-zero sub_* — that is 4.1 wave 2's.
    seedSessionRow(db, { id: 's1' });
    const row = readSessionList(db, PAGE).items[0]!;

    expect(row.agent_count).toBe(0);
    expect(row.sub_tool_call_count).toBe(0);
    expect(row.sub_error_count).toBe(0);
    expect(row.sub_tokens_in).toBe(0);
    expect(row.sub_tokens_out).toBe(0);
    expect(row.sub_tokens_cache_read).toBe(0);
    expect(row.sub_tokens_cache_write).toBe(0);
    expect('sub_est_cost' in row).toBe(true);
    expect(row.sub_est_cost).toBeNull();
    expect(row.rollup_state).toBe('own');
  });

  it('3b. est_cost stays explicit null — unpriceable, never free (write.ts:533-538)', () => {
    seedSessionRow(db, { id: 'priced', est_cost: 1.25 });
    seedSessionRow(db, { id: 'unpriced', est_cost: null });
    const rows = readSessionList(db, PAGE).items;

    expect(rows.find((r) => r.id === 'priced')?.est_cost).toBe(1.25);
    const unpriced = rows.find((r) => r.id === 'unpriced')!;
    expect('est_cost' in unpriced).toBe(true);
    expect(unpriced.est_cost).toBeNull();
  });

  it('3c. has_drift is derived from drift_json, and drift_json never reaches the row', () => {
    seedSessionRow(db, { id: 'clean', drift_json: '{}' });
    seedSessionRow(db, { id: 'drifted', drift_json: '{"unjoined_tool_uses":1}' });
    const rows = readSessionList(db, PAGE).items;

    expect(rows.find((r) => r.id === 'clean')?.has_drift).toBe(false);
    expect(rows.find((r) => r.id === 'drifted')?.has_drift).toBe(true);
    expect('drift_json' in rows[0]!).toBe(false);
  });

  it('4. snippet() spans BOTH FTS columns — column 0 would blank every input-only hit', () => {
    seedFull();
    const hits = searchEvents(db, { q: 'quick', limit: 50 });
    const byId = new Map(hits.map((h) => [h.event_id, h]));

    // e1 matches only in `text`; e2 matches only in `input`.
    expect(byId.get('e1')!.snippet).toContain('<mark>quick</mark>');
    expect(byId.get('e2')!.snippet).toContain('<mark>quick</mark>');

    // ★ Mutation control. The same query with column index 0 returns null for
    // the input-only hit — a Bash argument or Grep pattern would render with no
    // context at all, and no other assertion here would notice.
    const mutated = db
      .prepare(
        `SELECT e.id AS event_id, snippet(events_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet
           FROM events_fts JOIN events e ON e.rowid = events_fts.rowid
           JOIN sessions s ON s.id = e.session_id
          WHERE events_fts MATCH ?`,
      )
      .all('quick') as unknown as { event_id: string; snippet: string | null }[];

    expect(mutated.find((r) => r.event_id === 'e2')?.snippet).toBeNull();
    expect(mutated.find((r) => r.event_id === 'e1')?.snippet).not.toBeNull();
  });
});

describe('AC2 — sidecars never enter the session list', () => {
  it('9. a sidecar with a NEWER last_activity_at than every parent is still excluded', () => {
    const parents = ['p1', 'p2', 'p3'];
    for (const [index, id] of parents.entries()) {
      seedSessionRow(db, { id, last_activity_at: `2026-08-1${index + 1}T09:00:00.000Z` });
    }
    for (let n = 0; n < 5; n += 1) {
      // Newer than every parent: an unfiltered query would surface these first.
      seedSidecarRow(db, 'p1', { id: `kid-${n}`, last_activity_at: '2026-09-01T09:00:00.000Z' });
    }

    // `limit` is far above the row count, so exclusion cannot be mistaken for paging.
    for (const query of [
      { ...PAGE },
      { ...PAGE, q: 'title' },
      { ...PAGE, project: '/Users/dev/proj' },
      { ...PAGE, project: '/Users/dev/proj', q: 'title' },
    ]) {
      const { items } = readSessionList(db, query);
      expect(items.map((r) => r.id).sort()).toEqual(parents);
    }

    // …and the sidecars really are in the table, so the assertion is not vacuous.
    const total = db.prepare('SELECT count(*) AS n FROM sessions').get() as unknown as {
      n: number;
    };
    expect(total.n).toBe(8);

    // readProjects excludes them too — the same partial predicate.
    expect(readProjects(db).items[0]?.session_count).toBe(3);
  });
});

describe('AC3 — sort, ordering and the q filter are correct', () => {
  const seedSorted = (): void => {
    seedSessionRow(db, {
      id: 'low',
      last_activity_at: '2026-08-11T09:00:00.000Z',
      est_cost: 1,
      tokens_in: 1,
      tokens_out: 1,
      error_count: 1,
    });
    seedSessionRow(db, {
      id: 'mid',
      last_activity_at: '2026-08-12T09:00:00.000Z',
      est_cost: 5,
      tokens_in: 5,
      tokens_out: 5,
      error_count: 5,
    });
    seedSessionRow(db, {
      id: 'high',
      last_activity_at: '2026-08-13T09:00:00.000Z',
      est_cost: 9,
      tokens_in: 9,
      tokens_out: 9,
      error_count: 9,
    });
  };

  it('16. every sort orders descending on its own column', () => {
    seedSorted();
    for (const sort of ['recent', 'cost', 'tokens', 'errors'] as const) {
      expect(
        readSessionList(db, { ...PAGE, sort }).items.map((r) => r.id),
        sort,
      ).toEqual(['high', 'mid', 'low']);
    }
  });

  it('16b. an unknown sort key cannot reach the SQL — the map is frozen and keyed', () => {
    seedSorted();
    const injected = 'last_activity_at; DROP TABLE sessions --' as never;
    expect(() => readSessionList(db, { ...PAGE, sort: injected })).toThrow();
    expect(readSessionList(db, PAGE).items).toHaveLength(3);
  });

  it('11. same-millisecond sessions get a total, stable id DESC order', () => {
    const same = '2026-08-14T09:00:00.000Z';
    for (const id of ['b', 'a', 'c']) seedSessionRow(db, { id, last_activity_at: same });

    for (let n = 0; n < 3; n += 1) {
      expect(readSessionList(db, PAGE).items.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    }
  });

  it('q filters over title || preview || project_path, and escapes LIKE wildcards', () => {
    seedSessionRow(db, { id: 's1', title: 'refactor the parser', preview: 'hello' });
    seedSessionRow(db, { id: 's2', title: null, preview: 'ship the parser', project_path: '/z' });
    seedSessionRow(db, { id: 's3', title: '100% done', preview: null, project_path: '/z' });

    // COALESCE is required: `NULL || x` is NULL, so s2 would vanish without it.
    expect(
      readSessionList(db, { ...PAGE, q: 'parser' })
        .items.map((r) => r.id)
        .sort(),
    ).toEqual(['s1', 's2']);
    expect(
      readSessionList(db, { ...PAGE, q: '/z' })
        .items.map((r) => r.id)
        .sort(),
    ).toEqual(['s2', 's3']);

    // A literal `%` matches only itself; an unescaped one would match everything.
    expect(readSessionList(db, { ...PAGE, q: '100%' }).items.map((r) => r.id)).toEqual(['s3']);
    expect(readSessionList(db, { ...PAGE, q: '%' }).items.map((r) => r.id)).toEqual(['s3']);
    expect(readSessionList(db, { ...PAGE, q: 'no such text' }).items).toEqual([]);
  });
});

describe('AC4 — has_more is a LIMIT n+1 probe, never a COUNT(*)', () => {
  // ★ The reviewed allowlist, not a blanket exemption. `present: false` is what a
  // future `GROUP BY harness_version` must flip to land — which makes adding one
  // a reviewed act instead of a silent one.
  interface CountSite {
    fragment: string;
    present: boolean;
    why: string;
  }

  const COUNT_SITES: readonly CountSite[] = [
    {
      fragment: 'buildProjectsSql',
      present: true,
      why: 'GET /api/projects IS the aggregate the spec specifies (data-model-v2.md:288-290): SELECT project_path, COUNT(*), MAX(last_activity_at) GROUP BY 1. It is not a pagination count.',
    },
    {
      fragment: 'countUnprojected',
      present: true,
      why: 'GET /api/search reports unprojected_count honestly (data-model-v2.md:349-354). A denominator over sessions, not a page total.',
    },
    {
      fragment: 'readDriftRows',
      present: false,
      why: 'Q4 rules the harness_versions tally into the MAPPER, so this selects raw rows and holds no count today. Present:false is the guard — a GROUP BY harness_version landing here must flip this flag, which is the review.',
    },
    {
      fragment: 'readHealthCounts',
      present: true,
      why: 'GET /api/health reports sessions_indexed and sessions_projected by name (data-model-v2.md:394-396). Both are corpus totals over `sessions`, not a page total, and sessions_projected is the exact complement of countUnprojected.',
    },
    {
      fragment: 'readEventCount',
      present: true,
      why: 'POST /api/sessions/:id/reproject reports event_count (data-model-v2.md:373-375). An exact total over one session on the session index — the LIMIT n+1 probe cannot answer a total, and paging every event into the route to length it would be worse. Turns need no twin: sessions.turn_count is a stamped column.',
    },
  ];

  /**
   * Every `count(*)` in `read.ts`, tagged with the exported function it sits in.
   * Comment LINES are skipped: this file has to name the forbidden aggregate in
   * prose to explain why it is forbidden, and a count that never reaches SQLite
   * is not the thing AC4 is about. Only whole-line comments are dropped, so a
   * count cannot hide behind a trailing `//` on a live statement.
   */
  function countLines(text = SOURCE): { line: string; owner: string }[] {
    const found: { line: string; owner: string }[] = [];
    let owner = '<module scope>';
    for (const line of text.split('\n')) {
      const declared = /^export function (\w+)/.exec(line);
      if (declared !== null) owner = declared[1]!;
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
      if (/count\s*\(\s*\*\s*\)/i.test(line)) found.push({ line: line.trim(), owner });
    }
    return found;
  }

  it('17. every count(*) in read.ts sits in a reviewed allowlist entry', () => {
    const permitted = new Set(COUNT_SITES.map((site) => site.fragment));
    const found = countLines();

    expect(
      found.filter((hit) => !permitted.has(hit.owner)).map((hit) => `${hit.owner}: ${hit.line}`),
      'unreviewed COUNT(*) in db/read.ts. `has_more` comes from a LIMIT n+1 probe — if this is ' +
        'a genuine spec-required aggregate, add a COUNT_SITES entry with a written reason.',
    ).toEqual([]);

    // Both rot directions. A `present: true` entry that stopped matching means
    // the aggregate the spec requires went away.
    for (const site of COUNT_SITES) {
      expect(site.why.length, `${site.fragment} needs a justification`).toBeGreaterThan(0);
      expect(
        found.some((hit) => hit.owner === site.fragment),
        `${site.fragment} is allowlisted with present: ${site.present} but the source disagrees`,
      ).toBe(site.present);
    }

    expect(SOURCE).toContain('limit + 1');
  });

  it('17b. the count scanner is not vacuous', () => {
    // Softening the pattern to match nothing would green the assertion above.
    expect(countLines().length).toBe(COUNT_SITES.filter((s) => s.present).length);
    expect(countLines('export function f() {\n  return `count(*)`;\n}\n')).toHaveLength(1);
    expect(countLines('export function f() {\n  return `COUNT( * )`;\n}\n')).toHaveLength(1);
    expect(countLines('export function f() {\n  return 1;\n}\n')).toEqual([]);

    // The comment skip drops a whole-line comment and nothing else: a trailing
    // `//` on a live statement must not launder the count past the gate.
    expect(countLines('export function f() {\n  // count(*) in prose\n}\n')).toEqual([]);
    expect(countLines('export function f() {\n  return `count(*)`; // why\n}\n')).toHaveLength(1);
  });

  it.each([
    [4, 4, false],
    [5, 4, true],
    [4, 5, false],
    [0, 3, false],
    [1, 1, false],
    [2, 1, true],
  ])('18. %i rows at limit %i probes has_more = %s', (rows, limit, expected) => {
    for (let n = 0; n < rows; n += 1) {
      seedSessionRow(db, { id: `s${n}`, last_activity_at: `2026-08-0${n + 1}T09:00:00.000Z` });
    }
    const page = readSessionList(db, { limit, offset: 0 });

    expect(page.has_more).toBe(expected);
    expect(page.items.length).toBeLessThanOrEqual(limit);
    expect(page.items).toHaveLength(Math.min(rows, limit));
  });

  it('18b. the n+1 probe row is sliced off, never served', () => {
    for (let n = 0; n < 5; n += 1) {
      seedSessionRow(db, { id: `s${n}`, last_activity_at: `2026-08-0${n + 1}T09:00:00.000Z` });
    }
    const first = readSessionList(db, { limit: 2, offset: 0 });
    const second = readSessionList(db, { limit: 2, offset: 2 });

    expect(first.items.map((r) => r.id)).toEqual(['s4', 's3']);
    expect(second.items.map((r) => r.id)).toEqual(['s2', 's1']);
    expect(first.items.some((r) => second.items.some((o) => o.id === r.id))).toBe(false);
  });

  it('19. an offset past the end is an empty page, not an error', () => {
    seedSessionRow(db, { id: 's1' });

    let page!: Page<SessionRow>;
    expect(() => {
      page = readSessionList(db, { limit: 2, offset: 100 });
    }).not.toThrow();
    expect(page).toEqual({ items: [], limit: 2, offset: 100, has_more: false });
  });

  it('19b. readEventPage past last_seq is an empty page that holds the cursor', () => {
    const id = seedFull();

    let page!: ReturnType<typeof readEventPage>;
    expect(() => {
      page = readEventPage(db, id, { from_seq: 9_999, limit: 10 });
    }).not.toThrow();
    expect(page).toEqual({ items: [], next_seq: 9_999, has_more: false });

    // The cursor advances past the last served event when there IS one.
    const walked = readEventPage(db, id, { from_seq: 0, limit: 2 });
    expect(walked).toMatchObject({ next_seq: 3, has_more: true });
    expect(readEventPage(db, id, { from_seq: walked.next_seq, limit: 2 })).toMatchObject({
      has_more: false,
    });
  });

  it('20. has_more is (offset + limit < n) at every table size', () => {
    // One db, one project per size: a project-filtered list over `/p{n}` has
    // exactly n rows, so the property varies n without rebuilding the schema.
    const MAX = 12;
    for (let n = 0; n <= MAX; n += 1) {
      for (let row = 0; row < n; row += 1)
        seedSessionRow(db, { id: `p${n}-${row}`, project_path: `/p${n}` });
    }

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 20 }),
        (n, limit, offset) => {
          const page = readSessionList(db, { limit, offset, project: `/p${n}` });
          expect(page.has_more).toBe(offset + limit < n);
          expect(page.items).toHaveLength(Math.max(0, Math.min(limit, n - offset)));
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Task 6.1's two live-diff readers ---------------------------------------

describe('AC1 — the live diff reads through the one door', () => {
  const OTHER = 'sess-other';

  beforeEach(() => {
    for (const id of ['sess-1', OTHER]) {
      seedSessionRow(db, { id });
      seedProjection(db, id, {
        turns: [{ seq: 1 }],
        events: [
          { id: `${id}:a`, seq: 1, kind: 'tool_call', name: 'Agent' },
          { id: `${id}:b`, seq: 2, kind: 'tool_call', name: 'Agent' },
          { id: `${id}:c`, seq: 3, kind: 'text' },
        ],
      });
    }
    // `EventSeed` carries no `status`, and the column is what the diff reads.
    db.prepare(`UPDATE events SET status = 'running' WHERE id IN (?, ?, ?)`).run(
      'sess-1:a',
      'sess-1:b',
      `${OTHER}:a`,
    );
    db.prepare(`UPDATE events SET status = 'ok' WHERE id = ?`).run('sess-1:c');
  });

  it("readRunningEventIds returns only this session's running rows, in seq order", () => {
    expect(readRunningEventIds(db, 'sess-1')).toEqual(['sess-1:a', 'sess-1:b']);
    expect(readRunningEventIds(db, OTHER)).toEqual([`${OTHER}:a`]);
    expect(readRunningEventIds(db, 'no-such-session')).toEqual([]);
  });

  it('readEventsByIds returns full event rows for the named ids, in seq order', () => {
    const rows = readEventsByIds(db, 'sess-1', ['sess-1:c', 'sess-1:a']);
    expect(rows.map((row) => row.id)).toEqual(['sess-1:a', 'sess-1:c']);
    // The same key set every other event reader returns — no bespoke projection.
    expect(new Set(Object.keys(rows[0]!))).toEqual(new Set(EVENT_ROW_KEYS));
  });

  it('readEventsByIds is scoped by session, so an id cannot be read across one', () => {
    // The scope is not decoration: `events.id` is a global primary key, so
    // without it a caller could read another session's row by guessing an id.
    expect(readEventsByIds(db, 'sess-1', [`${OTHER}:a`])).toEqual([]);
  });

  it('readEventsByIds answers an empty id list without a query', () => {
    // `IN ()` is a syntax error in SQLite, so the empty case is handled ahead of
    // the statement rather than by luck.
    expect(readEventsByIds(db, 'sess-1', [])).toEqual([]);
  });
});

// --- The `/api/search` 500: FTS5 EXPRESSION syntax vs. ordinary search terms --
//
// `q` is a bound parameter (`MATCH ?`), so none of this is injection — the
// surface is FTS5 expression syntax, in which a hyphen, a slash, a plus and a
// trailing colon are all illegal. Those are exactly what a file path and a Bash
// result contain, so before the phrase fallback the shipped route answered 500
// or 400 for the search this feature exists to serve.

describe('AC1 — searchEvents answers real query shapes instead of throwing', () => {
  /** One row carrying every literal shape below, so a hit proves the term matched. */
  function seedShapes(): void {
    seedSessionRow(db, { id: 'shapes' });
    seedProjection(db, 'shapes', {
      turns: [{ seq: 1 }],
      events: [
        {
          id: 'sh1',
          seq: 1,
          text:
            'ENOENT: no such file at src/db/read.ts, ' +
            'while running --no-verify over foo-bar (C++, e.g. this one). done',
          input: '{"pattern":"quick"}',
        },
      ],
    });
  }

  /**
   * The eight shapes whose RAW expression is illegal, in the order they appear
   * below. Written out rather than derived from `SHAPES`: this list IS the
   * control, and deriving it from the table it checks would make it vacuous.
   */
  const UNPARSEABLE = [
    'foo-bar',
    'ENOENT:',
    'src/db/read.ts',
    'C++',
    'e.g.',
    '--no-verify',
    '*',
    '"',
  ];

  /** `[q, hits]`. `*` and `"` quote to a phrase with no tokens, so they match nothing. */
  const SHAPES: readonly (readonly [string, number])[] = [
    ['foo-bar', 1],
    ['ENOENT:', 1],
    ['src/db/read.ts', 1],
    ['C++', 1],
    ['e.g.', 1],
    ['--no-verify', 1],
    ['*', 0],
    ['"', 0],
    // The raw arm runs FIRST, which is what keeps an operator query an operator
    // query rather than flattening it into a literal phrase.
    ['text:done', 1],
    // Needs `spill_fts`'s UNINDEXED `input`: without it the spill arm throws, the
    // retry searches the literal phrase, and this answers 0.
    ['input:pattern', 1],
    ['nothing OR done', 1],
  ];

  it.each(SHAPES)('q=%j finds %i row and never throws', (q, hits) => {
    seedShapes();
    expect(searchEvents(db, { q, limit: 50 })).toHaveLength(hits);
  });

  it('mutation control: without the fallback 8 of those 11 shapes throw', () => {
    seedShapes();
    const throwers = SHAPES.filter(([q]) => {
      try {
        db.prepare('SELECT rowid FROM events_fts WHERE events_fts MATCH ?').all(q);
        return false;
      } catch {
        return true;
      }
    }).map(([q]) => q);

    expect(throwers).toEqual(UNPARSEABLE);
  });

  it('a real fault still propagates — the fallback swallows a parse, never a fault', () => {
    seedShapes();
    // The load-bearing 500 control: both arms throw the same thing, and the
    // second throw is the one that leaves this function.
    db.exec('DROP TABLE events_fts');
    expect(() => searchEvents(db, { q: 'foo-bar', limit: 50 })).toThrow(/no such table/);
  });

  it('NUL is the one q both arms lose, which is why the guard is upstream', () => {
    seedShapes();
    // SQLite truncates a bound string at NUL, so the quoted arm loses its own
    // closing quote and throws `unterminated string`. `parseSearchQuery` rejects
    // NUL as `invalid q` ahead of this; delete that guard and this is a 500.
    const q = `foo-bar${String.fromCharCode(0)}tail`;
    expect(() => searchEvents(db, { q, limit: 50 })).toThrow(/unterminated string/);
  });
});

// --- Task 7.5: the spill arm ------------------------------------------------

describe('task 7.5 — searchEvents reads spill_fts as a second arm', () => {
  const PATH = '/archive/-slug/s/tool-results/spilled.txt';

  /** A tool_call spill row with no text, plus its body in `spill_fts`. */
  function seedSpill(session: string, id: string, body: string): void {
    seedSessionRow(db, { id: session });
    seedProjection(db, session, {
      turns: [{ seq: 1 }],
      events: [{ id, seq: 1, kind: 'tool_call', name: 'Bash', text: null }],
    });
    db.prepare(`UPDATE events SET output_storage = 'spill', spill_path = ? WHERE id = ?`).run(
      PATH,
      id,
    );
    db.prepare(
      `INSERT INTO spill_fts(event_id, session_id, spill_path, text, input) VALUES (?, ?, ?, ?, NULL)`,
    ).run(id, session, PATH, body);
  }

  const ids = (q: string, session?: string): string[] =>
    searchEvents(db, { q, limit: 50, ...(session !== undefined && { session }) })
      .map((h) => h.event_id)
      .sort();

  it('both arms answer one query, ?session= scopes BOTH, and LIMIT applies to the union', () => {
    seedFull('inline');
    seedSpill('one', 'toolu_one', 'quick words from a spilled body');
    seedSpill('two', 'toolu_two', 'quick words from another one');

    expect(ids('quick')).toEqual(['e1', 'e2', 'toolu_one', 'toolu_two']);
    expect(ids('quick', 'two')).toEqual(['toolu_two']);
    expect(searchEvents(db, { q: 'quick', limit: 3 })).toHaveLength(3);
  });

  it('an unparseable q present only in a spilled body is found through the phrase retry', () => {
    seedSpill('sp', 'toolu_sp', 'the command printed foo-bar and stopped');
    expect(ids('foo-bar')).toEqual(['toolu_sp']);
    expect(ids('foo-bar', 'sp')).toEqual(['toolu_sp']);
  });

  it('a body whose event no longer points at it never surfaces, before any reconcile', () => {
    seedSpill('sp', 'toolu_sp', 'zzspilltoken lives here');
    db.prepare(`UPDATE events SET output_storage = 'missing', spill_path = NULL`).run();
    expect(ids('zzspilltoken')).toEqual([]);
  });
});
