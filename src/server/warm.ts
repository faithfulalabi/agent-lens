/*
 * The `POST /api/warm` background queue (Task 7.4) — `warm_progress`'s producer.
 *
 * ★ WHY THIS EXISTS, because the obvious answer is wrong. Tier B is NOT
 * lazy-on-first-open: `runWave2` walks `readTreeRoots` and `projectTree`
 * projects each root AND every descendant (`watch.ts:238-281`), the live tick
 * runs wave 2 at the end of every beat (`live.ts:199`), so a running server
 * warms the whole corpus unaided in ~20 s with nobody clicking anything.
 *
 * What nothing else can do is re-warm after a `PROJECTOR_VERSION` bump.
 * `rollup_state` has one writer and only goes `'own'` -> `'complete'`
 * (`write.ts:594`), and `readTreeRoots` selects `'own'` — so wave 2 warms each
 * tree exactly once, ever. The tick's candidates are `pending ∪ indexed_ids`,
 * i.e. sessions whose file moved. A version bump leaves every row
 * `projection_state = 'ready'` with a stale version, reached by neither, and
 * reprojected one at a time inside whichever request opens it. That state is
 * not hypothetical: `render-gate/index.ts:737` measures 287 of 293 rows at
 * version 4 against a projector at 5.
 *
 * NO SQL HERE — `readWarmableIds` is the one door (`sql-one-door.test.ts`).
 */

import type { DatabaseSync } from 'node:sqlite';
import { ensureProjectedFold } from '../db/freshness.js';
import { readWarmableIds } from '../db/read.js';
import type { ProjectionEnv } from '../db/write.js';
import type { WarmProgressFrame } from '../shared/api.js';
import type { StreamHub } from './stream.js';

export interface WarmQueueOptions {
  db: DatabaseSync;
  env: ProjectionEnv;
  hub: StreamHub;
  /**
   * ponytail: the seam AC3's mutation control needs, and the only reason it is a
   * parameter. Weakening the default to a microtask starves the 1 Hz tick
   * completely (measured 0 timer fires vs 19 over 20 sessions), and the control
   * arm in `warm.test.ts` is what keeps that from happening silently.
   */
  yieldTo?: () => Promise<void>;
}

export interface WarmQueue {
  /**
   * Start a run over every warmable session. Returns what the caller may report
   * as `queued`. A run already in flight starts nothing and returns the honest
   * remaining count.
   */
  start(): number;
  /** Stop at the next session boundary. Called by `startServer.close()`. */
  close(): void;
}

/**
 * One session per event-loop turn, so a 5-6 second whole-corpus sweep never
 * holds the loop.
 *
 * `setImmediate`, never `Promise.resolve()`: a microtask yield leaves the loop
 * in the same turn, so timers never come due and the 1 Hz tick is starved. A
 * `setImmediate` queued from the check phase runs on the NEXT iteration, so the
 * loop makes one full turn — timers, then poll, then one warm session — per
 * session. `await hub.publish(...)` alone collapses to a microtask when no
 * client is attached (`stream.ts:111-122` resolves `Promise.all([])`), so the
 * publish cannot stand in for this.
 */
const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The warm queue. Deliberately NOT the live tick's `DEADLINE_MS` idiom: that
 * bounds a synchronous phase inside a beat that already owns its slot, whereas
 * this owns its own turns — a 250 ms slice would run a deadline's worth of
 * sessions per turn instead of one, which is ~15x worse for the tick it must not
 * starve. The bound is stated in the same shape: one warm session per turn,
 * worst case 135.7 ms (7.1's measured maximum).
 */
export function createWarmQueue(options: WarmQueueOptions): WarmQueue {
  const { db, env, hub } = options;
  const yieldTo = options.yieldTo ?? yieldToLoop;

  let inFlight = false;
  let closed = false;

  const drain = async (ids: readonly string[]): Promise<void> => {
    const total = ids.length;
    let done = 0;
    for (const id of ids) {
      // FIRST, before any projection: the 202 has to reach the wire before the
      // handler's caller is made to wait on a session, and `start()` returns
      // synchronously only because nothing runs ahead of this await.
      await yieldTo();
      if (closed) return;
      try {
        ensureProjectedFold(db, id, env);
      } catch (error) {
        // The gate answers `'failed'` rather than throwing, so this is the fault
        // nobody predicted. Counting it anyway is what keeps `done === total`
        // reachable; the residual shows up in `unprojected_count`.
        console.error(error);
      }
      done += 1;
      const frame: WarmProgressFrame = { done, total };
      await hub.publish('warm_progress', frame);
    }
  };

  return {
    start: () => {
      // `close()` runs BEFORE the socket does, so a request already accepted can
      // reach this during shutdown. Reporting a queue that will never be walked
      // would be a 202 that lies.
      if (closed) return 0;
      // Snapshotted FIRST and unconditionally, so `queued` is the same array the
      // run walks rather than a second count that could disagree with it.
      const ids = readWarmableIds(db);
      if (inFlight) return ids.length;
      if (ids.length === 0) return 0;

      inFlight = true;
      // A rejection here would surface as an unhandled rejection and end the
      // process; a background loop must not take the server down with it — the
      // same reasoning `live.ts:210-214` states for the tick.
      void drain(ids)
        .catch((error: unknown) => console.error(error))
        .finally(() => {
          inFlight = false;
        });
      return ids.length;
    },
    close: () => {
      // SYNCHRONOUS, and that is the point: `startServer.close()` calls this
      // before `opened.close()`, so a pending `setImmediate` cannot reach a
      // closed database and throw where nothing can catch it.
      closed = true;
    },
  };
}
