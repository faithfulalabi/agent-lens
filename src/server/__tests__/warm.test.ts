/*
 * Task 7.4 — `POST /api/warm`, its queue, and the AC3 yield.
 *
 * ★ NO BOOT PRODUCES AN INDEXED-BUT-UNPROJECTED CORPUS, which is why the
 * end-to-end tests below un-project by hand in four steps. With
 * `sweepIntervalMs: 0` (the `bootTestServer` default) `start.ts:194` skips the
 * pass entirely and `sessions` is EMPTY; with any other value `sweep.tick()`
 * runs wave 1 AND wave 2 synchronously before the socket binds, and
 * `projectTree` projects every root plus every descendant — so the rows arrive
 * already projected and the queue is empty again. There is no stub seam through
 * a boot: `StartOptions` carries no wave-2 knob, and adding one for a test would
 * not even work (`watch.ts:274-277` — a zero deadline still projects one tree
 * per tick, which on a small fixture is the whole fixture).
 *
 * ★ AND THE HARNESS MUST CLEAR TWO COLUMNS, NOT ONE. `live.test.ts:1060`'s
 * `projected_size = NULL` idiom is correct for its claim and wrong for this one:
 * alone it leaves `projection_state = 'ready'`, so the warm reader never selects
 * the row. `projection_state = 'none'` alone leaves the freshness stamp intact,
 * so the gate answers `'hit'` and writes NOTHING — the state stays `'none'`
 * forever. Only both together let a run start AND finish.
 *
 * The doubles below are copied rather than shared, on `live.test.ts`'s terms:
 * `recordingHub` and the env wrappers are ~25 lines that belong to the file that
 * drives them, not to a fixtures module nine files import.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveTranscriptRoot } from '../../archive/paths.js';
import { createArchiveReader } from '../../archive/read.js';
import { createProjectionEnv } from '../../corpus/env.js';
import { createCorpusSweep, emptyReport, type CorpusSweep } from '../../corpus/watch.js';
import { ensureProjectedFold } from '../../db/freshness.js';
import { countUnprojected, readWarmableIds } from '../../db/read.js';
import type { ProjectionEnv } from '../../db/write.js';
import {
  fileEnv,
  humanLine,
  openCache,
  seedIndexRow,
  seedSessionRow,
  seedSidecarRow,
} from '../../db/__tests__/fixtures/index.js';
import { PROJECTOR_VERSION } from '../../transcript/version.js';
import { startLiveTick, type LiveTick } from '../live.js';
import type { StreamEventName, StreamHub } from '../stream.js';
import { createWarmQueue, type WarmQueue } from '../warm.js';
import {
  bootTestServer,
  cleanupDir,
  openTestDb,
  TOKEN_HEADER,
  type TestServer,
} from './helpers.js';

const REAL_CORPUS = process.env.AGENT_LENS_REAL_CORPUS === '1';
const runIt = REAL_CORPUS ? it : it.skip;

/** Well under anything measured; a floor on the sample, never a cardinality. */
const MIN_SESSIONS = 10;

/**
 * A turn is ONE session, so an inter-frame gap is one session's cost. A gap this
 * large would mean the loop batched — the regression test 12 exists to catch.
 * Generous on purpose: 7.1's worst measured session is 135.7 ms.
 */
const MAX_TURN_MS = 2_000;

interface Frame {
  event: StreamEventName;
  data: Record<string, unknown>;
  at: number;
}

/** A hub that records instead of writing. `attach` is never reached from here. */
function recordingHub(): StreamHub & { frames: Frame[] } {
  const frames: Frame[] = [];
  return {
    frames,
    attach: () => Promise.resolve(),
    publish: async (event, data) => {
      frames.push({ event, data: data as Record<string, unknown>, at: performance.now() });
    },
    beat: () => Promise.resolve(),
    drain: () => Promise.resolve(),
    size: () => 0,
  };
}

function warmFrames(hub: { frames: Frame[] }): Frame[] {
  return hub.frames.filter((frame) => frame.event === 'warm_progress');
}

