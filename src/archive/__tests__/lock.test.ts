// Tests 10 and 11 — where the "two passes cannot interleave chunks" claim is proved.

import { afterEach, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireLock, MAX_LOCK_AGE_MS, releaseLock } from '../lock.js';
import { archiveOnce, type ArchiveResult } from '../mirror.js';
import { resolveLockPath, ensureDir } from '../paths.js';
import {
  archivePath,
  cleanup,
  makeSandbox,
  SLUG,
  sourcePath,
  writeSource,
  type Sandbox,
} from './fixtures.js';

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

const HERE = resolve(import.meta.dirname, '../../..');
const BIN = join(HERE, 'bin', 'agent-lens.js');

function writeLock(s: Sandbox, record: unknown): string {
  ensureDir(s.dataDir);
  const path = resolveLockPath(s.dataDir);
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record), {
    mode: 0o600,
  });
  return path;
}

describe('lock reclaim policy — ordered rows, liveness outranks age (Test 11)', () => {
  it('row 1: an EPERM holder is ALIVE and owned by another user -> HELD, never stolen', () => {
    // pid 1 is root-owned and alive, so `kill(1, 0)` throws EPERM; a naive
    // `try { kill } catch { stale }` would reclaim it.
    const s = sb();
    writeLock(s, { pid: 1, started_at: Date.now(), hostname: hostname() });

    const lock = acquireLock(s.dataDir, { pid: 4242 });

    expect(lock.state.state).toBe('held');
    expect(lock.state.holder_pid).toBe(1);
  });

  it('row 2: a live same-host holder is HELD regardless of age', () => {
    // Age must never override liveness, or a long cold start loses its lock mid-copy.
    const s = sb();
    const now = Date.now();
    writeLock(s, {
      pid: 5150,
      started_at: now - MAX_LOCK_AGE_MS * 10,
      hostname: hostname(),
    });

    const lock = acquireLock(s.dataDir, {
      pid: 4242,
      now,
      isAlive: () => 'alive',
    });

    expect(lock.state.state).toBe('held');
    expect(lock.state.age_ms).toBeGreaterThan(MAX_LOCK_AGE_MS);
  });

  it('row 3: an ESRCH holder is genuinely dead -> reclaimed', () => {
    const s = sb();
    writeLock(s, { pid: 999999, started_at: Date.now(), hostname: hostname() });

    const lock = acquireLock(s.dataDir, { pid: 4242, isAlive: () => 'dead' });

    expect(lock.state.state).toBe('reclaimed');
    expect(lock.state.reclaim_reason).toBe('esrch');
    expect(JSON.parse(readFileSync(resolveLockPath(s.dataDir), 'utf8')).pid).toBe(4242);
  });

  it('row 4: a foreign hostname makes the pid meaningless -> reclaimed', () => {
    const s = sb();
    writeLock(s, { pid: 5150, started_at: Date.now(), hostname: 'some-other-box' });

    const lock = acquireLock(s.dataDir, { pid: 4242, isAlive: () => 'alive' });

    expect(lock.state.state).toBe('reclaimed');
    expect(lock.state.reclaim_reason).toBe('foreign-host');
  });

  it('row 5: an unparseable lock is reclaimed only once it is older than MAX_LOCK_AGE_MS', () => {
    const s = sb();
    const path = writeLock(s, 'not json at all');
    const mtimeSeconds = statSync(path).mtimeMs / 1000;

    const fresh = acquireLock(s.dataDir, { pid: 4242, now: statSync(path).mtimeMs + 1000 });
    expect(fresh.state.state).toBe('held');

    // Age the file rather than the clock, so this asserts the mtime path.
    utimesSync(path, mtimeSeconds, mtimeSeconds);
    const aged = acquireLock(s.dataDir, {
      pid: 4242,
      now: statSync(path).mtimeMs + MAX_LOCK_AGE_MS + 1000,
    });
    expect(aged.state.state).toBe('reclaimed');
    expect(aged.state.reclaim_reason).toBe('unparseable');
  });

  it('a lock recording pid <= 0 is unparseable, never a signal to a process GROUP', () => {
    const s = sb();
    const path = writeLock(s, { pid: 0, started_at: 0, hostname: hostname() });
    const mtime = statSync(path).mtimeMs;

    const lock = acquireLock(s.dataDir, { pid: 4242, now: mtime + MAX_LOCK_AGE_MS + 1000 });

    expect(lock.state.state).toBe('reclaimed');
    expect(lock.state.reclaim_reason).toBe('unparseable');
  });
});

