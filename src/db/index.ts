import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Envelope } from '../shared/index.js';
import { makeEnvelope } from '../shared/index.js';
import type {
  CaptureMode,
  Session,
  Trace,
  Span,
  Message,
  RawEventStatus,
  SpanStatus,
  TailerOffset,
} from '../shared/index.js';
import { runMigrations } from './migrate.js';

// SQLite layer: schema application + queries. The ONLY module that touches SQL.
// Schema now comes from the migration runner (Task 2.1); Phase-1 ingest still
// uses the `spans_lite` compat table until Task 2.2 cuts over.
export const MODULE = 'db';

/** The on-disk DB filename inside the data dir. */
export const DB_FILE = 'agent-lens.db';

/** A materialized spans-lite row — one derived row per envelope for the live list. */
export interface SpanLite {
  seq: number;
  event_id: string;
  session_id: string;
  source: string;
  hook_name: string | null;
  ts: string;
}

/** Open (or create) the data-dir DB, run migrations + pragmas, return the handle. */
export function openDb(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  runMigrations(db);
  ensurePromptTraceMap(db);
  return db;
}

/**
 * Compat side-table mapping a harness `prompt_id` to the trace it opened, so
 * Pre/Post tool spans attach to the right turn. Kept out of migration 001 (frozen
 * by Task 2.1) and created on open like `spans_lite`; the durable identity is
 * still `traces.id = {session_id}:{turn_seq}`, this is only the correlator bridge.
 */