/**
 * A `ProjectionEnv` that BURNS REAL WALL TIME on the named paths. AC3 is a claim
 * about the actual event loop, so an injected clock — which is what the live
 * tick's backoff tests use — would prove a mechanism over numbers the test
 * itself supplies. This spins instead.
 */
function slowEnv(base: ProjectionEnv, costMs: number, paths: ReadonlySet<string>): ProjectionEnv {
  return {
    ...base,
    readLines: (archivePath) => {
      if (paths.has(archivePath)) {
        const until = performance.now() + costMs;
        while (performance.now() < until) {
          /* spin: the cost must land on the loop, not on a timer */
        }
      }
      return base.readLines(archivePath);
    },
  };
}

/** A `ProjectionEnv` whose read of one named path throws, so the gate fails it. */
function brokenEnv(base: ProjectionEnv, broken: string): ProjectionEnv {
  return {
    ...base,
    readLines: (archivePath) => {
      if (archivePath === broken) throw new Error('unreadable');
      return base.readLines(archivePath);
    },
  };
}

const SLUG = '-Users-dev-proj';

/**
 * One archived transcript line.
 *
 * `humanLine` rather than a hand-built envelope: the harness field names live
 * behind `one-door.test.ts`'s gate, which scans test files too, and the fixtures
 * module is the reviewed place that already reads them.
 */
function transcriptLine(session: string, i: number): unknown {
  return humanLine(
    `line ${i} of ${session}`,
    new Date(Date.UTC(2026, 7, 14, 9, 0, Math.min(i, 59))).toISOString(),
  );
}

/** One archived transcript, in the mirror's `<slug>/<stem>.jsonl` layout. */
function seedArchive(dataDir: string, session: string, lines = 2): string {
  const slug = join(dataDir, 'archive', SLUG);
  mkdirSync(slug, { recursive: true });
  const path = join(slug, `${session}.jsonl`);
  writeFileSync(
    path,
    Array.from({ length: lines }, (_, i) => `${JSON.stringify(transcriptLine(session, i))}\n`).join(
      '',
    ),
  );
  return path;
}

/** `n` distinct, deterministic session ids. `tag` keeps two tests from colliding. */
function sessionIds(n: number, tag: string): string[] {
  return Array.from(
    { length: n },
    (_, i) => `aaaaaaaa-1111-4111-8111-${tag}${String(i).padStart(10, '0')}`,
  );
}

async function waitFor(predicate: () => boolean, deadlineMs: number, what: string): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const dbs: DatabaseSync[] = [];
const queues: WarmQueue[] = [];
const ticks: LiveTick[] = [];
const dirs: string[] = [];
let server: TestServer | undefined;

function scratchDb(): DatabaseSync {
  const db = openCache();
  dbs.push(db);
  return db;
}

function scratchDir(prefix = 'agent-lens-warm-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function track(queue: WarmQueue): WarmQueue {
  queues.push(queue);
  return queue;
}

afterEach(async () => {
  // ORDER IS LOAD-BEARING: every loop stops before any database closes, or a
  // pending `setImmediate` wakes on a closed handle and throws inside a callback
  // no test can catch.
  for (const queue of queues) queue.close();
  for (const tick of ticks) tick.close();
  queues.length = 0;
  ticks.length = 0;
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
  for (const db of dbs) db.close();
  dbs.length = 0;
  for (const dir of dirs) cleanupDir(dir);
  dirs.length = 0;
});

/**
 * The four-step harness, and the ONLY way to reach an indexed-but-unprojected
 * corpus through a real boot. Returns a booted server whose sweep never ran.
 *
 * `rollup_state` is deliberately left `'complete'` from step 2: this is a
 * miniature of the `PROJECTOR_VERSION`-bump state the endpoint exists for, which
 * makes it the honest fixture rather than a convenient one.
 */
