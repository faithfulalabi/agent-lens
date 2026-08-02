// The delta publisher (Task 6.1): ordered, resumable, per-session change streams.
//
// Pure in-process fan-out with NO hono and NO SQL import — the HTTP half lives in
// `stream-api.ts`, which injects the two write callbacks. That keeps every rule
// below unit-testable without a socket.
//
// **`Broadcaster` (`sse.ts`) is deliberately untouched.** It is the Phase-1 global
// raw-event fan-out that `ingest.ts`, `replay.ts`, the 2.6a certification harness
// and four test files depend on; widening it would be pure churn.

import { randomUUID } from 'node:crypto';
import type {
  Delta,
  DeltaBody,
  HelloFrame,
  ResumeVerdict,
  StreamEndFrame,
} from '../shared/delta.js';

/** The scope key for the sessions-list stream, which is not any one session. */
export const LIST_SCOPE = '*';

/**
 * Backfill depth for one session's stream.
 *
 * Derived, not guessed: `app.ts`'s ingest route calls `ingestEnvelope`, which is a
 * SINGLE-ITEM `ingestBatch`, so every hook POST flushes its own rollups and emits
 * ~3 deltas (the span, a `trace_updated`, a `session_updated`). The multi-item
 * batch coalescing that would collapse those parents only happens in `replaySpool`,
 * which is deliberately given no publisher. A `BURST` of 500 (`ingest-batch.test.ts`)
 * against one session therefore produces ~500 span deltas plus ~2 parent deltas
 * once per-scope parent coalescing (below) has done its job — so 2048 is genuinely
 * ~4 bursts of headroom rather than the 1.3x it would be without that coalescing.
 *
 * **Capacity governs backfill depth ONLY.** A live subscriber is fed by push, not
 * by reading the ring, so AC1's "no delta lost under burst" holds for an attached
 * client at any ring size.
 */
export const DELTA_RING_CAPACITY = 2048;

/**
 * Backfill depth for the sessions-list stream. Only `session_updated` reaches this
 * scope and parent coalescing collapses a whole burst on one session to a single
 * entry, so this holds ~512 distinct SESSIONS, not 512 envelopes.
 */
export const LIST_RING_CAPACITY = 512;

/** How long a scope with no subscribers survives before the reaper releases it. */
export const SCOPE_IDLE_TTL_MS = 300_000;

/** How a connection puts one delta on the wire. Injected so this module stays hono-free. */
export type DeltaWriter = (delta: Delta) => Promise<void>;

/** How a connection emits its terminal frame and closes. */
export type EndWriter = (frame: StreamEndFrame) => Promise<void>;

/** What a connecting client asks for, plus how to write to it. */
export interface SubscribeOptions {
  /** The client's resume cursor. Absent -> start live from head. */
  fromSeq?: number;
  /** The client's stream epoch. Required for a backfill — see {@link DeltaPublisher.subscribe}. */
  streamId?: string;
  write: DeltaWriter;
  end: EndWriter;
}

/** A live connection's handle on its scope. */
export interface Subscription {
  /** The handshake to send as the first frame, before {@link start}. */
  readonly hello: HelloFrame;
  /** Begin draining: backfill first, then live frames. Call AFTER writing `hello`. */
  start(): void;
  /** The client went away. Idempotent. */
  close(): void;
  /** Frames waiting to be written — the test seam for the coalescing bound. */
  readonly pending: number;
}

/** One scope's state: a ring, a seq counter, an epoch, and its connections. */
interface Scope {
  key: string;
  streamId: string;
  /** Last seq issued on this scope. Starts at 0; the first delta is seq 1. */
  seq: number;
  ring: RingBuffer<Delta>;
  /** Coalesce key -> the PARENT delta currently held in the ring under it. */
  ringKeys: Map<string, Delta>;
  connections: Set<Connection>;
  /** Epoch ms the last subscriber left; `undefined` while anyone is attached. */
  idleSince: number | undefined;
}

