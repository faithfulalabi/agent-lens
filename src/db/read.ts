// Every `SELECT` the product runs. Sibling of `write.ts`, and the second half of
// the invariant `db/index.ts:18` states: no SQL exists outside `src/db/`.
// `__tests__/sql-one-door.test.ts` is what makes that a fact rather than a
// comment.
//
// **This module never projects.** `ensureProjectedFold` (`freshness.ts:163`) does
// `readdirSync` + `statSync` and can trigger a full reprojection; the caller
// must have run it before `readSessionHeader`/`readEventPage`/`readTurns`.
// `spec/data-model-v2.md:295` puts that gate on the route. Nothing here opens a
// file, and `fs-write-sites.test.ts` holds it to that.
//
// **Two rules carried over from `db/reads.ts:1-30`, one deliberately dropped:**
//
// 1. **Conditional predicate assembly, never a null-guard disjunction.** The
//    obvious way to write an optional filter destroys the plan invisibly:
//    measured, the null-guard form yields ONE clean plan row with no temp
//    b-tree, no join and byte-identical rows — so it passes every naive
//    assertion while never once touching `idx_sessions_project`. Terms are
//    pushed into a `where[]`/`params[]` pair instead, and the builders are
//    exported so `__tests__/read-plan.test.ts` can plan their exact text.
//
// 2. DROPPED. That file forbids an `id` tiebreaker because the plan-001 index
//    had no room for one. The v2 DDL puts `, id DESC` INTO both list indexes
//    (`schema.ts:134-137`), and the tiebreaker costs no temp b-tree.
//
// 3. **`null` becomes key-absent only where the wire shape declares the key
//    optional** — `agent_type`, `agent_description`, `spawn_depth`,
//    `parent_session_id` (`data-model-v2.md:302`). `est_cost` and `sub_est_cost`
//    are declared `number|null` and stay explicit `null`: NULL means UNPRICEABLE
//    model, never free (`write.ts:533-538`).
//
// `has_more` is a `LIMIT n+1` probe, never a `COUNT(*)`, and there is
// deliberately no `total`. The `sub_*` columns read back as their DDL defaults
// until task 4.1's second wave sums them; they are selected and returned as-is.

import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '../shared/api.js';

type SqlParam = string | number;

/** A statement and its bound parameters, in order. */
export interface SqlQuery {
  sql: string;
  params: SqlParam[];
}

// --- Wire shapes -----------------------------------------------------------
// `spec/data-model-v2.md:547-549` files these under a `shared/wire.ts` that no
// task creates. They live here until a browser-facing consumer needs them.

/** `GET /api/sessions` row. `live` is stamped by the server, never a column. */
export interface SessionRow {
  id: string;
  title: string | null;
  preview: string | null;
  project_path: string;
  git_branch: string | null;
  model: string | null;
  harness_version: string | null;
  started_at: string;
  last_activity_at: string;
  turn_count: number;
  tool_call_count: number;
  error_count: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  est_cost: number | null;
  agent_count: number;
  sub_tool_call_count: number;
  sub_error_count: number;
  sub_tokens_in: number;
  sub_tokens_out: number;
  sub_tokens_cache_read: number;
  sub_tokens_cache_write: number;
  sub_est_cost: number | null;
  rollup_state: 'own' | 'complete';
  has_drift: boolean;
}

export interface ProjectSummary {
  path: string;
  session_count: number;
  last_activity_at: string;
}

/** `drift_json`, parsed. Every key is omitted at zero by the writer. */
export interface DriftCounts {
  unknown_line_types: Record<string, number>;
  unknown_block_types: Record<string, number>;
  unjoined_tool_uses: number;
  unresolved_spills: number;
}

export type ProjectionState = 'none' | 'ready' | 'failed' | 'empty';

export interface SessionProjection {
  state: ProjectionState;
  error?: string;
  projector_version: number | null;
  projected_at: string | null;
  drift: DriftCounts;
}

