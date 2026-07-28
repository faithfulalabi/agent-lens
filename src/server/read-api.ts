// The five read endpoints (Task 5.0) — the entire read surface of the product,
// which every Phase 5/6/7 view is built on:
//
//   GET /api/sessions?from&to&project&limit&offset
//   GET /api/sessions/:id                          -> SessionDetail
//   GET /api/sessions/:id/spans[?trace=:traceId]   -> Page<Span>
//   GET /api/traces/:id/messages                   -> Page<Message>
//   GET /api/payloads/:id[?range=start-end]        -> PayloadSlice
//
// **Zero SQL lives here.** Every query is a call into `src/db/reads.ts`, which
// is what keeps `db/index.ts:15`'s "the ONLY module that touches SQL" true.
// Same handler-thin split as `ingest.ts:1-5`, and the param guards are small
// exported pure functions in the hand-rolled style of `isValidEnvelopeShape`
// (`ingest.ts:126-137`) — the repo has no validation library and gains none here.
//
// **`GET /api/traces/:id/messages` returns an EMPTY PAGE against real ingest
// data, and that is expected, not a defect.** Its designated writer is Task 3.2
// (Merge Policy + Messages Projection); `insertMessage` (`db/index.ts:266-272`)
// has no production caller today, so until 3.2 lands the only thing that puts
// rows in `messages` is `src/db/seed.ts`. Do not "fix" the empty response.
//
// **The `/api/*` JSON-404 terminator is deliberately NOT registered here.** It
// is exported as `jsonNotFound` and registered by `buildApp` AFTER every real
// `/api` route. Hono matches in registration order, so an `app.all('/api/*')`
// placed at this insertion point would shadow `/api/stream` and 404 it (probed
// on hono 4.12.31), breaking `__tests__/ingest.test.ts:63-101`.

