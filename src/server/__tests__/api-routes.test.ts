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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { createArchiveReader } from '../../archive/read.js';
import { createContentEnv, createContentResolver } from '../../content/resolve.js';
import { createProjectionEnv } from '../../corpus/env.js';
import { foldArchive } from '../../db/freshness.js';
import { projectSession } from '../../db/write.js';
import {
  SESSION_ID,
  fileEnv,
  humanLine,
  openCache,
  seedIndexRow,
  seedProjection,
  seedSessionRow,
  spillMarker,
  toolCallLine,
  toolResultLine,
  writeTranscript,
} from '../../db/__tests__/fixtures/index.js';
import {
  EVENT_ROW_KEYS,
  SEARCH_HIT_KEYS,
  SESSION_ROW_KEYS as DB_SESSION_ROW_KEYS,
  TURN_ROW_KEYS,
} from '../../db/__tests__/fixtures/shapes.js';
import { createCorpusSweep, emptyReport } from '../../corpus/watch.js';
import { sealArchiveFile } from '../../archive/seal.js';
import type { Page } from '../../shared/api.js';
import {
  readEventArchivePath,
  readEventContentRow,
  type EventRow,
  type ProjectSummary,
  type SearchHit,
  type SessionDetailHeader,
  type SessionRow,
  type TurnRow,
} from '../../db/read.js';
import { TOKEN_HEADER } from '../../shared/index.js';
import { buildApiApp } from '../app.js';
import type { DriftReport } from '../api.js';
import { createStreamHub, type StreamHub } from '../stream.js';
import { createWarmQueue, type WarmQueue } from '../warm.js';
import { stubWarm } from './helpers.js';

const TOKEN = 'test-token';

/** `SessionRow` as served: the db row plus the server-stamped `live`. */
const SESSION_ROW_KEYS = [...DB_SESSION_ROW_KEYS, 'live'];

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
let hub: StreamHub;
/**
 * ★ HELD SO `afterEach` CAN CLOSE IT. The queue yields with `setImmediate`, so
 * a run left in flight wakes AFTER `db.close()` below and throws "database is
 * not open" from a timer callback — across the rest of this file, with nothing
 * able to stop it. `close()` sets the stop flag synchronously.
 */
let warm: WarmQueue;

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

  hub = createStreamHub();
  warm = createWarmQueue({ db, env: fileEnv(), hub });
  app = buildApiApp({
    db,
    env: fileEnv(),
    token: TOKEN,
    uiDir: join(sandbox.root, 'no-such-ui'),
    hub,
    warm,
  });
});