async function bootUnprojected(options: {
  sessions: number;
  lines?: number;
  /** How many of the sessions lose their projection outright. */
  missing: number;
  /** How many keep `'ready'` but drop to an older projector. */
  stale: number;
}): Promise<{ server: TestServer; ids: string[]; missing: string[]; stale: string[] }> {
  const dataDir = scratchDir('agent-lens-warm-boot-');
  const ids = sessionIds(options.sessions, 'wa');
  for (const id of ids) seedArchive(dataDir, id, options.lines ?? 2);

  // Step 2: a LONG period, not a short one. The first pass is synchronous and
  // runs before `bind()` (`start.test.ts:78-80`), so this indexes and projects
  // deterministically without any timer firing.
  const seeded = await bootTestServer({ dataDir, sweepIntervalMs: 60_000 });
  await seeded.close();

  const missing = ids.slice(0, options.missing);
  const stale = ids.slice(options.missing, options.missing + options.stale);
  const db = openTestDb(dataDir);
  try {
    const holes = missing.map(() => '?').join(', ');
    // BOTH COLUMNS. Either alone is a fixture that cannot finish — see the file
    // header.
    db.prepare(
      `UPDATE sessions SET projection_state = 'none', projected_size = NULL
       WHERE id IN (${holes})`,
    ).run(...missing);
    if (stale.length > 0) {
      const staleHoles = stale.map(() => '?').join(', ');
      // ★ FOUNDER RULING 4. Without this the harness produces only
      // `none@current` and the `OR projector_version IS NOT :version` limb —
      // the entire basis of the endpoint — is never driven through the route.
      // These rows stay `'ready'`, which is exactly production's shape today.
      db.prepare(`UPDATE sessions SET projector_version = ? WHERE id IN (${staleHoles})`).run(
        PROJECTOR_VERSION - 1,
        ...stale,
      );
    }
  } finally {
    db.close();
  }

  // Step 4: the default `sweepIntervalMs: 0`, so no sweep and no live tick — the
  // rows survive unprojected, with real archive paths behind them.
  server = await bootTestServer({ dataDir });
  return { server, ids, missing, stale };
}

async function getJson<T>(s: TestServer, path: string): Promise<T> {
  const res = await fetch(s.url(path), { headers: { [TOKEN_HEADER]: s.token } });
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}

/** ★ `?q=a` IS MANDATORY: with no `q` the route 400s and carries no count. */
async function unprojectedCount(s: TestServer): Promise<number> {
  return (await getJson<{ unprojected_count: number }>(s, '/api/search?q=a')).unprojected_count;
}

async function postWarm(s: TestServer): Promise<{ status: number; queued: number }> {
  const res = await fetch(s.url('/api/warm'), {
    method: 'POST',
    headers: { [TOKEN_HEADER]: s.token },
  });
  const body = (await res.json()) as { queued: number };
  return { status: res.status, queued: body.queued };
}

function stateOf(dataDir: string, ids: readonly string[]): Map<string, [string, number | null]> {
  const db = openTestDb(dataDir);
  try {
    const out = new Map<string, [string, number | null]>();
    for (const id of ids) {
      const row = db
        .prepare('SELECT projection_state AS s, projector_version AS v FROM sessions WHERE id = ?')
        .get(id) as { s: string; v: number | null } | undefined;
      if (row !== undefined) out.set(id, [row.s, row.v]);
    }
    return out;
  } finally {
    db.close();
  }
}

/* --------------------------------------------------------------- AC1 --- */

