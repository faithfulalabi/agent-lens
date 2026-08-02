// The live-tail wire contract (Task 6.1): what the per-session delta streams put
// on the wire, and the handshake that makes reconnection lossless. Type-only, so
// the browser can import it for free — a sibling of `api.ts`/`entities.ts`.
//
// **Deliberately NOT re-exported from `src/shared/index.ts`.** That barrel pulls
// in `token.js` (`node:crypto`/`fs`/`os`/`path`) and `pricing.js` (`node:crypto`),
// so anything browser-facing must import this module directly —
// `import type { Delta } from '@shared/delta.js'` — exactly as `api.ts:5-9` says.
//
// --- The three consumer rules, which are the contract 5.1c/6.2/6.3 code against
//
// 1. **Branch on the `event:` name. NEVER on the presence of `data:`.** Verified
//    against the installed hono 4.12.31 (`dist/helper/streaming/sse.js`):
//    `SSEMessage` is `{data, event?, id?, retry?}` — there is no `comment` field,
//    so `writeSSE` cannot emit an SSE comment at all. A heartbeat is
//    `writeSSE({event:'heartbeat', data:''})`, which serializes to
//    `event: heartbeat\ndata: \n\n` — an empty `data:` LINE, not a comment. So
//    "has a data line ⇒ it is a delta" is false, and `JSON.parse('')` is the
//    swallowed crash Task 5.1c documents.
// 2. **Heartbeats carry no `id:`** (hono only emits `id:` when truthy), so a
//    heartbeat must never advance the client's last-seq.
// 3. **`error` is a reserved event name** — hono's own `run()` emits `event: error`
//    on an uncaught throw in the stream callback when `streamSSE` is given a third
//    `onError` argument. Never reuse it for a delta kind.

import type { Session, Span, Trace } from './entities.js';

/** Every delta kind. Each one is also its own SSE `event:` name — see rule 1. */
export type DeltaKind =
  | 'span_opened'
  | 'span_updated'
  | 'span_closed'
  | 'trace_updated'
  | 'session_updated';

/**
 * What the ingest path stages: a whole entity, and no `seq`.
 *
 * **`seq` belongs to the stream, not to the change.** One logical change is
 * published to two scopes (the session stream and the sessions-list stream) and
 * is stamped independently on each, so the body cannot carry it.
 *
 * **Whole entities, never patches.** `upsertSpan` merges in SQL (`COALESCE`,
 * `json_patch`, a `json_group_array` tag union, a terminal-status guard —
 * `db/index.ts:229-263`), so the normalizer's inputs are *not* the post-merge
 * row; only a re-read after the upsert is truthful. It also makes deltas
 * idempotent under replay, backfill, and coalescing, and makes 6.2's apply step
 * a last-write-wins map assignment.
 */
export type DeltaBody =
  | {
      kind: 'span_opened' | 'span_updated' | 'span_closed';
      session_id: string;
      span: Span;
    }
  | { kind: 'trace_updated'; session_id: string; trace: Trace }
  | { kind: 'session_updated'; session_id: string; session: Session };

/** A `DeltaBody` stamped with the seq of the stream it is going out on. */
export type Delta = DeltaBody & { seq: number };

/**
 * How a connecting client is being served, decided server-side and reported in
 * the `hello` frame. The client never computes this — it never parses,
 * increments, or gap-compares its cursor (Task 5.1c contract (a)).
 *
 * - `live` — no cursor was sent; frames start at the current head.
 * - `backfill` — the cursor is inside the ring on this same stream, so the
 *   missed deltas are replayed before live frames resume. This is the
 *   network-only-drop case (collector still up, ring intact).
 * - `refetch` — the cursor cannot be honoured (`stream_id` mismatch after a
 *   collector restart, or a cursor already evicted from the ring). The client
 *   re-reads current state from the Task 5.0 endpoints. **The stream STAYS
 *   OPEN** and continues from head; closing it would create a reconnect race,
 *   and the DB has everything the client needs.
 */
export type ResumeVerdict = 'live' | 'backfill' | 'refetch';

/**
 * The first frame on every delta stream, always. One handshake shape, one enum,
 * three cases — see {@link ResumeVerdict}.
 *
 * `stream_id` is the epoch that makes resume safe. Per-scope seq is in-memory and
 * therefore NOT durable across a collector restart; without an epoch there is a
 * real silent-divergence hole (client at seq 5, server restarts, ingests 20
 * deltas, client reconnects at 6 and is served *a different* delta 6). A
 * `stream_id` mismatch is an unconditional `refetch`.
 */
export interface HelloFrame {
  stream_id: string;
  /** The session this stream is scoped to; `null` on the sessions-list stream. */
  session_id: string | null;
  /** Oldest seq still replayable from the ring; `0` when the ring is empty. */
  first_seq: number;
  /** Newest seq issued on this stream; `0` before the first delta. */
  last_seq: number;
  resume: ResumeVerdict;
}

/**
 * The terminal frame. Emitted for exactly two reasons, and `session_interrupted`
 * is deliberately NOT one of them:
 *
 * **`interrupted` is not terminal.** `reviveSession` (`db/index.ts:508-524`) flips
 * `interrupted` back to `live` and runs on every non-transcript envelope via
 * `normalizer.ts:121`. Ending the stream on a sweep would stop the client
 * reconnecting, and a late hook that revived the session would then be invisible
 * until a manual reload — precisely the silently-stale view live tail exists to
 * prevent. On `interrupted` the stream stays open and a later revive arrives on
 * the same connection.
 *
 * `complete` is the one state revive cannot undo (both of `reviveSession`'s
 * UPDATEs are `WHERE … status = 'interrupted'`), so it is genuinely final.
 */
export interface StreamEndFrame {
  reason: 'session_complete' | 'server_shutdown';
}

/** Non-delta SSE event names. Delta frames use their {@link DeltaKind} verbatim. */
export const SSE_EVENT = {
  hello: 'hello',
  heartbeat: 'heartbeat',
  streamEnd: 'stream_end',
} as const;

/** The query parameter carrying the client's resume cursor. */
export const FROM_SEQ_PARAM = 'from_seq';

/** The query parameter carrying the client's stream epoch. */
export const STREAM_ID_PARAM = 'stream_id';
