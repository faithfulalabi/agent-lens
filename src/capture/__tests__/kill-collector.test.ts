// Task 2.6a — AC1's second half and Phase 2's AC5: "kill the collector
// mid-session, restart it, and the replayed spool produces the identical final
// state as a never-down run."
//
// Both runs are driven through the REAL adapter (`runHook`), not through
// `ingestBatch`, because the thing under test is the adapter's POST-or-spool
// fork plus `startServer`'s replay-before-bind (`start.ts:104`). One script of
// hook payloads, two data dirs:
//
//   control — server up the whole time, no explicit port, so the adapter
//             exercises the real config.json port-discovery path.
//   killed  — server up for the first K hooks, then `close()` (socket down, DB
//             closed, config.json cleared), the rest spooled, then restarted.
//
// **Identical means projection-identical, not archive-identical.** `replaySpool`
// re-stamps `source:'spool_replay'` and `insertRawEvent` is DO NOTHING on
// conflict, so `raw_events.source` legitimately records HOW an event arrived and
// MUST differ between the runs. `spans.source` is the literal `'hook'` at every
// normalizer call site, so the projection proper is genuinely identical — and
// the "differ on source and nothing else" claim is asserted below, not assumed.

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { runHook } from '../../cli/hook.js';
import { spoolFile } from '../spool.js';
import {
  bootTestServer,
  cleanupDir,
  openTestDb,
  type TestServer,
} from '../../server/__tests__/helpers.js';
import { at } from './fixtures.js';
import { projectionSnapshot } from './golden.js';

const SESSION = 'sess-kill';

/** How many hooks land before the collector is killed. */
const KILL_AFTER = 4;

/** A dead port: connection refused, so the adapter spools. See the note below. */
const DEAD_PORT = 1;

/**
 * The hook script, as Claude Code would hand it to the adapter on stdin: one
 * turn that completes, then a second turn straddling the outage.
 */
