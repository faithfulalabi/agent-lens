// Opening cache.db, in the one order that is safe.
//
// The lock comes BEFORE the constructor. Measured on node:sqlite/Node 26:
// unlinking cache.db while another process holds a handle forks the database
// silently — the old process keeps reading a ghost inode, its INSERTs succeed
// with no exception, and the rows are lost on close. A lock taken after the
// constructor leaves that window open.
//
// The connection pragmas are re-applied on EVERY open, not left to the DDL
// header. Measured: busy_timeout reverts to 0 and synchronous to FULL on reopen,
// and the DDL runs only on create — so a busy_timeout set there is live exactly
// once. Two writers with busy_timeout=0 starve each other on 311-372 of 800
// transactions; with 5000 they starve on none.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireLock, type Lock, type LockIdentity } from '../archive/lock.js';
import { SCHEMA_DDL, SCHEMA_VERSION } from './schema.js';

export const CACHE_DB_FILE = 'cache.db';
export const CACHE_LOCK_FILE = 'cache.db.lock';

/** A second instance found the data dir locked. `holderPid` is the live holder. */
export class DbLockedError extends Error {
  readonly holderPid: number | undefined;

  constructor(message: string, holderPid: number | undefined) {
    super(message);
    this.name = 'DbLockedError';
    this.holderPid = holderPid;
  }
}

export interface OpenDbOptions {
  dataDir: string;
  /**
   * The port the CALLER wants, never the holder's bound port — `startServer`
   * auto-increments off 4470, so the holder routinely listens elsewhere.
   */
  port?: number;
  /** Injectable identity + clock, so the lock reclaim rows stay testable. */
  identity?: LockIdentity;
  /** Injectable so the "WAL did not take" limb is reachable off a network fs. */
  readJournalMode?: (db: DatabaseSync) => string;
}

export interface OpenedDb {
  db: DatabaseSync;
  /** Closes the handle, THEN releases the lock. Never the other way round. */
  close: () => void;
}

/**
 * Connection-scoped pragmas, re-applied on every open. Exported because the
 * two-writer test drives raw handles through it: the lock refuses a second
 * openDb, so busy_timeout is otherwise unreachable from a real caller.
 */
export function applyConnectionPragmas(db: DatabaseSync): void {
  // busy_timeout FIRST, and the order is a fix rather than a style. The journal
  // mode change takes a brief exclusive lock of its own, so with the default
  // timeout of 0 it throws `database is locked` the moment another connection is
  // mid-transaction — measured, as a flake in the two-writer test. It does not
  // retry itself, and it fails SOFT: the mode stays whatever it was.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
}

/** Read back rather than assumed: WAL fails soft to `delete` on some filesystems. */
function journalModeOf(db: DatabaseSync): string {
  return String(
    (db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown })?.journal_mode,
  );
}

function userVersionOf(db: DatabaseSync): number {
  return Number(
    (db.prepare('PRAGMA user_version').get() as { user_version?: unknown })?.user_version,
  );
}

function connect(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  applyConnectionPragmas(db);
  return db;
}

function shutdown(db: DatabaseSync | undefined, lock: Lock): void {
  if (db?.isOpen === true) db.close();
  lock.release();
}

/**
 * A reading handle on an EXISTING cache.db: no lock, no pragmas, no schema
 * check. `undefined` when the file is absent, so a reporting caller can say "no
 * cache yet" instead of manufacturing the evidence it is reporting on.
 *
 * NO `applyConnectionPragmas`: `journal_mode = WAL` is a write, and this handle
 * must not take the exclusive step a running server would then wait on.
 *
 * MEASURED on node:sqlite/Node 26, both arms:
 *   - With a writer live in another process — WAL handle held, an IMMEDIATE
 *     transaction open — a read-only connection reads committed rows fine, and
 *     an INSERT through it fails `attempt to write a readonly database`.
 *   - With NO writer and the `-shm` already checkpointed away, SQLite RECREATES
 *     `cache.db-wal` and `cache.db-shm` beside the database to read it. Two
 *     empty sidecars of SQLite's own, next to a file that already exists — never
 *     the database itself, which is why the `existsSync` above is the guard that
 *     matters. Stated rather than hidden: the caller's own docs say it writes
 *     nothing, and this is the one qualification on that.
 *
 * Throws whatever the constructor throws (`file is not a database` on a torn
 * file); the caller decides whether that is fatal.
 */
export function openReadOnlyDb(dataDir: string): DatabaseSync | undefined {
  const path = join(dataDir, CACHE_DB_FILE);
  if (!existsSync(path)) return undefined;
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * Takes the single-instance lock, then opens cache.db, recreating it when
 * `user_version` does not match `SCHEMA_VERSION`. Throws `DbLockedError` when
 * another instance holds the data dir.
 */
export function openDb(options: OpenDbOptions): OpenedDb {
  const { dataDir, port, identity, readJournalMode = journalModeOf } = options;
  const lockPath = join(dataDir, CACHE_LOCK_FILE);
  const lock = acquireLock(dataDir, identity, lockPath);

  if (lock.state.state === 'held') {
    const holderPid = lock.state.holder_pid;
    const who = `agent-lens is already running (pid ${holderPid ?? 'unknown'})`;
    throw new DbLockedError(
      port === undefined ? `${who}; ${lockPath} is held` : `${who}; port ${port} was requested`,
      holderPid,
    );
  }

  // The connect is INSIDE the try. `new DatabaseSync` opens lazily, so a torn
  // cache.db surfaces as `file is not a database` from the first pragma — and a
  // lock left behind there carries this process's own live pid, which row 2 of
  // the stale table then honours until the process exits.
  const path = join(dataDir, CACHE_DB_FILE);
  let handle: DatabaseSync | undefined;
  try {
    handle = connect(path);
    if (userVersionOf(handle) !== SCHEMA_VERSION) {
      handle.close();
      // `force` is load-bearing, not tidiness: a first run reads user_version 0,
      // so the fresh-machine path IS this branch, with no -wal/-shm on disk.
      for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
      handle = connect(path);
      handle.exec(SCHEMA_DDL);
    }

    const mode = readJournalMode(handle);
    if (mode !== 'wal') {
      throw new Error(`refusing to use ${path}: journal_mode read back '${mode}', not 'wal'`);
    }

    const db = handle;
    return { db, close: () => shutdown(db, lock) };
  } catch (error) {
    shutdown(handle, lock);
    throw error;
  }
}
