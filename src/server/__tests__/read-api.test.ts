// Task 5.0 HTTP-level tests for the five read endpoints, plus the two wiring
// guards that keep them honest: the `/api/*` JSON-404 terminator must not
// shadow `/api/stream` (Test 17), and `app.onError` must JSON-ify a 500 on an
// API path (Test 18).
//
// Every test boots a server over a PRE-SEEDED data dir — seeding happens before
// `startServer`, because WAL permits one writer. The inactivity sweep is
// disabled: the fixture's timestamps are historical, so a sweep would flip the
// deliberately-live session to `interrupted` and stamp `ended_at` onto the rows
// the null-strip assertions depend on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Message, Session, Span } from '../../shared/entities.js';
import type { Page, PayloadSlice, SessionDetail } from '../../shared/api.js';
import { seedFixtureDb, type SeedManifest } from '../../db/seed.js';
import { freshDb } from '../../capture/__tests__/fixtures.js';
import { buildApp } from '../app.js';
import { Broadcaster } from '../sse.js';
import { clampRange, parsePageParams, parseRange, parseTimeRange } from '../read-api.js';
import {
  bootTestServer,
  cleanupDir,
  makeTestEnvelope,
  TOKEN_HEADER,
  type TestServer,
} from './helpers.js';

let server: TestServer;
let manifest: SeedManifest;

const SEED = { sessions: 3, tracesPerSession: 2, spansPerTrace: 3 };

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-read-'));
  manifest = seedFixtureDb(dataDir, SEED);
  server = await bootTestServer({ dataDir, sweepIntervalMs: 0 });
});

afterEach(async () => {
  await server.close();
  cleanupDir(server.dataDir);
  vi.restoreAllMocks();
});

/** GET with the server token, returning status, headers, and the raw body. */
async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ res: Response; text: string }> {
  const res = await fetch(server.url(path), {
    headers: { [TOKEN_HEADER]: server.token, ...headers },
  });
  return { res, text: await res.text() };
}

/** GET and parse as JSON, asserting a 200 first. */
async function getJson<T>(path: string): Promise<T> {
  const { res, text } = await get(path);
  expect(res.status, `${path} -> ${text}`).toBe(200);
  return JSON.parse(text) as T;
}

/** Read one SSE frame of the given type (mirrors `ingest.test.ts:31-60`). */
async function readOneEvent(
  res: Response,
  eventType: string,
  timeoutMs = 1000,
): Promise<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!frame.includes(`event: ${eventType}`)) continue;
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (dataLine) return JSON.parse(dataLine.slice('data:'.length).trim());
      }
    }
    throw new Error(`no "${eventType}" frame within ${timeoutMs}ms`);
  } finally {
    await reader.cancel();
  }
}

// --- The pure param guards, unit-tested directly ---------------------------
// Same treatment `isValidEnvelopeShape` gets: the guards are exported precisely
// so their edge cases can be pinned without an HTTP round-trip.