describe('AC1 — the 202 is on the wire before any projection begins', () => {
  it('1b. start() returns without having warmed anything', () => {
    // ★ REHOMED FROM `api-routes.test.ts`, WHERE IT WAS VACUOUS. All three rows
    // there share a `last_activity_at`, so the newest is `SEEDED`, whose archive
    // path exists on no machine — the gate answers `'failed'` BEFORE any write
    // (`freshness.ts:173`), the count never moves, and the test greens under the
    // very mutation it exists to catch. Here the newest row is projectable.
    const dataDir = scratchDir();
    const db = scratchDb();
    const [newest, older] = sessionIds(2, 'nb') as [string, string];
    // `older` first, so `newest` really is the newest by `last_activity_at`.
    seedIndexRow(db, seedArchive(dataDir, older), {
      id: older,
      last_activity_at: '2026-08-14T09:00:00.000Z',
    });
    seedIndexRow(db, seedArchive(dataDir, newest), {
      id: newest,
      last_activity_at: '2026-08-14T11:00:00.000Z',
    });
    expect(readWarmableIds(db)[0]).toBe(newest);

    const queue = track(createWarmQueue({ db, env: fileEnv(), hub: recordingHub() }));
    const queued = queue.start();

    // MUTATION CONTROL: this is the assertion the leading `await yieldTo()` in
    // `drain` exists to satisfy. Remove that await and the first session is
    // projected inside `start()`, so the count drops to 1 here.
    expect(readWarmableIds(db)).toHaveLength(queued);
    expect(queued).toBe(2);
  });

  it('2. queued counts sidecars, not just the sessions a list would show', async () => {
    // Founder ruling 3's executable form, and the non-vacuity control against
    // `readWarmableIds` acquiring a `TOP_LEVEL_ONLY` predicate: sidecars are
    // 92.9% of the real corpus and their bodies are searchable.
    const db = scratchDb();
    const parent = seedSessionRow(db, { id: 'parent-1', projection_state: 'none' });
    seedSidecarRow(db, parent, { id: 'agent-1', projection_state: 'none' });
    seedSidecarRow(db, parent, { id: 'agent-2', projection_state: 'none' });

    const queue = track(createWarmQueue({ db, env: fileEnv(), hub: recordingHub() }));
    expect(queue.start()).toBe(3);

    // And a POST that lands after `close()` reports 0 rather than a queue
    // nothing will walk. `startServer.close()` stops the loop BEFORE the socket,
    // so a request already accepted can reach here during shutdown.
    queue.close();
    expect(queue.start()).toBe(0);
    await Promise.resolve();
  });
});

/* --------------------------------------------------------------- AC2 --- */

