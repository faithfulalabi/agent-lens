// The 1 Hz live tick: sweep, re-project what moved, publish the diff.
//
// It owns the one timer the server runs, and it is the timer the sweep already
// had — `startServer` hands the sweep here instead of calling `sweep.bind()`.
// There is no second pipeline and no second query path: wave 1 already computes
// "whose bytes moved" (`corpus/scan.ts:168-176`) in the one query that loads the
// Tier-A index, and `ensureProjectedFold` is the SAME function the cold read
// path calls. Byte-identity between live and cold output is therefore a property
// of calling one function twice, not a second implementation to keep in step.
//
// ★ "LIVE" MEANS ARCHIVE-LIVE. The tick reads the archive, never
// `~/.claude/projects`, and nothing in the server copies one to the other:
// `archiveOnce` has a single caller, the `agent-lens archive` CLI command. In
// production the mirror is an external launchd job at 15 minutes of WAKE time,
// and measured real gaps run to 28.8 h. So this tick is 1 Hz over correct bytes
// and end-to-end latency is the mirror's, not this file's. Making the archive
// itself live is a separate task with its own containment surface.
//
// ★ NO SUBSCRIBER CONCEPT. The filter is the fold check, which already runs once
// per tick and normally answers "nothing moved". That is a tighter bound than
// "every subscribed session, moved or not", and it costs no protocol surface.
//
// ★ THE HEARTBEAT IS NOT HERE. The hub owns its own wall-clock timer, so the
// beat survives a boot with the sweep switched off and never scales with the
// sweep period. See `stream.ts`.

import type { DatabaseSync } from 'node:sqlite';
import type { CorpusSweep } from '../corpus/watch.js';
import { ensureProjectedFold, fingerprint } from '../db/freshness.js';
import {
  readEventsByIds,
  readRunningEventIds,
  readSessionHeader,
  readTurns,
  type EventRow,
  type SessionDetailHeader,
} from '../db/read.js';
import type { ProjectionEnv } from '../db/write.js';
import type { SessionChangedFrame, SessionIndexedFrame, SessionRollups } from '../shared/api.js';
import type { StreamHub } from './stream.js';

const INTERVAL_MS = 1000;

/**
 * A reprojection over this backs its session off. It is not theoretical: FTS
 * population costs 8-14x the rest of the SQLite write (`db/write.ts:161-163`,
 * 5.6 -> 43.8 ms measured) and `projectSession` runs it unconditionally, so a
 * large session trips this routinely. That is the design working — the felt
 * latency for the biggest sessions is 5 s, not 1 s.
 */
const SLOW_MS = 100;

/** How long a slow session sits out. Per session, never global. */
const SLOW_INTERVAL_MS = 5000;

/**
 * The reprojection phase's own budget, checked BETWEEN sessions and never before
 * the first, so one slow session still makes progress.
 *
 * The same shape and the same number as wave 2's (`corpus/watch.ts:54`) and for
 * the same reason: whole-file projection is unbounded, so only a deadline bounds
 * the phase — at `deadline + one session`. Note that calling `wave2()` here
 * rather than `sweep.tick()` restarts wave 2's own clock, so a tick's worst case
 * is now wave 1 (~20 ms) + this deadline + one session + wave 2's deadline + one
 * tree, rather than the single ~1,035 ms `watch.ts:52-55` derived. An overrun
 * skips fires rather than stacking passes — see the in-flight guard below, which
 * this file needs and `watch.ts` does not, because that tick is synchronous.
 */
const DEADLINE_MS = 250;

export interface LiveTickOptions {
  db: DatabaseSync;
  env: ProjectionEnv;
  sweep: CorpusSweep;
  hub: StreamHub;
  /** `0` binds no timer, mirroring `sweepIntervalMs: 0`, so a test never sleeps. */
  intervalMs?: number;
  now?: () => number;
}

export interface LiveTick {
  /** One pass, unguarded. Tests await it; the timer goes through `fire` instead. */
  tick(): Promise<void>;
  close(): void;
}

/** The own-column slice of a session header — see {@link SessionRollups}. */
function ownRollups(header: SessionDetailHeader): SessionRollups {
  return {
    last_activity_at: header.last_activity_at,
    turn_count: header.turn_count,
    tool_call_count: header.tool_call_count,
    error_count: header.error_count,
    tokens_in: header.tokens_in,
    tokens_out: header.tokens_out,
    tokens_cache_read: header.tokens_cache_read,
    tokens_cache_write: header.tokens_cache_write,
    est_cost: header.est_cost,
  };
}

