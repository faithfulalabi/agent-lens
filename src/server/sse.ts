// The naive SSE broadcaster: a single global stream, no per-session filtering
// (Phase 6 owns the real thing). Subscribers register a publish callback; the
// ingest pipeline calls `publish` once per genuinely-new event.

import type { SpanLite } from '../db/index.js';

/** A subscriber's sink — invoked with each new event's serializable payload. */
export type Subscriber = (event: SpanLite) => void;

/**
 * A subscriber's teardown — invoked once, when the server is going away.
 *
 * Optional because the Broadcaster's other consumers are plain in-process
 * listeners with nothing to wind down; only a route holding an open response
 * body needs it, and that body is exactly what `server.close()` waits on.
 */
export type EndHandler = () => void | Promise<void>;

/** In-process fan-out. Not exported as a singleton — the app owns one instance. */
export class Broadcaster {
  private readonly subscribers = new Set<Subscriber>();
  private readonly ends = new Set<EndHandler>();

  /** Register a sink; returns an unsubscribe fn (call on stream abort/close). */
  subscribe(sub: Subscriber, onEnd?: EndHandler): () => void {
    this.subscribers.add(sub);
    if (onEnd) this.ends.add(onEnd);
    return () => {
      this.subscribers.delete(sub);
      if (onEnd) this.ends.delete(onEnd);
    };
  }

  /**
   * Owe every connection a terminal frame, then drop it. The twin of
   * `DeltaPublisher.shutdown` for the Broadcaster-backed routes, called from
   * `startServer`'s `close()` BEFORE `server.close(...)`: without it that call
   * waits forever on a response body nothing will ever end.
   */
  shutdown(): void {
    const handlers = [...this.ends];
    this.ends.clear();
    this.subscribers.clear();
    for (const end of handlers) void end();
  }

  /** Fan a new event out to every current subscriber. */
  publish(event: SpanLite): void {
    for (const sub of this.subscribers) {
      sub(event);
    }
  }

  /** Current subscriber count (for tests / heartbeat bookkeeping). */
  get size(): number {
    return this.subscribers.size;
  }
}