describe('AC2 — the run is newest-first and ends at done == total', () => {
  it('4. sessions are projected in the reader’s newest-first order', async () => {
    const dataDir = scratchDir();
    const db = scratchDb();
    const hub = recordingHub();
    const ids = sessionIds(3, 'or');
    const paths = new Map<string, string>();
    const stamps = [
      '2026-08-14T09:00:00.000Z',
      '2026-08-14T10:00:00.000Z',
      '2026-08-14T11:00:00.000Z',
    ];
    ids.forEach((id, i) => {
      const path = seedArchive(dataDir, id);
      paths.set(path, id);
      seedIndexRow(db, path, { id, last_activity_at: stamps[i]! });
    });

    const seen: string[] = [];
    const base = fileEnv();
    const recording: ProjectionEnv = {
      ...base,
      readLines: (archivePath) => {
        const id = paths.get(archivePath);
        if (id !== undefined) seen.push(id);
        return base.readLines(archivePath);
      },
    };

    const expected = readWarmableIds(db);
    expect(expected).toEqual([...ids].reverse());

    const queue = track(createWarmQueue({ db, env: recording, hub }));
    expect(queue.start()).toBe(3);
    await waitFor(() => warmFrames(hub).length === 3, 10_000, 'three warm frames');

    // The gate saw them newest-first, and the frames correspond to that order.
    expect(seen).toEqual(expected);
  });

  it('5. frames run 1..total, every total is N, and the last is { N, N }', async () => {
    const dataDir = scratchDir();
    const db = scratchDb();
    const hub = recordingHub();
    const ids = sessionIds(4, 'fr');
    for (const id of ids) seedIndexRow(db, seedArchive(dataDir, id), { id });

    const queue = track(createWarmQueue({ db, env: fileEnv(), hub }));
    const queued = queue.start();
    expect(queued).toBe(4);
    await waitFor(() => warmFrames(hub).length === 4, 10_000, 'four warm frames');

    const frames = warmFrames(hub).map((f) => f.data as unknown as { done: number; total: number });
    expect(frames.map((f) => f.done)).toEqual([1, 2, 3, 4]);
    expect(frames.every((f) => f.total === 4)).toBe(true);
    expect(frames.at(-1)).toEqual({ done: 4, total: 4 });
    // `queued === total` is an IDENTITY: `start()` returns the same snapshot the
    // run walks, so no second read can disagree with it.
    expect(queued).toBe(frames.at(-1)!.total);
  });

  it(
    '6. end to end over a real archive: afterwards nothing is unprojected',
    { timeout: 30_000 },
    async () => {
      const booted = await bootUnprojected({ sessions: 8, missing: 3, stale: 4 });
      const s = booted.server;

      // The missing subset is the only limb `unprojected_count` can see — a
      // version-stale row is `'ready'`, which is the whole reason this endpoint
      // exists and the reason the assertion below reads two different columns.
      expect(await unprojectedCount(s)).toBe(booted.missing.length);
      const before = stateOf(s.dataDir, booted.stale);
      expect(
        [...before.values()].every(
          ([state, v]) => state === 'ready' && v === PROJECTOR_VERSION - 1,
        ),
      ).toBe(true);

      const warmed = await postWarm(s);
      expect(warmed.status).toBe(202);
      // A SUPERSET of the search denominator: missing plus version-stale.
      expect(warmed.queued).toBe(booted.missing.length + booted.stale.length);

      // ★ `?q=a`, never a bare `/api/search`: with no `q` the route 400s with
      // `{ error: 'invalid q' }`, which carries no `unprojected_count` at all —
      // so the poll would spin to its timeout no matter what the warm did.
      const deadline = Date.now() + 20_000;
      let remaining = await unprojectedCount(s);
      while (remaining > 0) {
        if (Date.now() > deadline) throw new Error(`unprojected_count stuck at ${remaining}`);
        remaining = await unprojectedCount(s);
      }
      expect(remaining).toBe(0);

      // The reboot ran NO sweep, so nothing but the warm could have done this.
      const health = await getJson<{ files_indexed: number | null }>(s, '/api/health');
      expect(health.files_indexed).toBe(0);

      const after = stateOf(s.dataDir, booted.ids);
      expect(after.size).toBe(booted.ids.length);
      for (const [id, [state]] of after) {
        expect(['ready', 'empty'], id).toContain(state);
      }
      // ★ FOUNDER RULING 4's assertion: the version-stale rows advanced, which
      // only the `projector_version` limb of the predicate could have caused.
      for (const id of booted.stale) {
        expect(after.get(id)?.[1], id).toBe(PROJECTOR_VERSION);
      }
    },
  );

  it('7. a failed session does not hang the run, and the residual is honest', async () => {
    const dataDir = scratchDir();
    const db = scratchDb();
    const hub = recordingHub();
    const ids = sessionIds(3, 'fl');
    const paths = ids.map((id, i) => {
      const path = seedArchive(dataDir, id);
      seedIndexRow(db, path, {
        id,
        last_activity_at: `2026-08-14T0${9 - i}:00:00.000Z`,
      });
      return path;
    });

    const queue = track(createWarmQueue({ db, env: brokenEnv(fileEnv(), paths[1]!), hub }));
    expect(queue.start()).toBe(3);
    await waitFor(() => warmFrames(hub).length === 3, 10_000, 'three warm frames');

    // `done` counts ATTEMPTS, so the terminal condition is always reachable.
    expect(warmFrames(hub).at(-1)).toMatchObject({ data: { done: 3, total: 3 } });
    const row = db
      .prepare('SELECT projection_state AS s FROM sessions WHERE id = ?')
      .get(ids[1]!) as { s: string };
    expect(row.s).toBe('failed');
    // Open Question 2's executable record: AC2's `unprojected_count: 0` is a
    // claim about a corpus where every session projects, and this is not one.
    expect(countUnprojected(db)).toBe(1);
  });
});

/* --------------------------------------------------------------- AC3 --- */

