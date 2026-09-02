// The v2 read API: ten routes, every param guard an exported pure function, and
// ZERO SQL — `src/db/read.ts` is the only door, the invariant `db/index.ts:18`
// states and `__tests__/sql-one-door.test.ts` enforces.
//
// ★ THE ROUTE OWNS THE FRESHNESS GATE. `db/read.ts` never projects — it opens no
// file — so `GET /api/sessions/:id` calls `ensureProjectedFold` BEFORE it reads,
// per `data-model-v2.md:295`. Nothing else calls it on the request path, so a
// route that skips it serves a stale projection with no way for anyone to tell.
//
// Guards return `ParseResult<T>`, ported deliberately from `read-api.ts:66`:
// the discriminated union is what makes "400 with a JSON body, never a 500 and
// never HTML" a TYPE rather than a convention. Nothing here imports that file —
// it is Task 4.5's to delete — so `jsonNotFound` is re-declared below.

import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import type { CorpusSweep } from '../corpus/watch.js';
import { ensureProjectedFold, fingerprint, type ProjectionOutcome } from '../db/freshness.js';
import {
  countUnprojected,
  readDriftRows,
  readEventContentRow,
  readEventCount,
  readEventPage,
  readHealthCounts,
  readMeta,
  readProjects,
  readSessionHeader,
  readSessionList,
  readTurns,
  searchEvents,
  type DriftRow,
  type EventContentRow,
  type ProjectionState,
  type SearchQuery,
  type SessionDetailHeader,
  type SessionListQuery,
  type SessionProjection,
  type SessionSort,
} from '../db/read.js';
import { deleteSessionProjection, projectSession, type ProjectionEnv } from '../db/write.js';
import type { StreamHub } from './stream.js';
import type { WarmQueue } from './warm.js';

/** Wiring the ten routes need. */
export interface ApiDeps {
  db: DatabaseSync;
  /**
   * ★ REQUIRED, never optional. `app.ts:28-33` made `deltas` optional so tests
   * would not break, and that is precisely how the freshness gate would stop
   * running with nobody noticing. A test that cannot supply an env is a test
   * that is not exercising the gate.
   */
  env: ProjectionEnv;
  /**
   * ★ REQUIRED, for the same reason `env` is. The stream route is the hub's only
   * mount point, and a hub the app can boot without is a hub that quietly stops
   * carrying frames.
   */
  hub: StreamHub;
  /**
   * ★ REQUIRED, for the same reason `env` and `hub` are. Route 8 is the queue's
   * only trigger, and a `/api/warm` the app can boot without is a 202 that
   * warms nothing.
   */
  warm: WarmQueue;
  /** The corpus sweep handle. `files_indexed` lives only in its in-memory report. */
  sweep?: CorpusSweep;
  /** Task 4.4's content resolver. Absent -> the `inline` limb only. */
  resolveContent?: ContentResolver;
}

/** Page size when `?limit` is absent, on the list and on search. */
export const DEFAULT_LIMIT = 50;

/** `GET /api/sessions/:id?limit=` default — a whole screen of events at once. */
export const EVENT_PAGE_LIMIT = 1000;

/** Ceiling on `?limit`, applied as a CLAMP rather than a rejection. */
export const MAX_LIMIT = 10_000;

/** A non-negative base-10 integer, and nothing else — no signs, no exponents. */
const NON_NEGATIVE_INT = /^\d+$/;

/** `start-end`, `end` omissible (`1024-`). Anything else is malformed. */
const RANGE = /^(\d+)-(\d*)$/;

/** Parsed value, or the `{error}` string that becomes a 400 body. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface PageParams {
  limit: number;
  offset: number;
}

/** A byte range as the client asked for it, before clamping. `end` inclusive. */
export interface RawRange {
  start: number;
  /** Absent means "to the end of the field". */
  end?: number;
}

