// AC2, AC3, AC4 — the 1 Hz live tick.
//
// ★ EVERY TEST DRIVES `tick()` EXPLICITLY AGAINST AN INJECTED CLOCK. `intervalMs`
// is 0 everywhere here, which binds no timer, so nothing in this file sleeps and
// nothing waits on wall time. If a test in this suite ever needs more than the
// root project's 5 s default, that is a leaked real timer rather than a reason
// to raise the timeout.
//
// ★ THE AC2 CONSTRUCTION, AND WHY IT IS BUILT THIS WAY. `projectionSnapshot`
// does `SELECT * FROM sessions` and strips only six volatile columns
// (`project/__tests__/fixtures.ts:48-55`) — `rollup_state`, `file_size` and
// `project_path` are all COMPARED. So both sides must be seeded by an identical
// `wave1` and projected by the same `ensureProjectedFold`, and NEITHER may run
// wave 2: wave 2 reaches `markRollupComplete`, which flips the root from `'own'`
// to `'complete'`, and a naive comparison then reds on a column that has nothing
// to do with projection.
//
// ★ AND THE LIVE SIDE'S ONLY SEEDING PASS IS THE TICK'S OWN `wave1()`. A pre-pass
// would leave `indexed_ids` empty on the tick — `scanCorpus` diffs the on-disk
// fold against the row it just wrote — so step 2 would loop over nothing and the
// live database would hold Tier-A rows with no turns and no events.

import { afterEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { discover } from '../../archive/discover.js';
import { archiveOnce, createMirrorContext, mirrorFile } from '../../archive/mirror.js';
import { canonicalizeTranscriptPath, resolveTranscriptRoot } from '../../archive/paths.js';
import { createArchiveReader, type ArchiveReader } from '../../archive/read.js';
import {
  cleanup,
  makeSandbox,
  writeSource,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';
import { createProjectionEnv } from '../../corpus/env.js';
import { classifyCorpusPath, logicalPathOf, rowIdOf } from '../../corpus/paths.js';
import { createCorpusSweep, emptyReport, type CorpusSweep } from '../../corpus/watch.js';
import { ensureProjectedFold } from '../../db/freshness.js';
import { readEventPage, readSessionHeader, readTurns } from '../../db/read.js';
import { projectionSnapshot } from '../../project/__tests__/fixtures.js';
import type { ProjectionEnv } from '../../db/write.js';
import {
  countingReader,
  jsonl,
  machineryLine,
  newReaderLog,
  openCache,
  readPaths,
  toolCallLine,
  toolResultLine,
  writeFile,
  type ReaderLog,
} from '../../db/__tests__/fixtures/index.js';
import { startLiveTick, type LiveTick } from '../live.js';
import type { StreamEventName, StreamHub } from '../stream.js';

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SLUG = '-Users-dev-proj';
const SRC_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FIXTURES = join(SRC_DIR, 'project', '__tests__', 'fixtures');

/** The launch boilerplate the harness writes; an Agent call answered by it stays `running`. */
function launchResult(agentId: string): string {
  return (
    'Async agent launched successfully. (This tool result is internal metadata — never quote ' +
    `or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${agentId}\n` +
    'The agent is working in the background.'
  );
}

/** The `<task-notification>` line that back-patches one async `Agent` call. */
function notificationLine(callId: string, answer: string, ts: string): Record<string, unknown> {
  return machineryLine(
    [
      '<task-notification>',
      '<task-id>aTASK1</task-id>',
      `<tool-use-id>${callId}</tool-use-id>`,
      '<output-file>/tmp/tasks/aTASK1.output</output-file>',
      '<status>completed</status>',
      '<summary>Agent "the sub-agent" finished</summary>',
      `<result>${answer}</result>`,
      '</task-notification>',
    ].join('\n'),
    ts,
  );
}

function ts(seconds: number): string {
  return `2026-08-14T09:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.000Z`;
}

/**
 * `n` async `Agent` calls, every one left `running`.
 *
 * `prefix` is required rather than defaulted: `events.id` is a GLOBAL primary
 * key and a `toolu_*` id is used verbatim, so two sessions sharing a call id
 * collide on insert and the second projection fails.
 */
function concurrentAgents(prefix: string, count: number): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index++) {
    lines.push(toolCallLine(`${prefix}${index}`, 'Agent', ts(index * 2 + 1)));
    lines.push(
      toolResultLine(`${prefix}${index}`, launchResult(`aAGENT${index}`), ts(index * 2 + 2)),
    );
  }
  return lines;
}

interface Frame {
  event: StreamEventName;
  data: Record<string, unknown>;
}

/** A hub that records instead of writing. `attach` is never reached from here. */
function recordingHub(): StreamHub & { frames: Frame[] } {
  const frames: Frame[] = [];
  return {
    frames,
    attach: () => Promise.resolve(),
    publish: async (event, data) => {
      frames.push({ event, data: data as Record<string, unknown> });
    },
    beat: () => Promise.resolve(),
    drain: () => Promise.resolve(),
    size: () => 0,
  };
}

function changedFrames(hub: { frames: Frame[] }): Frame[] {
  return hub.frames.filter((frame) => frame.event === 'session_changed');
}

/**
 * A `ProjectionEnv` whose `readLines` advances the injected clock — the honest
 * way to make one reprojection slow, because the cost lands inside the gate's own
 * timing window rather than being faked around it.
 */