/** `GET /api/sessions/:id` header. The four sidecar keys are absent on a parent. */
export interface SessionDetailHeader extends SessionRow {
  /** The session's cwd. Same value as `project_path`, under the wire's name. */
  cwd: string;
  agent_type?: string;
  agent_description?: string;
  spawn_depth?: number;
  parent_session_id?: string;
  projection: SessionProjection;
}

export interface TurnRow {
  id: string;
  seq: number;
  kind: string;
  /** The `Agent` call a `task_notification` turn answers, else null. */
  parent_event_id: string | null;
  title: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  duration_source: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  est_cost: number | null;
  tool_call_count: number;
  error_count: number;
  first_seq: number;
  last_seq: number;
}

export interface EventRow {
  id: string;
  turn_id: string;
  seq: number;
  kind: string;
  ts: string;
  request_id: string | null;
  block_index: number | null;
  name: string | null;
  status: string | null;
  duration_ms: number | null;
  duration_source: string | null;
  input: string | null;
  input_bytes: number | null;
  input_storage: string | null;
  text: string | null;
  text_bytes: number | null;
  output_storage: string | null;
  spill_path: string | null;
  spill_bytes: number | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  est_cost: number | null;
  child_session_id: string | null;
  agent_type: string | null;
  agent_status: string | null;
  raw_type: string;
  raw_subtype: string | null;
}

/**
 * The coordinates `GET /api/events/:id/content` dispatches on. No join, so the
 * archive path is a SECOND read — {@link readEventArchivePath}, keyed on
 * `session_id`.
 *
 * CORRECTED 2026-08-25 (task 4.4): this comment previously said the archive path
 * was "derivable from `session_id`". It is not. A top-level archive path is
 * `<root>/<slug>/<id>.jsonl` and the slug is not recoverable from the id;
 * `corpus/paths.ts` has `rowIdOf` and no inverse.
 */
export interface EventContentRow {
  id: string;
  session_id: string;
  block_index: number | null;
  input: string | null;
  input_bytes: number | null;
  input_storage: string | null;
  text: string | null;
  text_bytes: number | null;
  output_storage: string | null;
  spill_path: string | null;
  spill_bytes: number | null;
  src_offset: number;
  src_len: number;
  result_offset: number | null;
  result_len: number | null;
  result_block: number | null;
}

export interface SearchHit {
  session_id: string;
  session_title: string | null;
  project_path: string;
  turn_id: string;
  event_id: string;
  seq: number;
  kind: string;
  name: string | null;
  ts: string;
  snippet: string | null;
}

/** One projected session's raw drift text. The report aggregates in the mapper. */
export interface DriftRow {
  id: string;
  title: string | null;
  harness_version: string | null;
  drift_json: string;
}

// --- Pagination ------------------------------------------------------------

interface PageParams {
  limit: number;
  offset: number;
}

/** The tail every offset-paginated statement ends with. */
const PAGE_TAIL = ' LIMIT ? OFFSET ?';

/**
 * Bind {@link PAGE_TAIL}. Call AFTER every filter param — these are the two
 * trailing `?`s. The `+ 1` is the probe row {@link pageOf} slices back off.
 */
function pushPageParams(params: SqlParam[], page: PageParams): void {
  params.push(page.limit + 1, page.offset);
}

/** Run a `LIMIT n+1` query and fold the probe row into `has_more`. */
function pageOf<Row, T>(
  db: DatabaseSync,
  query: SqlQuery,
  map: (row: Row) => T,
  { limit, offset }: PageParams,
): Page<T> {
  const rows = db.prepare(query.sql).all(...query.params) as unknown as Row[];
  return {
    items: rows.slice(0, limit).map(map),
    limit,
    offset,
    has_more: rows.length > limit,
  };
}

// --- Session list ----------------------------------------------------------

export type SessionSort = 'recent' | 'cost' | 'tokens' | 'errors';