describe('AC3 — the yield leaves the event loop to everything else', () => {
  it(
    '8. a repeating timer keeps firing during a warm — with its mutation control',
    { timeout: 30_000 },
    async () => {
      // ★ REAL WALL TIME, NOT AN INJECTED CLOCK. AC3 is a claim about the actual
      // event loop, so the only honest harness spins real milliseconds and counts
      // real timer fires.
      const K = 12;
      const COST_MS = 16;
      const PERIOD_MS = 10;

      const run = async (yieldTo?: () => Promise<void>): Promise<number> => {
        const dataDir = scratchDir();
        const db = scratchDb();
        const hub = recordingHub();
        const paths = new Set<string>();
        for (const id of sessionIds(K, 'yl')) {
          const path = seedArchive(dataDir, id);
          paths.add(path);
          seedIndexRow(db, path, { id });
        }

        let fires = 0;
        const timer = setInterval(() => {
          fires += 1;
        }, PERIOD_MS);
        try {
          const queue = track(
            createWarmQueue({
              db,
              env: slowEnv(fileEnv(), COST_MS, paths),
              hub,
              ...(yieldTo !== undefined && { yieldTo }),
            }),
          );
          expect(queue.start()).toBe(K);
          await waitFor(() => warmFrames(hub).length === K, 20_000, `${K} warm frames`);
        } finally {
          clearInterval(timer);
        }
        return fires;
      };

      // AT LEAST K-1, NEVER K. A repeating `setInterval` fires at most once per
      // timers phase however many periods elapsed, so one full loop turn per
      // session buys one fire per session — minus the first turn, whose
      // `setImmediate` resolves at t≈0, before the 10 ms timer has come due.
      // Measured on Node v26: 19 fires over 20 sessions, identical across runs.
      const withYield = await run();
      expect(withYield).toBeGreaterThanOrEqual(K - 1);

      // ★ THE MUTATION CONTROL, and the reason `yieldTo` is a seam at all.
      // `await Promise.resolve()` is a MICROTASK: the loop never leaves its turn,
      // so timers never come due. `await hub.publish(...)` collapses to exactly
      // this when no client is attached, which is why the publish cannot stand in
      // for the yield.
      const microtask = await run(() => Promise.resolve());
      expect(microtask).toBe(0);
    },
  );

  it(
    '9. session list and detail reads stay served throughout a warm',
    { timeout: 60_000 },
    async () => {
      const booted = await bootUnprojected({ sessions: 20, lines: 40, missing: 20, stale: 0 });
      const s = booted.server;
      expect((await postWarm(s)).queued).toBe(20);

      const reads: number[] = [];
      let clearedAfter = -1;
      const deadline = Date.now() + 45_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error('warm never drained');
        // The LIST route, deliberately: `GET /api/sessions/:id` runs the gate
        // itself (`api.ts:455`), so polling it would do the warm's work for it.
        const res = await fetch(s.url('/api/sessions'), { headers: { [TOKEN_HEADER]: s.token } });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        await res.json();
        reads.push(reads.length);

        if ((await unprojectedCount(s)) > 0) continue;
        clearedAfter = reads.length;
        break;
      }

      // ★ THE LIMB THAT MAKES THIS NON-TRIVIAL. Without it a blocking loop that
      // simply finished first would pass: every read would then be served after
      // the warm, and the test would say nothing about concurrency.
      expect(clearedAfter).toBeGreaterThan(1);
      expect(reads.length).toBe(clearedAfter);

      // One detail read at the END, for its content type — it runs the gate.
      const detail = await fetch(s.url(`/api/sessions/${booted.ids[0]!}`), {
        headers: { [TOKEN_HEADER]: s.token },
      });
      expect(detail.status).toBe(200);
      expect(detail.headers.get('content-type')).toContain('application/json');
    },
  );

  it(
    '10. the live tick keeps publishing while a warm is mid-run',
    { timeout: 30_000 },
    async () => {
      // IN-PROCESS, never through a boot: a `sweepIntervalMs: 0` boot has no tick
      // at all, and any other value projects the fixture before the socket binds.
      const K = 12;
      const dataDir = scratchDir();
      const db = scratchDb();
      const hub = recordingHub();
      const env = fileEnv();

      // The session the tick reprojects: already `ready@current`, so the warm's
      // snapshot cannot contain it and every frame it produces is the tick's.
      const [growing] = sessionIds(1, 'gr') as [string];
      const growingPath = seedArchive(dataDir, growing);
      seedIndexRow(db, growingPath, { id: growing });
      expect(ensureProjectedFold(db, growing, env).outcome).toBe('projected');

      const slowPaths = new Set<string>();
      for (const id of sessionIds(K, 'sl')) {
        const path = seedArchive(dataDir, id);
        slowPaths.add(path);
        seedIndexRow(db, path, { id });
      }

      let line = 100;
      const sweep: CorpusSweep = {
        // Wave 1 stands in for the walk: it grows the file and reports the id,
        // which is exactly the shape `live.ts:129-140` consumes. Wave 2 is
        // stubbed for the reason every tick test stubs it — it rolls sub-agents
        // up and has nothing to do with this claim.
        wave1: () => {
          line += 1;
          appendFileSync(growingPath, `${JSON.stringify(transcriptLine(growing, line))}\n`);
          return { ...emptyReport(), indexed_ids: [growing] };
        },
        wave2: () => emptyReport(),
        tick: () => emptyReport(),
        report: () => emptyReport(),
        close: () => undefined,
      };

      const tick = startLiveTick({
        db,
        env: slowEnv(env, 16, slowPaths),
        sweep,
        hub,
        intervalMs: 10,
      });
      ticks.push(tick);

      const queue = track(createWarmQueue({ db, env: slowEnv(env, 16, slowPaths), hub }));
      expect(queue.start()).toBe(K);
      await waitFor(() => warmFrames(hub).length === K, 20_000, `${K} warm frames`);

      const lastWarm = hub.frames.findLastIndex((f) => f.event === 'warm_progress');
      const changed = hub.frames.filter((f) => f.event === 'session_changed');
      const midRun = hub.frames.filter((f, i) => f.event === 'session_changed' && i < lastWarm);
      const diagnostic = `${changed.length} session_changed, ${midRun.length} of them mid-run`;

      // MID-RUN, not merely present: a tick that only fired after the loop
      // finished would prove the opposite of AC3. Reds under the microtask yield
      // for the same reason test 8 does.
      expect(midRun.length, diagnostic).toBeGreaterThanOrEqual(2);
    },
  );
});