/** Inclusive byte interval actually served, plus the slice length. */
export interface ClampedRange {
  start: number;
  end: number;
  length: number;
}

export type ContentField = 'text' | 'input';

// --- Guards ----------------------------------------------------------------

/**
 * `?limit`/`?offset`. Absent -> `fallbackLimit`. Present -> a non-negative
 * base-10 integer; `-1`, `1.5`, `1e3` and `abc` are all 400s. `limit = 0` is a
 * 400 (an empty page is what `offset` past the end is for), while
 * `limit > MAX_LIMIT` clamps — a cap, not a rejection.
 */
export function parsePageParams(
  query: Record<string, string>,
  fallbackLimit = DEFAULT_LIMIT,
): ParseResult<PageParams> {
  let limit = fallbackLimit;
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
    // `limit` is clamped, so only `offset` can carry an unbounded value into the
    // query — and `node:sqlite` throws `datatype mismatch` binding a non-safe
    // integer, which AC3 wants as a 400, not a 500.
    if (!Number.isSafeInteger(offset)) return { ok: false, error: 'invalid offset' };
  }

  return { ok: true, value: { limit, offset } };
}

/** `?from_seq` — the event cursor. Absent -> 0, the start of the session. */
export function parseFromSeq(raw: string | undefined): ParseResult<number> {
  if (raw === undefined || raw === '') return { ok: true, value: 0 };
  if (!NON_NEGATIVE_INT.test(raw)) return { ok: false, error: 'invalid from_seq' };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { ok: false, error: 'invalid from_seq' };
  return { ok: true, value };
}

const SORTS: readonly SessionSort[] = ['recent', 'cost', 'tokens', 'errors'];

/**
 * `?sort`. Absent -> `recent`, the only one that rides an index. Validated here
 * so an unknown key never reaches `buildSessionListSql`, whose own throw
 * (`read.ts:325`) would surface as a 500 instead of a 400.
 */
export function parseSort(raw: string | undefined): ParseResult<SessionSort> {
  if (raw === undefined || raw === '') return { ok: true, value: 'recent' };
  const sort = SORTS.find((known) => known === raw);
  return sort === undefined ? { ok: false, error: 'invalid sort' } : { ok: true, value: sort };
}

const FIELDS: readonly ContentField[] = ['text', 'input'];

/** `?field=text|input`. Absent -> `text`, the output half every viewer opens. */
export function parseField(raw: string | undefined): ParseResult<ContentField> {
  if (raw === undefined || raw === '') return { ok: true, value: 'text' };
  const field = FIELDS.find((known) => known === raw);
  return field === undefined ? { ok: false, error: 'invalid field' } : { ok: true, value: field };
}

/**
 * `?range=<start>-<end>`, byte offsets, `end` INCLUSIVE (RFC 9110) and
 * omissible. Absent -> the whole field.
 *
 * A negative start is malformed, not out-of-bounds, and `5-2` is malformed for
 * the same reason: an inverted interval is a caller bug, not something to clamp
 * into silence.
 */
export function parseRange(raw: string | undefined): ParseResult<RawRange | undefined> {
  if (raw === undefined || raw === '') return { ok: true, value: undefined };
  const match = RANGE.exec(raw);
  if (match === null) return { ok: false, error: 'invalid range' };
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return { ok: false, error: 'invalid range' };
  if (match[2] === '') return { ok: true, value: { start } };
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end)) return { ok: false, error: 'invalid range' };
  if (end < start) return { ok: false, error: 'invalid range' };
  return { ok: true, value: { start, end } };
}

/**
 * Fit a requested range onto `byteSize` bytes: `start` into `[0, byteSize]`,
 * `end` into `[start - 1, byteSize - 1]`. Out of bounds clamps to an empty or
 * truncated slice and still returns 200, never a throw.
 */
