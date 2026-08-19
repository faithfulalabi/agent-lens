// Tests 4-12 — the open order, the release surface, the refusal, and the
// pragmas that revert if nobody re-applies them.
//
// EVERY REOPEN LIMB CALLS close() FIRST. Measured against archive/lock.ts:
// a second acquireLock IN THE SAME PROCESS returns `held` carrying the caller's
// own pid, so two openDb calls on one data dir throw DbLockedError until the
// first releases. That is not a quirk of the tests; it is what AC4's release
// surface exists for.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_LOCK_AGE_MS } from '../../archive/lock.js';
import { ensureDir } from '../../archive/paths.js';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import {
  applyConnectionPragmas,
  CACHE_DB_FILE,
  CACHE_LOCK_FILE,
  DbLockedError,
  openDb,
  type OpenDbOptions,
  type OpenedDb,
} from '../open.js';
import { SCHEMA_VERSION } from '../schema.js';

const HERE = resolve(import.meta.dirname, '../../..');
const TSX = join(HERE, 'node_modules', '.bin', 'tsx');
const OPEN_MODULE = resolve(import.meta.dirname, '..', 'open.ts');

let sandbox: Sandbox | undefined;
const handles: OpenedDb[] = [];

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

/** `openDb`, with teardown attached. `close()` is idempotent, so arms may close early. */
function open(options: OpenDbOptions): OpenedDb {
  const handle = openDb(options);
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

function dbPath(s: Sandbox): string {
  return join(s.dataDir, CACHE_DB_FILE);
}

function lockPath(s: Sandbox): string {
  return join(s.dataDir, CACHE_LOCK_FILE);
}

function writeLock(s: Sandbox, record: unknown): string {
  ensureDir(s.dataDir);
  const path = lockPath(s);
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record), {
    mode: 0o600,
  });
  return path;
}

function heldBy(pid: number): { pid: number; started_at: number; hostname: string } {
  return { pid, started_at: Date.now(), hostname: hostname() };
}

const INSERT_SESSION = `INSERT INTO sessions
  (id, source_path, archive_path, file_mtime_ms, file_size, project_path, started_at, last_activity_at)
  VALUES (?, '/src.jsonl', '/arch.jsonl', 1, 2, '/proj', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')`;

function sessionCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n);
}

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

describe('a version mismatch removes and recreates (AC3)', () => {
  it('drops the stale projection, and the sidecars are gone only after close()', () => {
    const s = sb();
    const first = open({ dataDir: s.dataDir });
    first.db.prepare(INSERT_SESSION).run('s1');
    first.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    first.close();

    const second = open({ dataDir: s.dataDir });

    // These two ARE the recreate proof.
    expect(userVersion(second.db)).toBe(SCHEMA_VERSION);
    expect(sessionCount(second.db)).toBe(0);

    // Only now. openDb returns a LIVE WAL handle, so -wal/-shm exist on disk the
    // instant it returns — this step reds unconditionally at the point above.
    // What it proves is that close() really closed the handle, NOT that the
    // removal ran: a clean close checkpoints and unlinks them regardless.
    second.close();
    expect(readdirSync(s.dataDir).sort()).toEqual([CACHE_DB_FILE]);
  });

  it('a fresh data dir takes the same branch and does not throw ENOENT', () => {
    // The removal is ENOENT-tolerant because THIS is the common path, not a
    // corner: a brand-new cache.db reads user_version 0, which mismatches, so
    // the first run on a new machine removes -wal/-shm that were never there.
    const s = sb();
    expect(existsSync(s.dataDir)).toBe(false);

    const opened = open({ dataDir: s.dataDir });

    expect(userVersion(opened.db)).toBe(SCHEMA_VERSION);
    expect(sessionCount(opened.db)).toBe(0);
    opened.db.prepare(INSERT_SESSION).run('s1');
    expect(sessionCount(opened.db)).toBe(1);
  });
});

