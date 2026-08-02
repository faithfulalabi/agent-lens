// Reads: every line of the query API's SQL (Task 5.0). Sibling of `rollups.ts`
// and re-exported from `src/db/index.ts`, so the "`src/db` is the only SQL door"
// invariant holds literally — `src/server/read-api.ts` contains no SQL at all.
//
// **Three rules this file exists to enforce, all of them load-bearing:**
//
// 1. **Conditional predicate assembly, never `? IS NULL OR col = ?`.** The
//    null-guard idiom is the obvious way to build an optional filter and it
//    silently destroys the plan: probed, `WHERE (? IS NULL OR project_path = ?)`
//    yields one clean `SCAN sessions USING INDEX idx_sessions_started_at` row —
//    no temp b-tree, no subquery — so it *passes* a naive plan assertion while
//    never touching `idx_sessions_project_started`. Terms are pushed into a
//    `where[]`/`params[]` pair instead, which is why `buildSessionListSql` is
//    exported: the AC2 tests assert on the exact SQL text this produces.
//
// 2. **No `id` tiebreaker in the session list's `ORDER BY`.** Probed:
//    `ORDER BY started_at DESC, id DESC` injects `USE TEMP B-TREE FOR LAST TERM
//    OF ORDER BY`, breaking the single-indexed-pass guarantee AC2 encodes. The
//    accepted cost (founder ruling 2026-07-27): two sessions sharing an
//    identical-millisecond `started_at` have UNSPECIFIED relative order. That is
//    not a bug to be "fixed" by adding the tiebreaker back — fixing it properly
//    needs a `sessions(started_at DESC, id)` index, i.e. a migration.
//
// 3. **`null` becomes key-absent, never `null` and never `0`.** Every nullable
//    column reads back as `null`, but the entities declare `?: T`, which under
//    `strict` does not admit `null`. The repo's usual `as unknown as T[]` cast
//    would ship `null`s straight to the UI, so these mappers assign optional
//    keys conditionally. `spans.est_cost` is the sharp case: `null` means
//    *unpriced* (`rollups.ts:37-38` — "NULL for an unknown model, never 0"), and
//    coalescing it to `0` would silently report an unknown model as free.

import type { DatabaseSync } from 'node:sqlite';
import type {
  CaptureMode,
  Message,
  MessageRole,
  Session,
  SessionStatus,
  Span,
  SpanSource,
  SpanStatus,
  SpanType,
  Trace,
  TraceStatus,
  TraceTrigger,
} from '../shared/entities.js';
import type { Page } from '../shared/api.js';

/** A bound SQL parameter. Every read here binds only strings and numbers. */
type SqlParam = string | number;

/** One compiled statement plus its positional bindings. */
export interface SqlQuery {
  sql: string;
  params: SqlParam[];
}

/** Offset/limit paging, identical on all four lists. */
export interface PageParams {
  limit: number;
  offset: number;
}

/** `GET /api/sessions` filters, all optional, all conditionally assembled. */
export interface SessionListQuery extends PageParams {
  /** Inclusive lower bound on `started_at`. */
  from?: string;
  /** Inclusive upper bound on `started_at`. */
  to?: string;
  project?: string;
}

/** `GET /api/sessions/:id/spans` — `trace` is optional (founder ruling, OQ2). */
export interface SessionSpansQuery extends PageParams {
  trace?: string;
}

// Explicit column lists everywhere: migration 002 appended `tokens_cache_read`
// and `tokens_cache_write` via ALTER TABLE, so `SELECT *` column order no longer
// matches declaration order and a positional assumption would silently rot.

const SESSION_COLUMNS = `id, harness, project_path, git_branch, model, started_at,
  ended_at, status, capture_mode, transcript_path, total_tokens, tokens_in,
  tokens_out, tokens_cache_read, tokens_cache_write, est_cost, tool_call_count,
  error_count, trace_count`;

const TRACE_COLUMNS = `id, session_id, turn_seq, trigger, prompt_preview, started_at,
  ended_at, status, total_tokens, tokens_in, tokens_out, tokens_cache_read,
  tokens_cache_write, est_cost, duration_ms, tool_call_count, error_count`;

const SPAN_COLUMNS = `id, trace_id, parent_span_id, span_type, name, status, started_at,
  ended_at, input_payload_id, output_payload_id, model, tokens_in, tokens_out,
  tokens_cache_read, tokens_cache_write, est_cost, source, tags, attrs`;

const MESSAGE_COLUMNS = `id, trace_id, span_id, seq, role, payload_id`;

// --- Row shapes (what SQLite actually hands back) --------------------------

interface SessionRow {
  id: string;
  harness: string;
  project_path: string;
  git_branch: string | null;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  capture_mode: string;
  transcript_path: string | null;
  total_tokens: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  est_cost: number;
  tool_call_count: number;
  error_count: number;
  trace_count: number;
}

