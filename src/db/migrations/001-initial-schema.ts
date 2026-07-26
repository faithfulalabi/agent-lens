// Migration 001 — the full production schema from `spec/data-model.md`:
// 8 tables + FTS5 external-content table + all indexes. Supersedes the Phase-1
// minimal schema (Task 1.3). Column names/types mirror `src/shared/entities.ts`
// verbatim (notably `payloads.content` and `raw_events.raw` are BLOB, correcting
// the 1.3 TEXT column). SQL stays confined to `src/db/`.

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './index.js';

/** DDL for the full schema. Runs inside the runner's transaction. */
function up(db: DatabaseSync): void {
  // --- Core entities -------------------------------------------------------

  db.exec(`
    CREATE TABLE sessions (
      id              TEXT PRIMARY KEY,
      harness         TEXT NOT NULL,
      project_path    TEXT NOT NULL,
      git_branch      TEXT,
      model           TEXT,
      started_at      TEXT NOT NULL,
      ended_at        TEXT,
      status          TEXT NOT NULL,
      capture_mode    TEXT NOT NULL,
      transcript_path TEXT,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      tokens_in       INTEGER NOT NULL DEFAULT 0,
      tokens_out      INTEGER NOT NULL DEFAULT 0,
      est_cost        REAL    NOT NULL DEFAULT 0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      error_count     INTEGER NOT NULL DEFAULT 0,
      trace_count     INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE traces (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_seq        INTEGER NOT NULL,
      trigger         TEXT NOT NULL,
      prompt_preview  TEXT NOT NULL,
      started_at      TEXT NOT NULL,
      ended_at        TEXT,
      status          TEXT NOT NULL,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      est_cost        REAL    NOT NULL DEFAULT 0,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      error_count     INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE payloads (
      id         TEXT PRIMARY KEY,
      content    BLOB NOT NULL,
      byte_size  INTEGER NOT NULL,
      mime_hint  TEXT
    )
  `);

  db.exec(`
    CREATE TABLE spans (
      id                  TEXT PRIMARY KEY,
      trace_id            TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
      parent_span_id      TEXT REFERENCES spans(id) ON DELETE SET NULL,
      span_type           TEXT NOT NULL,
      name                TEXT NOT NULL,
      status              TEXT NOT NULL,
      started_at          TEXT NOT NULL,
      ended_at            TEXT,
      input_payload_id    TEXT REFERENCES payloads(id),
      output_payload_id   TEXT REFERENCES payloads(id),
      model               TEXT,
      tokens_in           INTEGER,
      tokens_out          INTEGER,
      tokens_cache_read   INTEGER,
      tokens_cache_write  INTEGER,
      est_cost            REAL,
      source              TEXT NOT NULL,
      tags                TEXT NOT NULL DEFAULT '[]',
      attrs               TEXT NOT NULL DEFAULT '{}'
    )
  `);

  db.exec(`
    CREATE TABLE messages (
      id          TEXT PRIMARY KEY,
      trace_id    TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
      span_id     TEXT REFERENCES spans(id) ON DELETE SET NULL,
      seq         INTEGER NOT NULL,
      role        TEXT NOT NULL,
      payload_id  TEXT NOT NULL REFERENCES payloads(id)
    )
  `);

  db.exec(`
    CREATE TABLE raw_events (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      source      TEXT NOT NULL,
      hook_name   TEXT,
      received_at TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'processed',
      error       TEXT,
      raw         BLOB NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE tailer_offsets (
      transcript_path   TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      committed_offset  INTEGER NOT NULL,
      file_identity     TEXT
    )
  `);

  // `IF NOT EXISTS`: the runner pre-creates this so it can read the version
  // before any migration runs (see migrate.ts getSchemaVersion).
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_state (
      key    TEXT PRIMARY KEY,
      value  TEXT
    )
  `);

  // --- FTS5 external-content over payloads ---------------------------------
  // Keyed on the implicit integer rowid (payloads has a TEXT PK, so we key FTS
  // on rowid, not id). Population/scope is Phase-7's concern; 001 only wires it.
  db.exec(`
    CREATE VIRTUAL TABLE payloads_fts USING fts5(
      content,
      content='payloads',
      content_rowid='rowid'
    )
  `);

  // --- Indexes (spec/data-model.md §Indexes) -------------------------------
  db.exec(`CREATE INDEX idx_sessions_started_at ON sessions(started_at DESC)`);
  db.exec(`CREATE INDEX idx_sessions_project_started ON sessions(project_path, started_at)`);
  db.exec(`CREATE INDEX idx_sessions_status ON sessions(status)`);
  db.exec(`CREATE INDEX idx_traces_session_turn ON traces(session_id, turn_seq)`);
  db.exec(`CREATE INDEX idx_spans_trace_started ON spans(trace_id, started_at)`);
  db.exec(`CREATE INDEX idx_spans_trace_status ON spans(trace_id, status)`);
  db.exec(`CREATE INDEX idx_spans_type_name ON spans(span_type, name)`);
  db.exec(`CREATE INDEX idx_messages_trace_seq ON messages(trace_id, seq)`);
  db.exec(`CREATE INDEX idx_raw_events_session ON raw_events(session_id)`);
  db.exec(`CREATE INDEX idx_raw_events_status ON raw_events(status)`);
}

/** Migration 001: the full production schema. */
export const migration001: Migration = {
  version: 1,
  name: 'initial-schema',
  up,
};