describe('param guards', () => {
  it('parsePageParams defaults, clamps, and rejects', () => {
    expect(parsePageParams({})).toEqual({ ok: true, value: { limit: 100, offset: 0 } });
    expect(parsePageParams({ limit: '5', offset: '10' })).toEqual({
      ok: true,
      value: { limit: 5, offset: 10 },
    });
    expect(parsePageParams({ limit: '999999' })).toEqual({
      ok: true,
      value: { limit: 10_000, offset: 0 },
    });
    expect(parsePageParams({ limit: '0' }).ok).toBe(false);
    expect(parsePageParams({ offset: '-3' }).ok).toBe(false);
  });

  it('parseRange treats an inverted or negative interval as malformed', () => {
    expect(parseRange(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseRange('3-7')).toEqual({ ok: true, value: { start: 3, end: 7 } });
    expect(parseRange('1024-')).toEqual({ ok: true, value: { start: 1024 } });
    expect(parseRange('7-3').ok).toBe(false);
    expect(parseRange('-1-3').ok).toBe(false);
  });

  it('parseTimeRange rejects non-ISO values and an inverted window', () => {
    expect(parseTimeRange({ from: '2026-07-01' }).ok).toBe(true);
    expect(parseTimeRange({ from: '2026-07-01T00:00:00.000Z' }).ok).toBe(true);
    expect(parseTimeRange({ from: '2026-13-45' }).ok).toBe(false);
    expect(parseTimeRange({ to: 'yesterday' }).ok).toBe(false);
    expect(parseTimeRange({ from: '2026-07-09', to: '2026-07-08' })).toEqual({
      ok: false,
      error: 'invalid time range',
    });
  });

  it('clampRange fits any request onto the payload, never inverting length', () => {
    expect(clampRange(undefined, 10)).toEqual({ start: 0, end: 9, length: 10 });
    expect(clampRange({ start: 2, end: 4 }, 10)).toEqual({ start: 2, end: 4, length: 3 });
    // End past the payload truncates; start past it collapses to an empty slice.
    expect(clampRange({ start: 2, end: 999 }, 10)).toEqual({ start: 2, end: 9, length: 8 });
    expect(clampRange({ start: 99, end: 200 }, 10)).toEqual({
      start: 10,
      end: 9,
      length: 0,
    });
    expect(clampRange({ start: 5 }, 10)).toEqual({ start: 5, end: 9, length: 5 });
  });
});

// --- Test 1: shapes verbatim ----------------------------------------------

describe('AC1 — Test 1: entity shapes come back verbatim from a seeded DB', () => {
  it('serves Session rows with every entity key and no null-valued optionals', async () => {
    const page = await getJson<Page<Session>>('/api/sessions');
    expect(page.items).toHaveLength(3);

    const complete = page.items.find((s) => s.id === 'seed-s0')!;
    expect(complete).toMatchObject({
      id: 'seed-s0',
      harness: 'claude-code',
      status: 'complete',
      capture_mode: 'full',
      git_branch: 'main',
    });
    expect(complete.trace_count).toBe(2);
    expect(complete.total_tokens).toBeGreaterThan(0);
    expect(typeof complete.est_cost).toBe('number');

    const live = page.items.find((s) => s.id === manifest.liveSessionId)!;
    for (const key of ['ended_at', 'git_branch', 'model', 'transcript_path']) {
      expect(Object.hasOwn(live, key), `${key} should be absent, not null`).toBe(false);
    }
  });

  it('serves Trace rows nested in SessionDetail with rollups populated', async () => {
    const detail = await getJson<SessionDetail>('/api/sessions/seed-s0');
    expect(detail.session.id).toBe('seed-s0');
    const trace = detail.traces.items[0]!;
    expect(trace).toMatchObject({
      id: 'seed-s0:1',
      session_id: 'seed-s0',
      turn_seq: 1,
      trigger: 'user_prompt',
      status: 'complete',
    });
    expect(trace.total_tokens).toBeGreaterThan(0);
    expect(trace.tool_call_count).toBe(2);
    expect(typeof trace.duration_ms).toBe('number');
  });

  it('serves Span rows with parsed tags/attrs and payload REFS only', async () => {
    const page = await getJson<Page<Span>>('/api/sessions/seed-s0/spans');
    const root = page.items.find((s) => s.id === 'seed-s0:1:sp0')!;

    expect(Array.isArray(root.tags)).toBe(true);
    expect(root.tags).toContain('seeded');
    expect(root.attrs).toMatchObject({ seed: true });
    expect(typeof root.input_payload_id).toBe('string');
    // Refs only — no blob bodies on the span list.
    expect(Object.hasOwn(root, 'content')).toBe(false);
    expect(Object.hasOwn(root, 'parent_span_id')).toBe(false);

    const child = page.items.find((s) => s.id === 'seed-s0:1:sp1')!;
    expect(child.parent_span_id).toBe('seed-s0:1:sp0');
    expect(child.span_type).toBe('tool_call');
  });

  it('serves Message rows for the thread view', async () => {
    const page = await getJson<Page<Message>>('/api/traces/seed-s0:1/messages');
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      trace_id: 'seed-s0:1',
      seq: 1,
      role: 'user',
    });
    expect(Object.hasOwn(page.items[0]!, 'span_id')).toBe(false);
    expect(page.items[1]!.span_id).toBe('seed-s0:1:sp0');
  });
});