/* --------------------------------------------------------------- AC4 --- */

describe('AC4 — a second POST double-queues nothing', () => {
  it('11. two starts back to back produce exactly N frames', async () => {
    const dataDir = scratchDir();
    const db = scratchDb();
    const hub = recordingHub();
    const N = 5;
    for (const id of sessionIds(N, 'dq')) seedIndexRow(db, seedArchive(dataDir, id), { id });

    const queue = track(createWarmQueue({ db, env: fileEnv(), hub }));
    const first = queue.start();
    // ★ MUTATION CONTROL. Without the `inFlight` guard this starts a SECOND
    // drain over the same snapshot: 2N frames, and `done` repeats 1..N twice.
    const second = queue.start();

    expect(first).toBe(N);
    expect(second).toBeLessThanOrEqual(first);
    await waitFor(() => warmFrames(hub).length >= N, 10_000, `${N} warm frames`);
    // Settle long enough that a second drain would have shown itself.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const frames = warmFrames(hub).map((f) => f.data as unknown as { done: number; total: number });
    expect(frames).toHaveLength(N);
    expect(frames.every((f) => f.total === N)).toBe(true);
    expect(new Set(frames.map((f) => f.done)).size).toBe(N);

    // A POST after the run finished starts a FRESH run — the guard is a skipped
    // beat, never a latch.
    db.prepare(`UPDATE sessions SET projection_state = 'none', projected_size = NULL`).run();
    expect(queue.start()).toBe(N);
    await waitFor(() => warmFrames(hub).length === 2 * N, 10_000, `${2 * N} warm frames`);
  });
});

/* -------------------------------------------------------- real corpus --- */