export function clampRange(range: RawRange | undefined, byteSize: number): ClampedRange {
  const start = Math.min(range?.start ?? 0, byteSize);
  const requestedEnd = range?.end ?? byteSize - 1;
  const end = Math.max(start - 1, Math.min(requestedEnd, byteSize - 1));
  return { start, end, length: end - start + 1 };
}

/**
 * `?q` is required and non-empty; `?session` scopes; `?limit` pages. `?offset` is
 * validated and then ignored — search has no pagination (`data-model-v2.md:363`).
 *
 * NUL is rejected because it is the one input `searchEvents`' phrase fallback
 * cannot rescue: SQLite truncates the bound string at NUL, losing the closing
 * quote, so both arms throw and the user gets a 500 for text they typed.
 */
export function parseSearchQuery(query: Record<string, string>): ParseResult<SearchQuery> {
  const q = query.q;
  if (q === undefined || q === '' || q.includes('\0')) return { ok: false, error: 'invalid q' };
  const page = parsePageParams(query);
  if (!page.ok) return page;
  const value: SearchQuery = { q, limit: page.value.limit };
  if (query.session !== undefined && query.session !== '') value.session = query.session;
  return { ok: true, value };
}

/**
 * How recently a session must have been active to render as live.
 *
 * ponytail: CEILING — a constant here because `src/config.ts` (spec:412-414,
 * which the spec gives `LIVE_BACKOFF_MS`) does not exist and no task creates it.
 * Upgrade path: move this there when that file lands.
 */
export const LIVE_WINDOW_MS = 60_000;

/**
 * `live` is stamped by the server, never a column (`data-model-v2.md:278`).
 *
 * Mirrored into the browser by Task 6.2 at `ui/src/lib/live.ts`, which names
 * this pair back: a list row patched in place from a `session_changed` frame
 * has to re-decide its own badge, and `ui/` cannot import from `src/server/`.
 */
export function isLive(last_activity_at: string, now: number): boolean {
  const at = Date.parse(last_activity_at);
  return !Number.isNaN(at) && now - at < LIVE_WINDOW_MS;
}

// --- Mappers ---------------------------------------------------------------

/** The four values `sessions.projection_state` actually holds (`read.ts:96`). */
const PROJECTION_STATES: readonly ProjectionState[] = ['none', 'ready', 'failed', 'empty'];

const ARCHIVE_UNREADABLE = 'archive unreadable: the projection could not be verified';

/**
 * Restate the stored projection state against what the gate just saw.
 *
 * ★ The `'failed'` limb is the whole point. `foldArchive` answering `undefined`
 * makes the gate report `'failed'` BEFORE any write, so the column can still
 * read `'ready'` for a session whose bytes are gone — exactly the silent
 * staleness the gate exists to prevent. The surviving turns and events are still
 * served, labelled: blanking them would discard content the user can still read,
 * and `data-model-v2.md:340` already makes "present but unverifiable" a normal
 * labelled state rather than an error.
 *
 * ⚠️ SPEC DEVIATION, recorded rather than papered over. `data-model-v2.md:303`
 * declares `state: 'ready'|'failed'`; the column, `db/read.ts:96` and a probe of
 * a SUCCESSFUL gate call all carry four. Folding `'none'`/`'empty'` onto
 * `'ready'` would tell the browser a session is projected when it is not.
 */
export function toDetailProjection(
  header: SessionDetailHeader,
  outcome: ProjectionOutcome,
): SessionProjection {
  const stored = header.projection;
  if (outcome === 'failed') {
    return { ...stored, state: 'failed', error: stored.error ?? ARCHIVE_UNREADABLE };
  }
  // The column has a DDL default but no CHECK (`schema.ts:123`), so a value
  // outside the four is reachable and must never leave as one.
  return PROJECTION_STATES.includes(stored.state) ? stored : { ...stored, state: 'none' };
}

