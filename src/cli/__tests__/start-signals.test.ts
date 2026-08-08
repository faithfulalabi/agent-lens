// Task 0.4 — the collector's shutdown contract, driven the only way it can be
// driven: from a real spawned process. A signal handler cannot be exercised from
// inside a vitest worker (`dev-server.test.ts:203` says so outright), and the
// discriminator for the SIGHUP bug — `{ code: null, signal: 'SIGHUP' }` versus
// `{ code: 0, signal: null }` — exists only on a child's exit status.
//
// **Spawning `src/cli/index.ts` directly, never `bin/agent-lens.js`, is
// load-bearing.** The shim (`bin/agent-lens.js:18-22`) is a `spawnSync` with no
// signal forwarding, and tsx forks underneath it: a three-process chain where
// `child.kill()` on the top pid reaches only the shim. A real terminal close
// signals the whole process group, so production is fixed by the source change
// alone — but a test that kills one pid cannot observe it through the shim.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToken, TOKEN_HEADER } from '../../shared/index.js';
import { readConfig, writeConfig, type RuntimeConfig } from '../../server/config.js';

const HERE = import.meta.dirname;
const CLI_ENTRY = join(HERE, '..', 'index.ts');
const REPO_ROOT = join(HERE, '..', '..', '..');
const START_SOURCE = readFileSync(join(HERE, '..', 'commands', 'start.ts'), 'utf8');

/** Every signal the collector must survive as a clean shutdown. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Generous: a cold tsx boot plus a bind, never a sleep the assertions depend on. */
const SPAWN_TIMEOUT_MS = 30_000;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Outcome extends Exit {
  config: RuntimeConfig | null;
}

interface Collector {
  child: ChildProcess;
  port: number;
  dataDir: string;
  stderr: () => string;
  exit: Promise<Exit>;
}

const children: ChildProcess[] = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // Order matters: release the held SSE bodies first so a surviving child is not
  // still serving one, then kill, then remove the dirs neither owns any more.
  for (const reader of readers.splice(0)) {
    await reader.cancel().catch(() => undefined);
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Boot a collector on an ephemeral port and resolve once it announces readiness.
 *
 * `--port 0` keeps it off 4470, which `port.test.ts:39` holds in a parallel
 * worker, and no test here ever re-binds a child's freed ephemeral port — the
 * flake `kill-collector.test.ts:154-158` rules against, and a non-discriminator
 * besides (an unhandled signal kills the process, so the OS reclaims the socket
 * either way). An empty transcript root keeps the boot catch-up, which runs
 * before `bind()`, off the developer's real `~/.claude/projects`.
 */
async function boot(dataDir = tempDir('agent-lens-sig-')): Promise<Collector> {
  const transcriptRoot = tempDir('agent-lens-sig-tr-');
  const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, 'start', '--port', '0'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENT_LENS_DIR: dataDir,
      AGENT_LENS_TRANSCRIPT_ROOT: transcriptRoot,
    },
  });
  children.push(child);

  let err = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => (err += chunk));

  // Registered before the readiness wait so a child that dies during boot
  // rejects the handshake instead of hanging until the suite timeout.
  const exit = new Promise<Exit>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      out += chunk;
      const match = /agent-lens listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match) resolve(Number(match[1]));
    });
    void exit.then(() =>
      reject(new Error(`collector exited before readiness\nstdout: ${out}\nstderr: ${err}`)),
    );
  });

  return { child, port, dataDir, stderr: () => err, exit };
}

/** The single post-condition every signal must produce, gathered after exit. */
async function outcome(collector: Collector): Promise<Outcome> {
  const { code, signal } = await collector.exit;
  return { code, signal, config: readConfig(collector.dataDir) };
}

/**
 * Attach a real `/api/stream` client and hold its body open — the production
 * sequence (server closes first, client still attached) that no existing test
 * exercises, because they all cancel the reader first (`helpers.ts:213`,
 * `stream-deltas.test.ts:485-489`).
 *
 * Resolving `fetch` is a sufficient handshake, not an approximation: hono's
 * `streamSSE` invokes the route callback *synchronously* before returning the
 * Response (`hono/dist/helper/streaming/sse.js` — `run(stream, cb, onError)`
 * precedes `c.newResponse(...)`), and `broadcaster.subscribe` is the first
 * statement in that callback, ahead of its first `await`. So the subscription is
 * registered before a single response header reaches this process.
 */
