// The advisory single-pass lock.
//
// THIS IS A CORRECTNESS PRECONDITION, NOT DEFENCE IN DEPTH. Do not "optimise" it
// away as redundant. `mirror.ts` writes positionally (`writeSync(fd, ..., pos)`)
// rather than with `O_APPEND`, because `O_APPEND` lets the kernel pick the offset
// and two overlapping cron runs would each append their own delta and duplicate
// bytes into the system of record. But a positional write PAST EOF creates a
// sparse NUL hole that `statSync().size` reports as real content:
//
//   writeSync(fd,'AAAA',0,4,0); writeSync(fd,'CCCC',0,4,12)
//   -> size 16, bytes: 41 41 41 41 00*8 43 43 43 43
//
// With a chunked copy loop, two concurrent passes can land chunk N+1 before
// chunk N; a crash in that window leaves an archive whose size and head hash both
// look fine and which the next pass therefore extends from the wrong offset —
// permanent silent corruption. `archiveOnce` copies ZERO bytes when it cannot
// acquire this lock. Invariant W (`mirror.ts`) is the second line of defence and
// turns a lock bug into a loud throw rather than a hole.
//
// Written to be absorbed by task 3.4's general single-instance lock, not
// duplicated by it.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname } from 'node:path';
import { ensureDir, resolveLockPath, statSafe } from './paths.js';

/**
 * How long a STALE RECORD is trusted — never how long a running process is
 * allowed to run. See the ordered policy below: liveness outranks age.
 */
export const MAX_LOCK_AGE_MS = 60 * 60 * 1000;

export type ReclaimReason = 'esrch' | 'foreign-host' | 'unparseable';

/** Reported in `--json` so a stuck lock is visible to `doctor` instead of swallowed by exit 0. */
export interface LockState {
  state: 'acquired' | 'held' | 'reclaimed';
  holder_pid?: number;
  age_ms?: number;
  reclaim_reason?: ReclaimReason;
}

export interface Lock {
  state: LockState;
  /** Best-effort, never throws. Deletes the lock file only if it is still ours. */
  release: () => void;
}

/** Injectable identity + clock, so the five ordered rows are testable without spawning processes. */
export interface LockIdentity {
  pid?: number;
  hostname?: string;
  now?: number;
  /** `process.kill(pid, 0)` by default. */
  isAlive?: (pid: number) => 'alive' | 'dead' | 'permission-denied';
}

interface LockRecord {
  pid: number;
  started_at: number;
  hostname: string;
}

function defaultIsAlive(pid: number): 'alive' | 'dead' | 'permission-denied' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    // EPERM means the process EXISTS and is owned by another user. Treating it
    // as dead (the naive `try { kill } catch { stale }` shape) steals a live
    // holder's lock — verified: `process.kill(1, 0)` throws EPERM for launchd.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'permission-denied' : 'dead';
  }
}

function parseRecord(raw: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { pid, started_at, hostname } = parsed as Partial<LockRecord>;
    // `pid <= 0` is rejected on purpose: `process.kill(0, sig)` and negative pids
    // signal whole process GROUPS. A corrupt lock file must never be able to
    // steer a signal, not even signal 0.
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    return {
      pid,
      started_at: typeof started_at === 'number' ? started_at : 0,
      hostname: typeof hostname === 'string' ? hostname : '',
    };
  } catch {
    return undefined;
  }
}

/** Create the lock file exclusively, or report `EEXIST` by returning false. */
function tryCreate(lockPath: string, record: LockRecord): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Delete the lock file only when it still records `pid`.
 *
 * A naive `unlinkSync` on exit deletes its SUCCESSOR's lock: process A is
 * reclaimed from, B creates its own lock and starts copying, A then exits and
 * unlinks — reopening the exact concurrent-chunk window this lock exists to
 * close. Best-effort by design: a SIGKILLed process releases nothing at all,
 * which is precisely what the reclaim rows below exist to clean up.
 */