/** One connected client: a coalescing queue drained by a single promise chain. */
interface Connection {
  scope: Scope;
  queue: Delta[];
  /** Coalesce key -> the delta currently queued under it. */
  keys: Map<string, Delta>;
  write: DeltaWriter;
  end: EndWriter;
  started: boolean;
  draining: boolean;
  closed: boolean;
  /** Set once a terminal frame is owed; written after the queue drains. */
  ending: StreamEndFrame | undefined;
}

/**
 * The coalescing identity of a delta: the ENTITY it addresses, not its kind.
 * All three span kinds share one key because they all describe the same row —
 * a `span_opened` superseded by a `span_closed` loses nothing, because the
 * payload is the whole entity.
 */
function coalesceKey(body: DeltaBody): string {
  switch (body.kind) {
    case 'trace_updated':
      return `trace:${body.trace.id}`;
    case 'session_updated':
      return `session:${body.session.id}`;
    default:
      return `span:${body.span.id}`;
  }
}

/** True for the parent kinds that coalesce inside the ring as well as per connection. */
function isParent(body: DeltaBody): boolean {
  return body.kind === 'trace_updated' || body.kind === 'session_updated';
}

/**
 * A fixed-capacity, seq-ordered log. Oldest entries are evicted on overflow, and
 * an arbitrary entry can be removed to support coalescing.
 *
 * Backed by an array with a moving `start` index and amortized compaction, so
 * `push` is O(1) amortized rather than the O(n) an `Array.shift()` ring would be
 * at 500-deltas-per-burst.
 */
export class RingBuffer<T extends { seq: number }> {
  private items: T[] = [];
  private start = 0;

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.items.length - this.start;
  }

  /**
   * Oldest replayable seq, or `0` when empty. There is deliberately no `lastSeq`
   * counterpart: the newest seq is the SCOPE's counter, which stays meaningful
   * when the ring is empty and is what `hello.last_seq` reports.
   */
  get firstSeq(): number {
    return this.size === 0 ? 0 : this.items[this.start]!.seq;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.size > this.capacity) this.start += 1;
    if (this.start >= this.capacity) {
      this.items = this.items.slice(this.start);
      this.start = 0;
    }
  }

  /** Remove one entry by identity — the delete half of coalescing. No-op if absent. */
  remove(item: T): void {
    const idx = this.items.indexOf(item, this.start);
    if (idx !== -1) this.items.splice(idx, 1);
  }

  /** Every buffered entry with `seq >= fromSeq`, oldest first. */
  since(fromSeq: number): T[] {
    const out: T[] = [];
    for (let i = this.start; i < this.items.length; i += 1) {
      const item = this.items[i]!;
      if (item.seq >= fromSeq) out.push(item);
    }
    return out;
  }

  toArray(): T[] {
    return this.items.slice(this.start);
  }
}