export function ensurePromptTraceMap(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_trace_map (
      session_id  TEXT NOT NULL,
      prompt_id   TEXT NOT NULL,
      trace_id    TEXT NOT NULL,
      PRIMARY KEY (session_id, prompt_id)
    )
  `);
}

/**
 * Archive an envelope verbatim. Upsert-by-`event_id`:
 * `INSERT ... ON CONFLICT(id) DO NOTHING`. Returns `true` only when a genuinely
 * new row was written (via `changes`), so the server broadcasts once per event.
 *
 * `raw` holds the WHOLE envelope, not just `raw_payload` (`data-model.md`:
 * "every envelope that ever arrived, verbatim"). That makes the archive lossless
 * enough for dead-letter reprocess to rebuild the envelope, and lets payload
 * lookbacks (`lastSessionStartSource`) read it without a second store.
 */
export function insertRawEvent(
  db: DatabaseSync,
  envelope: Envelope,
  status: RawEventStatus = 'processed',
  error?: string,
): boolean {
  const stmt = db.prepare(
    `INSERT INTO raw_events (id, session_id, source, hook_name, received_at, status, error, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const result = stmt.run(
    envelope.event_id,
    envelope.session_id,
    envelope.source,
    envelope.hook_name ?? null,
    new Date().toISOString(),
    status,
    error ?? null,
    JSON.stringify(envelope),
  );
  return result.changes === 1;
}

/** Materialize the spans-lite row for a new event at the given seq. Idempotent. */
export function insertSpanLite(
  db: DatabaseSync,
  seq: number,
  envelope: Envelope,
): void {
  const stmt = db.prepare(
    `INSERT INTO spans_lite (seq, event_id, session_id, source, hook_name, ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  );
  stmt.run(
    seq,
    envelope.event_id,
    envelope.session_id,
    envelope.source,
    envelope.hook_name ?? null,
    envelope.ts,
  );
}

/** All spans-lite rows in seq order — the hydration source on page load / restart. */
export function getAllEventsOrdered(db: DatabaseSync): SpanLite[] {
  const rows = db
    .prepare(
      `SELECT seq, event_id, session_id, source, hook_name, ts
       FROM spans_lite ORDER BY seq ASC`,
    )
    .all() as unknown as SpanLite[];
  return rows;
}

/** Next monotonically-increasing seq (max existing + 1), starting at 1. */
export function nextSeq(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(seq) AS max FROM spans_lite').get() as {
    max: number | null;
  };
  return (row.max ?? 0) + 1;
}

// --- Normalizer row-level helpers (Task 2.2) ------------------------------
// The projection writes (sessions/traces/spans/payloads/messages) live here so
// the SQL boundary holds: `src/capture/normalizer.ts` computes policy and calls
// these; it never embeds SQL. Every helper is upsert-shaped so the same envelope
// replayed twice converges to identical rows (idempotency).

/** Fields the normalizer supplies when opening/closing a session. */
export type SessionUpsert = Pick<Session, 'id' | 'harness' | 'project_path' | 'started_at' | 'status' | 'capture_mode'> &
  Partial<Pick<Session, 'git_branch' | 'model' | 'ended_at' | 'transcript_path'>>;

/** Fields the normalizer supplies when opening/closing a trace. */
export type TraceUpsert = Pick<Trace, 'id' | 'session_id' | 'turn_seq' | 'trigger' | 'prompt_preview' | 'started_at' | 'status'> &
  Partial<Pick<Trace, 'ended_at'>>;

/** Fields the normalizer supplies when opening/updating a span. */
export type SpanUpsert = Pick<Span, 'id' | 'trace_id' | 'span_type' | 'name' | 'status' | 'started_at' | 'source'> &
  Partial<Pick<Span, 'parent_span_id' | 'ended_at' | 'input_payload_id' | 'output_payload_id' | 'model' | 'tags' | 'attrs'>>;

/**
 * Content-address a payload blob. `id = sha256(content)` (full hex — distinct
 * from event-id's 128-bit truncation). Identical content collides to one row via
 * `ON CONFLICT(id) DO NOTHING`, so dedup is by construction. Returns the id.
 */
export function insertPayload(db: DatabaseSync, content: string): string {
  const id = createHash('sha256').update(content, 'utf8').digest('hex');
  db.prepare(
    `INSERT INTO payloads (id, content, byte_size, mime_hint)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, content, Buffer.byteLength(content, 'utf8'), 'application/json');
  return id;
}

/** Upsert a session by id; on conflict advance only the mutable lifecycle fields. */
export function upsertSession(db: DatabaseSync, s: SessionUpsert): void {
  db.prepare(
    `INSERT INTO sessions (id, harness, project_path, git_branch, model,
                           started_at, ended_at, status, capture_mode, transcript_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status          = excluded.status,
       ended_at        = COALESCE(excluded.ended_at, sessions.ended_at),
       git_branch      = COALESCE(excluded.git_branch, sessions.git_branch),
       model           = COALESCE(excluded.model, sessions.model),
       transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path)`,
  ).run(
    s.id,
    s.harness,
    s.project_path,
    s.git_branch ?? null,
    s.model ?? null,
    s.started_at,
    s.ended_at ?? null,
    s.status,
    s.capture_mode,
    s.transcript_path ?? null,
  );
}

/** Upsert a trace by id; on conflict advance only status/ended_at. */
export function upsertTrace(db: DatabaseSync, t: TraceUpsert): void {
  db.prepare(
    `INSERT INTO traces (id, session_id, turn_seq, trigger, prompt_preview,
                         started_at, ended_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status   = excluded.status,
       ended_at = COALESCE(excluded.ended_at, traces.ended_at)`,
  ).run(
    t.id,
    t.session_id,
    t.turn_seq,
    t.trigger,
    t.prompt_preview,
    t.started_at,
    t.ended_at ?? null,
    t.status,
  );
}

/**
 * Upsert a span by id — the Pre→Post correlation primitive. PreToolUse opens the
 * span (status running, input payload); PostToolUse updates the SAME id
 * (ended_at, output payload, terminal status). `COALESCE` guards the opening
 * fields so a closing update never nulls out what open established.
 *
 * Three conflict rules do the resilience work (Task 2.3):
 * - **Terminal-status guard.** A late-arriving open (`running`) never reverts a
 *   span that already reached a terminal status, so Pre/Post replay in any order
 *   converges on the same row.
 * - **`attrs` merge** via `json_patch` (RFC 7386): drift keys accumulate and
 *   Task 2.4's `pricing_version` stamp survives later upserts. NOTE: an explicit
 *   `null` value DELETES that key — callers must omit nulls, not pass them.
 * - **`tags` union** via `json_each` + `json_group_array`: markers like
 *   `synthetic_open`/`degraded` accumulate and dedupe. The union does NOT
 *   preserve insertion order, so read tags as a set.
 */
export function upsertSpan(db: DatabaseSync, s: SpanUpsert): void {
  db.prepare(
    `INSERT INTO spans (id, trace_id, parent_span_id, span_type, name, status,
                        started_at, ended_at, input_payload_id, output_payload_id,
                        model, source, tags, attrs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status            = CASE WHEN excluded.status = 'running' AND spans.status <> 'running'
                                THEN spans.status ELSE excluded.status END,
       ended_at          = COALESCE(excluded.ended_at, spans.ended_at),
       output_payload_id = COALESCE(excluded.output_payload_id, spans.output_payload_id),
       input_payload_id  = COALESCE(excluded.input_payload_id, spans.input_payload_id),
       model             = COALESCE(excluded.model, spans.model),
       parent_span_id    = COALESCE(excluded.parent_span_id, spans.parent_span_id),
       attrs             = json_patch(spans.attrs, excluded.attrs),
       tags              = (SELECT json_group_array(v) FROM (
                              SELECT value AS v FROM json_each(spans.tags)
                              UNION SELECT value FROM json_each(excluded.tags)))`,
  ).run(
    s.id,
    s.trace_id,
    s.parent_span_id ?? null,
    s.span_type,
    s.name,
    s.status,
    s.started_at,
    s.ended_at ?? null,
    s.input_payload_id ?? null,
    s.output_payload_id ?? null,
    s.model ?? null,
    s.source,
    JSON.stringify(s.tags ?? []),
    JSON.stringify(s.attrs ?? {}),
  );
}

/** Insert a thread-view message row (idempotent by id). */
export function insertMessage(db: DatabaseSync, m: Message): void {
  db.prepare(
    `INSERT INTO messages (id, trace_id, span_id, seq, role, payload_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(m.id, m.trace_id, m.span_id ?? null, m.seq, m.role, m.payload_id);
}

/**
 * Resolve the trace id a `prompt_id` opened, so Pre/Post tool spans attach to the
 * right turn. Trace identity is `{session_id}:{turn_seq}`; this lookup bridges the
 * harness's `prompt_id` correlator to that identity within a session.
 */
export function getTraceIdByPromptId(
  db: DatabaseSync,
  sessionId: string,
  promptId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT trace_id FROM prompt_trace_map WHERE session_id = ? AND prompt_id = ?`,
    )
    .get(sessionId, promptId) as { trace_id: string } | undefined;
  return row?.trace_id;
}

/** Record a `prompt_id`→trace mapping (idempotent). */
export function mapPromptToTrace(
  db: DatabaseSync,
  sessionId: string,
  promptId: string,
  traceId: string,
): void {
  db.prepare(
    `INSERT INTO prompt_trace_map (session_id, prompt_id, trace_id)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id, prompt_id) DO NOTHING`,
  ).run(sessionId, promptId, traceId);
}

/** Highest turn_seq used in a session so far (0 if none) — for the next turn. */
export function maxTurnSeq(db: DatabaseSync, sessionId: string): number {
  const row = db
    .prepare(`SELECT MAX(turn_seq) AS max FROM traces WHERE session_id = ?`)
    .get(sessionId) as { max: number | null };
  return row.max ?? 0;
}

// --- Resilience helpers (Task 2.3) ----------------------------------------
// Degrade / dead-letter / synthesize / finalize support. Kept in one trailing
// block so the parallel Task 2.4 edits to this file rebase cleanly. Every helper
// is a plain statement over existing columns — no new tables, no migration.

/** An archived envelope as reprocess needs it: identity columns + the raw JSON. */
export interface DeadLetterRow {
  id: string;
  session_id: string;
  source: string;
  hook_name: string | null;
  received_at: string;
  raw: string;
}

/** Per-status archive counts, surfaced by `GET /api/health`. */
export interface IngestHealth {
  processed: number;
  degraded: number;
  dead_letter: number;
}

/** Retag an already-archived envelope (degraded on drift, healed on reprocess). */
export function setRawEventStatus(
  db: DatabaseSync,
  eventId: string,
  status: RawEventStatus,
  error?: string,
): void {
  db.prepare(`UPDATE raw_events SET status = ?, error = ? WHERE id = ?`).run(
    status,
    error ?? null,
    eventId,
  );
}

/**
 * Archive garbage that never became an envelope (an unparseable HTTP body or one
 * failing the shape guard) as a dead letter, keeping the original bytes. The
 * `event_id` is content-derived the same way spool replay derives one for a torn
 * line (`replay.ts`), so re-POSTing identical garbage dedupes instead of piling
 * up rows. `source` is recorded as `hook` — the HTTP boundary — because a body
 * that failed the shape guard has no trustworthy source of its own; whatever it
 * claimed is still readable in `raw`.
 */
export function deadLetterRaw(
  db: DatabaseSync,
  input: {
    rawText: string;
    error: string;
    sessionId?: string;
    hookName?: string;
  },
): void {
  const envelope = makeEnvelope({
    source: 'hook',
    session_id: input.sessionId ?? 'unknown',
    hook_name: input.hookName ?? 'unknown',
    raw_payload: input.rawText,
    ts: new Date().toISOString(),
  });
  db.prepare(
    `INSERT INTO raw_events (id, session_id, source, hook_name, received_at, status, error, raw)
     VALUES (?, ?, ?, ?, ?, 'dead_letter', ?, ?)
     ON CONFLICT(id) DO UPDATE SET error = excluded.error`,
  ).run(
    envelope.event_id,
    envelope.session_id,
    envelope.source,
    envelope.hook_name ?? null,
    envelope.ts,
    input.error,
    input.rawText,
  );
}

/**
 * Every dead letter in arrival order. The ordering is deliberate: replaying a
 * `PostToolUse` before its `PreToolUse` must still converge, and while the
 * terminal-status guard in `upsertSpan` makes that true, arrival order keeps the
 * reconstructed timeline honest.
 */
export function listDeadLetters(db: DatabaseSync): DeadLetterRow[] {
  return db
    .prepare(
      `SELECT id, session_id, source, hook_name, received_at, raw
       FROM raw_events WHERE status = 'dead_letter'
       ORDER BY received_at, rowid`,
    )
    .all() as unknown as DeadLetterRow[];
}

/** True if a span row already exists — how a close detects a missing open. */
export function spanExists(db: DatabaseSync, spanId: string): boolean {
  return (
    db.prepare(`SELECT 1 AS hit FROM spans WHERE id = ?`).get(spanId) !== undefined
  );
}

/**
 * The most recent still-`live` trace in a session — the attach target for orphan
 * spans. It refuses to hand back a closed turn, so post-`Stop` activity
 * synthesizes a new trace instead of retroactively polluting the completed one
 * (RFC 001), which a plain latest-trace lookup would do.
 */
export function latestOpenTraceId(
  db: DatabaseSync,
  sessionId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM traces WHERE session_id = ? AND status = 'live'
       ORDER BY turn_seq DESC LIMIT 1`,
    )
    .get(sessionId) as { id: string } | undefined;
  return row?.id;
}

/**
 * The `source` field of the session's most recent archived `SessionStart` — the
 * resume signal (`'resume'`), read straight off the raw archive so no side table
 * is needed. `$.raw_payload.source` is the HARNESS source; `$.source` is the
 * transport source (`hook`/`spool_replay`/…) and only the fallback for rows
 * written before the archive held the full envelope. `json_valid` skips
 * dead-lettered garbage, which is not JSON at all.
 */
export function lastSessionStartSource(
  db: DatabaseSync,
  sessionId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT COALESCE(json_extract(raw, '$.raw_payload.source'),
                       json_extract(raw, '$.source')) AS src
       FROM raw_events
       WHERE session_id = ? AND hook_name = 'SessionStart' AND json_valid(raw)
       ORDER BY received_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId) as { src: string | null } | undefined;
  return row?.src ?? undefined;
}

/** Ids of every still-`live` trace in a session — the finalization work list. */
export function liveTracesForSession(
  db: DatabaseSync,
  sessionId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM traces WHERE session_id = ? AND status = 'live' ORDER BY turn_seq`,
    )
    .all(sessionId) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Finalize every still-running span on a trace as `unknown` — an honest "we never
 * saw it close" rather than a fabricated success. Returns the IDs it closed, in
 * no particular order; `[]` when nothing was running.
 *
 * **It returns ids rather than a count because of Task 6.1.** All three callers
 * (`normalizer.ts`'s `closeSession` and `closeActiveTrace`, and the inactivity
 * sweep) close spans that no hook will ever report on again, so a live view can
 * only learn about them from here. With a bare count, every span finalized by
 * `Stop`, `SessionEnd`, or the sweep would spin forever in the UI. `.length` is
 * the old return value, so counting callers are unaffected.
 */
export function closeRunningSpans(
  db: DatabaseSync,
  traceId: string,
  endedAt: string,
): string[] {
  const rows = db
    .prepare(
      `UPDATE spans SET status = 'unknown', ended_at = COALESCE(ended_at, ?)
       WHERE trace_id = ? AND status = 'running' RETURNING id`,
    )
    .all(endedAt, traceId) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** Flip a live trace to `interrupted` (inactivity timeout). Returns true if it did. */
export function markTraceInterrupted(
  db: DatabaseSync,
  traceId: string,
  endedAt: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE traces SET status = 'interrupted', ended_at = COALESCE(ended_at, ?)
       WHERE id = ? AND status = 'live'`,
    )
    .run(endedAt, traceId);
  return Number(result.changes) > 0;
}

/**
 * Flip a live session to `interrupted` (inactivity timeout). Returns true if it
 * did — the sweep publishes a delta only for sessions it actually changed, so it
 * needs the same did-it-fire answer {@link markTraceInterrupted} already gives.
 */
export function markSessionInterrupted(db: DatabaseSync, sessionId: string): boolean {
  const result = db
    .prepare(
      `UPDATE sessions SET status = 'interrupted' WHERE id = ? AND status = 'live'`,
    )
    .run(sessionId);
  return Number(result.changes) > 0;
}

/**
 * Undo an inactivity timeout when the session speaks again: `interrupted` → `live`
 * for the session and its most recent interrupted trace. Never touches `complete`
 * rows, and deliberately leaves spans the sweep closed `unknown` alone — a real
 * close event upserts them to their true status anyway.
 */
export function reviveSession(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET status = 'live' WHERE id = ? AND status = 'interrupted'`,
  ).run(sessionId);
  db.prepare(
    `UPDATE traces SET status = 'live', ended_at = NULL
     WHERE id = (SELECT id FROM traces WHERE session_id = ? AND status = 'interrupted'
                 ORDER BY turn_seq DESC LIMIT 1)`,
  ).run(sessionId);
}

/**
 * Wall-clock last-arrival per still-open session — the inactivity sweep's input.
 * Staleness keys on `raw_events.received_at` (when WE saw it), never the harness
 * `ts`, so a clock-skewed or backfilled event cannot fake liveness. Falls back to
 * `started_at` for a session with no archived events (direct-normalize tests).
 */
export function lastActivityBySession(
  db: DatabaseSync,
): { session_id: string; last_activity: string }[] {
  return db
    .prepare(
      `SELECT s.id AS session_id,
              COALESCE((SELECT MAX(r.received_at) FROM raw_events r
                        WHERE r.session_id = s.id), s.started_at) AS last_activity
       FROM sessions s
       WHERE s.status = 'live'
          OR EXISTS (SELECT 1 FROM traces t
                     WHERE t.session_id = s.id AND t.status = 'live')`,
    )
    .all() as unknown as { session_id: string; last_activity: string }[];
}

// --- Transcript tailer helpers (Task 3.1) ---------------------------------
// Offset bookkeeping, transcript discovery, and the two session writes the
// tailer needs. SQL stays here; `src/capture/tailer.ts` decides policy.

/** One transcript path known to the tailer, with the session that named it. */
export interface TranscriptPathRow {
  session_id: string;
  transcript_path: string;
}

/** The committed resume point for one transcript file, or `undefined` if new. */
export function readTailerOffset(
  db: DatabaseSync,
  transcriptPath: string,
): TailerOffset | undefined {
  const row = db
    .prepare(
      `SELECT transcript_path, session_id, committed_offset, file_identity
       FROM tailer_offsets WHERE transcript_path = ?`,
    )
    .get(transcriptPath) as
    | {
        transcript_path: string;
        session_id: string;
        committed_offset: number;
        file_identity: string | null;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    transcript_path: row.transcript_path,
    session_id: row.session_id,
    committed_offset: Number(row.committed_offset),
    file_identity: row.file_identity ?? undefined,
  };
}

/**
 * Write a transcript file's resume point, keyed on the `transcript_path` PK.
 * Called from inside `ingestBatch`'s transaction (`beforeCommit`), so the offset
 * and the events it covers commit or roll back together.
 */
export function commitTailerOffset(db: DatabaseSync, row: TailerOffset): void {
  db.prepare(
    `INSERT INTO tailer_offsets (transcript_path, session_id, committed_offset, file_identity)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(transcript_path) DO UPDATE SET
       session_id       = excluded.session_id,
       committed_offset = excluded.committed_offset,
       file_identity    = excluded.file_identity`,
  ).run(
    row.transcript_path,
    row.session_id,
    row.committed_offset,
    row.file_identity ?? null,
  );
}

/**
 * Every transcript path a session has told us about — the tailer's PRIMARY
 * discovery source (populated from `SessionStart`). Values are stored exactly as
 * the harness spelled them, so the caller must canonicalize before use.
 */
export function transcriptPathsFromSessions(db: DatabaseSync): TranscriptPathRow[] {
  return db
    .prepare(
      `SELECT id AS session_id, transcript_path FROM sessions
       WHERE transcript_path IS NOT NULL AND transcript_path <> ''
       ORDER BY id`,
    )
    .all() as unknown as TranscriptPathRow[];
}

/**
 * Create a session row only if one does not exist — `INSERT ... DO NOTHING`.
 *
 * Deliberately NOT {@link upsertSession}, whose conflict clause sets
 * `status = excluded.status` unconditionally: a late transcript line would
 * resurrect a `complete` session to `live`. The tailer must be able to
 * materialize a row it has evidence for without editing one it does not own.
 */
export function insertSessionIfAbsent(db: DatabaseSync, s: SessionUpsert): void {
  db.prepare(
    `INSERT INTO sessions (id, harness, project_path, git_branch, model,
                           started_at, ended_at, status, capture_mode, transcript_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    s.id,
    s.harness,
    s.project_path,
    s.git_branch ?? null,
    s.model ?? null,
    s.started_at,
    s.ended_at ?? null,
    s.status,
    s.capture_mode,
    s.transcript_path ?? null,
  );
}

/**
 * Correct a session's `capture_mode`. This exists because `upsertSession`'s
 * `ON CONFLICT` list omits `capture_mode`, so whichever writer creates the row
 * owns the label FOREVER — and the tailer can legitimately win that race
 * (install agent-lens mid-session: no `SessionStart`, the transcript is
 * discovered, the row is minted `transcript_only`). Without this repair a later,
 * perfectly healthy hook could never fix the label, and Task 3.3's upgrade path
 * would be pre-empted. A no-op when the value already matches.
 */
export function setCaptureMode(
  db: DatabaseSync,
  sessionId: string,
  mode: CaptureMode,
): void {
  db.prepare(
    `UPDATE sessions SET capture_mode = ? WHERE id = ? AND capture_mode <> ?`,
  ).run(mode, sessionId, mode);
}

/** Archive counts by status — the drift/dead-letter counter the UI banner reads. */
export function ingestHealth(db: DatabaseSync): IngestHealth {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS count FROM raw_events GROUP BY status`)
    .all() as unknown as { status: string; count: number }[];
  const health: IngestHealth = { processed: 0, degraded: 0, dead_letter: 0 };
  for (const row of rows) {
    if (row.status in health) {
      health[row.status as keyof IngestHealth] = Number(row.count);
    }
  }
  return health;
}

// --- Transcript merge helpers (Task 3.2) ----------------------------------
// The three writes/reads the merge policy needs that no existing helper can
// express. Kept in a trailing block so parallel edits to this file rebase
// cleanly. No new tables and no DDL: correlation reads the `raw_events`
// archive, per the `lastSessionStartSource` precedent above.

/** Content + provenance fields the transcript merge may write onto a span. */
export interface SpanContentUpgrade {
  span_id: string;
  input_payload_id?: string;
  output_payload_id?: string;
  model?: string;
  /** UNIONed with the existing tags — never assigned. */
  tags?: string[];
  /** Merged with `json_patch`; null-valued keys must be omitted by the caller. */
  attrs?: Record<string, unknown>;
}

/**
 * Write content + provenance onto an EXISTING span, and nothing else.
 *
 * Deliberately not {@link upsertSpan}, whose `ON CONFLICT` list also carries
 * `status`, `started_at` and `ended_at`: a transcript block whose natural status
 * is `ok` would clobber a hook-recorded `error`/`denied`, violating "hooks own
 * lifecycle, transcript owns content" (RFC 001). This helper cannot express a
 * lifecycle write at all, which is what makes that rule mechanical rather than
 * conventional.
 *
 * Three details are load-bearing:
 * - **Payload columns are `COALESCE`d, never assigned.** A payload ref is only
 *   ever FILLED IN, so a transcript version can never downgrade one a hook
 *   already stored. The caller still decides whether to insert the blob at all
 *   ({@link spanOutputMissing}); the COALESCE is the structural backstop.
 * - **`tags` UNION, never assign** — a plain assignment would erase the
 *   `synthetic_open`/`degraded` markers the hook path set.
 * - **`attrs` binds `'{}'` when absent, never SQL NULL.** `json_patch(x, NULL)`
 *   returns NULL and `spans.attrs` is `NOT NULL`, so a null patch document would
 *   throw and dead-letter the item. (Null-VALUED keys are a separate hazard:
 *   `json_patch` treats them as deletes, so callers omit them.)
 *
 * `source` is absent on purpose. Task 3.2 never writes `source: 'merged'` —
 * spans are `hook` (untouched by merge) or `transcript` (created by it). Mixed
 * provenance becomes meaningful only when Task 3.4 completes a payload from the
 * sidecar, and that task owns the transition.
 */
export function upgradeSpanContent(db: DatabaseSync, u: SpanContentUpgrade): void {
  db.prepare(
    `UPDATE spans SET
       input_payload_id  = COALESCE(input_payload_id, ?),
       output_payload_id = COALESCE(output_payload_id, ?),
       model             = COALESCE(?, model),
       attrs             = json_patch(attrs, ?),
       tags              = (SELECT json_group_array(v) FROM (
                              SELECT value AS v FROM json_each(spans.tags)
                              UNION SELECT value FROM json_each(?)))
     WHERE id = ?`,
  ).run(
    u.input_payload_id ?? null,
    u.output_payload_id ?? null,
    u.model ?? null,
    JSON.stringify(u.attrs ?? {}),
    JSON.stringify(u.tags ?? []),
    u.span_id,
  );
}

/**
 * Close a span the TRANSCRIPT opened, and only such a span.
 *
 * The one lifecycle write the merge is allowed, and the `WHERE` clause is what
 * makes it safe rather than a convention:
 * - `source = 'transcript'` — the row was created by the merge, so no hook ever
 *   established this span's lifecycle. A hook-created span is excluded outright,
 *   which is "hooks own lifecycle" enforced in SQL.
 * - `status = 'running'` — only the open state the merge itself wrote is
 *   replaced. A hook that reached the span first and recorded a terminal status
 *   keeps it, and a re-merge is a no-op because the span is no longer running.
 *
 * Without this, a transcript-only tool call could never record its outcome:
 * `upgradeSpanContent` cannot express `status` by design, so the `tool_result`
 * block's `is_error` would be unreachable and every failed call in a hookless
 * session would read `ok` — silently zeroing `error_count` in the rollups.
 */
export function closeTranscriptSpan(
  db: DatabaseSync,
  spanId: string,
  status: SpanStatus,
  endedAt: string,
): void {
  db.prepare(
    `UPDATE spans SET status = ?, ended_at = COALESCE(ended_at, ?)
     WHERE id = ? AND source = 'transcript' AND status = 'running'`,
  ).run(status, endedAt, spanId);
}

/** The payload refs a span currently holds; either may be absent. */
export interface SpanPayloadRefs {
  input_payload_id?: string;
  output_payload_id?: string;
}

/**
 * What content a span already has, or `undefined` when the span does not exist.
 *
 * The merge asks this BEFORE serializing a transcript block, and the "before"
 * is load-bearing twice over. `payloads` is content-addressed and insert-only,
 * so writing first and discarding the id would leave a permanent row for a blob
 * nothing references. And when a hook already stored the richer object, the
 * thread-view message must point at THAT — the transcript's flattened rendering
 * is a downgrade for the reader exactly as it is for the span.
 */
export function spanPayloadRefs(
  db: DatabaseSync,
  spanId: string,
): SpanPayloadRefs | undefined {
  const row = db
    .prepare(`SELECT input_payload_id AS i, output_payload_id AS o FROM spans WHERE id = ?`)
    .get(spanId) as { i: string | null; o: string | null } | undefined;
  if (row === undefined) return undefined;
  return {
    input_payload_id: row.i ?? undefined,
    output_payload_id: row.o ?? undefined,
  };
}

/** Next per-trace message seq (max existing + 1), starting at 1. */
export function nextMessageSeq(db: DatabaseSync, traceId: string): number {
  const row = db
    .prepare(`SELECT MAX(seq) AS max FROM messages WHERE trace_id = ?`)
    .get(traceId) as { max: number | null };
  return (row.max ?? 0) + 1;
}

/** The two correlation fields one archived transcript line carries. */
export interface TranscriptLineLinks {
  promptId?: string;
  parentUuid?: string;
}

/**
 * Read a transcript line's `promptId`/`parentUuid` straight off the raw archive,
 * keyed by the deterministic event id `{session}:transcript:{uuid}`.
 *
 * **No side table, by design.** `insertRawEvent` runs before `normalize` inside
 * the same transaction, so every line — including the `attachment` and `system`
 * lines that project nothing, and dead-lettered ones — is already a primary-key
 * lookup away. A side table populated only by lines that PROJECT would miss the
 * ~10% of assistant lines whose parent is an `attachment`/`system` line, and
 * they would silently resolve to no trace. Same reasoning, and same precedent,
 * as {@link lastSessionStartSource}.
 */
export function transcriptLineLinks(
  db: DatabaseSync,
  sessionId: string,
  uuid: string,
): TranscriptLineLinks | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(raw, '$.raw_payload.promptId')   AS prompt_id,
              json_extract(raw, '$.raw_payload.parentUuid') AS parent_uuid
       FROM raw_events WHERE id = ? AND json_valid(raw)`,
    )
    .get(`${sessionId}:transcript:${uuid}`) as
    | { prompt_id: string | null; parent_uuid: string | null }
    | undefined;
  if (row === undefined) return undefined;
  return {
    promptId: row.prompt_id ?? undefined,
    parentUuid: row.parent_uuid ?? undefined,
  };
}

// --- Rollups (Task 2.4) ----------------------------------------------------
// Write-time aggregates over spans/traces/sessions. Re-exported here so
// `src/db` stays the single SQL door; the SQL itself lives in `./rollups.js`.

export type { SpanUsage } from './rollups.js';
export {
  recordSpanUsage,
  recomputeTraceRollup,
  recomputeSessionRollup,
  recomputeRollups,
} from './rollups.js';

// --- Reads (Task 5.0) ------------------------------------------------------
// The query API's SQL, plus the fixture seeder that composes the writers above.
// Re-exported here so `src/db` stays the single SQL door; the SQL itself lives
// in `./reads.js` and `./seed.js` contains none at all.

export type {
  PageParams,
  PayloadMeta,
  SessionListQuery,
  SessionSpansQuery,
  SqlQuery,
} from './reads.js';
export {
  buildSessionListSql,
  buildSessionSpansSql,
  readPayloadMeta,
  readPayloadSlice,
  readSession,
  readSessions,
  readSessionSpans,
  readSessionTraces,
  readSpan,
  readTrace,
  readTraceMessages,
  sessionExists,
  toMessage,
  toSession,
  toSpan,
  toTrace,
  traceBelongsToSession,
  traceExists,
} from './reads.js';

export type { SeedManifest, SeedOptions } from './seed.js';
export { seedFixtureDb, seedInto, SEED_EPOCH } from './seed.js';

/**
 * Open an in-memory database, exercise a table + FTS5 virtual table, and close.
 * Returns true if the round-trip succeeds. Used by the scaffold smoke test to
 * verify the pinned `node:sqlite` + FTS5 runtime.
 */
export function sqliteSmoke(): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
    db.exec('CREATE VIRTUAL TABLE t_fts USING fts5(body)');
    db.exec("INSERT INTO t (body) VALUES ('hello world')");
    db.exec("INSERT INTO t_fts (rowid, body) SELECT id, body FROM t");
    const row = db.prepare("SELECT body FROM t_fts WHERE t_fts MATCH 'hello'").get() as
      | { body: string }
      | undefined;
    return row?.body === 'hello world';
  } finally {
    db.close();
  }
}