describe('★ the lock is taken before the database is opened (AC4)', () => {
  it('a refused open creates no cache.db at all', () => {
    // Behavioural, not a source grep: a lock taken AFTER the constructor leaves
    // the file behind, so this assertion is what separates the two orders.
    const s = sb();
    writeLock(s, heldBy(4242));

    expect(() =>
      openDb({ dataDir: s.dataDir, identity: { pid: 9999, isAlive: () => 'alive' } }),
    ).toThrow(DbLockedError);

    expect(existsSync(dbPath(s))).toBe(false);
    expect(readdirSync(s.dataDir).sort()).toEqual([CACHE_LOCK_FILE]);
  });

  it('a cache.db that is not a database releases the lock instead of wedging it', () => {
    // `new DatabaseSync` opens lazily, so torn bytes surface from the first
    // pragma — inside openDb, with the lock already taken. A lock leaked there
    // records THIS process's live pid, which row 2 of the stale table honours at
    // any age: every later open, in any process, would refuse until this one
    // exits. No handle survives the throw, so releasing is safe as well as
    // mandatory.
    const s = sb();
    ensureDir(s.dataDir);
    writeFileSync(dbPath(s), 'this is not a database');

    expect(() => openDb({ dataDir: s.dataDir })).toThrow(/not a database/i);

    expect(existsSync(lockPath(s))).toBe(false);
  });

  it('★ close() releases the lock, so one process can reopen', () => {
    const s = sb();
    const first = open({ dataDir: s.dataDir });
    expect(existsSync(lockPath(s))).toBe(true);

    first.close();
    expect(existsSync(lockPath(s))).toBe(false);

    // Genuinely red without the release surface: the second acquireLock in one
    // process returns `held` carrying this process's own pid.
    const second = open({ dataDir: s.dataDir });
    expect(existsSync(lockPath(s))).toBe(true);
    expect(userVersion(second.db)).toBe(SCHEMA_VERSION);
  });
});

describe('★ the unlink forks the database, and the lock is what stops it (AC4)', () => {
  it('WITHOUT a lock the writes vanish, and nothing throws to say so', () => {
    const s = sb();
    ensureDir(s.dataDir);
    const path = dbPath(s);
    const ghost = new DatabaseSync(path);
    applyConnectionPragmas(ghost);
    ghost.exec('CREATE TABLE t (v TEXT)');
    ghost.prepare('INSERT INTO t VALUES (?)').run('before');

    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });

    // The defect, in one line: a caller cannot detect this.
    expect(() => ghost.prepare('INSERT INTO t VALUES (?)').run('after')).not.toThrow();
    expect(ghost.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 });
    ghost.close();

    const fresh = new DatabaseSync(path);
    const tables = fresh.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'");
    expect(tables.get()).toEqual({ n: 0 });
    fresh.close();
  });

  it('WITH it the second instance is refused, so the first keeps its rows', () => {
    const s = sb();
    const first = open({ dataDir: s.dataDir });
    first.db.prepare(INSERT_SESSION).run('s1');

    expect(() => openDb({ dataDir: s.dataDir })).toThrow(DbLockedError);

    first.close();
    const second = open({ dataDir: s.dataDir });
    expect(sessionCount(second.db)).toBe(1);
  });
});

describe('the second instance refuses explicitly (AC5)', () => {
  it('names the CALLER’S intended port, never a port anything is listening on', () => {
    // Deterministic holder: a real sleeping process, so the liveness row fires
    // with no timing assumption (lock.test.ts:217-239).
    const s = sb();
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      writeLock(s, heldBy(holder.pid!));

      const thrown = catchOf(() => openDb({ dataDir: s.dataDir, port: 4317 }));

      expect(thrown).toBeInstanceOf(DbLockedError);
      expect((thrown as DbLockedError).holderPid).toBe(holder.pid);
      expect((thrown as Error).message).toContain(`pid ${holder.pid}`);
      expect((thrown as Error).message).toContain('port 4317 was requested');
      // Pins the wording against drifting back to the false claim. startServer
      // auto-increments off DEFAULT_PORT on EADDRINUSE, so a holder listening on
      // 4471 while the second instance names 4470 is the common case.
      expect((thrown as Error).message).not.toContain('on port');
      expect(existsSync(dbPath(s))).toBe(false);
    } finally {
      holder.kill('SIGKILL');
    }
  }, 60000);

  it('with no port it names the holder pid and the lock path', () => {
    const s = sb();
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      writeLock(s, heldBy(holder.pid!));

      const thrown = catchOf(() => openDb({ dataDir: s.dataDir }));

      // A DbLockedError and nothing else: no config.json is written, read or
      // parsed anywhere in this module, so a malformed one cannot turn the
      // refusal into a SyntaxError.
      expect(thrown).toBeInstanceOf(DbLockedError);
      expect((thrown as Error).message).toContain(`pid ${holder.pid}`);
      expect((thrown as Error).message).toContain(lockPath(s));
      expect((thrown as Error).message).not.toContain('port');
    } finally {
      holder.kill('SIGKILL');
    }
  }, 60000);
});