function costedEnv(
  base: ProjectionEnv,
  costMs: (archivePath: string) => number,
  advance: (ms: number) => void,
): ProjectionEnv {
  return {
    ...base,
    readLines: (archivePath) => {
      advance(costMs(archivePath));
      return base.readLines(archivePath);
    },
  };
}

/** A `ProjectionEnv` whose first `n` reads throw, so the gate answers `'failed'`. */
function flakyEnv(base: ProjectionEnv, failures: number): ProjectionEnv {
  let left = failures;
  return {
    ...base,
    readLines: (archivePath) => {
      if (left-- > 0) throw new Error('unreadable');
      return base.readLines(archivePath);
    },
  };
}

let sandbox: Sandbox | undefined;
const opened: DatabaseSync[] = [];
const ticks: LiveTick[] = [];
const sweeps: CorpusSweep[] = [];

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

/** The production projection env over the sandbox roots. */
function projEnv(reader: ArchiveReader = createArchiveReader()): ProjectionEnv {
  const s = sb();
  return createProjectionEnv(reader, { archiveRoot: s.archiveRoot, transcriptRoot: s.sourceRoot });
}

afterEach(() => {
  for (const tick of ticks.splice(0)) tick.close();
  for (const sweep of sweeps.splice(0)) sweep.close();
  for (const db of opened.splice(0)) db.close();
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

function cache(): DatabaseSync {
  const db = openCache();
  opened.push(db);
  return db;
}

function sweepOver(db: DatabaseSync, now?: () => number): CorpusSweep {
  const s = sb();
  const sweep = createCorpusSweep({
    db,
    dataDir: s.dataDir,
    transcriptRoot: s.sourceRoot,
    ...(now !== undefined && { now }),
  });
  sweeps.push(sweep);
  return sweep;
}

/** Write a transcript straight into the archive, where the projector reads. */
function writeArchived(records: readonly unknown[], id = SESSION_ID): string {
  return writeFile(join(sb().archiveRoot, SLUG, `${id}.jsonl`), jsonl(records));
}

function growArchived(path: string, records: readonly unknown[]): void {
  appendFileSync(path, jsonl(records));
}

interface LiveSide {
  db: DatabaseSync;
  hub: ReturnType<typeof recordingHub>;
  tick: LiveTick;
}

/**
 * The live half of AC2's construction: a tick whose wave 2 is stubbed out, over
 * its own database, driven by `tick()` alone.
 */
function liveSide(options: { env?: ProjectionEnv; now?: () => number } = {}): LiveSide {
  const db = cache();
  const sweep = sweepOver(db, options.now);
  const hub = recordingHub();
  const tick = startLiveTick({
    db,
    env: options.env ?? projEnv(),
    // Wave 2 flips `rollup_state` to `'complete'`, which `projectionSnapshot`
    // compares. Stubbing it is what keeps AC2 a statement about projection.
    sweep: { ...sweep, wave2: () => emptyReport() },
    hub,
    intervalMs: 0,
    ...(options.now !== undefined && { now: options.now }),
  });
  ticks.push(tick);
  return { db, hub, tick };
}

/** The cold exemplar: the same wave 1, then the same gate, called directly. */
function coldSide(id = SESSION_ID): DatabaseSync {
  const db = cache();
  sweepOver(db).wave1();
  ensureProjectedFold(db, id, projEnv());
  return db;
}

describe('AC2 — a live reprojection is byte-identical to a cold one', () => {
  it('a grown file reprojects byte-identically to a cold projection of the same bytes', async () => {
    writeArchived(fixtureLines());

    const live = liveSide();
    await live.tick.tick();
    const cold = coldSide();

    expect(projectionSnapshot(live.db)).toBe(projectionSnapshot(cold));
    // Non-vacuity: both sides actually projected something.
    expect(readTurns(live.db, SESSION_ID).length).toBeGreaterThan(0);
  });

  it('the async Agent back-patched by a later-turn task-notification survives the live path', async () => {
    // The `tool_use` is on line 2 and the notification is on line 11, eight turns
    // later — structurally out of reach of a last-turn reprojection.
    const path = writeArchived(fixtureLines());
    growArchived(path, [notificationLine('toolu_silent', 'the silent arm answer', ts(30))]);

    const live = liveSide();
    await live.tick.tick();
    const cold = coldSide();

    expect(projectionSnapshot(live.db)).toBe(projectionSnapshot(cold));

    const patched = eventById(live.db, 'toolu_silent');
    expect(patched.status).not.toBe('running');
    expect(patched.text).toBe('the silent arm answer');
  });

  it('no growth means no reprojection and no frame', async () => {
    writeArchived(fixtureLines());
    const live = liveSide();

    await live.tick.tick();
    const first = readSessionHeader(live.db, SESSION_ID)!.projection.projected_at;
    const framesAfterFirst = changedFrames(live.hub).length;
    expect(framesAfterFirst).toBe(1);

    await live.tick.tick();

    // Guards test 8 against passing vacuously through a tick that reprojects
    // unconditionally: the fold matched, so nothing was read and nothing was said.
    expect(changedFrames(live.hub)).toHaveLength(framesAfterFirst);
    expect(readSessionHeader(live.db, SESSION_ID)!.projection.projected_at).toBe(first);
  });

  it('publishes nothing when the projector already holds the grown bytes', async () => {
    // The `'hit'` branch, and it is reachable in production: the detail route runs
    // the SAME gate on every request (`api.ts:424`), so a browser that opens a
    // growing session projects it before the next tick gets there. Wave 1 still
    // offers the id — its Tier-A diff is a different pair of columns — and the
    // tick must notice there is nothing left to say.
    const path = writeArchived(fixtureLines());
    const live = liveSide();
    await live.tick.tick();
    expect(changedFrames(live.hub)).toHaveLength(1);

    growArchived(path, [notificationLine('toolu_silent', 'the silent arm answer', ts(30))]);
    ensureProjectedFold(live.db, SESSION_ID, projEnv());
    const projectedAt = readSessionHeader(live.db, SESSION_ID)!.projection.projected_at;

    await live.tick.tick();

    expect(changedFrames(live.hub)).toHaveLength(1);
    expect(readSessionHeader(live.db, SESSION_ID)!.projection.projected_at).toBe(projectedAt);
  });

  it('announces each id once as session_indexed', async () => {
    writeArchived(fixtureLines());
    const live = liveSide();

    await live.tick.tick();
    await live.tick.tick();

    expect(live.hub.frames.filter((frame) => frame.event === 'session_indexed')).toEqual([
      { event: 'session_indexed', data: { session_id: SESSION_ID } },
    ]);
  });
});

describe('AC2 — a failed projection is retried, never forgotten', () => {
  it('keeps a failed session pending and publishes it on the next tick', async () => {
    // ★ THE BUG `pending` EXISTS TO PREVENT. Wave 1 has already cleared the
    // Tier-A diff that offered this id, and wave 2 never revisits a rolled-up
    // tree — so a tick that dropped the id on `'failed'` would lose this
    // session's growth permanently rather than for one second.
    writeArchived(fixtureLines());
    const live = liveSide({ env: flakyEnv(projEnv(), 1) });

    await live.tick.tick();
    expect(changedFrames(live.hub)).toHaveLength(0);
    expect(readTurns(live.db, SESSION_ID)).toHaveLength(0);

    await live.tick.tick();

    expect(changedFrames(live.hub)).toHaveLength(1);
    expect(readTurns(live.db, SESSION_ID).length).toBeGreaterThan(0);
  });
});

describe('AC4 — the timer never overlaps two passes', () => {
  it('skips a fire while a pass is still in flight, and logs rather than crashing', async () => {
    // The ONLY test here that binds a real timer, and deliberately: `tick` is
    // async, so it returns at its first `await` and the interval keeps firing
    // underneath it. `watch.ts`'s "node coalesces a late fire" reasoning holds
    // for a synchronous callback and does not carry over.
    let waves = 0;
    let inPublish = 0;
    let concurrent = 0;

    const sweep: CorpusSweep = {
      tick: () => emptyReport(),
      wave1: () => {
        waves += 1;
        // A fresh id per pass, so every pass reaches `publish` and blocks there.
        return { ...emptyReport(), indexed: 1, indexed_ids: [`sess-${waves}`] };
      },
      wave2: () => emptyReport(),
      report: () => emptyReport(),
      close: () => undefined,
    };
    const hub: StreamHub = {
      ...recordingHub(),
      publish: async () => {
        inPublish += 1;
        concurrent = Math.max(concurrent, inPublish);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inPublish -= 1;
      },
    };

    const tick = startLiveTick({
      db: cache(),
      env: projEnv(),
      sweep,
      hub,
      intervalMs: 2,
    });
    ticks.push(tick);

    await new Promise((resolve) => setTimeout(resolve, 200));
    tick.close();

    expect(concurrent).toBe(1);
    // ~200 ms of 40 ms passes. Unguarded, a 2 ms interval would run ~100.
    expect(waves).toBeLessThan(10);
    expect(waves).toBeGreaterThan(0);
  });
});

describe('AC3 — `patched` is exactly the running -> not-running set', () => {
  it('contains exactly the events that stopped being running', async () => {
    const path = writeArchived(fixtureLines());
    const live = liveSide();
    await live.tick.tick();

    // `toolu_marker` and `toolu_structured` were answered on lines 9 and 10, so
    // `toolu_silent` is the fixture's only `running` row before the growth.
    expect(runningIds(live.db)).toEqual(['toolu_silent']);

    growArchived(path, [notificationLine('toolu_silent', 'the silent arm answer', ts(30))]);
    await live.tick.tick();

    const frame = changedFrames(live.hub).at(-1)!;
    expect(new Set((frame.data.patched as { id: string }[]).map((event) => event.id))).toEqual(
      new Set(['toolu_silent']),
    );
    expect(runningIds(live.db)).toEqual([]);
  });

  it('excludes an event that was not running before, however it ends up', async () => {
    const path = writeArchived(fixtureLines());
    const live = liveSide();
    await live.tick.tick();

    // A brand-new unanswered Agent call: `running` AFTER but not BEFORE, so the
    // diff must not claim it. This pins the direction of the subtraction.
    growArchived(path, [
      toolCallLine('toolu_fresh', 'Agent', ts(40)),
      toolResultLine('toolu_fresh', launchResult('aFRESH'), ts(41)),
      notificationLine('toolu_silent', 'the silent arm answer', ts(42)),
    ]);
    await live.tick.tick();

    const frame = changedFrames(live.hub).at(-1)!;
    expect((frame.data.patched as { id: string }[]).map((event) => event.id)).toEqual([
      'toolu_silent',
    ]);
    expect(runningIds(live.db)).toEqual(['toolu_fresh']);
  });

  it('is exact at a size the real fixture cannot reach — twelve at once', async () => {
    // No cap and no `patched_truncated` wire field: whole-file reprojection makes
    // a refetch cheap, so an oversized frame costs bandwidth and never
    // correctness. Capping would buy a permanent client branch for a case with
    // zero corpus witnesses.
    const path = writeArchived(concurrentAgents('toolu_a', 12));
    const live = liveSide();
    await live.tick.tick();
    expect(runningIds(live.db)).toHaveLength(12);

    growArchived(
      path,
      Array.from({ length: 12 }, (_, index) =>
        notificationLine(`toolu_a${index}`, `answer ${index}`, ts(60 + index)),
      ),
    );
    await live.tick.tick();

    const patched = changedFrames(live.hub).at(-1)!.data.patched as { id: string }[];
    expect(patched).toHaveLength(12);
    expect(new Set(patched.map((event) => event.id))).toEqual(
      new Set(Array.from({ length: 12 }, (_, index) => `toolu_a${index}`)),
    );
  });

  it('carries session_id, fingerprint, from_seq, patched and rollups, and nothing else', async () => {
    writeArchived(fixtureLines());
    const live = liveSide();
    await live.tick.tick();

    const frame = changedFrames(live.hub).at(-1)!;
    expect(new Set(Object.keys(frame.data))).toEqual(
      new Set(['session_id', 'fingerprint', 'from_seq', 'patched', 'rollups']),
    );

    const turns = readTurns(live.db, SESSION_ID);
    expect(frame.data.from_seq).toBe(turns[turns.length - 1]!.first_seq);
    // `'<mtime_ms>:<size>:<sidecar_count>'`, the same epoch the detail route ships.
    expect(String(frame.data.fingerprint)).toMatch(/^\d+:\d+:\d+$/);

    // The rollups are the own-file columns ONLY. `sub_*`, `agent_count` and
    // `rollup_state` are all written by `recomputeSubagentRollups`, which the live
    // path does not run and could not run correctly — omitting a key is honest,
    // publishing a stale total under a fresh fingerprint is not.
    const rollups = frame.data.rollups as Record<string, unknown>;
    expect(new Set(Object.keys(rollups))).toEqual(
      new Set([
        'last_activity_at',
        'turn_count',
        'tool_call_count',
        'error_count',
        'tokens_in',
        'tokens_out',
        'tokens_cache_read',
        'tokens_cache_write',
        'est_cost',
      ]),
    );
  });
});

describe('AC4 — the 100 ms / 5 s per-session backoff', () => {
  it('backs a slow session off to 5 s, and reconsiders it exactly then', async () => {
    let clock = 1_000_000;
    const now = (): number => clock;
    const base = projEnv();
    const path = writeArchived(fixtureLines());

    const live = liveSide({
      now,
      env: costedEnv(
        base,
        () => 150,
        (ms) => (clock += ms),
      ),
    });
    await live.tick.tick();
    expect(changedFrames(live.hub)).toHaveLength(1);

    const backedOffAt = clock;
    growArchived(path, [notificationLine('toolu_silent', 'the silent arm answer', ts(30))]);

    // ★ The four skipped ticks are what make `pending` load-bearing. Wave 1's
    // upsert clears the Tier-A diff on the FIRST of them, so from the second tick
    // on this id reaches step 2 only because `pending` still holds it — and the
    // gate reads `projected_mtime_ms`, a different pair of columns, so the session
    // is still genuinely projection-stale.
    for (const offset of [1000, 2000, 3000, 4000]) {
      clock = backedOffAt + offset;
      await live.tick.tick();
      expect(changedFrames(live.hub), `published at +${offset} ms`).toHaveLength(1);
    }

    clock = backedOffAt + 5000;
    await live.tick.tick();
    expect(changedFrames(live.hub)).toHaveLength(2);
    expect(eventById(live.db, 'toolu_silent').status).not.toBe('running');
  });

  it('is per session and does not slow its neighbours', async () => {
    const other = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    let clock = 1_000_000;
    const now = (): number => clock;
    const base = projEnv();
    const slowPath = writeArchived(fixtureLines());
    // Its own call ids, because `events.id` is a global primary key.
    const fastPath = writeArchived(concurrentAgents('toolu_b', 1), other);

    const live = liveSide({
      now,
      env: costedEnv(
        base,
        (p) => (p === slowPath ? 150 : 0),
        (ms) => (clock += ms),
      ),
    });
    await live.tick.tick();
    const startedAt = clock;
    expect(new Set(changedFrames(live.hub).map((f) => f.data.session_id))).toEqual(
      new Set([SESSION_ID, other]),
    );

    growArchived(slowPath, [notificationLine('toolu_silent', 'slow answer', ts(30))]);
    growArchived(fastPath, [notificationLine('toolu_b0', 'fast answer', ts(30))]);

    clock = startedAt + 1000;
    await live.tick.tick();
    // Only the neighbour. A GLOBAL backoff would publish neither.
    expect(
      changedFrames(live.hub)
        .slice(2)
        .map((f) => f.data.session_id),
    ).toEqual([other]);

    clock = startedAt + 5000;
    await live.tick.tick();
    expect(
      changedFrames(live.hub)
        .slice(3)
        .map((f) => f.data.session_id),
    ).toEqual([SESSION_ID]);
  });

  it('never backs off a fast session — the non-vacuity control', async () => {
    let clock = 1_000_000;
    const now = (): number => clock;
    const base = projEnv();
    const path = writeArchived(fixtureLines());

    // 40 ms, comfortably under SLOW_MS.
    const live = liveSide({
      now,
      env: costedEnv(
        base,
        () => 40,
        (ms) => (clock += ms),
      ),
    });
    await live.tick.tick();
    const startedAt = clock;

    growArchived(path, [notificationLine('toolu_silent', 'the silent arm answer', ts(30))]);
    clock = startedAt + 1000;
    await live.tick.tick();

    // Published on the very next tick, not five seconds later.
    expect(changedFrames(live.hub)).toHaveLength(2);
  });
});

describe('AC4 — a half-written source line never reaches the projector', () => {
  it('stops the mirror at the last complete newline and leaves the tick unharmed', async () => {
    const s = sb();
    const rel = `${SLUG}/${SESSION_ID}.jsonl`;
    writeSource(s, rel, jsonl(fixtureLines()));
    archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    const archivePath = join(s.archiveRoot, rel);
    const live = liveSide();
    await live.tick.tick();
    const before = projectionSnapshot(live.db);
    const archivedBefore = readFileSync(archivePath, 'utf8');

    // Half a line, no trailing newline — a transcript caught mid-append.
    appendFileSync(join(s.sourceRoot, rel), '{"type":"user","timesta');

    // ★ FORCED UNSETTLED, the idiom `archive/__tests__/mirror.test.ts:55` already
    // established, so this is Task 1.1's rule under test rather than a race. A
    // settled file is a file at rest, which is a different case entirely.
    const sourceRoot = canonicalizeTranscriptPath(s.sourceRoot);
    const archiveRoot = canonicalizeTranscriptPath(s.archiveRoot);
    const entry = discover(sourceRoot, archiveRoot).find((e) => e.relPath === rel);
    let call = 0;
    mirrorFile(
      entry!,
      createMirrorContext({
        archiveRoot,
        statFile: (path) => {
          const real = statSync(path, { bigint: true });
          if (call++ > 0) return real;
          const doctored = Object.create(real) as typeof real;
          Object.defineProperty(doctored, 'mtimeNs', { value: real.mtimeNs + 1n });
          return doctored;
        },
      }),
    );

    // (a) The archive is unchanged and still newline-terminated.
    expect(readFileSync(archivePath, 'utf8')).toBe(archivedBefore);
    expect(archivedBefore.endsWith('\n')).toBe(true);

    // (b) The tick does not throw, and (c) the projection did not move.
    await expect(live.tick.tick()).resolves.toBeUndefined();
    expect(projectionSnapshot(live.db)).toBe(before);
  });

  it('the projector opens no path under the transcript root during a tick', async () => {
    const s = sb();
    writeSource(s, `${SLUG}/${SESSION_ID}.jsonl`, jsonl(fixtureLines()));
    archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    const log: ReaderLog = newReaderLog();
    const live = liveSide({ env: projEnv(countingReader(log, createArchiveReader())) });
    await live.tick.tick();

    // The direct, positive form of "the projector reads the archive": every byte
    // came from under the archive root, three hops from any source path.
    expect(readPaths(log).length).toBeGreaterThan(0);
    for (const path of readPaths(log)) {
      expect(path.startsWith(s.archiveRoot), path).toBe(true);
      expect(path.startsWith(s.sourceRoot), path).toBe(false);
    }
  });
});

// --- Local readers ---------------------------------------------------------

/** `async-agent.jsonl`, parsed. Its own session id is `SESSION_ID` already. */
function fixtureLines(): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, 'async-agent.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runningIds(db: DatabaseSync): string[] {
  return readEventPage(db, SESSION_ID, { from_seq: 0, limit: 10_000 })
    .items.filter((event) => event.status === 'running')
    .map((event) => event.id);
}

function eventById(db: DatabaseSync, id: string): { status: string | null; text: string | null } {
  const found = readEventPage(db, SESSION_ID, { from_seq: 0, limit: 10_000 }).items.find(
    (event) => event.id === id,
  );
  expect(found, `no event ${id}`).toBeDefined();
  return found!;
}

// --- AC3(b): the "under 10" bound, measured rather than capped ---------------
//
// ★ ASSERT PROPERTIES, PRINT COUNTS, PIN NOTHING — the shape of
// `corpus/__tests__/corpus.test.ts:1-8`, and opt-in via the same
// `AGENT_LENS_REAL_CORPUS=1` gate. Reads `~/.agent-lens/archive` and never
// `~/.claude/projects`; every database here is in memory and every write lands
// in a temp dir.
//
// ★ WHAT IS MEASURED IS AN UPPER BOUND ON A TICK'S DIFF, DELIBERATELY. Each real
// session is projected twice: once truncated to the lines before its FIRST
// `<task-notification>`, then whole. The diff is therefore every async `Agent`
// call that session ever back-patches — and one 1 Hz tick can only ever answer a
// subset of them. So `max < 10` here implies `max < 10` per tick, and it is
// falsifiable: a real session that notifies twelve calls reds this.
//
// The number is a MEASUREMENT, never a cap. `patched` is uncapped on the wire
// and there is no `patched_truncated` field: whole-file reprojection makes a
// refetch cheap, so an oversized frame costs bandwidth and never correctness. If
// this ever prints a maximum near 10, that is the moment to cap — with a number
// measured rather than guessed.

const REAL_CORPUS = process.env.AGENT_LENS_REAL_CORPUS === '1';
const runIt = REAL_CORPUS ? it : it.skip;

/** The bound AC3 states. A ceiling on the observation, never enforced in code. */
const PATCHED_BOUND = 10;

/** Well under anything measured; a lower bound, never a cardinality. */
const MIN_SESSIONS = 10;

/**
 * The busiest ONE SECOND of task-notifications in a transcript, as a line range.
 *
 * This is the cut that makes the measurement a real tick's diff rather than a
 * whole session's: the tick reprojects once a second, so `patched` is exactly
 * the calls answered by the notifications that landed in one second. Every
 * notification follows its own launch, so the launches are always in the prefix.
 */
function busiestNotificationSecond(
  lines: readonly string[],
): { start: number; end: number } | undefined {
  const bySecond = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (!line.includes('<task-notification>')) return;
    const parsed = JSON.parse(line) as { timestamp?: string };
    const second = (parsed.timestamp ?? '').slice(0, 19);
    bySecond.set(second, [...(bySecond.get(second) ?? []), index]);
  });

  let busiest: number[] | undefined;
  for (const indexes of bySecond.values()) {
    if (busiest === undefined || indexes.length > busiest.length) busiest = indexes;
  }
  if (busiest === undefined || busiest[0] === 0) return undefined;
  return { start: busiest[0]!, end: busiest[busiest.length - 1]! + 1 };
}

