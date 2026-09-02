// Read-API wire shapes that are NOT raw entities (Task 5.0). Type-only, so the
// browser can import it for free — a sibling of `entities.ts` and, like it, the
// contract Task 5.1c's typed client is written against.
//
// **Deliberately NOT re-exported from `src/shared/index.ts`.** That barrel pulls
// in `token.js` (`node:crypto`/`fs`/`os`/`path`) and `pricing.js` (`node:crypto`),
// so anything browser-facing must be imported from this module directly —
// `import type { Page } from '@shared/api.js'` — the way
// `ui/src/__tests__/shared-types.test-d.ts` imports `@shared/entities.js`.
//
// `SessionDetail` and `PayloadSlice` went in Task 5.1. Both described routes
// task 4.5 deleted, nothing constructed either, and they carried this module's
// only entity import.

/**
 * The one pagination envelope, identical on every list the read API serves.
 *
 * `has_more` comes from a `LIMIT n+1` probe, not a `COUNT(*)`: a count is a
 * second query with a read-time aggregate, which is exactly what the Flow 3
 * "rollups at write time" bet forbids. There is deliberately no `total`.
 */
export interface Page<T> {
  items: T[];
  /** The effective limit after clamping to `MAX_LIMIT`. */
  limit: number;
  offset: number;
  has_more: boolean;
}

// --- `/api/stream` frame payloads (Task 6.1) --------------------------------
// One frame type per event name that has a producer, and as of Task 7.4 that is
// all four of `STREAM_EVENTS`: `POST /api/warm`'s queue is `warm_progress`'s
// producer, so the payload shape below is a contract rather than the invention
// it would have been while nothing emitted the frame.

/**
 * The own-file aggregates of one session, and deliberately nothing else.
 *
 * `sub_*`, `agent_count` and `rollup_state` are ALL written by
 * `recomputeSubagentRollups`, which the live path does not run and could not run
 * correctly — a parent's totals mean nothing until every child is projected, and
 * the sweep's second wave never revisits a rolled-up tree. Omitting a key is
 * honest; a stale total under a fresh fingerprint is a precise-looking lie.
 */
export interface SessionRollups {
  last_activity_at: string;
  turn_count: number;
  tool_call_count: number;
  error_count: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  est_cost: number | null;
}

/**
 * `event: session_changed` — the whole file was re-projected and these rows moved.
 *
 * Generic over the event row so the browser can bind its own `EventRow` without
 * this module importing one: `src/db/read.ts` reaches `node:sqlite`, and this
 * file stays browser-safe.
 *
 * `patched` carries exactly the events that WERE `status='running'` before the
 * reprojection and are not now — the async-Agent back-patch, which lands turns
 * after the call it answers. It is uncapped: whole-file reprojection makes a
 * refetch cheap, so an oversized frame costs bandwidth and never correctness.
 */
export interface SessionChangedFrame<Event = unknown> {
  session_id: string;
  /** `'<mtime_ms>:<size>:<sidecar_count>'` — the same epoch the detail route ships. */
  fingerprint: string;
  /** `first_seq` of the session's last turn: where a client re-reads from. */
  from_seq: number;
  patched: Event[];
  rollups: SessionRollups;
}

/** `event: session_indexed` — the tick saw this id for the first time. */
export interface SessionIndexedFrame {
  session_id: string;
}

/**
 * `event: warm_progress` (spec:382) — one frame per session the warm queue
 * attempted, ending at `done === total`.
 *
 * `done` counts ATTEMPTS, not successes: a session the projector cannot read is
 * stamped `'failed'` and counted anyway, because a run that skipped it could
 * never reach its own terminal condition. There is deliberately no `failed`
 * key — the residual is `/api/search`'s `unprojected_count`, which already
 * reports it.
 */
export interface WarmProgressFrame {
  done: number;
  total: number;
}

/**
 * `event: heartbeat` — liveness only, and its payload is the EMPTY STRING.
 *
 * Not `{}`: `data: ''` is the frame that once crashed a client which branched on
 * the presence of a data line and called `JSON.parse` on it. Putting the
 * adversarial bytes on the wire is what keeps that branch from coming back.
 * This deviates from `spec/data-model-v2.md:369`, which writes `data: {}`, in
 * favour of AC1's "an empty `data:` line" and the two client tests that already
 * pin these exact bytes.
 */
export type HeartbeatFrame = '';