// --- Test 1b: the null-strip mapper, over the wire -------------------------

describe('AC1 — Test 1b: a NULL est_cost is key-absent over the wire', () => {
  it('never serializes est_cost as null or 0 for an unpriced span', async () => {
    const page = await getJson<Page<Span>>('/api/sessions/seed-s0/spans');
    const unpriced = page.items.find((s) => s.id === manifest.unpricedSpanId)!;

    expect(unpriced).toBeDefined();
    expect(Object.hasOwn(unpriced, 'est_cost')).toBe(false);
    expect(unpriced.est_cost).not.toBe(null);
    expect(unpriced.est_cost).not.toBe(0);
    expect(unpriced.tokens_in).toBeGreaterThan(0);
  });

  it('omits ended_at and output_payload_id on a still-running span', async () => {
    const page = await getJson<Page<Span>>(`/api/sessions/${manifest.liveSessionId}/spans`);
    const open = page.items.find((s) => s.id === manifest.openSpanId)!;
    expect(Object.hasOwn(open, 'ended_at')).toBe(false);
    expect(Object.hasOwn(open, 'output_payload_id')).toBe(false);
    expect(open.status).toBe('running');
  });
});

// --- Tests 4/5: one pagination scheme, four lists --------------------------

/** The four paginated lists: three top-level `Page<T>`, one nested in a detail. */
const LISTS: {
  name: string;
  path: () => string;
  pick: (body: unknown) => Page<unknown>;
}[] = [
  {
    name: 'GET /api/sessions',
    path: () => '/api/sessions',
    pick: (body) => body as Page<unknown>,
  },
  {
    name: 'GET /api/sessions/:id/spans',
    path: () => '/api/sessions/seed-s0/spans',
    pick: (body) => body as Page<unknown>,
  },
  {
    name: 'GET /api/traces/:id/messages',
    path: () => '/api/traces/seed-s0:1/messages',
    pick: (body) => body as Page<unknown>,
  },
  {
    name: 'GET /api/sessions/:id (.traces)',
    path: () => '/api/sessions/seed-s0',
    pick: (body) => (body as SessionDetail).traces as unknown as Page<unknown>,
  },
];

describe('AC3 — Test 4: every list uses the same limit/offset Page envelope', () => {
  it.each(LISTS)('$name', async ({ path, pick }) => {
    const full = pick(await getJson(`${path()}?limit=1000`));
    expect(Object.keys(full).sort()).toEqual(['has_more', 'items', 'limit', 'offset']);
    expect(full.limit).toBe(1000);
    expect(full.offset).toBe(0);
    expect(full.has_more).toBe(false);

    const total = full.items.length;
    expect(total).toBeGreaterThan(1);

    // has_more is correct exactly at the boundary page.
    const partial = pick(await getJson(`${path()}?limit=${total - 1}`));
    expect(partial.items).toHaveLength(total - 1);
    expect(partial.has_more).toBe(true);

    const exact = pick(await getJson(`${path()}?limit=${total}`));
    expect(exact.items).toHaveLength(total);
    expect(exact.has_more).toBe(false);

    // Offset walks the list without overlap.
    const second = pick(await getJson(`${path()}?limit=1&offset=1`));
    expect(second.items).toHaveLength(1);
    expect(second.offset).toBe(1);
    expect(second.items[0]).toEqual(full.items[1]);
  });
});

describe('AC3 — Test 5: a page past the end is an empty page, not an error', () => {
  it.each(LISTS)('$name', async ({ path, pick }) => {
    const total = pick(await getJson(`${path()}?limit=1000`)).items.length;
    const offset = total * 10;

    const { res, text } = await get(`${path()}?limit=10&offset=${offset}`);
    expect(res.status).toBe(200);
    expect(pick(JSON.parse(text))).toEqual({
      items: [],
      limit: 10,
      offset,
      has_more: false,
    });
  });
});