import type { Context, Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import {
  readPayloadMeta,
  readPayloadSlice,
  readSession,
  readSessions,
  readSessionSpans,
  readSessionTraces,
  readTraceMessages,
  sessionExists,
  traceBelongsToSession,
  traceExists,
  type PageParams,
  type SessionListQuery,
} from '../db/reads.js';
import type { PayloadSlice, SessionDetail } from '../shared/api.js';

/** Page size when `?limit` is absent. */
export const DEFAULT_LIMIT = 100;

/**
 * Ceiling on `?limit`, applied as a CLAMP rather than a rejection. The headroom
 * is deliberate: Task 5.3 pulls a whole 5,000-span trace in one request.
 */
export const MAX_LIMIT = 10_000;

/** A non-negative base-10 integer, and nothing else — no signs, no exponents. */
const NON_NEGATIVE_INT = /^\d+$/;

/** `start-end`, `end` omissible (`1024-`). Anything else is malformed. */
const RANGE = /^(\d+)-(\d*)$/;

/** An ISO-8601 date, optionally with a time part. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

/** Parsed value, or the `{error}` string that becomes a 400 body. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A byte range as the client asked for it, before clamping. `end` inclusive. */
export interface RawRange {
  start: number;
  /** Absent means "to the end of the payload". */
  end?: number;
}

/** Inclusive byte interval actually served, plus the slice length. */
export interface ClampedRange {
  start: number;
  end: number;
  length: number;
}

/**
 * `?limit`/`?offset`. Absent -> defaults. Present -> must be a non-negative
 * base-10 integer; `-1`, `1.5`, `1e3` and `abc` are all 400s. `limit = 0` is a
 * 400 (an empty page is what `offset` past the end is for), while
 * `limit > MAX_LIMIT` clamps — a cap, not a rejection.
 */
export function parsePageParams(query: Record<string, string>): ParseResult<PageParams> {
  let limit = DEFAULT_LIMIT;
  const rawLimit = query.limit;
  if (rawLimit !== undefined && rawLimit !== '') {
    if (!NON_NEGATIVE_INT.test(rawLimit)) return { ok: false, error: 'invalid limit' };
    const parsed = Number(rawLimit);
    if (parsed === 0) return { ok: false, error: 'invalid limit' };
    limit = Math.min(parsed, MAX_LIMIT);
  }

  let offset = 0;
  const rawOffset = query.offset;
  if (rawOffset !== undefined && rawOffset !== '') {
    if (!NON_NEGATIVE_INT.test(rawOffset)) return { ok: false, error: 'invalid offset' };
    offset = Number(rawOffset);
    // `limit` is clamped to MAX_LIMIT, so only `offset` can carry an unbounded
    // value into the query — and `node:sqlite` throws `datatype mismatch` when
    // binding a non-safe integer (probed), which AC5 wants as a 400, not a 500.
    if (!Number.isSafeInteger(offset)) return { ok: false, error: 'invalid offset' };
  }

  return { ok: true, value: { limit, offset } };
}

/**
 * `?from`/`?to` — inclusive ISO-8601 bounds on `sessions.started_at`. Compared
 * lexicographically in SQL, which is exactly right for ISO-8601 UTC strings.
 * A `to` that precedes `from` is rejected rather than silently returning
 * nothing, so a swapped-argument bug surfaces at the boundary.
 */
export function parseTimeRange(
  query: Record<string, string>,
): ParseResult<{ from?: string; to?: string }> {
  const value: { from?: string; to?: string } = {};
  for (const key of ['from', 'to'] as const) {
    const raw = query[key];
    if (raw === undefined || raw === '') continue;
    if (!ISO_DATE.test(raw) || Number.isNaN(Date.parse(raw))) {
      return { ok: false, error: `invalid ${key}` };
    }
    value[key] = raw;
  }
  if (value.from !== undefined && value.to !== undefined && value.to < value.from) {
    return { ok: false, error: 'invalid time range' };
  }
  return { ok: true, value };
}

/**
 * `?range=<start>-<end>`, byte offsets over the UTF-8 encoding, `end` INCLUSIVE
 * (RFC 9110 convention) and omissible. Absent -> the whole payload.
 *
 * A negative start is malformed, not out-of-bounds: SQLite's `substr` would
 * silently reinterpret it as an offset from the END, so it must never reach the
 * query. `5-2` is malformed for the same reason — an inverted interval is a
 * caller bug, not something to clamp into silence.
 */
export function parseRange(raw: string | undefined): ParseResult<RawRange | undefined> {
  if (raw === undefined || raw === '') return { ok: true, value: undefined };
  const match = RANGE.exec(raw);
  if (match === null) return { ok: false, error: 'invalid range' };
  const start = Number(match[1]);
  if (match[2] === '') return { ok: true, value: { start } };
  const end = Number(match[2]);
  if (end < start) return { ok: false, error: 'invalid range' };
  return { ok: true, value: { start, end } };
}

/**
 * Fit a requested range onto a payload of `byteSize` bytes: `start` into
 * `[0, byteSize]`, `end` into `[start - 1, byteSize - 1]`. An out-of-bounds
 * request therefore clamps to an empty or truncated slice and still returns
 * 200 (AC4) rather than throwing.
 */
export function clampRange(range: RawRange | undefined, byteSize: number): ClampedRange {
  const start = Math.min(range?.start ?? 0, byteSize);
  const requestedEnd = range?.end ?? byteSize - 1;
  const end = Math.max(start - 1, Math.min(requestedEnd, byteSize - 1));
  return { start, end, length: end - start + 1 };
}

/**
 * The `/api/*` terminator: an unmatched API path is a JSON 404, never HTML.
 *
 * Exported so `buildApp` can register it AFTER every real `/api` route —
 * see the module header for why it cannot live inside `registerReadApi`. It
 * also pre-empts Task 5.1b's SPA `app.get('*')` fallback, which would otherwise
 * answer `/api/nope` with an HTML page.
 */
export function jsonNotFound(c: Context): Response {
  return c.json({ error: 'not found' }, 404);
}

/**
 * Register the five read routes. Exactly five registrations, no catch-alls, so
 * this is safe to call from any insertion point in `buildApp`.
 */
export function registerReadApi(app: Hono, db: DatabaseSync): void {
  // Session list: one indexed pass over precomputed rollup columns. The Flow 3
  // "aggregate at write time" bet is cashed here — no join, no COUNT.
  app.get('/api/sessions', (c) => {
    const query = c.req.query();
    const page = parsePageParams(query);
    if (!page.ok) return c.json({ error: page.error }, 400);
    const time = parseTimeRange(query);
    if (!time.ok) return c.json({ error: time.error }, 400);

    const filter: SessionListQuery = { ...page.value, ...time.value };
    const project = query.project;
    if (project !== undefined && project !== '') filter.project = project;
    return c.json(readSessions(db, filter));
  });

  app.get('/api/sessions/:id', (c) => {
    const page = parsePageParams(c.req.query());
    if (!page.ok) return c.json({ error: page.error }, 400);

    const id = c.req.param('id');
    const session = readSession(db, id);
    if (session === undefined) return c.json({ error: 'not found' }, 404);

    const detail: SessionDetail = {
      session,
      traces: readSessionTraces(db, id, page.value),
    };
    return c.json(detail);
  });

  // Span rows for tree building — payload REFS only, never payload bodies.
  // `?trace=` is optional: present narrows to that trace, absent returns the
  // whole session. A trace id that belongs to a different session is a
  // RESOLUTION failure (404), not a malformed param (400).
  app.get('/api/sessions/:id/spans', (c) => {
    const query = c.req.query();
    const page = parsePageParams(query);
    if (!page.ok) return c.json({ error: page.error }, 400);

    const id = c.req.param('id');
    if (!sessionExists(db, id)) return c.json({ error: 'not found' }, 404);

    const trace = query.trace;
    if (trace !== undefined && trace !== '') {
      if (!traceBelongsToSession(db, id, trace)) {
        return c.json({ error: 'not found' }, 404);
      }
      return c.json(readSessionSpans(db, id, { ...page.value, trace }));
    }
    return c.json(readSessionSpans(db, id, page.value));
  });

  // Empty against real ingest data until Task 3.2 ships the writer — expected,
  // not a defect. See the module header.
  app.get('/api/traces/:id/messages', (c) => {
    const page = parsePageParams(c.req.query());
    if (!page.ok) return c.json({ error: page.error }, 400);

    const id = c.req.param('id');
    if (!traceExists(db, id)) return c.json({ error: 'not found' }, 404);
    return c.json(readTraceMessages(db, id, page.value));
  });

  // Lazy payload fetch. Always 200 + JSON, never 206 and never raw bytes: the
  // UI needs the full `byte_size` alongside the slice to decide whether to
  // offer "Show full".
  app.get('/api/payloads/:id', (c) => {
    const range = parseRange(c.req.query('range'));
    if (!range.ok) return c.json({ error: range.error }, 400);

    const meta = readPayloadMeta(db, c.req.param('id'));
    if (meta === undefined) return c.json({ error: 'not found' }, 404);

    const clamped = clampRange(range.value, meta.byte_size);
    const bytes = readPayloadSlice(db, meta.id, clamped.start, clamped.length);
    const slice: PayloadSlice = {
      id: meta.id,
      byte_size: meta.byte_size,
      range: { start: clamped.start, end: clamped.end },
      // Non-fatal decode: a range may split a multi-byte sequence, and U+FFFD at
      // the seam is the honest answer. Task 5.4's "Show full" refetches unranged.
      content: new TextDecoder().decode(bytes ?? new Uint8Array()),
      truncated: clamped.length < meta.byte_size,
    };
    if (meta.mime_hint !== undefined) slice.mime_hint = meta.mime_hint;
    return c.json(slice);
  });
}