/**
 * Per-session (and sessions-list) delta fan-out with seq-numbered, resumable
 * streams.
 *
 * ## Seq is per scope, and that is a real contract change
 *
 * The legacy `/api/stream` stamps `id:` from `nextSeq(db)` — a global `spans_lite`
 * rowid, durable across restart. Here each scope owns an in-memory counter from 1,
 * so ONE logical change goes out with TWO different seqs (once on the session
 * stream, once on the list stream). That is exactly why `DeltaBody` carries no
 * `seq` and the publisher stamps it per scope; a client tracks the seq of the
 * stream it is on and nothing else.
 *
 * ## seq is strictly increasing on the wire, but NOT necessarily contiguous
 *
 * A gap means "a delta for that entity was superseded before it left the queue".
 * It is lossless because every payload is a whole entity, and `from_seq =
 * lastSeqSeen + 1` still works because the ring is a far less coalesced log than
 * the wire: only parent deltas collapse there, so a backfill across a gap re-serves
 * the superseded span deltas and converges to the same state.
 *
 * ## Scope lifetime is bounded in the collector's NORMAL state
 *
 * With zero UI clients attached — the ordinary case — no subscriber ever leaves,
 * so an unsubscribe-only release would never run and every session ingested since
 * boot would retain a full ring. Three rules prevent that:
 *  1. **Lazy allocation** — a scope is minted on first SUBSCRIBE, never on publish.
 *     A publish with no scope is dropped, which is correct: a client connecting
 *     later gets `refetch` and reads current state from the Task 5.0 endpoints.
 *  2. **Idle-TTL reaper** ({@link reap}) — no subscribers for `SCOPE_IDLE_TTL_MS`
 *     releases the scope whatever the session's status. Driven by the existing
 *     sweep interval; no new timer.
 *  3. **Terminal release** — `session_updated{status:'complete'}` ends the session
 *     scope outright (see {@link publish}). This subsumes the "last subscriber left
 *     and the session is not live" fast path, which this module could not implement
 *     honestly anyway: it holds no DB handle and cannot ask a session's status.
 *
 * A later envelope for a released session simply mints a fresh scope with a fresh
 * `stream_id` at seq 1, and any stale client gets `refetch` — correct and honest.
 */
export class DeltaPublisher {
  private readonly scopes = new Map<string, Scope>();

  /** Live scope count — the test seam for the lifetime bound. */
  get scopeCount(): number {
    return this.scopes.size;
  }

  /** Connections attached to a scope; `0` when the scope does not exist. */
  subscriberCount(key: string): number {
    return this.scopes.get(key)?.connections.size ?? 0;
  }

  /** The current epoch for a scope, or `undefined` if it has none. */
  streamId(key: string): string | undefined {
    return this.scopes.get(key)?.streamId;
  }

  /**
   * Fan one change out to its session scope, and — for `session_updated` only —
   * to the sessions-list scope as well. The list stream is a list of SESSIONS;
   * span and trace churn has no place on it.
   */
  publish(body: DeltaBody): void {
    this.publishTo(body.session_id, body);
    if (body.kind === 'session_updated') this.publishTo(LIST_SCOPE, body);
  }

  /** Convenience for draining a staged batch. */
  publishAll(bodies: Iterable<DeltaBody>): void {
    for (const body of bodies) this.publish(body);
  }

  private publishTo(key: string, body: DeltaBody): void {
    const scope = this.scopes.get(key);
    // Lazy allocation: nobody is listening and no ring exists, so there is
    // nothing this delta could usefully be kept for.
    if (scope === undefined) return;

    scope.seq += 1;
    const delta = { ...body, seq: scope.seq } as Delta;

    // Per-scope PARENT coalescing. A single-item `ingestEnvelope` emits a
    // `trace_updated` + `session_updated` per hook POST, so a 500-envelope burst
    // on one session would otherwise spend ~1000 of the ring's 2048 slots on
    // redundant parent rows and evict the span deltas that actually differ.
    // Same delete-and-append-at-tail rule as the connection queue, so the ring
    // stays seq-monotonic.
    if (isParent(body)) {
      const ringKey = coalesceKey(body);
      const previous = scope.ringKeys.get(ringKey);
      if (previous !== undefined) scope.ring.remove(previous);
      scope.ringKeys.set(ringKey, delta);
    }
    scope.ring.push(delta);
    // A `ringKeys` entry is only useful while its delta is still replayable, and
    // a long session mints a new trace every turn — so without this the index
    // would retain one whole `Trace` per turn for the scope's lifetime, long
    // after the ring evicted it. Amortized: only once the index outgrows the ring.
    if (scope.ringKeys.size > scope.ring.capacity) {
      const oldest = scope.ring.firstSeq;
      for (const [key, held] of scope.ringKeys) {
        if (held.seq < oldest) scope.ringKeys.delete(key);
      }
    }

    for (const connection of scope.connections) this.enqueue(connection, delta);

    // `complete` is the one session state `reviveSession` cannot undo, so it is
    // the only ingest-driven reason to end a stream. `interrupted` deliberately
    // does NOT end it — see `StreamEndFrame`. The list stream outlives any one
    // session and is never ended here.
    if (key !== LIST_SCOPE && body.kind === 'session_updated') {
      if (body.session.status === 'complete') this.finish(scope, 'session_complete');
    }
  }