// --- Test 6: malformed paging params ---------------------------------------

describe('AC3/AC5 — Test 6: bad limit/offset are 400s, not 500s or silent defaults', () => {
  const BAD: [string, string][] = [
    ['limit=0', 'invalid limit'],
    ['limit=-1', 'invalid limit'],
    ['limit=abc', 'invalid limit'],
    ['limit=1.5', 'invalid limit'],
    ['limit=1e3', 'invalid limit'],
    ['offset=-1', 'invalid offset'],
    ['offset=abc', 'invalid offset'],
    ['offset=1.5', 'invalid offset'],
    // Digits, but past Number.MAX_SAFE_INTEGER: `node:sqlite` throws
    // `datatype mismatch` on binding, which must surface as 400, not 500.
    ['offset=99999999999999999999', 'invalid offset'],
  ];

  it.each(BAD)('rejects ?%s with 400 %s', async (query, error) => {
    for (const list of LISTS) {
      const { res, text } = await get(`${list.path()}?${query}`);
      expect(res.status, `${list.name}?${query}`).toBe(400);
      expect(JSON.parse(text)).toEqual({ error });
    }
  });

  it('clamps an over-large limit instead of rejecting it', async () => {
    const page = await getJson<Page<Session>>('/api/sessions?limit=999999');
    expect(page.limit).toBe(10_000);
  });
});

// --- Tests 7/8/10: payload range -------------------------------------------

describe('AC4 — Tests 7/8/10: payload slices, clamping, and malformed ranges', () => {
  it('returns the whole payload with no ?range', async () => {
    const slice = await getJson<PayloadSlice>(`/api/payloads/${manifest.unicodePayloadId}`);
    expect(slice.id).toBe(manifest.unicodePayloadId);
    expect(slice.truncated).toBe(false);
    expect(slice.range).toEqual({ start: 0, end: slice.byte_size - 1 });
    expect(Buffer.byteLength(slice.content, 'utf8')).toBe(slice.byte_size);
    expect(slice.mime_hint).toBe('application/json');
  });

  it('Test 7 — ?range returns the requested slice with the FULL byte_size', async () => {
    const whole = await getJson<PayloadSlice>(`/api/payloads/${manifest.unicodePayloadId}`);
    const slice = await getJson<PayloadSlice>(
      `/api/payloads/${manifest.unicodePayloadId}?range=0-4`,
    );

    expect(slice.byte_size).toBe(whole.byte_size);
    expect(slice.range).toEqual({ start: 0, end: 4 });
    expect(Buffer.byteLength(slice.content, 'utf8')).toBe(5);
    expect(slice.truncated).toBe(true);
    expect(whole.content.startsWith(slice.content)).toBe(true);
  });

  it('Test 7 — an open-ended ?range=n- runs to the end', async () => {
    const whole = await getJson<PayloadSlice>(`/api/payloads/${manifest.unicodePayloadId}`);
    const slice = await getJson<PayloadSlice>(
      `/api/payloads/${manifest.unicodePayloadId}?range=2-`,
    );
    expect(slice.range).toEqual({ start: 2, end: whole.byte_size - 1 });
    expect(slice.truncated).toBe(true);
  });

  it('Test 8 — an end past the payload truncates and still returns 200', async () => {
    const { res, text } = await get(`/api/payloads/${manifest.unicodePayloadId}?range=0-999999`);
    expect(res.status).toBe(200);
    const slice = JSON.parse(text) as PayloadSlice;
    expect(slice.range).toEqual({ start: 0, end: slice.byte_size - 1 });
    expect(slice.truncated).toBe(false);
  });

  it('Test 8 — a start past the payload clamps to an empty slice, 200', async () => {
    const { res, text } = await get(
      `/api/payloads/${manifest.unicodePayloadId}?range=999999-1000000`,
    );
    expect(res.status).toBe(200);
    const slice = JSON.parse(text) as PayloadSlice;
    expect(slice.content).toBe('');
    expect(slice.range.start).toBe(slice.byte_size);
    expect(slice.range.end).toBe(slice.byte_size - 1);
    expect(slice.truncated).toBe(true);
  });

  it.each(['abc', '5-2', '-1-3', '1-2-3', '1-2-', '', 'x-y'])(
    'Test 10 — a malformed ?range=%s is 400, never 500',
    async (range) => {
      const { res, text } = await get(
        `/api/payloads/${manifest.unicodePayloadId}?range=${encodeURIComponent(range)}`,
      );
      if (range === '') {
        // An empty value means "no range at all", not a malformed one.
        expect(res.status).toBe(200);
        return;
      }
      expect(res.status, `range=${range} -> ${text}`).toBe(400);
      expect(JSON.parse(text)).toEqual({ error: 'invalid range' });
    },
  );
});