interface TraceRow {
  id: string;
  session_id: string;
  turn_seq: number;
  trigger: string;
  prompt_preview: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  total_tokens: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  est_cost: number;
  duration_ms: number;
  tool_call_count: number;
  error_count: number;
}

interface SpanRow {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  span_type: string;
  name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  input_payload_id: string | null;
  output_payload_id: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  est_cost: number | null;
  source: string;
  tags: string;
  attrs: string;
}

interface MessageRow {
  id: string;
  trace_id: string;
  span_id: string | null;
  seq: number;
  role: string;
  payload_id: string;
}

/** Payload metadata without the blob — enough to clamp a range request. */
export interface PayloadMeta {
  id: string;
  byte_size: number;
  mime_hint?: string;
}

// --- Row -> entity mappers (the null-strip boundary) -----------------------

/** `sessions` row -> `Session`, omitting the 4 nullable columns when NULL. */
export function toSession(row: SessionRow): Session {
  const session: Session = {
    id: row.id,
    harness: row.harness,
    project_path: row.project_path,
    started_at: row.started_at,
    status: row.status as SessionStatus,
    capture_mode: row.capture_mode as CaptureMode,
    total_tokens: row.total_tokens,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    tokens_cache_read: row.tokens_cache_read,
    tokens_cache_write: row.tokens_cache_write,
    est_cost: row.est_cost,
    tool_call_count: row.tool_call_count,
    error_count: row.error_count,
    trace_count: row.trace_count,
  };
  if (row.git_branch !== null) session.git_branch = row.git_branch;
  if (row.model !== null) session.model = row.model;
  if (row.ended_at !== null) session.ended_at = row.ended_at;
  if (row.transcript_path !== null) session.transcript_path = row.transcript_path;
  return session;
}

/** `traces` row -> `Trace`, omitting `ended_at` when NULL. */
export function toTrace(row: TraceRow): Trace {
  const trace: Trace = {
    id: row.id,
    session_id: row.session_id,
    turn_seq: row.turn_seq,
    trigger: row.trigger as TraceTrigger,
    prompt_preview: row.prompt_preview,
    started_at: row.started_at,
    status: row.status as TraceStatus,
    total_tokens: row.total_tokens,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    tokens_cache_read: row.tokens_cache_read,
    tokens_cache_write: row.tokens_cache_write,
    est_cost: row.est_cost,
    duration_ms: row.duration_ms,
    tool_call_count: row.tool_call_count,
    error_count: row.error_count,
  };
  if (row.ended_at !== null) trace.ended_at = row.ended_at;
  return trace;
}

/**
 * `spans` row -> `Span`: omits the 10 nullable columns when NULL and parses the
 * two JSON-in-TEXT columns. `tags`/`attrs` are TEXT holding JSON
 * (`001-initial-schema.ts:82-83`, written via `JSON.stringify`) while the entity
 * declares `string[]` / `Record<string, unknown>`, so a raw cast would ship
 * JSON strings to the UI. Read `tags` as a SET — `upsertSpan`'s union does not
 * preserve insertion order.
 */
export function toSpan(row: SpanRow): Span {
  const span: Span = {
    id: row.id,
    trace_id: row.trace_id,
    span_type: row.span_type as SpanType,
    name: row.name,
    status: row.status as SpanStatus,
    started_at: row.started_at,
    source: row.source as SpanSource,
    tags: JSON.parse(row.tags) as string[],
    attrs: JSON.parse(row.attrs) as Record<string, unknown>,
  };
  if (row.parent_span_id !== null) span.parent_span_id = row.parent_span_id;
  if (row.ended_at !== null) span.ended_at = row.ended_at;
  if (row.input_payload_id !== null) span.input_payload_id = row.input_payload_id;
  if (row.output_payload_id !== null) span.output_payload_id = row.output_payload_id;
  if (row.model !== null) span.model = row.model;
  if (row.tokens_in !== null) span.tokens_in = row.tokens_in;
  if (row.tokens_out !== null) span.tokens_out = row.tokens_out;
  if (row.tokens_cache_read !== null) span.tokens_cache_read = row.tokens_cache_read;
  if (row.tokens_cache_write !== null) span.tokens_cache_write = row.tokens_cache_write;
  // NOT coalesced to 0: NULL here means "unpriced", not "free".
  if (row.est_cost !== null) span.est_cost = row.est_cost;
  return span;
}

/** `messages` row -> `Message`, omitting `span_id` when NULL. */
export function toMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    trace_id: row.trace_id,
    seq: row.seq,
    role: row.role as MessageRole,
    payload_id: row.payload_id,
  };
  if (row.span_id !== null) message.span_id = row.span_id;
  return message;
}