export interface SessionListQuery extends PageParams {
  project?: string;
  q?: string;
  sort?: SessionSort;
}

/**
 * Frozen: the ORDER BY expression is chosen by key, never interpolated from the
 * request string. Only `recent` rides an index — the DDL has no index on cost,
 * tokens or errors, so those three sort through a temp b-tree bounded by the
 * route's `MAX_LIMIT`. `tokens` is the non-cache total.
 */
const SORT_EXPRESSIONS: Readonly<Record<SessionSort, string>> = {
  recent: 'last_activity_at',
  cost: 'est_cost',
  tokens: '(tokens_in + tokens_out)',
  errors: 'error_count',
};

/**
 * The list columns, explicit. Never `SELECT *`: `schema.ts:8-10` records that a
 * silently dropped column is the exact failure this schema has already had.
 */
const SESSION_LIST_COLUMNS = `id, title, preview, project_path, git_branch, model, harness_version,
     started_at, last_activity_at, turn_count, tool_call_count, error_count,
     tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, est_cost,
     agent_count, sub_tool_call_count, sub_error_count, sub_tokens_in, sub_tokens_out,
     sub_tokens_cache_read, sub_tokens_cache_write, sub_est_cost, rollup_state, drift_json`;

/** Keeps sidecars — 65% of the corpus by bytes — out of every list scan. */
const TOP_LEVEL_ONLY = 'parent_session_id IS NULL';

/** A clean session serializes to exactly this (`transcript/drift.ts:90`). */
const NO_DRIFT = '{}';

const Q_PREDICATE =
  "(COALESCE(title,'') || ' ' || COALESCE(preview,'') || ' ' || project_path) LIKE ? ESCAPE '\\'";

/**
 * Wrap `q` for a contains-match, escaping the two LIKE wildcards and the escape
 * character itself. ASCII-only case folding, which is SQLite's default `LIKE`.
 */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

type SessionListDbRow = Omit<SessionRow, 'has_drift'> & { drift_json: string };

function toSessionRow(row: SessionListDbRow): SessionRow {
  const { drift_json, ...rest } = row;
  return { ...rest, has_drift: drift_json !== NO_DRIFT };
}

/**
 * The session-list statement: `sessions` alone, explicit columns, no join and no
 * aggregate. Exported because the plan tests prepare this exact text.
 */
export function buildSessionListSql(query: SessionListQuery): SqlQuery {
  const where: string[] = [TOP_LEVEL_ONLY];
  const params: SqlParam[] = [];
  if (query.project !== undefined) {
    where.push('project_path = ?');
    params.push(query.project);
  }
  if (query.q !== undefined) {
    where.push(Q_PREDICATE);
    params.push(likeContains(query.q));
  }
  // Looked up by key, never interpolated. The explicit throw is for the caller
  // that skipped validation: without it an unknown key reaches SQLite as
  // `ORDER BY undefined` and fails with a confusing "no such column".
  const sort = query.sort ?? 'recent';
  const order = SORT_EXPRESSIONS[sort];
  if (order === undefined) throw new Error(`unknown sort: ${String(sort)}`);

  const sql =
    `SELECT ${SESSION_LIST_COLUMNS} FROM sessions WHERE ${where.join(' AND ')}` +
    ` ORDER BY ${order} DESC, id DESC${PAGE_TAIL}`;
  pushPageParams(params, query);
  return { sql, params };
}

/** One page of the session list — precomputed columns only, no file touched. */
export function readSessionList(db: DatabaseSync, query: SessionListQuery): Page<SessionRow> {
  return pageOf<SessionListDbRow, SessionRow>(db, buildSessionListSql(query), toSessionRow, query);
}

// --- Projects --------------------------------------------------------------