  /**
   * Attach a client to a scope, minting the scope if this is the first subscriber.
   *
   * The returned `hello` must be written before {@link Subscription.start}, which
   * is what guarantees the handshake precedes both backfill and live frames.
   *
   * **A backfill requires a matching `stream_id`.** Per-scope seq is in-memory, so
   * without the epoch a cursor cannot be proven to refer to THIS stream — serving
   * it would silently hand the client a different delta at that seq after a
   * collector restart. An absent or stale `stream_id` is therefore a `refetch`,
   * which is cheap and complete via the Task 5.0 read endpoints.
   */
  subscribe(key: string, options: SubscribeOptions): Subscription {
    let scope = this.scopes.get(key);
    if (scope === undefined) {
      scope = {
        key,
        streamId: randomUUID(),
        seq: 0,
        ring: new RingBuffer<Delta>(
          key === LIST_SCOPE ? LIST_RING_CAPACITY : DELTA_RING_CAPACITY,
        ),
        ringKeys: new Map(),
        connections: new Set(),
        idleSince: undefined,
      };
      this.scopes.set(key, scope);
    }
    scope.idleSince = undefined;

    const { resume, backfill } = resolveResume(scope, options.fromSeq, options.streamId);

    const connection: Connection = {
      scope,
      queue: [...backfill],
      keys: new Map(),
      write: options.write,
      end: options.end,
      started: false,
      draining: false,
      closed: false,
      ending: undefined,
    };
    // Seed the coalescing index from the backfill so a live delta arriving before
    // the drain catches up supersedes its own stale backfill entry rather than
    // queueing twice.
    for (const delta of connection.queue) connection.keys.set(coalesceKey(delta), delta);
    scope.connections.add(connection);

    const hello: HelloFrame = {
      stream_id: scope.streamId,
      session_id: key === LIST_SCOPE ? null : key,
      first_seq: scope.ring.firstSeq,
      last_seq: scope.seq,
      resume,
    };

    return {
      hello,
      start: () => {
        connection.started = true;
        void this.drain(connection);
      },
      close: () => {
        connection.closed = true;
        scope.connections.delete(connection);
        if (scope.connections.size === 0) scope.idleSince = Date.now();
      },
      get pending() {
        return connection.queue.length;
      },
    };
  }

  /**
   * Release every scope that has had no subscribers for `ttlMs`. Called from the
   * existing inactivity-sweep interval — no timer of its own. Returns how many it
   * released. `now` is injected so tests need no fake clock.
   */
  reap(now: number = Date.now(), ttlMs: number = SCOPE_IDLE_TTL_MS): number {
    let released = 0;
    for (const [key, scope] of [...this.scopes]) {
      if (scope.connections.size > 0) continue;
      if (scope.idleSince === undefined) {
        // A scope can only reach zero subscribers through `close()`, which stamps
        // this; treat an unstamped one as idle from now rather than immortal.
        scope.idleSince = now;
        continue;
      }
      if (now - scope.idleSince >= ttlMs) {
        this.scopes.delete(key);
        released += 1;
      }
    }
    return released;
  }

  /**
   * Terminal frame on every open connection, then release every scope. Called from
   * `startServer`'s `close()` BEFORE `server.close(...)`, so a client with a stream
   * open learns why it ended and the socket can actually finish closing.
   */
  shutdown(): void {
    for (const scope of [...this.scopes.values()]) {
      this.finish(scope, 'server_shutdown');
    }
  }

