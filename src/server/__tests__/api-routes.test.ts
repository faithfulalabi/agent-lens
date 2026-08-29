// AC1: all ten routes, each asserted by SET-EQUALITY on its response key set
// against the field list transcribed from `spec/data-model-v2.md`, plus its
// status code. Never containment — `db/__tests__/read.test.ts:5-7` records that
// containment is provably blind to a dropped field, which is the failure this
// schema has already had.
//
// Everything runs through hono's `app.request()` over an in-memory `openCache()`:
// no socket, no `startServer`, and above all no plan-001 schema. One session is
// backed by a REAL transcript in a temp archive, because the detail route runs
// the freshness gate and a gate over a fictional path proves nothing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import {
  SESSION_ID,
  fileEnv,
  humanLine,
  openCache,
  seedIndexRow,
  seedProjection,
  seedSessionRow,
  toolCallLine,
  toolResultLine,
  writeTranscript,
} from '../../db/__tests__/fixtures/index.js';
import { emptyReport } from '../../corpus/watch.js';
import type { Page } from '../../shared/api.js';
import type {
  EventRow,
  ProjectSummary,
  SearchHit,
  SessionDetailHeader,
  SessionRow,
  TurnRow,
} from '../../db/read.js';
import { TOKEN_HEADER } from '../../shared/index.js';
import { buildApiApp } from '../app.js';
import type { DriftReport } from '../api.js';

const TOKEN = 'test-token';

/** `SessionRow`, transcribed from `data-model-v2.md:276-286`. `live` included. */
const SESSION_ROW_KEYS = [
  'id',
  'title',
  'preview',
  'project_path',
  'git_branch',
  'model',
  'harness_version',
  'started_at',
  'last_activity_at',
  'live',
  'turn_count',
  'tool_call_count',
  'error_count',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
  'agent_count',
  'sub_tool_call_count',
  'sub_error_count',
  'sub_tokens_in',
  'sub_tokens_out',
  'sub_tokens_cache_read',
  'sub_tokens_cache_write',
  'sub_est_cost',
  'rollup_state',
  'has_drift',
];

/** `TurnRow`, from `data-model-v2.md:314-317`. */
const TURN_ROW_KEYS = [
  'id',
  'seq',
  'kind',
  'title',
  'started_at',
  'ended_at',
  'duration_ms',
  'duration_source',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
  'tool_call_count',
  'error_count',
  'first_seq',
  'last_seq',
];

/** `EventRow`, from `data-model-v2.md:318-329`. */
const EVENT_ROW_KEYS = [
  'id',
  'turn_id',
  'seq',
  'kind',
  'ts',
  'request_id',
  'block_index',
  'name',
  'status',
  'duration_ms',
  'duration_source',
  'input',
  'input_bytes',
  'input_storage',
  'text',
  'text_bytes',
  'output_storage',
  'spill_path',
  'spill_bytes',
  'model',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
  'child_session_id',
  'agent_type',
  'agent_status',
  'raw_type',
  'raw_subtype',
];

/** `SearchHit`, from `data-model-v2.md:353`. */
const SEARCH_HIT_KEYS = [
  'session_id',
  'session_title',
  'project_path',
  'turn_id',
  'event_id',
  'seq',
  'kind',
  'name',
  'ts',
  'snippet',
];

const PAGE_KEYS = ['items', 'limit', 'offset', 'has_more'];

// The response bodies, named so every access below is typed. The key-set
// assertions are what check the wire shape; these only type the reads.

/** Every list row is a `SessionRow` plus the server-stamped `live`. */
type ListedRow = SessionRow & { live: boolean };

interface DetailBody {
  session: SessionDetailHeader & { live: boolean };
  turns: TurnRow[];
  events: EventRow[];
  next_seq: number;
  has_more: boolean;
  fingerprint: string;
}

interface ContentBody {
  id: string;
  field: string;
  storage: string;
  byte_size: number;
  range: { start: number; end: number };
  content: string;
  truncated: boolean;
  spill_path?: string;
}

interface SearchBody {
  items: SearchHit[];
  scope: string;
  unprojected_count: number;
}

interface ReprojectBody {
  session: SessionDetailHeader & { live: boolean };
  event_count: number;
  turn_count: number;
  took_ms: number;
}

interface HealthBody {
  ok: boolean;
  projects_root: string | null;
  index_built_at: string | null;
  files_indexed: number | null;
  sessions_indexed: number;
  sessions_projected: number;
  db_bytes: number;
  schema_version: string | null;
  projector_version: string | null;
}

