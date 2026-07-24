// The naive SSE broadcaster: a single global stream, no per-session filtering
// (Phase 6 owns the real thing). Subscribers register a publish callback; the
// ingest pipeline calls `publish` once per genuinely-new event.

import type { SpanLite } from '../db/index.js';

/** A subscriber's sink — invoked with each new event's serializable payload. */
export type Subscriber = (event: SpanLite) => void;

/** In-process fan-out. Not exported as a singleton — the app owns one instance. */
export class Broadcaster {
  private readonly subscribers = new Set<Subscriber>();

  /** Register a sink; returns an unsubscribe fn (call on stream abort/close). */
  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
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
