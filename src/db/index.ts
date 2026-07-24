import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { Envelope } from '../shared/index.js';
import { applySchema } from './schema.js';

// SQLite layer: schema application + queries. The ONLY module that touches SQL.
// Phase-1 tracer bullet subset (Task 1.3); Task 2.1 supersedes with the real
// migration runner.
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

/** Open (or create) the data-dir DB, apply the minimal schema, return the handle. */
export function openDb(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  applySchema(db);
  return db;
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
