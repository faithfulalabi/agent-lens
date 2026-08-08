// The advisory single-pass lock. Not defence in depth: `mirror.ts` writes
// positionally, so two concurrent passes can land chunks out of order and leave
// a sparse NUL hole the next pass then extends from the wrong offset.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname } from 'node:path';
import { ensureDir, resolveLockPath, statSafe } from './paths.js';

/** How long a stale record is trusted — never how long a live process may run. */
export const MAX_LOCK_AGE_MS = 60 * 60 * 1000;

export type ReclaimReason = 'esrch' | 'foreign-host' | 'unparseable';

/** Reported in `--json` so a stuck lock is visible instead of swallowed by exit 0. */
export interface LockState {
  state: 'acquired' | 'held' | 'reclaimed';
  holder_pid?: number;
  age_ms?: number;
  reclaim_reason?: ReclaimReason;
}

export interface Lock {
  state: LockState;
  /** Best-effort, never throws. Deletes the file only if it is still ours. */
  release: () => void;
}

/** Injectable identity + clock, so the reclaim rows are testable. */
export interface LockIdentity {
  pid?: number;
  hostname?: string;
  now?: number;
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
    // EPERM means the process exists under another user; only ESRCH means dead.
    // Treating EPERM as dead would steal a live holder's lock.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'permission-denied' : 'dead';
  }
}

function parseRecord(raw: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { pid, started_at, hostname } = parsed as Partial<LockRecord>;
    // Reject `pid <= 0`: those signal whole process groups.
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

/** Exclusive create, returning false on `EEXIST`. */
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

/** Only when it still records `pid`: an unconditional unlink deletes a successor's lock. */
export function releaseLock(lockPath: string, pid: number): void {
  try {
    const record = parseRecord(readFileSync(lockPath, 'utf8'));
    if (record?.pid === pid) unlinkSync(lockPath);
  } catch {
    // Gone, unreadable, or someone else's — leave it alone.
  }
}

/**
 * Acquire the pass lock. Rows are ordered, first match wins, and liveness
 * outranks age — age only breaks ties in rows 3-5:
 *   1. EPERM                 -> alive under another user -> held
 *   2. alive && same host    -> held, at any age
 *   3. ESRCH                 -> dead -> reclaim 'esrch'
 *   4. hostname differs      -> reclaim 'foreign-host'
 *   5. unparseable pid       -> reclaim, aged against the file's mtime
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

/** Unlink then one retry of `wx`. A second `EEXIST` means another pass won the race. */
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