// --- Paging ----------------------------------------------------------------

/**
 * Run a `LIMIT n+1` query and fold the probe row into `has_more`. Every list
 * goes through here, which is what makes AC3's "one scheme, applied
 * identically" true by construction rather than by convention.
 */
function pageOf<Row, T>(
  db: DatabaseSync,
  query: SqlQuery,
  map: (row: Row) => T,
  { limit, offset }: PageParams,
): Page<T> {
  const rows = db.prepare(query.sql).all(...query.params) as unknown as Row[];
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map(map),
    limit,
    offset,
    has_more: hasMore,
  };
}

/** The tail every list statement ends with. */
const PAGE_TAIL = ' LIMIT ? OFFSET ?';

/**
 * Bind {@link PAGE_TAIL}'s two params. Must be called AFTER every filter param
 * has been pushed — these are the statement's two trailing `?`s. The `+ 1` is
 * the `has_more` probe row that {@link pageOf} slices back off.
 */
function pushPageParams(params: SqlParam[], page: PageParams): void {
  params.push(page.limit + 1, page.offset);
}

// --- Sessions --------------------------------------------------------------

/**
 * The session-list statement: `sessions` alone, explicit columns, conditionally
 * assembled `WHERE`, `ORDER BY started_at DESC`. No join, no aggregate, no
 * subquery, no `id` tiebreaker — one indexed pass, which is the whole point.
 *
 * Exported because the AC2 tests prepare `'EXPLAIN QUERY PLAN ' + sql` against
 * this exact text. Which index the planner picks depends on the filter shape:
 * `idx_sessions_started_at` with no `project`, `idx_sessions_project_started`
 * whenever `project` is present (the composite index is genuinely the better
 * one there) — both are a single indexed SEARCH/SCAN, which is what AC2 asks.
 */
export function buildSessionListSql(query: SessionListQuery): SqlQuery {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (query.project !== undefined) {
    where.push('project_path = ?');
    params.push(query.project);
  }
  if (query.from !== undefined) {
    where.push('started_at >= ?');
    params.push(query.from);
  }
  if (query.to !== undefined) {
    where.push('started_at <= ?');
    params.push(query.to);
  }
  const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  const sql =
    `SELECT ${SESSION_COLUMNS} FROM sessions${clause}` +
    ` ORDER BY started_at DESC${PAGE_TAIL}`;
  pushPageParams(params, query);
  return { sql, params };
}

/** One page of the session list — precomputed rollup columns only. */
export function readSessions(
  db: DatabaseSync,
  query: SessionListQuery,
): Page<Session> {
  return pageOf<SessionRow, Session>(db, buildSessionListSql(query), toSession, query);
}

/** One session by id, or `undefined` if it does not exist. */
export function readSession(db: DatabaseSync, id: string): Session | undefined {
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined;
  return row === undefined ? undefined : toSession(row);
}

/** One page of a session's traces, oldest turn first. */
export function readSessionTraces(
  db: DatabaseSync,
  sessionId: string,
  page: PageParams,
): Page<Trace> {
  const params: SqlParam[] = [sessionId];
  const sql =
    `SELECT ${TRACE_COLUMNS} FROM traces WHERE session_id = ?` +
    ` ORDER BY turn_seq ASC${PAGE_TAIL}`;
  pushPageParams(params, page);
  return pageOf<TraceRow, Trace>(db, { sql, params }, toTrace, page);
}

/**
 * One trace by id, or `undefined` if it does not exist. The single-row sibling of
 * {@link readSessionTraces}, added for Task 6.1: a `trace_updated` delta must
 * carry the row as it stands AFTER the rollup flush, which only a re-read gives.
 */
export function readTrace(db: DatabaseSync, id: string): Trace | undefined {
  const row = db
    .prepare(`SELECT ${TRACE_COLUMNS} FROM traces WHERE id = ?`)
    .get(id) as TraceRow | undefined;
  return row === undefined ? undefined : toTrace(row);
}

// --- Spans -----------------------------------------------------------------

/**
 * The span-list statement, in its two shapes (founder ruling, OQ2):
 * `?trace=` present -> `WHERE trace_id = ?`, the clean
 * `SEARCH spans USING INDEX idx_spans_trace_started` path; absent -> every span
 * in the session via an indexed `IN (SELECT …)`. Same conditional assembly as
 * `buildSessionListSql`; never `? IS NULL OR col = ?`.
 *
 * The unfiltered shape does sort through a temp b-tree (spans from different
 * traces interleave in time). That is outside AC2, which scopes the
 * single-indexed-pass guarantee to the session list.
 */