describe('guarded release (Test 11)', () => {
  it('release deletes only OUR lock file', () => {
    const s = sb();
    const lock = acquireLock(s.dataDir, { pid: process.pid });
    expect(lock.state.state).toBe('acquired');
    expect(existsSync(resolveLockPath(s.dataDir))).toBe(true);

    lock.release();

    expect(existsSync(resolveLockPath(s.dataDir))).toBe(false);
  });

  it('release-after-reclaim does NOT delete the successor lock', () => {
    // An unconditional `unlinkSync` on exit deletes a successor's lock: A is
    // reclaimed from, B starts copying, A exits and unlinks B's lock.
    const s = sb();
    const pidA = 111111;
    const pidB = 222222;
    writeLock(s, { pid: pidA, started_at: Date.now(), hostname: hostname() });

    const lockB = acquireLock(s.dataDir, { pid: pidB, isAlive: () => 'dead' });
    expect(lockB.state.state).toBe('reclaimed');

    // A now runs its release path, unaware it was reclaimed from.
    releaseLock(resolveLockPath(s.dataDir), pidA);

    expect(existsSync(resolveLockPath(s.dataDir))).toBe(true);
    expect(JSON.parse(readFileSync(resolveLockPath(s.dataDir), 'utf8')).pid).toBe(pidB);
  });

  it('a HELD acquire never releases the holder’s lock', () => {
    const s = sb();
    writeLock(s, { pid: 1, started_at: Date.now(), hostname: hostname() });

    const lock = acquireLock(s.dataDir, { pid: 4242 });
    lock.release();

    expect(existsSync(resolveLockPath(s.dataDir))).toBe(true);
    expect(JSON.parse(readFileSync(resolveLockPath(s.dataDir), 'utf8')).pid).toBe(1);
  });

  it('release is best-effort: a missing or unparseable lock file never throws', () => {
    const s = sb();
    ensureDir(s.dataDir);
    expect(() => releaseLock(resolveLockPath(s.dataDir), process.pid)).not.toThrow();
    writeLock(s, 'garbage');
    expect(() => releaseLock(resolveLockPath(s.dataDir), process.pid)).not.toThrow();
    expect(existsSync(resolveLockPath(s.dataDir))).toBe(true);
  });
});

/** Run the real binary — what cron invokes — and parse its `--json` pass report. */
function runBinary(s: Sandbox): Promise<{ status: number | null; result: ArchiveResult }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      BIN,
      'archive',
      '--dataDir',
      s.dataDir,
      '--transcriptRoot',
      s.sourceRoot,
      '--json',
    ]);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.on('close', (status) =>
      resolvePromise({ status, result: JSON.parse(stdout) as ArchiveResult }),
    );
  });
}

describe('a held lock copies zero bytes and stays observable', () => {
  it('archiveOnce reports lock.state held and does not touch the archive', () => {
    const s = sb();
    writeSource(s, `${SLUG}/sess-1.jsonl`, '{"a":1}\n');
    writeLock(s, { pid: 1, started_at: Date.now(), hostname: hostname() });

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    expect(result.lock.state).toBe('held');
    expect(result.bytesCopied).toBe(0);
    expect(result.files).toHaveLength(0);
    expect(existsSync(archivePath(s, `${SLUG}/sess-1.jsonl`))).toBe(false);
    // Not swallowed by exit 0: a stuck lock is written to the log so `doctor` sees it.
    expect(result.logged).toBe(true);
  });

  it('the real binary exits 0 against a genuinely live same-host holder (Test 10a)', async () => {
    // Deterministic counterpart to the race below: a real live holder, so row 2
    // fires with no timing assumption.
    const s = sb();
    writeSource(s, `${SLUG}/sess-1.jsonl`, '{"a":1}\n');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      writeLock(s, { pid: holder.pid, started_at: Date.now(), hostname: hostname() });

      const { status, result } = await runBinary(s);

      expect(status).toBe(0); // a cron must not page for a normal overlap
      expect(result.lock.state).toBe('held');
      expect(result.lock.holder_pid).toBe(holder.pid);
      expect(result.bytesCopied).toBe(0);
      expect(existsSync(archivePath(s, `${SLUG}/sess-1.jsonl`))).toBe(false);
    } finally {
      holder.kill('SIGKILL');
    }
  });
});

describe('two concurrent passes (Test 10)', () => {
  it('converge to the single-pass result with no NUL hole, however they interleave', async () => {
    // Do not add an "exactly one reported held" assertion here: the children can
    // serialize under load, which flakes. Test 10a pins that deterministically.
    const s = sb();
    // Big enough to span many 1 MiB chunks, where two passes could interleave.
    const line = `{"pad":"${'y'.repeat(4000)}"}\n`;
    const body = line.repeat(1000); // ~4 MB per file
    for (let i = 0; i < 12; i++) writeSource(s, `${SLUG}/sess-${i}.jsonl`, body);

    const [a, b] = await Promise.all([runBinary(s), runBinary(s)]);

    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    // A child that lost the lock must have copied nothing at all.
    for (const { result } of [a, b]) {
      if (result.lock.state === 'held') {
        expect(result.bytesCopied).toBe(0);
        expect(result.files).toHaveLength(0);
      }
    }

    // A third serial pass settles anything the overlap left behind.
    archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    for (let i = 0; i < 12; i++) {
      const rel = `${SLUG}/sess-${i}.jsonl`;
      const source = readFileSync(sourcePath(s, rel));
      const archived = readFileSync(archivePath(s, rel));
      expect(archived.equals(source), rel).toBe(true);
      // The sparse-hole signature: NULs that `size` reports as real content.
      expect(archived.includes(Buffer.alloc(64, 0)), rel).toBe(false);
    }
  }, 60000);
});