/** `GET /api/projects`. The one list the spec specifies as an aggregate. */
export function buildProjectsSql(): SqlQuery {
  return {
    sql:
      `SELECT project_path AS path, count(*) AS session_count,` +
      ` max(last_activity_at) AS last_activity_at FROM sessions WHERE ${TOP_LEVEL_ONLY}` +
      ` GROUP BY project_path ORDER BY last_activity_at DESC, path ASC`,
    params: [],
  };
}

export function readProjects(db: DatabaseSync): { items: ProjectSummary[] } {
  const query = buildProjectsSql();
  return { items: db.prepare(query.sql).all() as unknown as ProjectSummary[] };
}

// --- Detail header ---------------------------------------------------------

type SessionHeaderDbRow = SessionListDbRow & {
  agent_type: string | null;
  agent_description: string | null;
  spawn_depth: number | null;
  parent_session_id: string | null;
  projection_state: ProjectionState;
  projection_error: string | null;
  projector_version: number | null;
  projected_at: string | null;
};

const SESSION_HEADER_COLUMNS = `${SESSION_LIST_COLUMNS},
     agent_type, agent_description, spawn_depth, parent_session_id,
     projection_state, projection_error, projector_version, projected_at`;

function parseDrift(text: string): DriftCounts {
  const raw = JSON.parse(text) as Partial<DriftCounts>;
  return {
    unknown_line_types: raw.unknown_line_types ?? {},
    unknown_block_types: raw.unknown_block_types ?? {},
    unjoined_tool_uses: raw.unjoined_tool_uses ?? 0,
    unresolved_spills: raw.unresolved_spills ?? 0,
  };
}

function toDetailHeader(row: SessionHeaderDbRow): SessionDetailHeader {
  const {
    agent_type,
    agent_description,
    spawn_depth,
    parent_session_id,
    projection_state,
    projection_error,
    projector_version,
    projected_at,
    ...listRow
  } = row;

  const header: SessionDetailHeader = {
    ...toSessionRow(listRow),
    cwd: listRow.project_path,
    projection: {
      state: projection_state,
      projector_version,
      projected_at,
      drift: parseDrift(listRow.drift_json),
    },
  };
  if (projection_error !== null) header.projection.error = projection_error;
  if (agent_type !== null) header.agent_type = agent_type;
  if (agent_description !== null) header.agent_description = agent_description;
  if (spawn_depth !== null) header.spawn_depth = spawn_depth;
  if (parent_session_id !== null) header.parent_session_id = parent_session_id;
  return header;
}

/** The detail header. `undefined` when no such session is indexed. */
export function readSessionHeader(db: DatabaseSync, id: string): SessionDetailHeader | undefined {
  const row = db
    .prepare(`SELECT ${SESSION_HEADER_COLUMNS} FROM sessions WHERE id = ?`)
    .get(id) as unknown as SessionHeaderDbRow | undefined;
  return row === undefined ? undefined : toDetailHeader(row);
}

// --- Turns -----------------------------------------------------------------

const TURN_COLUMNS = `id, seq, kind, parent_event_id, title, started_at, ended_at, duration_ms, duration_source,
     tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, est_cost,
     tool_call_count, error_count, first_seq, last_seq`;

/** Every turn, unpaginated: measured n=213 across 27 sessions. */
export function readTurns(db: DatabaseSync, session_id: string): TurnRow[] {
  return db
    .prepare(`SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? ORDER BY seq`)
    .all(session_id) as unknown as TurnRow[];
}

// --- Event page ------------------------------------------------------------

const EVENT_COLUMNS = `id, turn_id, seq, kind, ts, request_id, block_index, name, status,
     duration_ms, duration_source, input, input_bytes, input_storage,
     text, text_bytes, output_storage, spill_path, spill_bytes,
     model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, est_cost,
     child_session_id, agent_type, agent_status, raw_type, raw_subtype`;

export interface EventPageQuery {
  from_seq: number;
  limit: number;
}

/** Cursor-paginated by `seq`, not by offset: `next_seq` is the live-tail cursor. */
export interface EventPage {
  items: EventRow[];
  next_seq: number;
  has_more: boolean;
}

