// Migration runner: applies pending migrations in order, tracks the schema
// version in `system_state`, and guards against downgrades. Also owns the
// connection-level pragmas (WAL, foreign_keys, busy_timeout, synchronous) so
// fresh and migrated DBs behave identically. The ONLY migration entry point.

import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations/index.js';

/** The `system_state` key holding the integer schema version. */
const SCHEMA_VERSION_KEY = 'schema_version';
/** The `system_state` key holding the app version (diagnostic only). */
const APP_VERSION_KEY = 'app_version';

/** agent-lens release version, stamped diagnostically. Mirrors package.json. */
const APP_VERSION = '0.0.0';

/**
 * Thrown when the DB's `schema_version` is newer than any known migration —
 * i.e. an older binary opened a DB written by a newer one. We refuse to run
 * rather than risk applying stale DDL over a newer schema.
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly current: number,
    readonly latest: number,
  ) {
    super(
      `DB schema_version ${current} is newer than the latest known migration ${latest}; ` +
        `upgrade agent-lens or open with a matching version.`,
    );
    this.name = 'SchemaTooNewError';
  }
}

/** Apply connection-level pragmas. Idempotent; safe on every open. */
export function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA synchronous=NORMAL');
}

/** Upsert one `system_state` row. */
function setState(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO system_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** Read the current integer schema version, or 0 if unset. */
export function getSchemaVersion(db: DatabaseSync): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT)`,
  );
  const row = db
    .prepare(`SELECT value FROM system_state WHERE key = ?`)
    .get(SCHEMA_VERSION_KEY) as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/** True if this DB carries the legacy Phase-1 (Task 1.3) shape. */
function hasLegacySchema(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spans_lite'`,
    )
    .get() as { name: string } | undefined;
  return row !== undefined;
}

/**
 * Drop the Phase-1 minimal schema so migration 001 can build fresh. Pre-release
 * reset (founder's call, Task 2.1 approach): no data worth preserving, and
 * `raw_events` is re-created by 001 with the corrected BLOB column.
 */
function resetLegacySchema(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS spans_lite');
  db.exec('DROP TABLE IF EXISTS raw_events');
}

/** Recreate the `spans_lite` compat table Phase-1 ingest still reads/writes. */
function ensureSpansLiteCompat(db: DatabaseSync): void {
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

/**
 * Bring the DB up to the latest schema version. Fresh DBs run every migration;
 * up-to-date DBs are a no-op; legacy Phase-1 DBs are reset first (pre-release).
 * Throws {@link SchemaTooNewError} on a newer-versioned DB (downgrade guard).
 * Each migration runs in its own transaction, stamping its version on commit.
 */
export function runMigrations(db: DatabaseSync): void {
  applyPragmas(db);

  const current = getSchemaVersion(db);
  const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

  if (current > latest) {
    throw new SchemaTooNewError(current, latest);
  }

  // Legacy Phase-1 DB (no version, has spans_lite): reset before building 001.
  if (current === 0 && hasLegacySchema(db)) {
    resetLegacySchema(db);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      setState(db, SCHEMA_VERSION_KEY, String(migration.version));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Diagnostic app-version stamp (downgrade guard keys only on schema_version).
  setState(db, APP_VERSION_KEY, APP_VERSION);

  // Keep the Phase-1 live-list table alive until Task 2.2 cuts ingest over.
  ensureSpansLiteCompat(db);
}
