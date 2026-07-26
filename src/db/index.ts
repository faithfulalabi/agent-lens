import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Envelope } from '../shared/index.js';
import type {
  Session,
  Trace,
  Span,
  Message,
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
 */
export function insertRawEvent(
  db: DatabaseSync,
  envelope: Envelope,
  status: 'processed' | 'dead_letter' = 'processed',
): boolean {
  const stmt = db.prepare(
    `INSERT INTO raw_events (id, session_id, source, hook_name, received_at, status, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const result = stmt.run(
    envelope.event_id,
    envelope.session_id,
    envelope.source,
    envelope.hook_name ?? null,
    new Date().toISOString(),
    status,
    JSON.stringify(envelope.raw_payload),
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
  Partial<Pick<Span, 'parent_span_id' | 'ended_at' | 'input_payload_id' | 'output_payload_id' | 'model'>>;

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
 */
export function upsertSpan(db: DatabaseSync, s: SpanUpsert): void {
  db.prepare(
    `INSERT INTO spans (id, trace_id, parent_span_id, span_type, name, status,
                        started_at, ended_at, input_payload_id, output_payload_id,
                        model, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status            = excluded.status,
       ended_at          = COALESCE(excluded.ended_at, spans.ended_at),
       output_payload_id = COALESCE(excluded.output_payload_id, spans.output_payload_id),
       input_payload_id  = COALESCE(excluded.input_payload_id, spans.input_payload_id),
       model             = COALESCE(excluded.model, spans.model),
       parent_span_id    = COALESCE(excluded.parent_span_id, spans.parent_span_id)`,
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

/** The most-recently-opened trace in a session — the attach target for orphan spans. */
export function latestTraceId(
  db: DatabaseSync,
  sessionId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM traces WHERE session_id = ? ORDER BY turn_seq DESC LIMIT 1`,
    )
    .get(sessionId) as { id: string } | undefined;
  return row?.id;
}

/** Highest turn_seq used in a session so far (0 if none) — for the next turn. */
export function maxTurnSeq(db: DatabaseSync, sessionId: string): number {
  const row = db
    .prepare(`SELECT MAX(turn_seq) AS max FROM traces WHERE session_id = ?`)
    .get(sessionId) as { max: number | null };
  return row.max ?? 0;
}

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