/** Exported for the plan test. `seq >= ?` is what reaches `idx_events_session_seq`. */
export function buildEventPageSql(session_id: string, query: EventPageQuery): SqlQuery {
  return {
    sql:
      `SELECT ${EVENT_COLUMNS} FROM events WHERE session_id = ? AND seq >= ?` +
      ` ORDER BY seq LIMIT ?`,
    params: [session_id, query.from_seq, query.limit + 1],
  };
}

export function readEventPage(
  db: DatabaseSync,
  session_id: string,
  query: EventPageQuery,
): EventPage {
  const built = buildEventPageSql(session_id, query);
  const rows = db.prepare(built.sql).all(...built.params) as unknown as EventRow[];
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  return {
    items,
    next_seq: last === undefined ? query.from_seq : last.seq + 1,
    has_more: rows.length > query.limit,
  };
}

// --- Event content ---------------------------------------------------------

const EVENT_CONTENT_COLUMNS = `id, session_id, block_index, input, input_bytes, input_storage,
     text, text_bytes, output_storage, spill_path, spill_bytes,
     src_offset, src_len, result_offset, result_len, result_block`;

/** The row `resolveContent()` dispatches on. Task 4.4 owns turning it into bytes. */
export function readEventContentRow(
  db: DatabaseSync,
  event_id: string,
): EventContentRow | undefined {
  return db
    .prepare(`SELECT ${EVENT_CONTENT_COLUMNS} FROM events WHERE id = ?`)
    .get(event_id) as unknown as EventContentRow | undefined;
}

/** Where a session's bytes live, and whose sidecar it is. */
export interface EventArchive {
  archive_path: string;
  /** Non-null on a sidecar. It names the session whose `tool-results/` holds the
   *  spills, which is what a sidecar's own directory never does. */
  parent_session_id: string | null;
}

/**
 * The archive path an `events.src_offset` is relative to. A sidecar IS a
 * `sessions` row (`schema.ts:44`), so one lookup answers for both.
 */
export function readEventArchivePath(
  db: DatabaseSync,
  session_id: string,
): EventArchive | undefined {
  return db
    .prepare(`SELECT archive_path, parent_session_id FROM sessions WHERE id = ?`)
    .get(session_id) as unknown as EventArchive | undefined;
}

// --- Search ----------------------------------------------------------------

export interface SearchQuery {
  q: string;
  session?: string;
  limit: number;
}

// Column -1 spans EVERY indexed column. Measured: with column 0 a row whose only
// match is in `input` — every Bash-argument and Grep-pattern hit — renders a
// null snippet, so the search result shows no context at all.
const SNIPPET = `snippet(events_fts, -1, '<mark>', '</mark>', '…', 12)`;

/**
 * FTS5 over `events.text` and `events.input`. `session` scopes to one session;
 * without it this searches every PROJECTED session, which is what
 * {@link countUnprojected} reports the honest denominator for.
 */
export function searchEvents(db: DatabaseSync, query: SearchQuery): SearchHit[] {
  const where: string[] = ['events_fts MATCH ?'];
  const params: SqlParam[] = [query.q];
  if (query.session !== undefined) {
    where.push('e.session_id = ?');
    params.push(query.session);
  }
  const sql =
    `SELECT e.session_id AS session_id, s.title AS session_title, s.project_path AS project_path,` +
    ` e.turn_id AS turn_id, e.id AS event_id, e.seq AS seq, e.kind AS kind, e.name AS name,` +
    ` e.ts AS ts, ${SNIPPET} AS snippet` +
    ` FROM events_fts JOIN events e ON e.rowid = events_fts.rowid` +
    ` JOIN sessions s ON s.id = e.session_id` +
    ` WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`;
  params.push(query.limit);
  return db.prepare(sql).all(...params) as unknown as SearchHit[];
}