// --- Tests 11/13: 404s and 400s --------------------------------------------

describe('AC5 — Test 11: unknown ids are JSON 404s, never HTML and never 500', () => {
  it.each([
    '/api/sessions/nope',
    '/api/sessions/nope/spans',
    '/api/traces/nope/messages',
    '/api/payloads/nope',
  ])('%s', async (path) => {
    const { res, text } = await get(path);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(text.startsWith('<')).toBe(false);
    expect(JSON.parse(text)).toEqual({ error: 'not found' });
  });
});

describe('AC5 — Test 13: malformed from/to are 400; a foreign ?trace= is 404', () => {
  it.each([
    ['from=not-a-date', 'invalid from'],
    ['from=2026', 'invalid from'],
    ['to=07%2F01%2F2026', 'invalid to'],
    ['from=2026-07-02&to=2026-07-01', 'invalid time range'],
  ])('rejects ?%s with 400', async (query, error) => {
    const { res, text } = await get(`/api/sessions?${query}`);
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error });
  });

  it('accepts a well-formed from/to window', async () => {
    const page = await getJson<Page<Session>>(
      '/api/sessions?from=2026-07-01T00:00:00.000Z&to=2026-07-01T23:59:59.999Z',
    );
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('filters by project', async () => {
    const project = manifest.projects[0]!;
    const page = await getJson<Page<Session>>(
      `/api/sessions?project=${encodeURIComponent(project)}`,
    );
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((s) => s.project_path === project)).toBe(true);
  });

  it('404s a ?trace= that names a trace in a DIFFERENT session', async () => {
    // Well-formed and real, just not this session's — a resolution failure.
    const { res, text } = await get('/api/sessions/seed-s0/spans?trace=seed-s1:1');
    expect(res.status).toBe(404);
    expect(JSON.parse(text)).toEqual({ error: 'not found' });
  });
});

// --- Tests 13b/13c: the optional ?trace= filter -----------------------------

describe('AC1/AC3 — Tests 13b/13c: ?trace= is optional on the span list', () => {
  it('13b — with ?trace=, returns only that trace’s spans', async () => {
    const page = await getJson<Page<Span>>('/api/sessions/seed-s0/spans?trace=seed-s0:1');
    expect(page.items).toHaveLength(SEED.spansPerTrace);
    expect(page.items.every((s) => s.trace_id === 'seed-s0:1')).toBe(true);
  });

  it('13c — without ?trace=, returns every span in the session', async () => {
    const page = await getJson<Page<Span>>('/api/sessions/seed-s0/spans');
    expect(page.items).toHaveLength(SEED.tracesPerSession * SEED.spansPerTrace);
    expect(new Set(page.items.map((s) => s.trace_id)).size).toBe(SEED.tracesPerSession);
    expect(Object.keys(page).sort()).toEqual(['has_more', 'items', 'limit', 'offset']);
  });
});

// --- Test 14: auth ----------------------------------------------------------