export function releaseLock(lockPath: string, pid: number): void {
  try {
    const record = parseRecord(readFileSync(lockPath, 'utf8'));
    if (record?.pid === pid) unlinkSync(lockPath);
  } catch {
    // Gone, unreadable, or someone else's — leave it alone.
  }
}

/**
 * Acquire the pass lock.
 *
 * The reclaim rows are ORDERED and MUTUALLY EXCLUSIVE — first match wins, and
 * liveness outranks age:
 *
 *   1. `kill(pid,0)` throws EPERM        -> alive, other user  -> HELD
 *   2. `kill(pid,0)` succeeds && same host -> alive            -> HELD, regardless of age
 *   3. `kill(pid,0)` throws ESRCH        -> dead               -> reclaim 'esrch'
 *   4. recorded hostname differs         -> pid is meaningless -> reclaim 'foreign-host'
 *   5. unparseable / missing pid         -> reclaim, aged against the file's mtime
 *
 * Age is a tiebreaker inside rows 3-5, NEVER an override of rows 1-2. A
 * provably live same-host holder is held forever and surfaces as a stuck lock in
 * the log and in `doctor` — visible and correct — rather than being silently
 * overrun by a second pass mid-copy.
 */
export function acquireLock(dataDir: string, identity: LockIdentity = {}): Lock {
  const pid = identity.pid ?? process.pid;
  const hostname = identity.hostname ?? osHostname();
  const now = identity.now ?? Date.now();
  const isAlive = identity.isAlive ?? defaultIsAlive;

  const lockPath = resolveLockPath(dataDir);
  ensureDir(dirname(lockPath));
  const mine: LockRecord = { pid, started_at: now, hostname };

  if (tryCreate(lockPath, mine)) {
    return {
      state: { state: 'acquired', holder_pid: pid },
      release: () => releaseLock(lockPath, pid),
    };
  }

  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    // Vanished between `wx` and the read: the holder released. One retry.
    return tryCreate(lockPath, mine)
      ? { state: { state: 'acquired', holder_pid: pid }, release: () => releaseLock(lockPath, pid) }
      : { state: { state: 'held' }, release: () => {} };
  }

  const record = parseRecord(raw);
  const held = (extra: Partial<LockState>): Lock => ({
    state: { state: 'held', ...extra },
    release: () => {},
  });

  if (record === undefined) {
    // Row 5.
    const mtime = statSafe(lockPath)?.mtimeMs ?? 0;
    const age = now - mtime;
    if (age <= MAX_LOCK_AGE_MS) return held({ age_ms: age });
    return reclaim(lockPath, mine, 'unparseable', undefined, age);
  }

  const age = now - record.started_at;
  const liveness = isAlive(record.pid);

  if (liveness === 'permission-denied') return held({ holder_pid: record.pid, age_ms: age }); // row 1
  if (liveness === 'alive' && record.hostname === hostname) {
    return held({ holder_pid: record.pid, age_ms: age }); // row 2
  }
  if (liveness === 'dead') return reclaim(lockPath, mine, 'esrch', record.pid, age); // row 3
  return reclaim(lockPath, mine, 'foreign-host', record.pid, age); // row 4
}

/**
 * Unlink then ONE retry of `wx`. If the retry also `EEXIST`s another pass won the
 * race — report held and do not loop.
 */
function reclaim(
  lockPath: string,
  mine: LockRecord,
  reason: ReclaimReason,
  holderPid: number | undefined,
  ageMs: number,
): Lock {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone: the retry below decides the outcome either way.
  }
  if (!tryCreate(lockPath, mine)) {
    return { state: { state: 'held', holder_pid: holderPid, age_ms: ageMs }, release: () => {} };
  }
  return {
    state: { state: 'reclaimed', holder_pid: holderPid, age_ms: ageMs, reclaim_reason: reason },
    release: () => releaseLock(lockPath, mine.pid),
  };
}