type DriftBody = DriftReport & {
  projector_version: string | null;
  schema_version: string | null;
};

function keysOf(value: unknown): string[] {
  return Object.keys(value as object).sort();
}

/** Set-equality, the only comparison this file makes on a key set. */
function expectKeys(value: unknown, expected: readonly string[]): void {
  expect(keysOf(value)).toEqual([...expected].sort());
}

let sandbox: Sandbox;
let db: DatabaseSync;
let app: Hono;

/** The searchable, fully-seeded row. No file behind it: it never meets the gate. */
const SEEDED = 'seeded-1111-4111-8111-seeded000001';
const DRIFTY = 'drifty-1111-4111-8111-drifty000001';

beforeEach(() => {
  sandbox = makeSandbox();
  db = openCache();

  // A real transcript in a real archive: the detail, reproject and content routes
  // all run the gate, and the gate stats files.
  const archive = writeTranscript(join(sandbox.archiveRoot, `${SESSION_ID}.jsonl`), [
    humanLine('find the parser bug', '2026-08-14T09:00:00.000Z'),
    toolCallLine('toolu_1', 'Grep', '2026-08-14T09:00:01.000Z'),
    toolResultLine('toolu_1', 'match at line 7', '2026-08-14T09:00:02.000Z'),
  ]);
  seedIndexRow(db, archive);

  seedSessionRow(db, { id: SEEDED, title: 'the parser session' });
  seedProjection(db, SEEDED, {
    turns: [{ seq: 1 }],
    events: [{ id: 'ev-1', seq: 1, text: 'the quick brown parser', input: 'grep pattern' }],
  });

  seedSessionRow(db, {
    id: DRIFTY,
    harness_version: '2.2.0',
    drift_json: JSON.stringify({
      sidecar_agent_id_mismatch: 2,
      unjoined_tool_uses: 1,
      unknown_line_types: { summary: 4 },
      unknown_top_level_fields: { newField: 3 },
    }),
  });

  app = buildApiApp({
    db,
    env: fileEnv(),
    token: TOKEN,
    uiDir: join(sandbox.root, 'no-such-ui'),
  });
});

afterEach(() => {
  db.close();
  cleanup(sandbox);
});

/**
 * `app.request` builds no `Host` header, and `hostGuard` runs app-wide and 403s
 * without one — so every call here supplies the loopback name a real client
 * would send. `api-order.test.ts` is where a foreign one is asserted.
 */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Host: 'localhost', [TOKEN_HEADER]: TOKEN, ...(init.headers ?? {}) },
  });
}

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await call(path);
  return { status: res.status, body: (await res.json()) as T };
}

