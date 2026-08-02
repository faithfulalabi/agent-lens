// Task 6.1 unit tests for the delta publisher: the ring buffer, seq assignment,
// resume verdicts, scope lifetime, and the per-connection coalescing queue.
//
// No HTTP and no DB anywhere in here — `DeltaPublisher` imports neither, which is
// the whole reason its rules can be pinned this directly. The HTTP half lives in
// `stream-deltas.test.ts`.

import { describe, expect, it } from 'vitest';
import type { Session, Span, Trace } from '../../shared/entities.js';
import type { Delta, DeltaBody, StreamEndFrame } from '../../shared/delta.js';
import {
  DeltaPublisher,
  DELTA_RING_CAPACITY,
  LIST_SCOPE,
  RingBuffer,
  SCOPE_IDLE_TTL_MS,
} from '../deltas.js';

const SESSION = 'sess-1';

function span(id: string, status: Span['status'] = 'running'): Span {
  return {
    id,
    trace_id: `${SESSION}:1`,
    span_type: 'tool_call',
    name: 'Bash',
    status,
    started_at: '2026-08-01T00:00:00.000Z',
    source: 'hook',
    tags: [],
    attrs: {},
  };
}

function trace(id = `${SESSION}:1`): Trace {
  return {
    id,
    session_id: SESSION,
    turn_seq: 1,
    trigger: 'user_prompt',
    prompt_preview: '',
    started_at: '2026-08-01T00:00:00.000Z',
    status: 'live',
    total_tokens: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    est_cost: 0,
    duration_ms: 0,
    tool_call_count: 0,
    error_count: 0,
  };
}

function session(id = SESSION, status: Session['status'] = 'live'): Session {
  return {
    id,
    harness: 'claude-code',
    project_path: '/proj',
    started_at: '2026-08-01T00:00:00.000Z',
    status,
    capture_mode: 'full',
    total_tokens: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    est_cost: 0,
    tool_call_count: 0,
    error_count: 0,
    trace_count: 1,
  };
}

const spanDelta = (id: string, status?: Span['status']): DeltaBody => ({
  kind: 'span_updated',
  session_id: SESSION,
  span: span(id, status),
});

const traceDelta = (id?: string): DeltaBody => ({
  kind: 'trace_updated',
  session_id: SESSION,
  trace: trace(id),
});

const sessionDelta = (status: Session['status'] = 'live'): DeltaBody => ({
  kind: 'session_updated',
  session_id: SESSION,
  session: session(SESSION, status),
});

/** A collecting subscriber whose writes resolve immediately. */
function collector() {
  const seen: Delta[] = [];
  const ended: StreamEndFrame[] = [];
  return {
    seen,
    ended,
    write: async (delta: Delta) => {
      seen.push(delta);
    },
    end: async (frame: StreamEndFrame) => {
      ended.push(frame);
    },
  };
}

/**
 * A subscriber that blocks until released — the stalled consumer the coalescing
 * contract exists for.
 */