/** `drift_json` as `transcript/drift.ts:99` serializes it — a superset of `DriftCounts`. */
export interface RawDrift {
  unknown_line_types?: Record<string, number>;
  unknown_block_types?: Record<string, number>;
  unknown_top_level_fields?: Record<string, number>;
  unjoined_tool_uses?: number;
  unresolved_spills?: number;
  sidecar_agent_id_mismatch?: number;
}

export interface DriftSession {
  id: string;
  title: string | null;
  harness_version: string | null;
  counts: RawDrift;
}

/** The `/api/drift` body minus the two version stamps, which come from `meta`. */
export interface DriftReport {
  harness_versions: Record<string, number>;
  unknown_line_types: Record<string, number>;
  unknown_block_types: Record<string, number>;
  unknown_top_level_fields: Record<string, number>;
  unjoined_tool_uses: number;
  unresolved_spills: number;
  sessions_with_drift: DriftSession[];
}

/** A clean session serializes to exactly this (`transcript/drift.ts:90`). */
const NO_DRIFT = '{}';

function mergeBucket(into: Record<string, number>, from: Record<string, number> | undefined): void {
  for (const [key, n] of Object.entries(from ?? {})) into[key] = (into[key] ?? 0) + n;
}

/**
 * Tally every PROJECTED session by harness version, and every DRIFTING one into
 * the buckets, so a Claude Code release that changes the format shows up as one
 * number going 0 -> N against a population that says how big the check was.
 *
 * ★ THE AGGREGATION LIVES HERE, NOT IN THE READER. `data-model-v2.md:305-308`
 * pins the DETAIL response's `drift` at the four keys of `DriftCounts`, while
 * this report needs two more (`unknown_top_level_fields`,
 * `sidecar_agent_id_mismatch`). Widening `parseDrift` would change both, so the
 * extra keys are parsed off the raw text `readDriftRows` returns verbatim —
 * which `read.ts:206` already names as the design.
 *
 * ★ `harness_versions` IS THE CENSUS, NOT THE NUMERATOR. It counts every
 * projected session, clean or not, because `{}` is indistinguishable from a
 * broken endpoint and "0 drifting of 293 projected on 2.1.212" is not. The
 * 0 -> N signal lives in `sessions_with_drift`, which is `[]` on a clean corpus.
 * The cost is per-version attribution: a version's census number moves whether
 * or not it drifted, so `sessions_with_drift[].harness_version` is the only
 * carrier left for "which release did this".
 *
 * Clean rows leave at the writer's own marker, the same test `has_drift` uses,
 * so they reach no bucket and no scalar. Per-session `counts` carry the raw
 * object, extra keys included.
 *
 * ★ THE POPULATION COUNTS SIDECARS, unlike the session list. `readDriftRows`
 * omits the list's `TOP_LEVEL_ONLY` filter (`db/read.ts:614-621`) and keeps it:
 * a sub-agent transcript is a transcript, and drift in one is drift. So this is
 * a count of projected SESSIONS, not of conversations, and it will not match
 * `/api/sessions` — measured 272 of 293 ready rows are children.
 */
export function aggregateDrift(rows: readonly DriftRow[]): DriftReport {
  const report: DriftReport = {
    harness_versions: {},
    unknown_line_types: {},
    unknown_block_types: {},
    unknown_top_level_fields: {},
    unjoined_tool_uses: 0,
    unresolved_spills: 0,
    sessions_with_drift: [],
  };

  for (const row of rows) {
    const version = row.harness_version ?? 'unknown';
    report.harness_versions[version] = (report.harness_versions[version] ?? 0) + 1;

    if (row.drift_json === NO_DRIFT) continue;
    const counts = JSON.parse(row.drift_json) as RawDrift;
    mergeBucket(report.unknown_line_types, counts.unknown_line_types);
    mergeBucket(report.unknown_block_types, counts.unknown_block_types);
    mergeBucket(report.unknown_top_level_fields, counts.unknown_top_level_fields);
    report.unjoined_tool_uses += counts.unjoined_tool_uses ?? 0;
    report.unresolved_spills += counts.unresolved_spills ?? 0;
    report.sessions_with_drift.push({
      id: row.id,
      title: row.title,
      harness_version: row.harness_version,
      counts,
    });
  }
  return report;
}