/**
 * Start the live tick over an existing sweep and hub.
 *
 * Two pieces of closure state, neither persisted:
 *
 * - `backoffAt` — next eligible time per slow session. A restart re-measures,
 *   which is right: the backoff describes the last projection's cost, not the
 *   session.
 * - `pending` — LOAD-BEARING. Wave 1's upsert clears the Tier-A diff that put an
 *   id in `indexed_ids`, so a session deferred by the backoff drops out of
 *   `indexed_ids` on the very next tick while still being PROJECTION-stale — the
 *   gate reads `projected_mtime_ms`, a different pair of columns — and wave 2
 *   never revisits a rolled-up tree. Without `pending` a slow session's growth is
 *   dropped forever rather than deferred by 5 s.
 */
export function startLiveTick(options: LiveTickOptions): LiveTick {
  const { db, env, sweep, hub } = options;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? INTERVAL_MS;

  const backoffAt = new Map<string, number>();
  const pending = new Set<string>();
  const announced = new Set<string>();

  const tick = async (): Promise<void> => {
    const startedAt = now();
    const report = sweep.wave1();

    for (const id of report.indexed_ids) {
      if (announced.has(id)) continue;
      announced.add(id);
      const frame: SessionIndexedFrame = { session_id: id };
      await hub.publish('session_indexed', frame);
    }

    // `pending` first: a deferred session has waited longer than a fresh one.
    const candidates = [...pending, ...report.indexed_ids.filter((id) => !pending.has(id))];
    let visited = 0;

    for (const id of candidates) {
      // ★ THE ONLY SITE THAT INSERTS INTO `pending`. Without this line the set is
      // written by nothing, is always empty, and the backoff drops growth
      // instead of deferring it.
      if ((backoffAt.get(id) ?? 0) > now()) {
        pending.add(id);
        continue;
      }
      if (visited > 0 && now() - startedAt >= DEADLINE_MS) {
        pending.add(id);
        continue;
      }
      visited += 1;

      const before = new Set(readRunningEventIds(db, id));
      const startedProjection = now();
      const gate = ensureProjectedFold(db, id, env);
      if (now() - startedProjection > SLOW_MS) backoffAt.set(id, now() + SLOW_INTERVAL_MS);

      // `'failed'` STAYS PENDING. The gate answers `'failed'` when the fold or
      // the projection itself failed, and wave 1 has already cleared the Tier-A
      // diff while wave 2 never revisits a rolled-up tree — so forgetting it here
      // drops that session's growth permanently, which is the exact bug `pending`
      // exists to prevent. Back it off and retry.
      if (gate.outcome === 'failed') {
        pending.add(id);
        continue;
      }
      // A `'hit'` means the projector already holds these bytes: nothing moved,
      // so nothing is published. This is what keeps the no-growth test honest.
      if (gate.outcome !== 'projected' || gate.fold === undefined) {
        pending.delete(id);
        continue;
      }

      pending.delete(id);
      const header = readSessionHeader(db, id);
      if (header === undefined) continue;

      const after = new Set(readRunningEventIds(db, id));
      const stopped = [...before].filter((eventId) => !after.has(eventId));
      const turns = readTurns(db, id);
      const last = turns[turns.length - 1];
      const frame: SessionChangedFrame<EventRow> = {
        session_id: id,
        // The fold rides back on the gate result, so the tick never re-folds and
        // never needs an archive path of its own.
        fingerprint: fingerprint(gate.fold),
        from_seq: last === undefined ? 0 : last.first_seq,
        patched: readEventsByIds(db, id, stopped),
        rollups: ownRollups(header),
      };
      await hub.publish('session_changed', frame);
    }

    // LAST, so wave 2's own 250 ms deadline never delays a live frame.
    sweep.wave2();
  };

  /**
   * The timer's entry point, and it is NOT `tick` itself.
   *
   * `tick` is `async`, so it returns at its first `await` and the interval keeps
   * firing underneath it — `watch.ts`'s "node coalesces a late fire" reasoning
   * holds for a SYNCHRONOUS callback and does not carry over. Two overlapping
   * passes would both walk `candidates` and publish the same growth twice. The
   * guard is a skipped beat, which is correct: the work is idempotent and the
   * next fire is one second away.
   *
   * A rejection is logged rather than dropped. `void tick()` alone would surface
   * a genuine fault as an unhandled rejection, which ends the process — a
   * background loop must not take the server down with it.
   */
  let inFlight = false;
  const fire = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await tick();
    } catch (error) {
      console.error(error);
    } finally {
      inFlight = false;
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  if (intervalMs !== 0) {
    timer = setInterval(() => void fire(), intervalMs);
    timer.unref?.();
  }

  return {
    tick,
    close: (): void => {
      // FIRST, per `watch.ts:303-309`: a tick that fires after `db.close()`
      // throws where no caller can catch it.
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
