// Rollups: the write-time aggregates the session list and trace chips read
// (Flow 3's perf rule — computed at write, never at read). Lives under `src/db/`
// because it is all SQL; `src/capture/` decides *when* to call it.
//
// **Recompute from children, never delta arithmetic.** `SET n = n + 1` per event
// is the obvious incremental design and it is wrong for this architecture: spool
// replay, upsert-by-`event_id`, dead-letter reprocess, and Phase-3's transcript
// merge (which REWRITES span tokens after the fact) all re-run the same
// projection. Delta arithmetic double-counts on every one of those; a recompute
// is idempotent by construction and self-heals a drifted row. It is also less
// code, and it is index-backed by `idx_spans_trace_started`.
//
// **Every assignment is wrapped in COALESCE(..., 0) — no exceptions.** Every
// rollup target on `traces`/`sessions` is `NOT NULL`, and `SUM`/`COUNT` over a
// parent with zero children returns `NULL`. A `UserPromptSubmit` opens a trace
// with zero spans, so an uncoalesced assignment would throw `NOT NULL constraint
// failed` on the second envelope of every session and abort the whole batch
// transaction. The reviewer check is mechanical: no bare aggregate may appear on
// the right-hand side of a `SET` in this file.

import type { DatabaseSync } from 'node:sqlite';
import { estimateCost, PRICING_VERSION, type TokenUsage } from '../shared/index.js';

/** A full usage snapshot for one span, as Task 3.2's transcript merge supplies it. */
export interface SpanUsage extends TokenUsage {
  /** Harness model id; may carry a build-date suffix or vendor prefix. */
  model?: string;
}

/**
 * Record token usage on a span and price it. **The single entry point for token
 * data** — nothing in Phase 2 produces tokens (hook payloads carry none), so
 * Task 3.2's transcript merge is the caller.
 *
 * The write is a full snapshot, not a patch: all four token columns are set from
 * `usage`, so re-merging the same transcript line converges instead of
 * accumulating. `est_cost` is `NULL` for an unknown model (never `0` — see
 * `estimateCost`), and `attrs` records which pricing table produced the number
 * so a later rate bump is auditable per span. `json_set` merges into the existing
 * `attrs` object, preserving harness-drift keys the normalizer stashed there.
 */
export function recordSpanUsage(
  db: DatabaseSync,
  spanId: string,
  usage: SpanUsage,
): void {
  const cost = estimateCost(usage.model, usage);
  // A stale `pricing_status` would misreport a span that was repriced after a
  // table update, so the priced branch removes the key rather than leaving it.
  const attrsExpr =
    cost === null
      ? `json_set(attrs, '$.pricing_version', ?, '$.pricing_status', 'unknown_model')`
      : `json_remove(json_set(attrs, '$.pricing_version', ?), '$.pricing_status')`;
  db.prepare(
    `UPDATE spans SET
       tokens_in          = ?,
       tokens_out         = ?,
       tokens_cache_read  = ?,
       tokens_cache_write = ?,
       est_cost           = ?,
       model              = COALESCE(?, model),
       attrs              = ${attrsExpr}
     WHERE id = ?`,
  ).run(
    usage.tokens_in ?? null,
    usage.tokens_out ?? null,
    usage.cache_read ?? null,
    usage.cache_write ?? null,
    cost,
    usage.model ?? null,
    PRICING_VERSION,
    spanId,
  );
}

/**
 * Recompute one trace's aggregates from its spans. Idempotent.
 *
 * `SUM(est_cost)` deliberately SKIPS NULL span costs rather than treating them
 * as free — only the empty-set result is coalesced to 0. The inner
 * `COALESCE(tokens_in,0) + COALESCE(tokens_out,0)` inside `total_tokens` is a
 * *separate* requirement from the outer one: a span with `tokens_in` set but
 * `tokens_out` NULL would otherwise contribute NULL to the sum.
 *
 * `duration_ms` runs to the trace's own `ended_at`, or the latest span close
 * while the turn is still open, and is clamped with `MAX(…, 0)`: an out-of-order
 * `Stop` (which Task 2.3 tolerates) can put `ended_at` before `started_at`, and a
 * negative duration is a nonsense the UI must never render.
 */