export function buildSessionSpansSql(
  sessionId: string,
  query: SessionSpansQuery,
): SqlQuery {
  const params: SqlParam[] = [];
  let where: string;
  if (query.trace === undefined) {
    where = 'trace_id IN (SELECT id FROM traces WHERE session_id = ?)';
    params.push(sessionId);
  } else {
    where = 'trace_id = ?';
    params.push(query.trace);
  }
  const sql =
    `SELECT ${SPAN_COLUMNS} FROM spans WHERE ${where}` +
    ` ORDER BY started_at ASC${PAGE_TAIL}`;
  pushPageParams(params, query);
  return { sql, params };
}

/** One page of span rows for tree building — payload refs only, no blobs. */
export function readSessionSpans(
  db: DatabaseSync,
  sessionId: string,
  query: SessionSpansQuery,
): Page<Span> {
  return pageOf<SpanRow, Span>(
    db,
    buildSessionSpansSql(sessionId, query),
    toSpan,
    query,
  );
}

/**
 * One span by id, or `undefined` if it does not exist. The single-row sibling of
 * {@link readSessionSpans}, added for Task 6.1: `upsertSpan` merges in SQL, so
 * the post-merge row is knowable only by reading it back.
 */
export function readSpan(db: DatabaseSync, id: string): Span | undefined {
  const row = db
    .prepare(`SELECT ${SPAN_COLUMNS} FROM spans WHERE id = ?`)
    .get(id) as SpanRow | undefined;
  return row === undefined ? undefined : toSpan(row);
}

// --- Messages --------------------------------------------------------------

/** One page of a trace's thread-view messages, in sequence order. */
export function readTraceMessages(
  db: DatabaseSync,
  traceId: string,
  page: PageParams,
): Page<Message> {
  const params: SqlParam[] = [traceId];
  const sql =
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE trace_id = ?` +
    ` ORDER BY seq ASC${PAGE_TAIL}`;
  pushPageParams(params, page);
  return pageOf<MessageRow, Message>(db, { sql, params }, toMessage, page);
}

// --- Existence checks (what turns a bad path param into a 404) -------------

/** True if the session exists. */
export function sessionExists(db: DatabaseSync, sessionId: string): boolean {
  return (
    db.prepare('SELECT 1 AS hit FROM sessions WHERE id = ?').get(sessionId) !==
    undefined
  );
}

/** True if the trace exists. */
export function traceExists(db: DatabaseSync, traceId: string): boolean {
  return (
    db.prepare('SELECT 1 AS hit FROM traces WHERE id = ?').get(traceId) !== undefined
  );
}

/**
 * True if `traceId` names a trace *in this session*. A well-formed trace id
 * belonging to a different session is a resolution failure (404), not a
 * malformed param (400) — same class as an unknown `:id`.
 */
export function traceBelongsToSession(
  db: DatabaseSync,
  sessionId: string,
  traceId: string,
): boolean {
  return (
    db
      .prepare('SELECT 1 AS hit FROM traces WHERE id = ? AND session_id = ?')
      .get(traceId, sessionId) !== undefined
  );
}

// --- Payloads --------------------------------------------------------------

/** Payload metadata without the blob, or `undefined` if the id is unknown. */
export function readPayloadMeta(
  db: DatabaseSync,
  id: string,
): PayloadMeta | undefined {
  const row = db
    .prepare('SELECT id, byte_size, mime_hint FROM payloads WHERE id = ?')
    .get(id) as { id: string; byte_size: number; mime_hint: string | null } | undefined;
  if (row === undefined) return undefined;
  const meta: PayloadMeta = { id: row.id, byte_size: row.byte_size };
  if (row.mime_hint !== null) meta.mime_hint = row.mime_hint;
  return meta;
}

/**
 * `length` bytes of a payload starting at `start` (0-based), as raw bytes.
 *
 * `CAST(content AS BLOB)` is not decoration. `insertPayload` binds a JS *string*
 * into the BLOB-declared column (BLOB affinity is NONE), so the stored value has
 * text affinity: `length(content)` counts CHARACTERS (11 vs 12 bytes on
 * `{"héllo":1}`) and `substr(content, …)` slices characters. The cast forces
 * byte semantics, matching `byte_size`, which `insertPayload` computes with
 * `Buffer.byteLength(content, 'utf8')`.
 *
 * SQLite clamps `substr` natively — a start past the end yields an empty slice
 * and an over-long length truncates — so AC4's "clamps rather than throwing" is
 * free here. A NEGATIVE start is the exception: SQLite reinterprets it as
 * from-the-end, so the caller rejects it as malformed before reaching this.
 */
export function readPayloadSlice(
  db: DatabaseSync,
  id: string,
  start: number,
  length: number,
): Uint8Array | undefined {
  const row = db
    .prepare('SELECT substr(CAST(content AS BLOB), ?, ?) AS slice FROM payloads WHERE id = ?')
    .get(start + 1, length, id) as { slice: Uint8Array } | undefined;
  return row?.slice;
}