const SCRIPT: Record<string, unknown>[] = [
  {
    session_id: SESSION,
    hook_event_name: 'SessionStart',
    cwd: '/tmp/p',
    transcript_path: '/tmp/t',
  },
  { session_id: SESSION, hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'first' },
  {
    session_id: SESSION,
    hook_event_name: 'PreToolUse',
    prompt_id: 'p1',
    tool_use_id: 't1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  },
  {
    session_id: SESSION,
    hook_event_name: 'PostToolUse',
    prompt_id: 'p1',
    tool_use_id: 't1',
    tool_name: 'Bash',
    tool_response: { stdout: 'ok' },
  },
  { session_id: SESSION, hook_event_name: 'Stop', prompt_id: 'p1', stop_hook_active: true },
  { session_id: SESSION, hook_event_name: 'UserPromptSubmit', prompt_id: 'p2', prompt: 'second' },
  {
    session_id: SESSION,
    hook_event_name: 'PreToolUse',
    prompt_id: 'p2',
    tool_use_id: 't2',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/p/README.md' },
  },
  {
    session_id: SESSION,
    hook_event_name: 'PostToolUse',
    prompt_id: 'p2',
    tool_use_id: 't2',
    tool_name: 'Read',
    tool_response: { content: 'hi' },
  },
  { session_id: SESSION, hook_event_name: 'Stop', prompt_id: 'p2', stop_hook_active: true },
  { session_id: SESSION, hook_event_name: 'SessionEnd', reason: 'clear' },
];

/**
 * Feed hook `i` to the adapter with a FROZEN timestamp.
 *
 * The `ts` seam (`RunHookOptions.ts`) is what makes this test possible at all:
 * `runHook` normally stamps `new Date().toISOString()` per envelope, and the
 * normalizer threads that verbatim into every projection timestamp, so the two
 * runs would differ on `sessions.started_at`, `traces.started_at/ended_at`,
 * `spans.started_at/ended_at` and `traces.duration_ms`. Freezing the input keeps
 * the snapshot honest instead of teaching the serializer to ignore a real
 * difference.
 */
function hook(i: number, dataDir: string, port?: number): Promise<unknown> {
  return runHook({
    stdin: Readable.from([JSON.stringify(SCRIPT[i])]),
    dataDir,
    port,
    ts: at(i),
  });
}

/** Read a closed data dir's projection without going through the server. */
function snapshotOf(dataDir: string, normalizeSource = true): string {
  const db = openTestDb(dataDir);
  try {
    return projectionSnapshot(db, { normalizeSource });
  } finally {
    db.close();
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupDir(dir);
});

/** Boot a hermetic collector on `dataDir` (fresh one if omitted) and register cleanup. */
async function boot(dataDir?: string): Promise<TestServer> {
  const server = await bootTestServer({ dataDir, sweepIntervalMs: 0 });
  if (dataDir === undefined) dirs.push(server.dataDir);
  return server;
}

/** Never-down run: every hook POSTs to a live collector. Returns its data dir. */
async function runControl(): Promise<string> {
  const server = await boot();
  // No explicit port: the adapter must find the collector via config.json.
  for (let i = 0; i < SCRIPT.length; i++) await hook(i, server.dataDir);
  await server.close();
  return server.dataDir;
}

/** Collector dies after KILL_AFTER hooks; the rest spool and replay on restart. */
async function runKilled(): Promise<string> {
  let server = await boot();
  const dataDir = server.dataDir;
  for (let i = 0; i < KILL_AFTER; i++) await hook(i, dataDir);

  // The kill: closes the socket, closes the DB, clears config.json.
  await server.close();

  // Explicit DEAD_PORT is load-bearing, not laziness. After `clearConfig`, port
  // discovery falls back to DEFAULT_PORT 4470 and could hit a real dev server on
  // the developer's machine; re-using the just-freed ephemeral port risks a
  // parallel suite grabbing it. `port: 1` refuses deterministically — the same
  // modelling replay.test.ts:64 already uses.
  for (let i = KILL_AFTER; i < SCRIPT.length; i++) await hook(i, dataDir, DEAD_PORT);
  expect(existsSync(spoolFile(SESSION, dataDir))).toBe(true);

  // The restart: `startServer` runs `replaySpool` BEFORE it binds.
  server = await boot(dataDir);
  await server.close();
  return dataDir;
}

describe('kill the collector mid-session (AC1 / Phase 2 AC5)', () => {
  it('the killed-and-restarted run projects identically to the never-down run', async () => {
    const controlDir = await runControl();
    const killedDir = await runKilled();

    expect(existsSync(spoolFile(SESSION, killedDir))).toBe(false);
    expect(snapshotOf(killedDir)).toBe(snapshotOf(controlDir));

    // A second restart replays an empty spool and must change nothing.
    const afterFirstRestart = snapshotOf(killedDir);
    const server = await boot(killedDir);
    await server.close();
    expect(snapshotOf(killedDir)).toBe(afterFirstRestart);
  });

  it('the two archives differ on `source` and on nothing else', async () => {
    // Pins WHY `normalizeSource` exists. If the un-normalized snapshots ever match,
    // the normalization is dead weight; if the archives diverge on a column other
    // than `source`, the equality above is hiding a real difference.
    const controlDir = await runControl();
    const killedDir = await runKilled();

    expect(snapshotOf(killedDir, false)).not.toBe(snapshotOf(controlDir, false));
    expect(sources(killedDir)).toEqual([
      ...Array<string>(KILL_AFTER).fill('hook'),
      ...Array<string>(SCRIPT.length - KILL_AFTER).fill('spool_replay'),
    ]);
    expect(sources(controlDir)).toEqual(Array<string>(SCRIPT.length).fill('hook'));
  });
});

/** Archive `source` values in arrival order. */
function sources(dataDir: string): string[] {
  const db = openTestDb(dataDir);
  try {
    return (
      db
        .prepare(
          `SELECT r.source AS source FROM raw_events r
           JOIN spans_lite s ON s.event_id = r.id ORDER BY s.seq`,
        )
        .all() as { source: string }[]
    ).map((r) => r.source);
  } finally {
    db.close();
  }
}