describe('AC3 — the "under 10" bound as a property of the real corpus', () => {
  runIt('never back-patches ten or more events in one session', { timeout: 300_000 }, async () => {
    const archiveRoot = join(homedir(), '.agent-lens', 'archive');
    const reader = createArchiveReader();
    const observed: { id: string; patched: number }[] = [];

    for (const relPath of readdirSync(archiveRoot, { recursive: true, encoding: 'utf8' })) {
      const logical = logicalPathOf(relPath.split('\\').join('/'));
      if (classifyCorpusPath(logical) !== 'session') continue;

      const absolute = join(archiveRoot, logical);
      let text: string;
      try {
        text = reader.read(absolute, 0, reader.size(absolute)).toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n').filter((line) => line !== '');
      const window = busiestNotificationSecond(lines);
      // No async back-patch in this session: nothing can stop being `running`.
      if (window === undefined) continue;

      const id = rowIdOf(logical);
      const scratch = mkdtempSync(join(tmpdir(), 'agent-lens-live-corpus-'));
      const db = openCache();
      try {
        const target = join(scratch, 'archive', SLUG, `${id}.jsonl`);
        const hub = recordingHub();
        const sweep = createCorpusSweep({ db, dataDir: scratch, transcriptRoot: scratch });
        const tick = startLiveTick({
          db,
          env: createProjectionEnv(createArchiveReader(), {
            archiveRoot: join(scratch, 'archive'),
            transcriptRoot: resolveTranscriptRoot(),
          }),
          sweep: { ...sweep, wave2: () => emptyReport() },
          hub,
          intervalMs: 0,
        });

        writeFile(target, `${lines.slice(0, window.start).join('\n')}\n`);
        await tick.tick();
        writeFile(target, `${lines.slice(0, window.end).join('\n')}\n`);
        await tick.tick();

        const last = hub.frames.filter((frame) => frame.event === 'session_changed').at(-1);
        const patched = last === undefined ? 0 : (last.data.patched as unknown[]).length;
        observed.push({ id, patched });
      } finally {
        db.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    }

    const worst = observed.reduce((max, row) => (row.patched > max.patched ? row : max), {
      id: 'none',
      patched: 0,
    });
    const diagnostic =
      `${observed.length} sessions with a task-notification; ` +
      `max patched = ${worst.patched} (${worst.id})`;

    // A FLOOR on the sample, so a scan that found nothing cannot pass silently.
    expect(observed.length, diagnostic).toBeGreaterThanOrEqual(MIN_SESSIONS);
    expect(worst.patched, diagnostic).toBeLessThan(PATCHED_BOUND);
  });
});

// --- AC4, RE-DERIVED AND MEASURED -------------------------------------------
//
// ★ THE AC AS WRITTEN IS FALSE AND IS RETRACTED HERE. It read "FTS population
// never executes on the 1 Hz live path". It does: the tick calls
// `ensureProjectedFold`, which reprojects, and `projectSession` populates FTS
// unconditionally inside its own savepoint. Measured over the real archive, one
// live reprojection runs p50 15.9 / p90 36.0 / max 135.7 ms, of which FTS is
// p50 11.1 / max 92.4 — about 2.8x the rest of the reprojection, not the 8-14x
// that figure's own denominator (the `events` INSERT alone, ~6% of wall time)
// implies. Deferring the populate would recover roughly half of that half.
//
// ★ WHY NOTHING IS DEFERRED. The tick reads the ARCHIVE, and only the
// `agent-lens archive` CLI writes it, on a 15-minute launchd job. A session's
// bytes therefore move at most once per 15 minutes, so the 1 Hz loop reprojects
// a given session about once per 900 ticks; 2 of 312 sessions exceed `SLOW_MS`
// and the backoff contains both. The alternative costs a `sessions` column, a
// `SCHEMA_VERSION` bump, a durable dirty-marker protocol and two drain sites.
// It is filed forward against the day the archive itself becomes live, which is
// the only change that makes folds move faster than the measurement above.
//
// ★ SO THESE ASSERT THE TWO INVARIANTS THE DESIGN DOES GUARANTEE, AND THEY ARE
// SPLIT BECAUSE THEY NEED OPPOSITE HARNESSES. (a) needs ONE candidate, so the
// tick reaches the backoff branch at all. (b) needs the WHOLE corpus, because
// the `DEADLINE_MS` branch is guarded by `visited > 0` and a one-candidate tick
// never evaluates it. The suite's other backoff test runs on a fake clock with
// injected costs: it proves the MECHANISM over numbers the test supplies. These
// two are AC4's only contact with real projection cost.

/** `live.ts:51`, mirrored — the module does not export it. */
const SLOW_MS = 100;

/** `live.ts:54`, mirrored. */
const SLOW_INTERVAL_MS = 5000;

/** `live.ts:69`, mirrored. */
const DEADLINE_MS = 250;

/** A LOOP GUARD, never a bound. The burst is simulated at 19-25 ticks. */
const MAX_BURST_TICKS = 200;

const ARCHIVE_ROOT = join(homedir(), '.agent-lens', 'archive');

interface RealSession {
  absolute: string;
  id: string;
  bytes: number;
}

/** Every TOP-LEVEL transcript in the real archive, largest first. Read-only. */
function realSessions(): RealSession[] {
  const rows: RealSession[] = [];
  for (const relPath of readdirSync(ARCHIVE_ROOT, { recursive: true, encoding: 'utf8' })) {
    const logical = logicalPathOf(relPath.split('\\').join('/'));
    if (classifyCorpusPath(logical) !== 'session') continue;
    const absolute = join(ARCHIVE_ROOT, logical);
    try {
      rows.push({ absolute, id: rowIdOf(logical), bytes: statSync(absolute).size });
    } catch {
      continue;
    }
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

/**
 * A real clock a test can push FORWARD. Real elapsed time still flows through
 * it, which is what lets the >`SLOW_MS` branch fire on genuine projection cost;
 * the offset only skips the wait for a backoff to expire.
 */
function shiftableClock(): { now: () => number; skip: (ms: number) => void } {
  let offset = 0;
  return { now: () => Date.now() + offset, skip: (ms) => (offset += ms) };
}

describe('AC4(a) — a session that exceeds SLOW_MS is backed off on the next tick', () => {
  /** The largest real session, copied whole into a scratch archive with its sidecars. */
  function stage(scratch: string): { row: RealSession; target: string; lines: string[] } {
    const row = realSessions()[0]!;
    const target = join(scratch, 'archive', SLUG, `${row.id}.jsonl`);
    const sidecars = row.absolute.slice(0, -'.jsonl'.length);
    // The sidecars are part of the fold AND part of the cost, so a copy without
    // them would measure a cheaper session than the one the archive holds.
    if (existsSync(sidecars))
      cpSync(sidecars, target.slice(0, -'.jsonl'.length), { recursive: true });

    const reader = createArchiveReader();
    const text = reader.read(row.absolute, 0, reader.size(row.absolute)).toString('utf8');
    return { row, target, lines: text.split('\n').filter((line) => line !== '') };
  }

  /**
   * Three ticks over one staged session, growing the file before each of the
   * last two. `skipMs` is how far the clock jumps before the THIRD tick: 0
   * leaves the backoff holding, past `SLOW_INTERVAL_MS` lets the session back in.
   *
   * ★ THE MIDDLE TICK IS THE ONE THAT MATTERS, AND IT IS A REPROJECTION.
   * Measured, the first (cold) tick over the largest real session runs ~88 ms —
   * under `SLOW_MS`, because `deleteSessionProjection` has nothing to de-index
   * yet. A reprojection pays the delete idiom over live rows on top, which is
   * the ~136 ms the retraction quotes and the operation the live tick actually
   * performs. The clock is stepped after tick 1 unconditionally so a cold pass
   * that DID trip the threshold cannot defer tick 2 and hide the measurement.
   */
  async function growThenTick(
    skipMs: number,
  ): Promise<{ frames: number; reprojectionMs: number; row: RealSession }> {
    const scratch = mkdtempSync(join(tmpdir(), 'agent-lens-live-backoff-'));
    const db = openCache();
    try {
      const { row, target, lines } = stage(scratch);
      const hub = recordingHub();
      const clock = shiftableClock();
      const sweep = createCorpusSweep({ db, dataDir: scratch, transcriptRoot: scratch });
      const tick = startLiveTick({
        db,
        env: createProjectionEnv(createArchiveReader(), {
          archiveRoot: join(scratch, 'archive'),
          transcriptRoot: resolveTranscriptRoot(),
        }),
        sweep: { ...sweep, wave2: () => emptyReport() },
        hub,
        intervalMs: 0,
        now: clock.now,
      });

      writeFile(target, `${lines.slice(0, -2).join('\n')}\n`);
      await tick.tick();

      clock.skip(SLOW_INTERVAL_MS + 1000);
      writeFile(target, `${lines.slice(0, -1).join('\n')}\n`);
      const before = performance.now();
      await tick.tick();
      const reprojectionMs = performance.now() - before;

      clock.skip(skipMs);
      writeFile(target, `${lines.join('\n')}\n`);
      await tick.tick();

      return { frames: changedFrames(hub).length, reprojectionMs, row };
    } finally {
      db.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  function report(row: RealSession, ms: number): string {
    const text = `${row.id} (${(row.bytes / 1e6).toFixed(2)} MB) reprojected in ${ms.toFixed(1)} ms`;
    console.log(`[diagnostic] ${text}`);
    return text;
  }

  runIt(
    'the grown bytes are DEFERRED, so three ticks publish twice',
    { timeout: 300_000 },
    async () => {
      const { frames, reprojectionMs, row } = await growThenTick(0);
      const diagnostic = report(row, reprojectionMs);

      // Non-vacuity, and the premise of the whole retraction: slow sessions exist.
      // If the largest real session reprojects under SLOW_MS the cost model moved,
      // and this SHOULD red rather than pass on a backoff that never fired.
      expect(reprojectionMs, diagnostic).toBeGreaterThan(SLOW_MS);
      expect(frames, diagnostic).toBe(2);
    },
  );

  runIt(
    'control: past the backoff the SAME shape publishes three times',
    { timeout: 300_000 },
    async () => {
      // Without this arm the test above is satisfied by a third tick that had
      // nothing to publish. Deleting the backoff line in `live.ts` reds the arm
      // above and leaves this one green — the pair is what makes the claim
      // falsifiable rather than merely true.
      const { frames, reprojectionMs, row } = await growThenTick(SLOW_INTERVAL_MS + 1000);
      const diagnostic = report(row, reprojectionMs);

      expect(reprojectionMs, diagnostic).toBeGreaterThan(SLOW_MS);
      expect(frames, diagnostic).toBe(3);
    },
  );
});

describe('AC4(b) — one tick is bounded at wave 1 + DEADLINE_MS + one session', () => {
  runIt(
    'a whole-corpus burst drains without any tick exceeding the bound',
    { timeout: 600_000 },
    async () => {
      const dataDir = join(homedir(), '.agent-lens');
      const scratch = mkdtempSync(join(tmpdir(), 'agent-lens-live-burst-'));
      const walkDb = openCache();
      const db = openCache();
      try {
        // Wave 1 alone, on its own database, so the bound below uses a measured
        // walk-and-fold rather than a remembered ~20 ms.
        const walkStart = performance.now();
        createCorpusSweep({ db: walkDb, dataDir, transcriptRoot: scratch }).wave1();
        const wave1Ms = performance.now() - walkStart;

        const hub = recordingHub();
        const clock = shiftableClock();
        const sweep = createCorpusSweep({ db, dataDir, transcriptRoot: scratch });
        const realEnv = createProjectionEnv(createArchiveReader(), {
          archiveRoot: join(dataDir, 'archive'),
          transcriptRoot: resolveTranscriptRoot(),
        });
        const tick = startLiveTick({
          db,
          env: realEnv,
          // Wave 2 is stubbed for the same reason as everywhere else in this file:
          // it rolls sub-agents up and has nothing to do with the reprojection bound.
          sweep: { ...sweep, wave2: () => emptyReport() },
          hub,
          intervalMs: 0,
          now: clock.now,
        });

        // The worst case the design permits: every session moved at once. The loop
        // ends when a tick publishes nothing, and the clock steps past the backoff
        // between ticks so a deferred session really does come back.
        const tickMs: number[] = [];
        for (let pass = 0; pass < MAX_BURST_TICKS; pass += 1) {
          const published = changedFrames(hub).length;
          const before = performance.now();
          await tick.tick();
          tickMs.push(performance.now() - before);
          if (changedFrames(hub).length === published) break;
          clock.skip(SLOW_INTERVAL_MS + 1000);
        }

        // Now the per-session reprojection cost, in the same database and over the
        // same rows: clearing the size half of the stamp is what forces the gate to
        // reproject rather than answer `'hit'`.
        const ids = (
          db.prepare(`SELECT id FROM sessions WHERE projection_state = 'ready'`).all() as {
            id: string;
          }[]
        ).map((row) => row.id);
        const env = realEnv;
        const costs = new Map<string, number>();
        for (const id of ids) {
          db.prepare('UPDATE sessions SET projected_size = NULL WHERE id = ?').run(id);
          const before = performance.now();
          ensureProjectedFold(db, id, env);
          costs.set(id, performance.now() - before);
        }

        const sorted = [...costs.values()].sort((a, b) => a - b);
        const at = (p: number): number =>
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
        const worstSession = sorted[sorted.length - 1] ?? 0;
        const worstTick = Math.max(...tickMs);
        const tripping = [...costs]
          .filter(([, ms]) => ms > SLOW_MS)
          .map(([id, ms]) => `${id}=${ms.toFixed(1)}ms`);

        // Printed, never pinned. These are the numbers the AC4 retraction rests on.
        const diagnostic =
          `${ids.length} sessions in ${tickMs.length} ticks | reprojection p50 ${at(0.5).toFixed(1)} ` +
          `p90 ${at(0.9).toFixed(1)} p99 ${at(0.99).toFixed(1)} max ${worstSession.toFixed(1)} ms | ` +
          `wave1 ${wave1Ms.toFixed(1)} ms | worst tick ${worstTick.toFixed(1)} ms | ` +
          `over SLOW_MS: ${tripping.length === 0 ? 'none' : tripping.join(', ')}`;
        console.log(`[diagnostic] ${diagnostic}`);

        // A FLOOR on the sample, so a scan that found nothing cannot pass silently.
        expect(ids.length, diagnostic).toBeGreaterThanOrEqual(MIN_SESSIONS);
        // The whole burst drained rather than running out of passes.
        expect(tickMs.length, diagnostic).toBeLessThan(MAX_BURST_TICKS);
        // The bound the design states: the phase is checked BETWEEN sessions and
        // never before the first, so a tick costs wave 1, the deadline, and at most
        // one more session on top of it.
        expect(worstTick, diagnostic).toBeLessThanOrEqual(wave1Ms + DEADLINE_MS + worstSession);
      } finally {
        db.close();
        walkDb.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});