/** What one content field can serve, and how big the whole field really is. */
export interface ResolvedContent {
  storage: string;
  /** What is servable. A head preview when `storage` is not `inline`. */
  content: string;
  /** The TRUE byte size of the field, which `content` may be a prefix of. */
  byte_size: number;
  spill_path?: string;
}

/** Task 4.4's `resolveContent`. It owns `line_ref`, `spill` and `missing`. */
export type ContentResolver = (row: EventContentRow, field: ContentField) => ResolvedContent;

/** The column half of a content answer — no file touched. */
function storedContent(row: EventContentRow, field: ContentField): ResolvedContent {
  const isText = field === 'text';
  const resolved: ResolvedContent = {
    storage: (isText ? row.output_storage : row.input_storage) ?? 'absent',
    content: (isText ? row.text : row.input) ?? '',
    byte_size: (isText ? row.text_bytes : row.input_bytes) ?? 0,
  };
  // Spilling is an OUTPUT concept: an event's `spill_path` says nothing about
  // its `input`, so it rides along only on the field it describes.
  if (isText && row.spill_path !== null) resolved.spill_path = row.spill_path;
  return resolved;
}

// --- Routes ----------------------------------------------------------------

/** The `/api/*` terminator: an unmatched API path is a JSON 404, never HTML. */
export function jsonNotFound(c: Context): Response {
  return c.json({ error: 'not found' }, 404);
}

/**
 * Register the ten routes. No catch-all among them, so the `/api/*` terminator
 * stays `buildApiApp`'s to place — see its header for why the position matters.
 */