describe('the connection pragmas are applied on EVERY open (AC6)', () => {
  it('★ busy_timeout reads 5000 after a first open AND after close + reopen', () => {
    const s = sb();
    const first = open({ dataDir: s.dataDir });
    expect(first.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    first.close();

    // The whole regression guard. Measured: busy_timeout reverts to 0 and
    // synchronous to FULL on reopen, and the DDL runs only on create — so a
    // busy_timeout left to the DDL header passes the limb above and fails this
    // one, re-shipping the starvation on every open after the first.
    const second = open({ dataDir: s.dataDir });
    expect(second.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    expect(second.db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 });
    second.close();

    // …and the 5000 came from the applier, not from the file: a raw handle on
    // the very same bytes reads the reverted values.
    const raw = new DatabaseSync(dbPath(s));
    try {
      expect(raw.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 });
      expect(raw.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    } finally {
      raw.close();
    }
  });

  it('sets busy_timeout BEFORE journal_mode, so the mode change has a retry window', () => {
    // Asserted at the source, the way this repo's other structural guards are,
    // because no behavioural test pins it: the mode change short-circuits on an
    // already-WAL file most of the time and fails only inside a narrow race. It
    // surfaced as a flake in the two-writer arms below. Reversed, the mode change
    // runs with the default timeout of 0, throws `database is locked` against a
    // concurrent writer, does not retry itself, and fails SOFT — leaving the
    // journal mode at whatever it already was.
    const source = readFileSync(join(import.meta.dirname, '..', 'open.ts'), 'utf8');
    const busy = source.indexOf("db.exec('PRAGMA busy_timeout = 5000')");
    const journal = source.indexOf("db.exec('PRAGMA journal_mode = WAL')");

    expect(busy).toBeGreaterThan(-1);
    expect(journal).toBeGreaterThan(-1);
    expect(busy).toBeLessThan(journal);
  });

  it('journal_mode is read BACK, and openDb refuses anything but wal', () => {
    const s = sb();
    const opened = open({ dataDir: s.dataDir });
    expect(opened.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    opened.close();

    // Injected through the same read seam: WAL is unavailable on some network
    // filesystems and fails soft to `delete`, which a write-only PRAGMA hides.
    expect(() => openDb({ dataDir: s.dataDir, readJournalMode: () => 'delete' })).toThrow(
      /journal_mode read back 'delete'/,
    );

    // The refusal released the lock rather than wedging the data dir shut.
    expect(existsSync(lockPath(s))).toBe(false);
    open({ dataDir: s.dataDir });
  });
});

describe('two writers through applyConnectionPragmas (AC6)', () => {
  // NOT through openDb, and saying why is the point: AC4's lock refuses the
  // second process before it ever opens the file, so the production two-writer
  // case is unreachable by construction and the pragma would ship untested.

  const WRITER = `
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyConnectionPragmas } from ${JSON.stringify(OPEN_MODULE)};

const [dbFile, tag, mode] = process.argv.slice(2);
const dir = dirname(dbFile);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

// Barrier: overlap is the property under test, so neither child may finish
// before the other starts. Without it the two can serialize and the control arm
// reports zero contention for a reason that has nothing to do with the pragma.
writeFileSync(join(dir, 'ready-' + tag), '');
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  if (existsSync(join(dir, 'ready-a')) && existsSync(join(dir, 'ready-b'))) break;
  Atomics.wait(sleeper, 0, 0, 5);
}

const db = new DatabaseSync(dbFile);
applyConnectionPragmas(db);
// The control drives the SAME body; the override is the only delta.
if (mode === 'starve') db.exec('PRAGMA busy_timeout = 0');

const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
let committed = 0;
let busy = 0;
let other = 0;
for (let i = 0; i < 400; i++) {
  try {
    db.exec('BEGIN IMMEDIATE');
    insert.run(tag + '-' + i, 'x');
    db.exec('COMMIT');
    committed += 1;
  } catch (error) {
    if (/locked|busy/i.test(String(error))) busy += 1;
    else other += 1;
    try {
      db.exec('ROLLBACK');
    } catch {}
  }
}
db.close();
process.stdout.write(JSON.stringify({ committed, busy, other }));
`;

  interface WriterReport {
    committed: number;
    busy: number;
    other: number;
  }

  function writerScript(s: Sandbox): string {
    const path = join(s.root, 'writer.ts');
    writeFileSync(path, WRITER);
    return path;
  }

  function runWriter(script: string, s: Sandbox, tag: string, mode: string): Promise<WriterReport> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(TSX, [script, dbPath(s), tag, mode], {
        env: { ...process.env, AGENT_LENS_DIR: s.dataDir },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.on('close', (status) => {
        if (status === 0) resolvePromise(JSON.parse(stdout) as WriterReport);
        else rejectPromise(new Error(`writer ${tag} exited ${String(status)}: ${stderr}`));
      });
    });
  }

  /** WAL must be on disk BEFORE either child spawns — measurement 14. */
  function seedWalFile(s: Sandbox): string {
    open({ dataDir: s.dataDir }).close();
    return writerScript(s);
  }

  it('★ 800 of 800 commit, with zero SQLITE_BUSY', async () => {
    // On a delete-mode file with a reader holding a transaction, a child's
    // `PRAGMA journal_mode = WAL` throws, reads back `delete`, and never retries
    // — busy_timeout does not rescue it. The test would then measure two writers
    // on a rollback journal while claiming to measure WAL.
    const s = sb();
    const script = seedWalFile(s);

    const [a, b] = await Promise.all([
      runWriter(script, s, 'a', 'applier'),
      runWriter(script, s, 'b', 'applier'),
    ]);

    // The invariant, never which process won (lock.test.ts:242-278).
    expect(a.other + b.other).toBe(0);
    expect(a.busy + b.busy).toBe(0);
    expect(a.committed + b.committed).toBe(800);
  }, 60000);

  it('the same load with busy_timeout = 0 starves — non-zero, never a fixed count', async () => {
    // Measured 311 / 362 / 370 / 372 of 800, split unevenly and differently every
    // run. The count is load-dependent; the assertable invariant is zero versus
    // non-zero, so this must never grow a number.
    const s = sb();
    const script = seedWalFile(s);

    const [a, b] = await Promise.all([
      runWriter(script, s, 'a', 'starve'),
      runWriter(script, s, 'b', 'starve'),
    ]);

    expect(a.other + b.other).toBe(0);
    expect(a.busy + b.busy).toBeGreaterThan(0);
    expect(a.committed + b.committed).toBeLessThan(800);
  }, 60000);
});

describe('the inherited stale-lock policy, through the LockIdentity seam (AC4)', () => {
  // No real pids and no sleeps: rows 2, 3 and 5 of archive/lock.ts:111-119,
  // reached through openDb rather than re-argued here.

  it('a dead holder is reclaimed, and openDb proceeds', () => {
    const s = sb();
    writeLock(s, heldBy(999999));

    const opened = open({ dataDir: s.dataDir, identity: { pid: 4242, isAlive: () => 'dead' } });

    expect(userVersion(opened.db)).toBe(SCHEMA_VERSION);
    expect(JSON.parse(readFileSync(lockPath(s), 'utf8')).pid).toBe(4242);
  });

  it('a live same-host holder is held at any age', () => {
    const s = sb();
    const now = Date.now();
    writeLock(s, {
      pid: 5150,
      started_at: now - MAX_LOCK_AGE_MS * 10,
      hostname: hostname(),
    });

    expect(() =>
      openDb({ dataDir: s.dataDir, identity: { pid: 4242, now, isAlive: () => 'alive' } }),
    ).toThrow(DbLockedError);
    expect(existsSync(dbPath(s))).toBe(false);
  });

  it('an unparseable record is held while fresh, and reclaimed once aged', () => {
    const s = sb();
    const path = writeLock(s, 'not json at all');
    const mtime = statSync(path).mtimeMs;

    const thrown = catchOf(() =>
      openDb({ dataDir: s.dataDir, identity: { pid: 4242, now: mtime + 1000 } }),
    );

    // There is no pid to name here, and the message must still be constructible.
    expect(thrown).toBeInstanceOf(DbLockedError);
    expect((thrown as DbLockedError).holderPid).toBeUndefined();
    expect((thrown as Error).message).toContain('pid unknown');

    const opened = open({
      dataDir: s.dataDir,
      identity: { pid: 4242, now: mtime + MAX_LOCK_AGE_MS + 1000 },
    });
    expect(userVersion(opened.db)).toBe(SCHEMA_VERSION);
  });
});

/** The thrown value, so an arm can assert its type AND its message. */
function catchOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw, got none');
}