describe('AC6 — Test 14: every read endpoint 401s without a valid token', () => {
  const PATHS = [
    '/api/sessions',
    '/api/sessions/seed-s0',
    '/api/sessions/seed-s0/spans',
    '/api/traces/seed-s0:1/messages',
    '/api/payloads/anything',
  ];

  it.each(PATHS)('%s rejects a missing token', async (path) => {
    const res = await fetch(server.url(path));
    expect(res.status).toBe(401);
  });

  it.each(PATHS)('%s rejects a wrong token', async (path) => {
    const res = await fetch(server.url(path), { headers: { [TOKEN_HEADER]: 'nope' } });
    expect(res.status).toBe(401);
  });
});

// --- Test 15: the AC7 SQL boundary -----------------------------------------

describe('AC7 — Test 15: read-api.ts contains no SQL', () => {
  const source = readFileSync(new URL('../read-api.ts', import.meta.url), 'utf8');

  /** Source with block and line comments removed. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  /** Every string literal — backtick, single- AND double-quoted. */
  function stringLiterals(text: string): string[] {
    const pattern = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
    return text.match(pattern) ?? [];
  }

  it('has no SQL in any string literal, in any quote style', () => {
    // Single quotes are the repo's dominant SQL style, so a backtick-only scan
    // would miss `db.prepare('SELECT id FROM sessions')` entirely.
    const sql =
      /\b(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|FROM\s+(sessions|traces|spans|messages|payloads))\b/i;
    const offenders = stringLiterals(code).filter((literal) => sql.test(literal));
    expect(offenders).toEqual([]);
  });

  it('the scan actually catches SQL (guard against a vacuous assertion)', () => {
    const sql =
      /\b(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|FROM\s+(sessions|traces|spans|messages|payloads))\b/i;
    for (const violation of [
      "db.prepare('SELECT id FROM sessions')",
      'db.prepare("DELETE FROM payloads WHERE id = ?")',
      'db.prepare(`UPDATE spans SET model = ?`)',
    ]) {
      expect(stringLiterals(violation).some((l) => sql.test(l))).toBe(true);
    }
  });

  it('imports node:sqlite for TYPES only', () => {
    const imports = [
      ...source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'node:sqlite';$/gm),
    ];
    expect(imports).toHaveLength(1);
    expect(imports[0]![1]).toBe('type ');
    expect(imports[0]![2]!.trim()).toBe('DatabaseSync');
  });
});

// --- Tests 12/17/18: wiring guards -----------------------------------------

/**
 * Headers for a `buildApp(...).request(...)` call. A bare `Request` carries no
 * `host` header, and `hostGuard` (`app.ts:40`) 403s that before any route runs.
 */
const MOUNTED_HEADERS = { [TOKEN_HEADER]: 'tok', host: 'localhost' };

describe('AC5 — Test 12: an unmatched /api path is JSON 404 even under a SPA wildcard', () => {
  let db: DatabaseSync;
  afterEach(() => db.close());

  it('answers /api/nope with JSON while /session/x still gets the HTML fallback', async () => {
    db = freshDb();
    // Task 5.1b moved the SPA fallback INSIDE `buildApp`, where it is now the
    // last route in the app — so this test can no longer register its own
    // wildcard afterwards (it would be shadowed and silently prove nothing;
    // `static-serving.test.ts` pins that one-way door). It asserts against
    // `buildApp`'s own fallback instead. `uiDir` is the file-level server's
    // fake bundle, so nothing here resolves the real, gitignored `ui/dist`.
    const app = buildApp({
      db,
      token: 'tok',
      broadcaster: new Broadcaster(),
      uiDir: server.uiDir,
    });

    const api = await app.request('/api/nope', { headers: MOUNTED_HEADERS });
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
    const body = await api.text();
    expect(body.startsWith('<')).toBe(false);
    expect(JSON.parse(body)).toEqual({ error: 'not found' });

    const spa = await app.request('/session/x', { headers: { host: 'localhost' } });
    expect(spa.status).toBe(200);
    expect(spa.headers.get('content-type')).toContain('text/html');
    expect(await spa.text()).toContain('<div id="root">');
  });
});