afterEach(async () => {
  // BEFORE `db.close()`: a warm run started by the POST tests is still draining,
  // and its next wake would otherwise land on a closed database.
  warm.close();
  // The stream test below leaves a parked client attached; the drain is what
  // unparks it and ends its body.
  await hub.drain();
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
    // Task 0.17: the model lists are arrays of ids on the wire, never pairs.
    for (const row of body.items) {
      for (const list of [row.models, row.sub_models]) {
        expect(Array.isArray(list)).toBe(true);
        expect(list.every((id) => typeof id === 'string')).toBe(true);
      }
    }
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
      hub: createStreamHub(),
      // Never POSTed through, so it starts nothing there is anything to close.
      warm: stubWarm(),
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

describe('F1 — an out-of-root spill path never serves its bytes', () => {
  const SENTINEL_BODY = 'SENTINEL-PRIVATE-KEY-BYTES';

  /** Exists, is readable, and lies outside every root agent-lens owns. */
  function plantSentinel(): string {
    const sentinel = join(sandbox.root, 'outside', 'id_rsa');
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, SENTINEL_BODY);
    return sentinel;
  }

  /** The app with the PRODUCTION content resolver — the wiring `start.ts` builds. */
  function guardedApp(): Hono {
    return buildApiApp({
      db,
      env: fileEnv(),
      token: TOKEN,
      uiDir: join(sandbox.root, 'no-such-ui'),
      hub: createStreamHub(),
      // Never POSTed through, so it starts nothing there is anything to close.
      warm: stubWarm(),
      resolveContent: createContentResolver(
        (id) => readEventArchivePath(db, id)?.archive_path,
        createContentEnv(createArchiveReader(), [sandbox.archiveRoot, sandbox.sourceRoot]),
      ),
    });
  }

  async function contentOf(
    app: Hono,
    eventId: string,
  ): Promise<{ status: number; body: ContentBody }> {
    const res = await app.request(`/api/events/${eventId}/content?field=text`, {
      headers: { Host: 'localhost', [TOKEN_HEADER]: TOKEN },
    });
    return { status: res.status, body: (await res.json()) as ContentBody };
  }

  it('a hostile transcript projects to missing, and the route serves the labelled degrade', async () => {
    const sentinel = plantSentinel();
    const hostileId = 'h05711e0-1111-4111-8111-h05711e00001';
    const archive = writeTranscript(join(sandbox.archiveRoot, `${hostileId}.jsonl`), [
      humanLine('read my key', '2026-08-14T09:10:00.000Z'),
      toolCallLine('toolu_evil', 'Bash', '2026-08-14T09:10:01.000Z'),
      toolResultLine('toolu_evil', spillMarker(sentinel), '2026-08-14T09:10:02.000Z', {
        toolUseResult: { persistedOutputPath: sentinel },
      }),
    ]);
    seedIndexRow(db, archive, { id: hostileId });
    projectSession(
      db,
      hostileId,
      createProjectionEnv(createArchiveReader(), {
        archiveRoot: sandbox.archiveRoot,
        transcriptRoot: sandbox.sourceRoot,
      }),
      foldArchive(archive)!,
    );

    const projected = readEventContentRow(db, 'toolu_evil');
    expect(projected?.output_storage).toBe('missing');
    expect(projected?.spill_path).toBeNull();

    const { status, body } = await contentOf(guardedApp(), 'toolu_evil');
    expect(status).toBe(200);
    expect(body.storage).toBe('missing');
    expect(JSON.stringify(body)).not.toContain(SENTINEL_BODY);
  });

  it('a row already holding an out-of-root path — projected before the fix — is refused at serve time', async () => {
    const sentinel = plantSentinel();
    db.prepare(`UPDATE events SET output_storage = 'spill', spill_path = ? WHERE id = ?`).run(
      sentinel,
      'ev-1',
    );

    const { status, body } = await contentOf(guardedApp(), 'ev-1');
    expect(status).toBe(200);
    expect(body.storage).toBe('missing');
    expect(body.content).toBe('');
    expect(JSON.stringify(body)).not.toContain(SENTINEL_BODY);
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

  it('400s a missing q — the one param error left on this route', async () => {
    expect((await call('/api/search')).status).toBe(400);
  });

  // ★ DELIBERATE BEHAVIOUR CHANGE, not a weakening. `%22` (a lone quote) and
  // `AND` were 400s: FTS5 could not parse them as expressions, and the route
  // classified that as the user's fault. They are ordinary typed text, so
  // `searchEvents` now retries them as a literal phrase and searches for them.
  // The hit COUNT is a property of the fixture, never of the route, so nothing
  // here asserts one — the key set is what stops a handler that returns `{}`
  // without querying from passing.
  it('200s raw user text that is not a legal FTS5 expression', async () => {
    for (const q of ['%22', 'AND', 'foo-bar', 'ENOENT%3A', 'src%2Fdb%2Fread.ts']) {
      const res = await call(`/api/search?q=${q}`);
      expect(res.status, q).toBe(200);
      expect(res.headers.get('content-type'), q).toContain('application/json');
      const body = (await res.json()) as SearchBody;
      expectKeys(body, ['items', 'scope', 'unprojected_count']);
      expect(Array.isArray(body.items), q).toBe(true);
    }
  });

  it('400s a q carrying NUL — the one input the phrase fallback cannot rescue', async () => {
    // SQLite truncates a bound string at NUL, so the quoted arm loses its closing
    // quote and BOTH arms throw. Without the guard in `parseSearchQuery` this
    // exact request is a 500 (`read.test.ts` holds the reader-level witness).
    const res = await call('/api/search?q=foo-bar%00tail');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid q' });
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
    // Cancel rather than read: the route PARKS on the hub and emits nothing by
    // itself, so a reader here would wait for a frame this test never sends.
    // The body ends on `hub.drain()`, which `afterEach` calls.
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

// `spec:377-380` was the wrong block — that is `POST .../reproject`'s response
// body. `POST /api/warm` is `:391-394`, and "missing or stale" is `:392`.
describe('8. POST /api/warm (spec:391-394)', () => {
  it('is 202 { queued }, counting the version-stale rows too', async () => {
    const res = await call('/api/warm', { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { queued: number };
    expectKeys(body, ['queued']);

    // ★ 3, AND ONLY VIA THE VERSION LIMB. `seedSessionRow` stamps
    // `projection_state: 'ready'` and `projector_version: 1` (`fixtures:377-379`),
    // so `SEEDED` and `DRIFTY` are `ready@1` against a projector at 5 —
    // `countUnprojected` cannot see either, and a predicate without
    // `OR projector_version IS NOT :version` returns only `SESSION_ID`. This is
    // the assertion that reds if the queue is narrowed to the search denominator.
    expect(body.queued).toBe(3);
    expect(body.queued).toBeGreaterThan(
      (await getJson<SearchBody>('/api/search?q=parser')).body.unprojected_count,
    );
  });

  it('a second POST mid-run never reports more than the first', async () => {
    // AC4 at the HTTP boundary. The behavioural half — exactly N frames, no
    // repeated `done` — is `warm.test.ts`, which owns a corpus that can project;
    // two of this file's three rows point at `/Users/dev/…` and never will.
    const first = (await (await call('/api/warm', { method: 'POST' })).json()) as {
      queued: number;
    };
    const second = await call('/api/warm', { method: 'POST' });
    expect(second.status).toBe(202);
    const body = (await second.json()) as { queued: number };
    expectKeys(body, ['queued']);
    expect(body.queued).toBeLessThanOrEqual(first.queued);
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

    // The CENSUS: both projected rows, clean and drifting. `SEEDED` defaults to
    // `2.1.212`/`ready`; the third seeded row goes through `upsertSessionIndex`,
    // which never sets `projection_state`, so `schema.ts`'s `'none'` default
    // keeps it out of `readDriftRows`' `WHERE projection_state = 'ready'`.
    expect(body.harness_versions).toEqual({ '2.1.212': 1, '2.2.0': 1 });
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

  it('★ raises an unrecognised line type 0 -> N and names the release that carried it', async () => {
    /*
     * AC2 at the route, in its OWN case rather than in the shared `beforeEach`:
     * a third drifting row there would move `harness_versions`,
     * `unknown_line_types`, `unjoined_tool_uses` and the length above, all of
     * which the case before this one has settled.
     *
     * ★ THE VERSION IS READ OFF `sessions_with_drift`, NEVER OFF THE CENSUS.
     * `harness_versions` counts clean rows too, so the same assertion there
     * would hold for a session that never drifted at all.
     */
    const before = await getJson<DriftBody>('/api/drift');
    expect(before.body.unknown_line_types['widget_frame']).toBeUndefined();

    seedSessionRow(db, {
      id: 'widget-1111-4111-8111-widget000001',
      harness_version: '2.3.0',
      drift_json: JSON.stringify({ unknown_line_types: { widget_frame: 1 } }),
    });

    const { body } = await getJson<DriftBody>('/api/drift');
    expect(body.unknown_line_types['widget_frame']).toBe(1);

    const carrier = body.sessions_with_drift.find((s) => s.harness_version === '2.3.0');
    expect(carrier?.counts.unknown_line_types).toEqual({ widget_frame: 1 });
    expect(body.harness_versions).toEqual({ '2.1.212': 1, '2.2.0': 1, '2.3.0': 1 });
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
      hub: createStreamHub(),
      warm: stubWarm(),
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

describe('task 7.5 — a token only in a spilled body is found by GET /api/search (AC1)', () => {
  it('is found after one real sweep tick, and not before — through a SEALED body', async () => {
    const session = 'cccccccc-7575-4757-8757-cccccccccccc';
    const dir = join(sandbox.archiveRoot, '-Users-dev-proj', session);
    writeTranscript(`${dir}.jsonl`, [
      humanLine('run the long build', '2026-08-14T10:00:00.000Z'),
      toolCallLine('toolu_spilled', 'Bash', '2026-08-14T10:00:01.000Z'),
      toolResultLine(
        'toolu_spilled',
        spillMarker('/gone/tool-results/spilled.txt'),
        '2026-08-14T10:00:02.000Z',
      ),
    ]);
    const body = join(dir, 'tool-results', 'spilled.txt');
    mkdirSync(dirname(body), { recursive: true });
    writeFileSync(body, 'line 1\nthe build log says zzspilltoken at the end\n');
    sealArchiveFile(body, sandbox.archiveRoot);
    expect(existsSync(`${body}.zst`)).toBe(true);

    const search = (): Promise<{ status: number; body: SearchBody }> =>
      getJson<SearchBody>('/api/search?q=zzspilltoken');
    expect((await search()).body.items).toEqual([]);

    const sweep = createCorpusSweep({
      db,
      dataDir: sandbox.dataDir,
      transcriptRoot: sandbox.sourceRoot,
    });
    try {
      sweep.tick();
    } finally {
      sweep.close();
    }

    const { status, body: page } = await search();
    expect(status).toBe(200);
    expect(page.items).toHaveLength(1);
    const [hit] = page.items;
    expectKeys(hit, SEARCH_HIT_KEYS);
    expect(hit).toMatchObject({
      event_id: 'toolu_spilled',
      kind: 'tool_call',
      session_id: session,
    });
    expect(hit!.snippet).toContain('<mark>zzspilltoken</mark>');
  });
});