function stalledCollector() {
  const seen: Delta[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  return {
    seen,
    release: () => release!(),
    write: async (delta: Delta) => {
      if (first) {
        first = false;
        await gate;
      }
      seen.push(delta);
    },
    end: async () => {},
  };
}

/** Let the drain's promise chain run to completion. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('RingBuffer', () => {
  it('evicts oldest first and reports its replayable window', () => {
    const ring = new RingBuffer<{ seq: number }>(3);
    for (let seq = 1; seq <= 5; seq += 1) ring.push({ seq });

    expect(ring.size).toBe(3);
    expect(ring.firstSeq).toBe(3);
    expect(ring.toArray().map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('is empty-safe and serves `since` from the requested seq', () => {
    const ring = new RingBuffer<{ seq: number }>(4);
    expect(ring.size).toBe(0);
    expect(ring.firstSeq).toBe(0);
    expect(ring.since(1)).toEqual([]);

    for (let seq = 1; seq <= 4; seq += 1) ring.push({ seq });
    expect(ring.since(3).map((e) => e.seq)).toEqual([3, 4]);
    expect(ring.since(99)).toEqual([]);
  });

  it('removes an entry by identity and keeps evicting correctly afterwards', () => {
    const ring = new RingBuffer<{ seq: number }>(3);
    const a = { seq: 1 };
    ring.push(a);
    ring.push({ seq: 2 });
    ring.remove(a);
    ring.remove(a); // idempotent

    expect(ring.toArray().map((e) => e.seq)).toEqual([2]);
    ring.push({ seq: 3 });
    ring.push({ seq: 4 });
    ring.push({ seq: 5 });
    expect(ring.toArray().map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('stays correct across the amortized compaction boundary', () => {
    const ring = new RingBuffer<{ seq: number }>(2);
    for (let seq = 1; seq <= 50; seq += 1) ring.push({ seq });
    expect(ring.toArray().map((e) => e.seq)).toEqual([49, 50]);
    expect(ring.firstSeq).toBe(49);
  });
});

describe('DeltaPublisher — scope lifetime (Test 18c)', () => {
  it('allocates NO scope for a session nobody is watching', () => {
    const publisher = new DeltaPublisher();

    for (let i = 0; i < 20; i += 1) {
      publisher.publish({
        kind: 'session_updated',
        session_id: `sess-${i}`,
        session: session(`sess-${i}`),
      });
    }

    // Lazy allocation is the bound: with zero UI clients — the collector's
    // ORDINARY state — no subscriber ever leaves, so an unsubscribe-only release
    // would never run and each session would retain a full ring since boot.
    expect(publisher.scopeCount).toBe(0);
  });

  it('reaps an idle scope after the TTL even while the session is still live', () => {
    const publisher = new DeltaPublisher();
    const sink = collector();
    const sub = publisher.subscribe(SESSION, sink);
    sub.start();
    publisher.publish(spanDelta('a'));
    expect(publisher.scopeCount).toBe(1);

    sub.close();
    expect(publisher.subscriberCount(SESSION)).toBe(0);

    const now = Date.now();
    expect(publisher.reap(now)).toBe(0);
    expect(publisher.scopeCount).toBe(1);

    expect(publisher.reap(now + SCOPE_IDLE_TTL_MS + 1)).toBe(1);
    expect(publisher.scopeCount).toBe(0);
  });

  it('never reaps a scope that still has a subscriber', () => {
    const publisher = new DeltaPublisher();
    const sub = publisher.subscribe(SESSION, collector());
    sub.start();

    expect(publisher.reap(Date.now() + SCOPE_IDLE_TTL_MS * 10)).toBe(0);
    expect(publisher.scopeCount).toBe(1);
  });

  it('mints a fresh epoch at seq 1 when a released scope is subscribed again', async () => {
    const publisher = new DeltaPublisher();
    const first = publisher.subscribe(SESSION, collector());
    first.start();
    publisher.publish(spanDelta('a'));
    publisher.publish(spanDelta('b'));
    const firstId = publisher.streamId(SESSION);
    expect(first.hello.last_seq).toBe(0);

    first.close();
    publisher.reap(Date.now() + SCOPE_IDLE_TTL_MS + 1);

    const sink = collector();
    const second = publisher.subscribe(SESSION, sink);
    second.start();
    publisher.publish(spanDelta('a'));
    await settle();

    expect(publisher.streamId(SESSION)).not.toBe(firstId);
    expect(sink.seen.map((d) => d.seq)).toEqual([1]);
  });
});

describe('DeltaPublisher — seq assignment (Test 15)', () => {
  it('stamps seq per scope, so one change carries two different seqs (Test 14)', async () => {
    const publisher = new DeltaPublisher();
    const sessionSink = collector();
    const listSink = collector();
    const subA = publisher.subscribe(SESSION, sessionSink);
    const subB = publisher.subscribe(LIST_SCOPE, listSink);
    subA.start();
    subB.start();

    // Two span deltas reach only the session scope; the session delta reaches both.
    publisher.publish(spanDelta('a'));
    publisher.publish(spanDelta('b'));
    publisher.publish(sessionDelta());
    await settle();

    expect(sessionSink.seen.map((d) => d.seq)).toEqual([1, 2, 3]);
    // Same logical change, independent counter: seq 3 on the session stream, 1 here.
    expect(listSink.seen.map((d) => d.seq)).toEqual([1]);
    expect(listSink.seen[0]!.kind).toBe('session_updated');
  });

  it('keeps the sessions-list stream free of span and trace churn', async () => {
    const publisher = new DeltaPublisher();
    const listSink = collector();
    publisher.subscribe(LIST_SCOPE, listSink).start();

    publisher.publish(spanDelta('a'));
    publisher.publish(traceDelta());
    await settle();

    expect(listSink.seen).toEqual([]);
  });

  it('leaves `DeltaBody` seq-free — only the wire frame is stamped', async () => {
    const publisher = new DeltaPublisher();
    const sink = collector();
    publisher.subscribe(SESSION, sink).start();

    const body = spanDelta('a');
    publisher.publish(body);
    await settle();

    expect('seq' in body).toBe(false);
    expect(sink.seen[0]!.seq).toBe(1);
  });
});

describe('DeltaPublisher — resume verdicts (Tests 4, 5, 6)', () => {
  function primed(count: number) {
    const publisher = new DeltaPublisher();
    const warm = publisher.subscribe(SESSION, collector());
    warm.start();
    for (let i = 0; i < count; i += 1) publisher.publish(spanDelta(`s${i}`));
    return { publisher, streamId: publisher.streamId(SESSION)!, warm };
  }

  it('no cursor -> live, and no backfill', async () => {
    const { publisher } = primed(3);
    const sink = collector();
    const sub = publisher.subscribe(SESSION, sink);

    expect(sub.hello.resume).toBe('live');
    expect(sub.hello.last_seq).toBe(3);
    expect(sub.hello.first_seq).toBe(1);
    sub.start();
    await settle();
    expect(sink.seen).toEqual([]);
  });

  it('cursor inside the ring -> backfill of exactly the missed deltas', async () => {
    const { publisher, streamId } = primed(5);
    const sink = collector();
    const sub = publisher.subscribe(SESSION, { ...sink, fromSeq: 3, streamId });

    expect(sub.hello.resume).toBe('backfill');
    sub.start();
    await settle();
    expect(sink.seen.map((d) => d.seq)).toEqual([3, 4, 5]);
  });

  it('cursor exactly one past the head -> backfill with nothing missed', async () => {
    const { publisher, streamId } = primed(4);
    const sink = collector();
    const sub = publisher.subscribe(SESSION, { ...sink, fromSeq: 5, streamId });

    expect(sub.hello.resume).toBe('backfill');
    sub.start();
    await settle();
    expect(sink.seen).toEqual([]);
  });

  it('a mismatched stream_id is an unconditional refetch (Test 6)', () => {
    const { publisher } = primed(5);
    const sub = publisher.subscribe(SESSION, {
      ...collector(),
      fromSeq: 3,
      streamId: 'from-a-previous-collector',
    });

    // Without the epoch check the client would be served a DIFFERENT delta 3.
    expect(sub.hello.resume).toBe('refetch');
  });

  it('an absent stream_id cannot be proven to address this stream -> refetch', () => {
    const { publisher } = primed(5);
    const sub = publisher.subscribe(SESSION, { ...collector(), fromSeq: 3 });
    expect(sub.hello.resume).toBe('refetch');
  });

  it('an evicted cursor -> refetch, and the stream stays usable (Test 5)', async () => {
    const publisher = new DeltaPublisher();
    publisher.subscribe(SESSION, collector()).start();
    for (let i = 0; i < DELTA_RING_CAPACITY + 10; i += 1) {
      publisher.publish(spanDelta(`s${i}`));
    }
    const streamId = publisher.streamId(SESSION)!;

    const sink = collector();
    const sub = publisher.subscribe(SESSION, { ...sink, fromSeq: 1, streamId });
    expect(sub.hello.resume).toBe('refetch');
    expect(sub.hello.first_seq).toBeGreaterThan(1);

    // Refetch does NOT close the stream — live deltas keep arriving on it.
    sub.start();
    publisher.publish(spanDelta('after'));
    await settle();
    expect(sink.seen).toHaveLength(1);
  });

  it('a cursor ahead of anything issued -> refetch', () => {
    const { publisher, streamId } = primed(2);
    const sub = publisher.subscribe(SESSION, { ...collector(), fromSeq: 99, streamId });
    expect(sub.hello.resume).toBe('refetch');
  });
});

describe('DeltaPublisher — coalescing (Tests 18, 18b)', () => {
  it('supersedes a stale entry by APPENDING at the tail, never in place', async () => {
    const publisher = new DeltaPublisher();
    const sink = stalledCollector();
    const sub = publisher.subscribe(SESSION, sink);
    sub.start();

    // A@1 goes out and blocks the writer. Then B@2 queues, and A@3 supersedes
    // A@1's queued successor — the case revision 2's replace-in-place got wrong.
    publisher.publish(spanDelta('A'));
    publisher.publish(spanDelta('B'));
    publisher.publish(spanDelta('A'));
    publisher.publish(spanDelta('B'));

    sink.release();
    await settle();

    const seqs = sink.seen.map((d) => d.seq);
    // Strictly increasing across the whole stream. Under replace-in-place this
    // emits a decrease and strands the entity sitting behind the superseded one.
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
    // Both entities converge on their LATEST state.
    const last = new Map(sink.seen.map((d) => [(d as Delta & { span: Span }).span.id, d.seq]));
    expect(last.get('A')).toBe(3);
    expect(last.get('B')).toBe(4);
  });

  it('bounds the queue by distinct entities, and never drops the connection', async () => {
    const publisher = new DeltaPublisher();
    const sink = stalledCollector();
    const sub = publisher.subscribe(SESSION, sink);
    sub.start();

    publisher.publish(spanDelta('A'));
    for (let i = 0; i < DELTA_RING_CAPACITY * 2; i += 1) {
      publisher.publish(spanDelta(i % 2 === 0 ? 'A' : 'B'));
    }

    // Two distinct entities in flight -> at most two queued frames, whatever the
    // traffic. A dropped client would have to do a full refetch, which is far
    // more expensive than the deltas it could not absorb.
    expect(sub.pending).toBeLessThanOrEqual(2);

    sink.release();
    await settle();
    expect(sub.pending).toBe(0);
    const ids = new Set(sink.seen.map((d) => (d as Delta & { span: Span }).span.id));
    expect(ids).toEqual(new Set(['A', 'B']));
  });

  it('leaves the ring uncoalesced for spans, so a backfill re-serves the gap', async () => {
    const publisher = new DeltaPublisher();
    const sink = stalledCollector();
    const sub = publisher.subscribe(SESSION, sink);
    sub.start();
    const streamId = publisher.streamId(SESSION)!;

    publisher.publish(spanDelta('A'));
    publisher.publish(spanDelta('B'));
    publisher.publish(spanDelta('B'));
    sink.release();
    await settle();

    // The wire skipped B@2 — it was superseded before it left the queue.
    expect(sink.seen.map((d) => d.seq)).toEqual([1, 3]);

    // The RING is the authoritative log the coalescing contract rests on: a
    // reconnect inside the gap replays the uncoalesced sequence.
    const resumed = collector();
    const second = publisher.subscribe(SESSION, { ...resumed, fromSeq: 2, streamId });
    expect(second.hello.resume).toBe('backfill');
    second.start();
    await settle();
    expect(resumed.seen.map((d) => d.seq)).toEqual([2, 3]);
  });

  it('keeps the parent index bounded without corrupting the ring', async () => {
    const publisher = new DeltaPublisher();
    publisher.subscribe(SESSION, collector()).start();

    // One new trace per turn: every one mints a `ringKeys` entry, so past the
    // ring's capacity the index must shed the entries whose deltas were evicted
    // rather than retaining a whole `Trace` per turn for the scope's lifetime.
    const turns = DELTA_RING_CAPACITY + 50;
    for (let i = 0; i < turns; i += 1) publisher.publish(traceDelta(`${SESSION}:${i}`));

    const streamId = publisher.streamId(SESSION)!;
    const sink = collector();
    const sub = publisher.subscribe(SESSION, { ...sink, fromSeq: turns - 4, streamId });
    expect(sub.hello.resume).toBe('backfill');
    expect(sub.hello.last_seq).toBe(turns);
    sub.start();
    await settle();

    // The tail of the ring is intact and still seq-ordered after the pruning.
    expect(sink.seen.map((d) => d.seq)).toEqual([
      turns - 4,
      turns - 3,
      turns - 2,
      turns - 1,
      turns,
    ]);
  });

  it('coalesces PARENT deltas inside the ring so a burst cannot evict the spans', async () => {
    const publisher = new DeltaPublisher();
    publisher.subscribe(SESSION, collector()).start();

    // What a real burst looks like: `app.ts` ingests one envelope at a time, so
    // every hook POST emits a span plus BOTH parents.
    for (let i = 0; i < 500; i += 1) {
      publisher.publish(spanDelta(`s${i}`));
      publisher.publish(traceDelta());
      publisher.publish(sessionDelta());
    }

    const streamId = publisher.streamId(SESSION)!;
    const sink = collector();
    const sub = publisher.subscribe(SESSION, { ...sink, fromSeq: 1, streamId });
    expect(sub.hello.resume).toBe('backfill');
    sub.start();
    await settle();

    // ~1000 redundant parent deltas collapsed to one apiece, so all 500 span
    // deltas are still replayable inside a 2048-slot ring.
    const kinds = sink.seen.map((d) => d.kind);
    expect(kinds.filter((k) => k === 'trace_updated')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'session_updated')).toHaveLength(1);
    expect(kinds.filter((k) => k.startsWith('span_'))).toHaveLength(500);
    // Coalescing leaves gaps but never a decrease.
    const seqs = sink.seen.map((d) => d.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });
});

describe('DeltaPublisher — terminal frames', () => {
  it('ends a session stream on `complete`, after the delta that says so', async () => {
    const publisher = new DeltaPublisher();
    const sink = collector();
    publisher.subscribe(SESSION, sink).start();

    publisher.publish(sessionDelta('complete'));
    await settle();

    expect(sink.seen.map((d) => d.kind)).toEqual(['session_updated']);
    expect(sink.ended).toEqual([{ reason: 'session_complete' }]);
    expect(publisher.scopeCount).toBe(0);
  });

  it('does NOT end the stream on `interrupted`, and a revive lands on it', async () => {
    const publisher = new DeltaPublisher();
    const sink = collector();
    publisher.subscribe(SESSION, sink).start();

    publisher.publish(sessionDelta('interrupted'));
    await settle();
    expect(sink.ended).toEqual([]);

    // `reviveSession` runs on every envelope, so `interrupted` is not terminal —
    // ending here would leave a revived session invisible until a manual reload.
    publisher.publish(sessionDelta('live'));
    await settle();
    expect(sink.seen.map((d) => (d as Delta & { session: Session }).session.status)).toEqual([
      'interrupted',
      'live',
    ]);
  });

  it('never ends the sessions-list stream when one session completes', async () => {
    const publisher = new DeltaPublisher();
    const listSink = collector();
    publisher.subscribe(LIST_SCOPE, listSink).start();

    publisher.publish(sessionDelta('complete'));
    await settle();

    expect(listSink.ended).toEqual([]);
    expect(publisher.subscriberCount(LIST_SCOPE)).toBe(1);
  });

  it('shutdown gives every open stream a terminal frame and releases every scope', async () => {
    const publisher = new DeltaPublisher();
    const a = collector();
    const b = collector();
    publisher.subscribe(SESSION, a).start();
    publisher.subscribe(LIST_SCOPE, b).start();

    publisher.shutdown();
    await settle();

    expect(a.ended).toEqual([{ reason: 'server_shutdown' }]);
    expect(b.ended).toEqual([{ reason: 'server_shutdown' }]);
    expect(publisher.scopeCount).toBe(0);
  });

  it('drains everything already queued before the terminal frame', async () => {
    const publisher = new DeltaPublisher();
    const sink = stalledCollector();
    const sub = publisher.subscribe(SESSION, {
      ...sink,
      end: async (frame: StreamEndFrame) => {
        order.push(`end:${frame.reason}`);
      },
    });
    const order: string[] = [];
    sub.start();

    publisher.publish(spanDelta('A'));
    publisher.publish(spanDelta('B'));
    publisher.shutdown();
    sink.release();
    await settle();

    expect(sink.seen.map((d) => (d as Delta & { span: Span }).span.id)).toEqual(['A', 'B']);
    expect(order).toEqual(['end:server_shutdown']);
  });
});

describe('DeltaPublisher — teardown (Test 11)', () => {
  it('drops the subscriber count to zero on close and stops writing to it', async () => {
    const publisher = new DeltaPublisher();
    const sink = collector();
    const sub = publisher.subscribe(SESSION, sink);
    sub.start();
    expect(publisher.subscriberCount(SESSION)).toBe(1);

    sub.close();
    expect(publisher.subscriberCount(SESSION)).toBe(0);

    publisher.publish(spanDelta('after-close'));
    await settle();
    expect(sink.seen).toEqual([]);
  });
});