async function attachStream(collector: Collector): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${collector.port}/api/stream`, {
    headers: { [TOKEN_HEADER]: readToken(collector.dataDir)! },
  });
  expect(res.status).toBe(200);
  // Held open on purpose; released only in `afterEach`.
  readers.push(res.body!.getReader());
}

/** A genuinely dead pid: spawn a process that exits, and await its close. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise<void>((resolve) => child.on('close', () => resolve()));
  return child.pid!;
}

describe('agent-lens start — one shutdown for three signals (AC1, AC2, AC3)', () => {
  it.each(SIGNALS)(
    'exits through its own handler on %s and leaves no config.json',
    async (signal) => {
      const collector = await boot();
      collector.child.kill(signal);
      // A single deep-equal, because the failure modes are not independent:
      // `signal: null` is the AC2 discriminator (an unhandled SIGHUP yields
      // `{ code: null, signal: 'SIGHUP' }`) and `config: null` is the visible
      // damage PID 34231 left behind.
      expect(await outcome(collector)).toEqual({ code: 0, signal: null, config: null });
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('agent-lens start — shutdown with a live /api/stream client (AC2b)', () => {
  it.each(SIGNALS)(
    'exits on %s within a bounded time while a client holds the stream open',
    async (signal) => {
      const collector = await boot();
      await attachStream(collector);
      collector.child.kill(signal);
      // Red before the Broadcaster drain in the most literal way available: the
      // child never exits, `server.close` waiting on a response body nothing will
      // ever end, and this test dies on its timeout. This is the AC an open
      // browser tab on the shipped UI depends on — `ui/src/lib/sse.ts:39`
      // connects to exactly this endpoint.
      expect(await outcome(collector)).toEqual({ code: 0, signal: null, config: null });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'two different signals back-to-back produce exactly one shutdown (AC3b)',
    async () => {
      const collector = await boot();
      await attachStream(collector);

      // SAME TICK, no await between the two kills. The window between the first
      // `shutdown()` and its `resolve()` is now the drain time — a few ms — so any
      // spacing at all risks the second signal arriving after the process is gone,
      // which would make this pass without testing anything.
      collector.child.kill('SIGINT');
      collector.child.kill('SIGTERM');

      const result = await outcome(collector);
      expect(result).toEqual({ code: 0, signal: null, config: null });
      // A second `handle.close()` runs `db.close()` twice; the `closing` guard is
      // what stops that surfacing as an uncaught ERR_INVALID_STATE.
      expect(collector.stderr()).not.toMatch(/ERR_INVALID_STATE/);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('agent-lens start — source-text pins (AC1, AC3)', () => {
  // A deterministic backstop, NOT the primary evidence for the guard: a
  // `toContain('closing')` is satisfiable by a comment. The behavioural proof is
  // the back-to-back-signals test above.
  it('registers all three signals from one guarded implementation', () => {
    const count = (needle: string): number => START_SOURCE.split(needle).length - 1;

    expect(count('handle.close()')).toBe(1);
    expect(count('for (const signal of')).toBe(1);
    expect(START_SOURCE).toContain(`['SIGINT', 'SIGTERM', 'SIGHUP']`);
    // No copy-pasted third branch alongside the tuple loop.
    expect(START_SOURCE).not.toMatch(/process\.once\('SIG/);
    expect(count('closing')).toBeGreaterThan(0);
  });

  it('registers the handlers before announcing readiness', () => {
    const count = (needle: string): number => START_SOURCE.split(needle).length - 1;

    // Both counts are the precondition that makes the `indexOf` below mean
    // anything. The doc comment must state the ordering invariant in prose; an
    // implementer who echoes the readiness literal into it would otherwise make
    // `indexOf` resolve to the COMMENT and red a correct implementation. And
    // pinning the loop to exactly one occurrence stops a missing loop passing
    // vacuously on `indexOf === -1`.
    expect(count('for (const signal of')).toBe(1);
    expect(count('agent-lens listening on')).toBe(1);
    expect(START_SOURCE.indexOf('for (const signal of')).toBeLessThan(
      START_SOURCE.indexOf('agent-lens listening on'),
    );
  });
});

describe('agent-lens start — a stale config.json is overwritten, not consulted (AC4)', () => {
  it(
    'binds normally against a config naming a dead pid and rewrites it',
    async () => {
      // GREEN AT t = 0, AND THAT IS FINE — stated plainly rather than dressed up.
      // `startServer` imports only `clearConfig, writeConfig` (`start.ts:18`) and
      // its bind loop is driven purely by EADDRINUSE, so nothing today can make
      // this fail. It is a FORWARD-regression guard: it goes red the moment a
      // `refuseIfOwned`-style check (`src/dev/server.ts:171-178`) is ported into
      // the shipped path without a pid-liveness gate.
      const dataDir = tempDir('agent-lens-sig-stale-');
      writeConfig(dataDir, {
        port: 65_000,
        pid: await deadPid(),
        started_at: new Date().toISOString(),
      });

      const collector = await boot(dataDir);

      expect(collector.port).toBeGreaterThan(0);
      expect(readConfig(dataDir)!.pid).toBe(collector.child.pid);

      collector.child.kill('SIGTERM');
      await collector.exit;
    },
    SPAWN_TIMEOUT_MS,
  );
});