/**
 * Sessions whose content is not in the index yet. `empty` is a tombstone — the
 * file projected nothing — so it is projected, not pending.
 */
export function countUnprojected(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT count(*) AS n FROM sessions WHERE projection_state NOT IN ('ready', 'empty')`)
    .get() as unknown as { n: number };
  return row.n;
}

// --- Drift -----------------------------------------------------------------

/**
 * Raw rows for `GET /api/drift`. The per-`harness_version` tally and the
 * `unknown_*` merge happen in the mapper, which keeps this a plain row select
 * and keeps the reviewed `count(*)` allowlist honest.
 */
export function readDriftRows(db: DatabaseSync): DriftRow[] {
  return db
    .prepare(
      `SELECT id, title, harness_version, drift_json FROM sessions
       WHERE projection_state = 'ready'`,
    )
    .all() as unknown as DriftRow[];
}

// --- Health ----------------------------------------------------------------

/** The three `GET /api/health` numbers that are counted rather than stored. */
export interface HealthCounts {
  sessions_indexed: number;
  sessions_projected: number;
  db_bytes: number;
}

/**
 * `projected` is the exact complement of {@link countUnprojected}, so the two
 * always sum to `sessions_indexed`. `db_bytes` comes from the page counters
 * rather than a `statSync`, which keeps `fs` as well as SQL out of the route.
 */
export function readHealthCounts(db: DatabaseSync): HealthCounts {
  const sessions = db
    .prepare(
      `SELECT count(*) AS sessions_indexed,
       coalesce(sum(projection_state IN ('ready', 'empty')), 0) AS sessions_projected
     FROM sessions`,
    )
    .get() as unknown as Omit<HealthCounts, 'db_bytes'>;
  const pages = db.prepare('PRAGMA page_count').get() as unknown as { page_count: number };
  const size = db.prepare('PRAGMA page_size').get() as unknown as { page_size: number };
  return { ...sessions, db_bytes: pages.page_count * size.page_size };
}

/**
 * Events in one session's projection, for what `POST .../reproject` reports it
 * wrote. There is no counterpart for turns because `sessions.turn_count` is a
 * column the projection already stamps.
 */
export function readEventCount(db: DatabaseSync, session_id: string): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM events WHERE session_id = ?')
    .get(session_id) as unknown as { n: number };
  return row.n;
}

// --- Corpus sweep ----------------------------------------------------------
// Not wire shapes: these four serve `src/corpus/`, which walks the archive and
// diffs it against the rows below. They live here for the same reason the rest
// does — the one door.

/** The three freshness columns of one indexed session. */
export interface IndexedRow {
  archive_path: string;
  file_mtime_ms: number;
  file_size: number;
}

/** The whole Tier-A index in one query, keyed the way the walk diffs it. */
export function readIndexedFolds(db: DatabaseSync): Map<string, IndexedRow> {
  const rows = db
    .prepare('SELECT archive_path, file_mtime_ms, file_size FROM sessions')
    .all() as unknown as IndexedRow[];
  return new Map(rows.map((row) => [row.archive_path, row]));
}

/** One `meta` value. `undefined` when the key was never written. */
export function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value;
}

const TREE_ROOTS_SQL = `SELECT id FROM sessions
  WHERE parent_session_id IS NULL AND rollup_state = 'own'
  ORDER BY last_activity_at DESC, id DESC`;

/** Top-level trees no sweep has rolled up yet, newest first. */
export function readTreeRoots(db: DatabaseSync): string[] {
  const rows = db.prepare(TREE_ROOTS_SQL).all() as unknown as { id: string }[];
  return rows.map((row) => row.id);
}

/** The direct children of one session — wave 2's breadth-first frontier. */
export function readChildSessionIds(db: DatabaseSync, session_id: string): string[] {
  const rows = db
    .prepare('SELECT id FROM sessions WHERE parent_session_id = ?')
    .all(session_id) as unknown as { id: string }[];
  return rows.map((row) => row.id);
}
