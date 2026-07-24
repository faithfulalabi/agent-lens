// Minimal, idempotent DDL for the Phase-1 tracer bullet: a thin `raw_events`
// archive plus a `spans_lite` table backing the live list, and a `seq_counter`
// feeding SSE. Deliberately thin — Task 2.1 replaces this with the real
// migration runner. No SQL lives outside `src/db`.

import type { DatabaseSync } from 'node:sqlite';

/** Apply WAL + the minimal schema. Safe to call on every open (IF NOT EXISTS). */
export function applySchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_events (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      source      TEXT NOT NULL,
      hook_name   TEXT,
      received_at TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'processed',
      raw         TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS spans_lite (
      seq         INTEGER PRIMARY KEY,
      event_id    TEXT NOT NULL UNIQUE,
      session_id  TEXT NOT NULL,
      source      TEXT NOT NULL,
      hook_name   TEXT,
      ts          TEXT NOT NULL
    )
  `);
}