describe('AC5 — Test 17: the /api/* terminator does not shadow /api/stream', () => {
  it('still streams, and the other API routes still answer for themselves', async () => {
    const streamRes = await fetch(server.url('/api/stream'), {
      headers: { [TOKEN_HEADER]: server.token },
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

    // Do not wait on a heartbeat — the first one is 15s away (`app.ts:24`).
    // Drive a real event through instead, mirroring `ingest.test.ts:63-101`.
    const framePromise = readOneEvent(streamRes, 'raw_event');
    const envelope = makeTestEnvelope();
    const ingest = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toMatchObject({ inserted: true });
    expect((await framePromise).event_id).toBe(envelope.event_id);

    // The pre-existing routes answer for themselves, not with `{error:'not found'}`.
    const events = await get('/api/events');
    expect(events.res.status).toBe(200);
    expect(JSON.parse(events.text)).toHaveLength(1);

    const health = await get('/api/health');
    expect(health.res.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ processed: expect.any(Number) });
  });
});

describe('AC5 — Test 18: an uncaught throw on an /api path is a JSON 500', () => {
  it('never returns text/plain "Internal Server Error" under /api/', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exploding = {
      prepare: () => {
        throw new Error('boom');
      },
    } as unknown as DatabaseSync;

    // The throw must come from a REAL route: the terminator now lives inside
    // `buildApp`, so a route registered afterwards would be shadowed and answer
    // 404 without ever reaching `onError`.
    const app = buildApp({
      db: exploding,
      token: 'tok',
      broadcaster: new Broadcaster(),
      uiDir: server.uiDir,
    });
    const res = await app.request('/api/sessions', { headers: MOUNTED_HEADERS });

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = await res.text();
    expect(text).not.toBe('Internal Server Error');
    expect(text.startsWith('<')).toBe(false);
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
  });
});

/*
 * Task 5.2b, Test 8 — the server half of AC1a.
 *
 * The UI's own 300-row assertion renders a fixture; this one proves the server
 * will actually hand over 300 rows in one page, which is the half a component
 * test cannot reach. It lives here because this project owns the database.
 *
 * `?limit=1000` is not decoration: the route defaults to 100 and CLAMPS rather
 * than rejecting, so a request with no limit answers 200 with a third of the
 * data. That silent truncation is exactly what the client's own explicit
 * `LIST_LIMIT` exists to prevent, and this is where the default is pinned.
 *
 * One trace and one span per session: the session count is what is under test,
 * and the rest is a thousand rows of unrelated seeding.
 */
describe('AC1 — Task 5.2b Test 8: one page holds hundreds of sessions', () => {
  const SCALE = 300;

  it('returns all 300 seeded sessions under an explicit limit, and truncates without one', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-scale-'));
    seedFixtureDb(dataDir, { sessions: SCALE, tracesPerSession: 1, spansPerTrace: 1 });
    const scaled = await bootTestServer({ dataDir, sweepIntervalMs: 0 });

    try {
      const headers = { [TOKEN_HEADER]: scaled.token };
      const res = await fetch(scaled.url(`/api/sessions?limit=${SCALE * 2}`), { headers });
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page<Session>;

      expect(page.items).toHaveLength(SCALE);
      expect(page.has_more).toBe(false);
      expect(new Set(page.items.map((s) => s.id)).size).toBe(SCALE);

      // Newest first, which is the order the session list renders without sorting.
      const startedAt = page.items.map((s) => s.started_at);
      expect([...startedAt].sort((a, b) => b.localeCompare(a))).toEqual(startedAt);

      const defaulted = await fetch(scaled.url('/api/sessions'), { headers });
      const capped = (await defaulted.json()) as Page<Session>;
      expect(
        capped.items.length,
        'the default limit is 100 and the server clamps rather than rejecting — ' +
          'a client that omits ?limit gets a quiet third of the data.',
      ).toBe(100);
      expect(capped.has_more).toBe(true);
    } finally {
      await scaled.close();
      cleanupDir(scaled.dataDir);
    }
  });
});
