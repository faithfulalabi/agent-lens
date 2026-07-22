import { DatabaseSync } from 'node:sqlite';

// SQLite layer: migrations, queries. The only module that touches SQL.
// Filled in by Task 1.3. Placeholder export + a smoke helper that proves the
// built-in `node:sqlite` driver (Node >=24) opens and closes cleanly.
export const MODULE = 'db';

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
