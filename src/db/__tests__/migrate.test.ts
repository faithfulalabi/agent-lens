import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  runMigrations,
  getSchemaVersion,
  SchemaTooNewError,
} from '../migrate.js';

/** Names of the 8 production tables migration 001 creates. */
const EXPECTED_TABLES = [
  'sessions',
  'traces',
  'spans',
  'payloads',
  'messages',
  'raw_events',
  'tailer_offsets',
  'system_state',
] as const;

/** The 10 named indexes from spec/data-model.md §Indexes (PK-only tables excluded). */
const EXPECTED_INDEXES = [
  'idx_sessions_started_at',
  'idx_sessions_project_started',
  'idx_sessions_status',
  'idx_traces_session_turn',
  'idx_spans_trace_started',
  'idx_spans_trace_status',
  'idx_spans_type_name',
  'idx_messages_trace_seq',
  'idx_raw_events_session',
  'idx_raw_events_status',
] as const;

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe('runMigrations — AC1: fresh start, re-start no-op, version recorded', () => {
  it('creates the full schema on a fresh DB and records the version', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);

    expect(getSchemaVersion(db)).toBe(1);

    const tables = tableNames(db);
    for (const t of EXPECTED_TABLES) {
      expect(tables).toContain(t);
    }
    expect(tables).toContain('payloads_fts');
  });

  it('is a no-op on re-run (applies zero migrations, no throw)', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(1);
  });

  it('stamps app_version diagnostically', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    const row = db
      .prepare(`SELECT value FROM system_state WHERE key = 'app_version'`)
      .get() as { value: string } | undefined;
    expect(row?.value).toBeTruthy();
  });
});

describe('runMigrations — AC2: ordered application + downgrade guard', () => {
  it('applies migration 001 in order from an unversioned DB', () => {
    const db = new DatabaseSync(':memory:');
    expect(getSchemaVersion(db)).toBe(0);
    runMigrations(db);
    expect(getSchemaVersion(db)).toBe(1);
  });

  it('throws SchemaTooNewError on a newer-versioned DB and leaves it untouched', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare(`INSERT INTO system_state (key, value) VALUES ('schema_version', '999')`).run();

    expect(() => runMigrations(db)).toThrow(SchemaTooNewError);
    // No production tables were created (no partial DDL).
    expect(tableNames(db)).not.toContain('sessions');
  });

  it('resets a legacy Phase-1 DB (spans_lite, no version) to the full schema', () => {
    const db = new DatabaseSync(':memory:');
    // Simulate the Task 1.3 minimal schema.
    db.exec(`CREATE TABLE raw_events (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source TEXT NOT NULL,
      hook_name TEXT, received_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'processed',
      raw TEXT NOT NULL)`);
    db.exec(`CREATE TABLE spans_lite (
      seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      source TEXT NOT NULL, hook_name TEXT, ts TEXT NOT NULL)`);

    runMigrations(db);

    expect(getSchemaVersion(db)).toBe(1);
    const tables = tableNames(db);
    for (const t of EXPECTED_TABLES) {
      expect(tables).toContain(t);
    }
    // raw_events now carries the corrected BLOB column.
    const cols = db.prepare(`PRAGMA table_info(raw_events)`).all() as {
      name: string;
      type: string;
    }[];
    const rawCol = cols.find((c) => c.name === 'raw');
    expect(rawCol?.type).toBe('BLOB');
    // spans_lite compat table survives for Phase-1 ingest.
    expect(tables).toContain('spans_lite');
  });
});

describe('runMigrations — AC3: all data-model indexes exist', () => {
  it('creates exactly the 10 named indexes', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);

    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
           ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(names.sort()).toEqual([...EXPECTED_INDEXES].sort());
  });
});

describe('runMigrations — AC4: FTS5 insert + MATCH round-trip', () => {
  it('round-trips text through payloads_fts', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);

    db.exec(
      `INSERT INTO payloads (id, content, byte_size) VALUES ('h1', 'hello world', 11)`,
    );
    db.exec(`INSERT INTO payloads_fts (rowid, content) SELECT rowid, content FROM payloads`);

    const row = db
      .prepare(`SELECT content FROM payloads_fts WHERE payloads_fts MATCH 'hello'`)
      .get() as { content: string } | undefined;
    expect(row?.content).toBe('hello world');
  });
});