describe('AC2/AC3 — the real archive, opt-in', () => {
  runIt(
    '12. a whole-corpus warm drains, and no turn runs more than one session',
    { timeout: 600_000 },
    async () => {
      const dataDir = join(homedir(), '.agent-lens');
      const scratch = scratchDir('agent-lens-warm-real-');
      const db = scratchDb();
      const hub = recordingHub();

      // Wave 1 alone: index the real archive without projecting any of it.
      createCorpusSweep({ db, dataDir, transcriptRoot: scratch }).wave1();

      // ★ ONE PASS CANNOT DRAIN A FRESHLY INDEXED CORPUS, and that is the
      // product's behaviour rather than the queue's defect: wave 1 DEFERS
      // sidecars whose parent it has not indexed yet, and projecting a parent is
      // what discovers and inserts its children. Measured here: the first
      // snapshot is 43 rows and the table holds 360 once they land. So the honest
      // claim is CONVERGENCE — repeated POSTs reach a fixed point — which is also
      // exactly what a user clicking the button twice would see.
      const MAX_PASSES = 12;
      const perPass: number[] = [];
      const started = performance.now();
      const env = createProjectionEnv(createArchiveReader(), {
        archiveRoot: join(dataDir, 'archive'),
        transcriptRoot: resolveTranscriptRoot(),
      });
      const queue = track(createWarmQueue({ db, env, hub }));
      let previousKey = '';
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const remaining = readWarmableIds(db);
        // The fixed point is the ID SET repeating, never the count falling: the
        // count GROWS on the early passes as each projected parent inserts its
        // children. A repeated set is the permanently-failing residual.
        const key = remaining.join(',');
        if (remaining.length === 0 || key === previousKey) break;
        previousKey = key;
        const before = warmFrames(hub).length;
        const n = queue.start();
        perPass.push(n);
        await waitFor(() => warmFrames(hub).length === before + n, 570_000, `${n} warm frames`);
      }
      const wallMs = performance.now() - started;

      const frames = warmFrames(hub);
      // Between CONSECUTIVE frames only: one gap is one event-loop turn, and the
      // loop does exactly one session per turn.
      const gaps = frames.slice(1).map((f, i) => f.at - frames[i]!.at);
      const sorted = [...gaps].sort((a, b) => a - b);
      const at = (p: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      const failed = db
        .prepare(`SELECT id FROM sessions WHERE projection_state = 'failed'`)
        .all() as unknown as { id: string }[];
      const rows = db.prepare('SELECT count(*) AS n FROM sessions').get() as unknown as {
        n: number;
      };
      const sidecars = db
        .prepare('SELECT count(*) AS n FROM sessions WHERE parent_session_id IS NOT NULL')
        .get() as unknown as { n: number };
      const warmed = perPass.reduce((sum, n) => sum + n, 0);

      // PRINTED, NEVER PINNED — `corpus.test.ts:1-8`'s rule.
      const diagnostic =
        `${warmed} warmed over ${perPass.length} passes [${perPass.join(', ')}] | ` +
        `${rows.n} rows, ${sidecars.n} sidecars ` +
        `(${((sidecars.n / Math.max(rows.n, 1)) * 100).toFixed(1)}%) | ` +
        `wall ${wallMs.toFixed(0)} ms | per-turn p50 ${at(0.5).toFixed(1)} ` +
        `p90 ${at(0.9).toFixed(1)} max ${(sorted.at(-1) ?? 0).toFixed(1)} ms | ` +
        `failed: ${failed.length === 0 ? 'none' : failed.map((r) => r.id).join(', ')}`;
      console.log(`[diagnostic] ${diagnostic}`);

      // A FLOOR on the sample, so a scan that found nothing cannot pass silently.
      expect(warmed, diagnostic).toBeGreaterThanOrEqual(MIN_SESSIONS);
      expect(perPass.length, diagnostic).toBeLessThan(MAX_PASSES);
      // Every run ended at its own terminal condition.
      expect(frames.at(-1)?.data, diagnostic).toEqual({
        done: perPass.at(-1),
        total: perPass.at(-1),
      });
      // Either everything projected, or every remainder is an honest `'failed'`.
      expect(countUnprojected(db) - failed.length, diagnostic).toBe(0);
      // ONE SESSION PER TURN. A loop that batched would show a single gap far
      // larger than any one session's cost.
      expect(sorted.at(-1) ?? 0, diagnostic).toBeLessThan(MAX_TURN_MS);
    },
  );
});
