// Inactivity sweep: the "no news is bad news" half of graceful degradation. A
// session that simply stops emitting (crash, `kill -9`, closed laptop) never
// sends `Stop` or `SessionEnd`, so without this its trace stays `live` forever
// and the UI lies. The sweep marks such traces `interrupted` and finalizes their
// still-running spans `unknown` — visible degradation, never fabricated success.
//
// A pure function with `now` injected: no timers, no clock mocking in tests. The
// caller (`startServer`) owns the interval. Staleness keys on
// `raw_events.received_at` — when WE received the event, the same clock the
// archive stamps — never the harness `ts`, which a backfill can set to anything.

import type { DatabaseSync } from 'node:sqlite';
import {
  closeRunningSpans,
  lastActivityBySession,
  liveTracesForSession,
  markSessionInterrupted,
  markTraceInterrupted,
} from '../db/index.js';
import { TXN_TOP } from '../server/ingest.js';

/** Silence after which a live session is presumed interrupted. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** How often `startServer` runs the sweep. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Knobs for one sweep pass. `now` is injected so tests need no fake timers. */
export interface SweepOptions {
  /** Wall clock for this pass; defaults to the real now. */
  now?: Date;
  /** Silence threshold in ms; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * What one sweep pass changed. All zero/empty means nothing was stale.
 *
 * **The id lists exist because the sweep writes outside ingest** (Task 6.1). It
 * flips sessions/traces to `interrupted` and finalizes spans without any envelope
 * passing through the normalizer, so a client watching a session that simply goes
 * quiet has no other way to learn it was interrupted — the exact
 * stale-view-presenting-as-live that live tail exists to prevent. `startServer`
 * publishes a delta per id here. The two counts are kept alongside so
 * `closedSpans` still means what it always meant.
 */
export interface SweepResult {
  interruptedTraces: number;
  closedSpans: number;
  /** Sessions this pass actually flipped to `interrupted`. */
  sessionIds: string[];
  /** Traces this pass actually flipped to `interrupted`. */
  traceIds: string[];
  /** Spans this pass finalized `unknown`; `closedSpans === spanIds.length`. */
  spanIds: string[];
}

/**
 * Mark every session silent for longer than `timeoutMs` as `interrupted`, along
 * with its live traces and their running spans. Idempotent: a second pass over
 * the same state finds no `live` rows left and returns zeros. Runs in one
 * transaction so a partially-swept session can never be observed.
 */
export function sweepInactive(
  db: DatabaseSync,
  options: SweepOptions = {},
): SweepResult {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cutoff = now.getTime() - timeoutMs;
  const endedAt = now.toISOString();
  const result: SweepResult = {
    interruptedTraces: 0,
    closedSpans: 0,
    sessionIds: [],
    traceIds: [],
    spanIds: [],
  };

  const stale = lastActivityBySession(db).filter((row) => {
    const last = Date.parse(row.last_activity);
    // An unparseable timestamp is not evidence of silence — leave it alone.
    return !Number.isNaN(last) && last <= cutoff;
  });
  if (stale.length === 0) return result;

  db.exec(TXN_TOP.begin);
  try {
    for (const { session_id } of stale) {
      for (const traceId of liveTracesForSession(db, session_id)) {
        if (markTraceInterrupted(db, traceId, endedAt)) {
          result.interruptedTraces += 1;
          result.traceIds.push(traceId);
        }
        const closed = closeRunningSpans(db, traceId, endedAt);
        result.closedSpans += closed.length;
        result.spanIds.push(...closed);
      }
      // Only rows the sweep genuinely changed are named, so a caller publishing
      // from these lists never ships a delta for a row that did not move.
      if (markSessionInterrupted(db, session_id)) {
        result.sessionIds.push(session_id);
      }
    }
    db.exec(TXN_TOP.commit);
  } catch (err) {
    db.exec(TXN_TOP.rollback);
    throw err;
  }

  return result;
}