  /** Owe every connection a terminal frame, then drop the scope. */
  private finish(scope: Scope, reason: StreamEndFrame['reason']): void {
    const connections = [...scope.connections];
    scope.connections.clear();
    this.scopes.delete(scope.key);
    for (const connection of connections) {
      connection.ending = { reason };
      void this.drain(connection);
    }
  }

  /**
   * Queue one delta for one connection, coalescing by entity.
   *
   * **DELETE the stale entry and APPEND the new one at the TAIL. Never replace in
   * place.** Keeping the stale entry's queue POSITION while taking the newer seq
   * makes the wire seq non-monotonic and strands data: with `[A@1, B@2]` and a new
   * A stamped `seq 3` replacing A in place, the wire emits `3, 2`; a client
   * recording `lastSeqSeen = 3` that then drops reconnects at `from_seq=4` and
   * never receives B's seq-2 update. Appending at the tail keeps the queue both
   * FIFO and seq-ordered, at the cost of nothing.
   *
   * Queue length is therefore bounded by the number of distinct live entities in
   * the scope, not by traffic — which is why a stalled consumer is never dropped.
   */
  private enqueue(connection: Connection, delta: Delta): void {
    if (connection.closed) return;
    const key = coalesceKey(delta);
    const previous = connection.keys.get(key);
    if (previous !== undefined) {
      const idx = connection.queue.indexOf(previous);
      if (idx !== -1) connection.queue.splice(idx, 1);
    }
    connection.queue.push(delta);
    connection.keys.set(key, delta);
    void this.drain(connection);
  }

  /**
   * Drain one connection's queue, one awaited write at a time, so ordering is
   * explicit rather than microtask luck. Re-entrant calls are no-ops: the running
   * loop re-checks the queue, so anything enqueued mid-write is still picked up.
   */
  private async drain(connection: Connection): Promise<void> {
    if (connection.draining || !connection.started) return;
    connection.draining = true;
    try {
      while (!connection.closed && connection.queue.length > 0) {
        const delta = connection.queue.shift()!;
        const key = coalesceKey(delta);
        if (connection.keys.get(key) === delta) connection.keys.delete(key);
        await connection.write(delta);
      }
      const ending = connection.ending;
      if (ending !== undefined && !connection.closed) {
        connection.ending = undefined;
        connection.closed = true;
        await connection.end(ending);
      }
    } catch {
      // hono's `write` swallows broken-pipe errors, so a throw here is genuinely
      // unexpected. Abandon this one connection rather than spinning on it; the
      // client reconnects and resumes from its cursor.
      connection.closed = true;
      connection.scope.connections.delete(connection);
    } finally {
      connection.draining = false;
    }
  }
}

/**
 * Decide how a resuming client is served. Four `refetch` causes, one `backfill`,
 * one `live` — see `ResumeVerdict` for what each means to the client.
 *
 * The window is `first_seq <= from_seq <= last_seq + 1`, where `last_seq + 1` is
 * the caught-up case (nothing missed, backfill is empty).
 */
function resolveResume(
  scope: Scope,
  fromSeq: number | undefined,
  streamId: string | undefined,
): { resume: ResumeVerdict; backfill: Delta[] } {
  if (fromSeq === undefined) return { resume: 'live', backfill: [] };
  // Absent or stale epoch: the cursor cannot be proven to address this stream.
  if (streamId !== scope.streamId) return { resume: 'refetch', backfill: [] };
  // Ahead of anything we ever issued — a cursor from some other epoch.
  if (fromSeq > scope.seq + 1) return { resume: 'refetch', backfill: [] };
  if (fromSeq === scope.seq + 1) return { resume: 'backfill', backfill: [] };
  // Already evicted from the ring: the missed deltas are genuinely gone.
  if (scope.ring.size === 0 || fromSeq < scope.ring.firstSeq) {
    return { resume: 'refetch', backfill: [] };
  }
  return { resume: 'backfill', backfill: scope.ring.since(fromSeq) };
}