describe('1. GET /api/sessions (spec:271-286)', () => {
  it('is a Page<SessionRow> and every row carries the server-stamped `live`', async () => {
    const { status, body } = await getJson<Page<ListedRow>>('/api/sessions');
    expect(status).toBe(200);
    expectKeys(body, PAGE_KEYS);
    expect(body.items.length).toBeGreaterThan(0);
    for (const row of body.items) expectKeys(row, SESSION_ROW_KEYS);
    // `live` is stamped, never a column: historical fixtures are not live.
    expect(body.items.every((row) => row.live === false)).toBe(true);
  });

  it('filters on project and q, and sorts by key', async () => {
    expect(
      (await getJson<Page<ListedRow>>('/api/sessions?project=/Users/dev/proj')).body.items.length,
    ).toBeGreaterThan(0);
    expect((await getJson<Page<ListedRow>>('/api/sessions?project=/nope')).body.items).toEqual([]);
    expect(
      (await getJson<Page<ListedRow>>('/api/sessions?q=parser')).body.items.map((r) => r.id),
    ).toEqual([SEEDED]);
    expect((await getJson<Page<ListedRow>>('/api/sessions?sort=cost')).status).toBe(200);
  });

  it('400s a bad param as JSON, and never reaches the reader', async () => {
    for (const query of ['limit=0', 'limit=abc', 'offset=-1', 'sort=bogus']) {
      const res = await call(`/api/sessions?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(keysOf(await res.json())).toEqual(['error']);
    }
  });
});

describe('2. GET /api/projects (spec:288-290)', () => {
  it('is { items: [{ path, session_count, last_activity_at }] }', async () => {
    const { status, body } = await getJson<{ items: ProjectSummary[] }>('/api/projects');
    expect(status).toBe(200);
    expectKeys(body, ['items']);
    for (const row of body.items) {
      expectKeys(row, ['path', 'session_count', 'last_activity_at']);
    }
    // Grouped on the same column `?project=` filters on, so the filter can never
    // name a group this list omits.
    const paths = body.items.map((r) => r.path);
    expect(paths).toContain('/Users/dev/proj');
  });
});

describe('3. GET /api/sessions/:id (spec:294-331)', () => {
  it('is header + every turn + a page of events + the epoch', async () => {
    const { status, body } = await getJson<DetailBody>(`/api/sessions/${SESSION_ID}`);
    expect(status).toBe(200);
    expectKeys(body, ['session', 'turns', 'events', 'next_seq', 'has_more', 'fingerprint']);
    // A top-level session carries none of the four sidecar keys.
    expectKeys(body.session, [...SESSION_ROW_KEYS, 'cwd', 'projection']);
    expect(body.session.cwd).toBe(body.session.project_path);
    expectKeys(body.session.projection, ['state', 'projector_version', 'projected_at', 'drift']);
    expectKeys(body.session.projection.drift, [
      'unknown_line_types',
      'unknown_block_types',
      'unjoined_tool_uses',
      'unresolved_spills',
    ]);

    expect(body.turns.length).toBeGreaterThan(0);
    for (const turn of body.turns) expectKeys(turn, TURN_ROW_KEYS);
    expect(body.events.length).toBeGreaterThan(0);
    for (const event of body.events) expectKeys(event, EVENT_ROW_KEYS);

    // '<mtime_ms>:<size>:<sidecar_count>' — the live-tail epoch.
    expect(body.fingerprint).toMatch(/^\d+:\d+:\d+$/);
    expect(typeof body.next_seq).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
  });

  it('pages events by from_seq and 404s an unindexed id', async () => {
    const all = (await getJson<DetailBody>(`/api/sessions/${SESSION_ID}`)).body;
    const second = (await getJson<DetailBody>(`/api/sessions/${SESSION_ID}?from_seq=1`)).body;
    expect(second.events.length).toBe(all.events.length - 1);

    const missing = await call('/api/sessions/no-such-session');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
  });

  it('400s a bad param as JSON', async () => {
    for (const query of ['from_seq=-1', 'from_seq=abc', 'limit=0']) {
      const res = await call(`/api/sessions/${SESSION_ID}?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
  });
});

describe('4. GET /api/events/:id/content (spec:334-345)', () => {
  it('is the content envelope, and serves an inline field from the column', async () => {
    const res = await call('/api/events/ev-1/content?field=text');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContentBody;
    expectKeys(body, ['id', 'field', 'storage', 'byte_size', 'range', 'content', 'truncated']);
    expectKeys(body.range, ['start', 'end']);
    expect(body).toMatchObject({
      id: 'ev-1',
      field: 'text',
      storage: 'inline',
      content: 'the quick brown parser',
      truncated: false,
    });
  });

  it('serves the input half under ?field=input', async () => {
    const { body } = await getJson<ContentBody>('/api/events/ev-1/content?field=input');
    expect(body).toMatchObject({ field: 'input', storage: 'inline', content: 'grep pattern' });
  });

  it('clamps a range instead of rejecting it, and always answers 200 + JSON', async () => {
    const { status, body } = await getJson<ContentBody>(
      '/api/events/ev-1/content?field=text&range=4-8',
    );
    expect(status).toBe(200);
    // `end` is INCLUSIVE, the convention lifted verbatim from today's read-api.
    expect(body.content).toBe('quick');
    expect(body.range).toEqual({ start: 4, end: 8 });
    expect(body.truncated).toBe(true);

    const past = (await getJson<ContentBody>('/api/events/ev-1/content?range=9999-')).body;
    expect(past.content).toBe('');
    expect(past.truncated).toBe(true);
  });

  it('400s a bad field or range, and 404s an unknown event', async () => {
    expect((await call('/api/events/ev-1/content?field=body')).status).toBe(400);
    expect((await call('/api/events/ev-1/content?range=5-2')).status).toBe(400);
    const missing = await call('/api/events/no-such-event/content');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
  });

  it('labels an unresolvable field `missing` at 200 with the stored preview (spec:340)', async () => {
    // Task 4.4 owns `resolveContent`; until it lands, "full output no longer on
    // disk" is a NORMAL labelled state, not an error.
    db.prepare(
      `UPDATE events SET output_storage = 'spill', spill_path = '/gone.txt' WHERE id = ?`,
    ).run('ev-1');
    const { status, body } = await getJson<ContentBody>('/api/events/ev-1/content?field=text');
    expect(status).toBe(200);
    expectKeys(body, [
      'id',
      'field',
      'storage',
      'byte_size',
      'range',
      'content',
      'truncated',
      'spill_path',
    ]);
    expect(body.storage).toBe('missing');
    expect(body.content).toBe('the quick brown parser');
    expect(body.spill_path).toBe('/gone.txt');
  });

  it('defers to the 4.4 resolver when one is injected', async () => {
    db.prepare(`UPDATE events SET output_storage = 'line_ref' WHERE id = ?`).run('ev-1');
    const withResolver = buildApiApp({
      db,
      env: fileEnv(),
      token: TOKEN,
      uiDir: join(sandbox.root, 'no-such-ui'),
      resolveContent: (row, field) => ({
        storage: 'line_ref',
        content: `resolved ${row.id} ${field}`,
        byte_size: 12,
      }),
    });
    const res = await withResolver.request('/api/events/ev-1/content', {
      headers: { Host: 'localhost', [TOKEN_HEADER]: TOKEN },
    });
    expect(await res.json()).toMatchObject({
      storage: 'line_ref',
      content: 'resolved ev-1 text',
    });
  });
});

describe('5. GET /api/search (spec:349-354)', () => {
  it('is { items, scope, unprojected_count } with SearchHit rows', async () => {
    const { status, body } = await getJson<SearchBody>('/api/search?q=parser');
    expect(status).toBe(200);
    expectKeys(body, ['items', 'scope', 'unprojected_count']);
    expect(body.items.length).toBeGreaterThan(0);
    for (const hit of body.items) expectKeys(hit, SEARCH_HIT_KEYS);
    expect(body.scope).toBe('projected');
    expect(typeof body.unprojected_count).toBe('number');
  });

  it('scopes to one session when ?session= is given', async () => {
    const { body } = await getJson<SearchBody>(`/api/search?q=parser&session=${SEEDED}`);
    expect(body.scope).toBe('session');
    expect(body.items.every((hit) => hit.session_id === SEEDED)).toBe(true);
  });

  it('400s a missing q and a malformed FTS expression, never a 500', async () => {
    expect((await call('/api/search')).status).toBe(400);
    // Raw user text reaches FTS5; a lone quote is a malformed param, not a crash.
    for (const q of ['%22', 'AND']) {
      const res = await call(`/api/search?q=${q}`);
      expect(res.status, q).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
  });

  it('a REAL reader failure is a JSON 500, never blamed on q and never text/plain', async () => {
    // The 400 above is narrowed by message precisely so this stays a 500: an
    // index that is gone is a server fault, not a malformed param.
    db.exec('DROP TABLE events_fts');
    const res = await call('/api/search?q=parser');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'internal error' });
  });
});

describe('6. GET /api/stream (spec:358-369)', () => {
  it('opens an SSE stream and is not shadowed by the /api/* terminator', async () => {
    const res = await call('/api/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Cancel rather than read: the heartbeat loop runs until the client leaves.
    await res.body?.cancel();
  });
});

describe('7. POST /api/sessions/:id/reproject (spec:373-375)', () => {
  it('is { session, event_count, turn_count, took_ms } and rebuilds the projection', async () => {
    const before = (await getJson<DetailBody>(`/api/sessions/${SESSION_ID}`)).body;
    const res = await call(`/api/sessions/${SESSION_ID}/reproject`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReprojectBody;

    expectKeys(body, ['session', 'event_count', 'turn_count', 'took_ms']);
    expectKeys(body.session, [...SESSION_ROW_KEYS, 'cwd', 'projection']);
    expect(body.event_count).toBe(before.events.length);
    expect(body.turn_count).toBe(before.turns.length);
    expect(typeof body.took_ms).toBe('number');
    expect(body.took_ms).toBeGreaterThanOrEqual(0);
  });

  it('rebuilds even on a gate hit — the whole point of a FORCED reproject', async () => {
    // Warm the gate so the next call is a 'hit', which changes nothing by itself.
    await getJson<DetailBody>(`/api/sessions/${SESSION_ID}`);
    db.prepare('DELETE FROM events WHERE session_id = ?').run(SESSION_ID);
    db.prepare('DELETE FROM turns WHERE session_id = ?').run(SESSION_ID);

    const body = (await (
      await call(`/api/sessions/${SESSION_ID}/reproject`, { method: 'POST' })
    ).json()) as ReprojectBody;
    expect(body.event_count).toBeGreaterThan(0);
    expect(body.turn_count).toBeGreaterThan(0);
  });

  it('404s an unindexed id, and GET on it is the terminator not a 405', async () => {
    const missing = await call('/api/sessions/no-such/reproject', { method: 'POST' });
    expect(missing.status).toBe(404);
    // Probed: hono has no route for GET here, so it reaches `app.all('/api/*')`.
    const wrongVerb = await call(`/api/sessions/${SESSION_ID}/reproject`);
    expect(wrongVerb.status).toBe(404);
    expect(await wrongVerb.json()).toEqual({ error: 'not found' });
  });
});

describe('8. POST /api/warm (spec:377-380)', () => {
  it('is 202 { queued }', async () => {
    const res = await call('/api/warm', { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { queued: number };
    expectKeys(body, ['queued']);
    expect(typeof body.queued).toBe('number');
  });
});

describe('9. GET /api/drift (spec:382-392)', () => {
  it('is the whole alarm shape, including the two keys the reader drops', async () => {
    const { status, body } = await getJson<DriftBody>('/api/drift');
    expect(status).toBe(200);
    expectKeys(body, [
      'projector_version',
      'schema_version',
      'harness_versions',
      'unknown_line_types',
      'unknown_block_types',
      'unknown_top_level_fields',
      'unjoined_tool_uses',
      'unresolved_spills',
      'sessions_with_drift',
    ]);

    expect(body.harness_versions).toEqual({ '2.2.0': 1 });
    expect(body.unknown_line_types).toEqual({ summary: 4 });
    // ★ spec:390 requires this by name, and `db/read.ts`'s `parseDrift` drops it.
    expect(body.unknown_top_level_fields).toEqual({ newField: 3 });
    expect(body.unjoined_tool_uses).toBe(1);

    expect(body.sessions_with_drift.length).toBe(1);
    expectKeys(body.sessions_with_drift[0], ['id', 'title', 'harness_version', 'counts']);
    // The per-session counts keep `sidecar_agent_id_mismatch`, which the detail
    // response's four-key `drift` has no room for.
    expect(body.sessions_with_drift[0]!.counts.sidecar_agent_id_mismatch).toBe(2);
  });
});

describe('10. GET /api/health (spec:394-396)', () => {
  it('is the nine-key health shape', async () => {
    const { status, body } = await getJson<HealthBody>('/api/health');
    expect(status).toBe(200);
    expectKeys(body, [
      'ok',
      'projects_root',
      'index_built_at',
      'files_indexed',
      'sessions_indexed',
      'sessions_projected',
      'db_bytes',
      'schema_version',
      'projector_version',
    ]);
    expect(body.ok).toBe(true);
    expect(body.sessions_indexed).toBe(3);
    expect(body.db_bytes).toBeGreaterThan(0);
    // `files_indexed` lives only in the sweep's in-memory report; null beats a
    // fabricated count when no sweep is wired.
    expect(body.files_indexed).toBeNull();
  });

  it('sessions_projected is the exact complement of the search denominator', async () => {
    const health = (await getJson<HealthBody>('/api/health')).body;
    const search = (await getJson<SearchBody>('/api/search?q=parser')).body;
    expect(health.sessions_projected + search.unprojected_count).toBe(health.sessions_indexed);
  });

  it('reports files_indexed from the sweep when one is wired', async () => {
    const withSweep = buildApiApp({
      db,
      env: fileEnv(),
      token: TOKEN,
      uiDir: join(sandbox.root, 'no-such-ui'),
      sweep: {
        tick: () => {
          throw new Error('unused');
        },
        wave1: () => {
          throw new Error('unused');
        },
        wave2: () => {
          throw new Error('unused');
        },
        report: () => ({ ...emptyReport(), walked: 42 }),
        close: () => undefined,
      },
    });
    const res = await withSweep.request('/api/health', {
      headers: { Host: 'localhost', [TOKEN_HEADER]: TOKEN },
    });
    expect(((await res.json()) as HealthBody).files_indexed).toBe(42);
  });
});