export function recomputeTraceRollup(db: DatabaseSync, traceId: string): void {
  db.prepare(
    `UPDATE traces SET
       tokens_in          = COALESCE((SELECT SUM(tokens_in)          FROM spans WHERE trace_id = traces.id), 0),
       tokens_out         = COALESCE((SELECT SUM(tokens_out)         FROM spans WHERE trace_id = traces.id), 0),
       tokens_cache_read  = COALESCE((SELECT SUM(tokens_cache_read)  FROM spans WHERE trace_id = traces.id), 0),
       tokens_cache_write = COALESCE((SELECT SUM(tokens_cache_write) FROM spans WHERE trace_id = traces.id), 0),
       total_tokens       = COALESCE((SELECT SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0))
                                      FROM spans WHERE trace_id = traces.id), 0),
       est_cost           = COALESCE((SELECT SUM(est_cost)           FROM spans WHERE trace_id = traces.id), 0),
       tool_call_count    = COALESCE((SELECT COUNT(*) FROM spans
                                      WHERE trace_id = traces.id AND span_type = 'tool_call'), 0),
       error_count        = COALESCE((SELECT COUNT(*) FROM spans
                                      WHERE trace_id = traces.id AND status IN ('error', 'denied')), 0),
       duration_ms        = MAX(CAST(COALESCE(
                              (unixepoch(COALESCE(traces.ended_at,
                                                  (SELECT MAX(ended_at) FROM spans WHERE trace_id = traces.id)),
                                         'subsec')
                               - unixepoch(traces.started_at, 'subsec')) * 1000, 0) AS INTEGER), 0)
     WHERE id = ?`,
  ).run(traceId);
}

/**
 * Recompute one session's aggregates from its traces. Idempotent, and cheap —
 * traces-per-session is small and every source column is already `NOT NULL`.
 * Must run AFTER {@link recomputeTraceRollup} for every touched trace, or it
 * sums stale children; {@link recomputeRollups} enforces that ordering.
 *
 * `sessions` has no `duration_ms` column (per `spec/data-model.md`); wall-clock
 * session span is derived from `started_at`/`ended_at` at read time.
 */
export function recomputeSessionRollup(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET
       tokens_in          = COALESCE((SELECT SUM(tokens_in)          FROM traces WHERE session_id = sessions.id), 0),
       tokens_out         = COALESCE((SELECT SUM(tokens_out)         FROM traces WHERE session_id = sessions.id), 0),
       tokens_cache_read  = COALESCE((SELECT SUM(tokens_cache_read)  FROM traces WHERE session_id = sessions.id), 0),
       tokens_cache_write = COALESCE((SELECT SUM(tokens_cache_write) FROM traces WHERE session_id = sessions.id), 0),
       total_tokens       = COALESCE((SELECT SUM(total_tokens)       FROM traces WHERE session_id = sessions.id), 0),
       est_cost           = COALESCE((SELECT SUM(est_cost)           FROM traces WHERE session_id = sessions.id), 0),
       tool_call_count    = COALESCE((SELECT SUM(tool_call_count)    FROM traces WHERE session_id = sessions.id), 0),
       error_count        = COALESCE((SELECT SUM(error_count)        FROM traces WHERE session_id = sessions.id), 0),
       trace_count        = COALESCE((SELECT COUNT(*)                FROM traces WHERE session_id = sessions.id), 0)
     WHERE id = ?`,
  ).run(sessionId);
}

/**
 * Flush a batch's dirty set: every touched trace, then every touched session.
 * The order is load-bearing — sessions aggregate traces, so a session recomputed
 * first would sum the previous batch's numbers. Callers pass the ids collected
 * across a whole `ingestBatch` slice, so a 64-item burst on one trace costs one
 * recompute rather than 64.
 */
export function recomputeRollups(
  db: DatabaseSync,
  traceIds: Iterable<string>,
  sessionIds: Iterable<string>,
): void {
  for (const traceId of traceIds) recomputeTraceRollup(db, traceId);
  for (const sessionId of sessionIds) recomputeSessionRollup(db, sessionId);
}