export function registerApi(app: Hono, deps: ApiDeps): void {
  const { db, env } = deps;

  // 1. The list. One indexed pass over precomputed columns: no join, no
  //    aggregate, no file touched. `live` is stamped here, per spec:278.
  app.get('/api/sessions', (c) => {
    const query = c.req.query();
    const page = parsePageParams(query);
    if (!page.ok) return c.json({ error: page.error }, 400);
    const sort = parseSort(query.sort);
    if (!sort.ok) return c.json({ error: sort.error }, 400);

    const filter: SessionListQuery = { ...page.value, sort: sort.value };
    if (query.project !== undefined && query.project !== '') filter.project = query.project;
    if (query.q !== undefined && query.q !== '') filter.q = query.q;

    const listed = readSessionList(db, filter);
    const now = Date.now();
    return c.json({
      ...listed,
      items: listed.items.map((row) => ({ ...row, live: isLive(row.last_activity_at, now) })),
    });
  });

  // 2. The project list. Grouped on `project_path`, the same column the list
  //    filter matches on, so `?project=` can never name a group the list omits.
  app.get('/api/projects', (c) => c.json(readProjects(db)));

  // 3. ★ THE DETAIL ROUTE, AND THE GATE IS ITS FIRST ACT. Screens 2 and 3 and
  //    sub-agent expansion are all this one route (spec:294-331). The gate is
  //    called BEFORE any read and its fold is reused as the live-tail epoch, so
  //    the tree is walked once per request rather than twice.
  app.get('/api/sessions/:id', (c) => {
    const query = c.req.query();
    const page = parsePageParams(query, EVENT_PAGE_LIMIT);
    if (!page.ok) return c.json({ error: page.error }, 400);
    const from_seq = parseFromSeq(query.from_seq);
    if (!from_seq.ok) return c.json({ error: from_seq.error }, 400);

    const id = c.req.param('id');
    const gate = ensureProjectedFold(db, id, env);
    // Decided at the gate, before any read, so exactly one thing decides the 404.
    if (gate.outcome === 'unindexed') return jsonNotFound(c);

    const header = readSessionHeader(db, id);
    if (header === undefined) return jsonNotFound(c);

    const events = readEventPage(db, id, { from_seq: from_seq.value, limit: page.value.limit });
    return c.json({
      session: {
        ...header,
        live: isLive(header.last_activity_at, Date.now()),
        projection: toDetailProjection(header, gate.outcome),
      },
      turns: readTurns(db, id),
      events: events.items,
      next_seq: events.next_seq,
      has_more: events.has_more,
      // No fold means no bytes to take an epoch from. Empty is the honest answer
      // and it never equals a real epoch, so a client refetches rather than
      // trusting a stale one.
      fingerprint: gate.fold === undefined ? '' : fingerprint(gate.fold),
    });
  });

  // 4. The only second content request the client ever makes (spec:334-345).
  app.get('/api/events/:id/content', (c) => {
    const field = parseField(c.req.query('field'));
    if (!field.ok) return c.json({ error: field.error }, 400);
    const range = parseRange(c.req.query('range'));
    if (!range.ok) return c.json({ error: range.error }, 400);

    const row = readEventContentRow(db, c.req.param('id'));
    if (row === undefined) return jsonNotFound(c);

    const stored = storedContent(row, field.value);
    // `inline` and `absent` answer from the column alone, which is ~99% of rows
    // (spec:329-330). The rest need the archive, which is 4.4's resolver; until
    // it lands the honest answer is the stored preview labelled `missing` — a
    // NORMAL state the UI renders (spec:340), not an error.
    const resolved =
      stored.storage === 'inline' || stored.storage === 'absent'
        ? stored
        : (deps.resolveContent?.(row, field.value) ?? { ...stored, storage: 'missing' });

    const bytes = Buffer.from(resolved.content, 'utf8');
    const clamped = clampRange(range.value, bytes.length);
    const body: Record<string, unknown> = {
      id: row.id,
      field: field.value,
      storage: resolved.storage,
      byte_size: resolved.byte_size,
      range: { start: clamped.start, end: clamped.end },
      // Non-fatal decode: a range may split a multi-byte sequence, and U+FFFD at
      // the seam is the honest answer. An unranged refetch returns the whole field.
      content: bytes.subarray(clamped.start, clamped.start + clamped.length).toString('utf8'),
      truncated: clamped.length < resolved.byte_size,
    };
    if (resolved.spill_path !== undefined) body.spill_path = resolved.spill_path;
    return c.json(body);
  });

  // 5. Search. `?session=` scopes to one session; without it this covers every
  //    PROJECTED session, and `unprojected_count` is the honest denominator.
  app.get('/api/search', (c) => {
    const parsed = parseSearchQuery(c.req.query());
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    // No classifier here on purpose. `searchEvents` retries an unparseable `q`
    // as a literal phrase, so raw user text — `foo-bar`, `ENOENT:`, `*` — is
    // searched rather than blamed. What is left to throw is a real fault, and it
    // reaches `jsonErrorOnApiPaths` (`app.ts:18-28`) as a JSON 500.
    return c.json({
      items: searchEvents(db, parsed.value),
      scope: parsed.value.session === undefined ? 'projected' : 'session',
      unprojected_count: countUnprojected(db),
    });
  });

  // 6. THE ONE LIVE STREAM (spec:358-369, spec:534). Its POSITION between route 5
  //    and the `/api/*` terminator is load-bearing — a terminator registered
  //    above it 404s the SSE endpoint (probed) — so it stays exactly here.
  //
  //    The route is three lines because `stream.ts` owns everything: it attaches
  //    the client and PARKS, and the parked promise is resolved by `hub.drain()`
  //    at shutdown or by `onAbort` when the client leaves. Returning is what ends
  //    the response body, because hono's `run` closes the stream in its `finally`.
  //
  //    `streamSSE` takes TWO arguments and must keep taking two: a third
  //    `onError` makes hono emit `event: error`, and `error` is hono's name.
  //
  //    `?from_seq` is ACCEPTED AND IGNORED, deliberately. Task 6.2 deleted the
  //    client limb that appended it — no frame carries an `id:`, so the cursor
  //    it was built from could never be set — and honouring it would be the
  //    resume bookkeeping this design deletes anyway: whole-file reprojection
  //    makes a refetch cheap, so a reconnecting client simply takes the next
  //    `session_changed` frame and splices from the `from_seq` in its payload.
  //    Accept-and-ignore stays for any other client that sends one.
  app.get('/api/stream', (c) => streamSSE(c, (stream) => deps.hub.attach(stream)));

  // 7. Forced reprojection. Worst case in the whole corpus is 45 ms, so this is
  //    casual. The gate runs first for its fold; on a `'hit'` it changed nothing,
  //    so the rebuild is done here. On a miss the gate already rebuilt from the
  //    same bytes, and doing it twice would only cost.
  app.post('/api/sessions/:id/reproject', (c) => {
    const id = c.req.param('id');
    const started = Date.now();

    const gate = ensureProjectedFold(db, id, env);
    if (gate.outcome === 'unindexed') return jsonNotFound(c);
    if (gate.outcome === 'hit' && gate.fold !== undefined) {
      deleteSessionProjection(db, id);
      projectSession(db, id, env, gate.fold);
    }

    const header = readSessionHeader(db, id);
    if (header === undefined) return jsonNotFound(c);
    return c.json({
      session: { ...header, live: isLive(header.last_activity_at, Date.now()) },
      event_count: readEventCount(db, id),
      // The column the projection just stamped, so this is the same number the
      // list shows rather than a second, independently-drifting count.
      turn_count: header.turn_count,
      took_ms: Date.now() - started,
    });
  });

  // 8. Warm the whole corpus (spec:391-394). 202 + the count, and the queue
  //    behind it emits `warm_progress` over `/api/stream` until `done == total`.
  //
  //    ★ THE ATTRIBUTION HERE WAS STALE AND IS CORRECTED. This read "Task 6.1
  //    streams the frames… the background queue is 6.1's too" — 6.1 disclaimed
  //    both in writing (`stream.ts:36-42`) and shipped the name only. Task 7.4
  //    owns the queue, and `warm.ts` is it.
  //
  //    `start()` snapshots synchronously, before its first yield, so `queued` IS
  //    the run's `total` for the first POST rather than a second number that
  //    could disagree. A POST while a run is in flight starts nothing and
  //    reports the honest remaining count, so it cannot double-count.
  //
  //    `queued` is a SUPERSET of `/api/search`'s `unprojected_count`: it also
  //    counts version-stale rows, which are `projection_state = 'ready'` and so
  //    invisible to `countUnprojected` — the case nothing else re-warms. The
  //    body keeps exactly one key; `api-routes.test.ts:588` is set-equality.
  app.post('/api/warm', (c) => c.json({ queued: deps.warm.start() }, 202));

  // 9. THE DURABILITY ALARM (spec:382-392).
  app.get('/api/drift', (c) =>
    c.json({
      projector_version: readMeta(db, 'projector_version') ?? null,
      schema_version: readMeta(db, 'schema_version') ?? null,
      ...aggregateDrift(readDriftRows(db)),
    }),
  );

  // 10. Health. `files_indexed` has no store anywhere — the number lives only in
  //     the sweep's in-memory report (`watch.ts:65`) — so it is null when no
  //     sweep is wired, rather than a fabricated count.
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      projects_root: readMeta(db, 'projects_root') ?? null,
      index_built_at: readMeta(db, 'index_built_at') ?? null,
      files_indexed: deps.sweep?.report().walked ?? null,
      ...readHealthCounts(db),
      schema_version: readMeta(db, 'schema_version') ?? null,
      projector_version: readMeta(db, 'projector_version') ?? null,
    }),
  );
}
