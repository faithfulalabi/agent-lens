// Task 6.1 HTTP-level tests for the delta streams, plus the in-process ingest
// tests that pin WHERE deltas are staged.
//
// Envelopes are built with `hookEnvelope` rather than driven from a golden
// fixture set: `fixtures/scrubbed/` is a partial, untracked capture set right now
// (Task 1.7 owns completing it), so a test keyed to it would mean something
// different on every machine. The sequences below name their own shape, and the
// one the Test Plan actually cares about — a SessionEnd arriving while a tool
// span is still open — is spelled out explicitly.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { Session, Span, Trace } from '../../shared/entities.js';
import type { Envelope } from '../../shared/envelope.js';
import type { Delta } from '../../shared/delta.js';
import type { Page, SessionDetail } from '../../shared/api.js';
import { hookEnvelope, freshDb, SESSION } from '../../capture/__tests__/fixtures.js';
import { ingestBatch } from '../ingest.js';
import { Broadcaster } from '../sse.js';
import { DeltaPublisher, LIST_SCOPE } from '../deltas.js';
import { parseFromSeq } from '../stream-api.js';
import {
  bootTestServer,
  cleanupDir,
  readSseFrames,
  TOKEN_HEADER,
  type SseFrame,
  type TestServer,
} from './helpers.js';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    const booted = server;
    server = undefined;
    await booted.close();
    cleanupDir(booted.dataDir);
  }
  vi.restoreAllMocks();
});

const STREAM = `/api/stream/sessions/${SESSION}`;

function auth(): Record<string, string> {
  return { [TOKEN_HEADER]: server!.token };
}

function openSse(path: string): Promise<Response> {
  return fetch(server!.url(path), { headers: auth() });
}

async function post(envelope: Envelope): Promise<void> {
  const res = await fetch(server!.url('/api/ingest'), {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  expect(res.status).toBe(200);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(server!.url(path), { headers: auth() });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

/** Frames that are deltas, i.e. everything the handshake/liveness layer did not send. */
const CONTROL = new Set(['hello', 'heartbeat', 'stream_end']);
const isDelta = (f: SseFrame): boolean => !CONTROL.has(f.event);

/** Parse a delta frame. Branching on `event:` first is the whole contract. */
const asDelta = (f: SseFrame): Delta => JSON.parse(f.data) as Delta;

/** Apply deltas last-write-wins per entity id, inserting on an unknown id. */
function fold(frames: SseFrame[]): {
  session?: Session;
  traces: Map<string, Trace>;
  spans: Map<string, Span>;
} {
  const out = { session: undefined as Session | undefined, traces: new Map(), spans: new Map() };
  for (const frame of frames.filter(isDelta)) {
    const delta = asDelta(frame);
    if (delta.kind === 'session_updated') out.session = delta.session;
    else if (delta.kind === 'trace_updated') out.traces.set(delta.trace.id, delta.trace);
    else out.spans.set(delta.span.id, delta.span);
  }
  return out;
}

/** SessionStart, one turn, a closed tool span, then an OPEN one. */
function openingEnvelopes(): Envelope[] {
  return [
    hookEnvelope('SessionStart', { cwd: '/proj' }),
    hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }),
    hookEnvelope(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: { cmd: 'ls' } },
      { tool_use_id: 'toolu_1', prompt_id: 'p1' },
    ),
    hookEnvelope(
      'PostToolUse',
      { tool_name: 'Bash', tool_response: { ok: true } },
      { tool_use_id: 'toolu_1', prompt_id: 'p1' },
    ),
    hookEnvelope(
      'PreToolUse',
      { tool_name: 'Read', tool_input: { path: '/x' } },
      { tool_use_id: 'toolu_2', prompt_id: 'p1' },
    ),
  ];
}

const items = (envelopes: Envelope[]) => envelopes.map((envelope) => ({ envelope }));
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** An in-process subscriber that records everything it is handed. */
function collector() {
  const seen: Delta[] = [];
  return {
    seen,
    write: async (delta: Delta) => {
      seen.push(delta);
    },
    end: async () => {},
  };
}

describe('GET /api/stream/sessions/:id — ordered deltas match final DB state (AC1)', () => {
  it('folds to exactly what the read endpoints serve, ending on SessionEnd', async () => {
    server = await bootTestServer({ sweepIntervalMs: 0 });
    const envelopes = openingEnvelopes();
    // The session must exist before the stream can address it.
    await post(envelopes[0]!);

    const res = await openSse(STREAM);
    for (const envelope of envelopes.slice(1)) await post(envelope);
    // SessionEnd with `toolu_2` still running — the case that emits nothing at
    // all unless `closeRunningSpans` reports the ids it closed.
    await post(hookEnvelope('SessionEnd', {}, { ts: '2026-07-26T01:00:00.000Z' }));

    const frames = await readSseFrames(res, (f) => f.event === 'stream_end', 4000);

    // Strictly increasing, no repeats.
    const seqs = frames.filter(isDelta).map((f) => asDelta(f).seq);
    expect(seqs.length).toBeGreaterThan(0);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
    // The `id:` line mirrors the seq, which is what a client echoes back.
    expect(frames.filter(isDelta).map((f) => f.id)).toEqual(seqs.map(String));

    const folded = fold(frames);
    const detail = await getJson<SessionDetail>(`/api/sessions/${SESSION}`);
    const spans = await getJson<Page<Span>>(`/api/sessions/${SESSION}/spans`);

    expect(folded.session).toEqual(detail.session);
    expect([...folded.spans.values()].sort(byId)).toEqual([...spans.items].sort(byId));
    // Both tool spans are accounted for, including the one only SessionEnd closed.
    expect(folded.spans.get('toolu_2')!.status).toBe('unknown');
    expect(detail.session.status).toBe('complete');
  });

  it('sends session_updated{complete}, then stream_end, then EOF (Test 12)', async () => {
    server = await bootTestServer({ sweepIntervalMs: 0 });
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));

    const res = await openSse(STREAM);
    await post(hookEnvelope('SessionEnd', {}, { ts: '2026-07-26T01:00:00.000Z' }));
    // No `stop` predicate: read to EOF, so the assertion covers the close too.
    const frames = await readSseFrames(res, () => false, 3000);

    const tail = frames.slice(-2);
    expect(tail[0]!.event).toBe('session_updated');
    expect((JSON.parse(tail[0]!.data) as Delta & { session: Session }).session.status).toBe(
      'complete',
    );
    expect(tail[1]!.event).toBe('stream_end');
    expect(JSON.parse(tail[1]!.data)).toEqual({ reason: 'session_complete' });
  });
});

describe('resume protocol (AC2)', () => {
  it('serves exactly the missed deltas on a stale cursor (Test 4)', async () => {
    server = await bootTestServer({ sweepIntervalMs: 0 });
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));

    const first = await openSse(STREAM);
    await post(hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }));
    const seen = await readSseFrames(first, (_f, all) => all.filter(isDelta).length >= 2, 3000);
    const hello = JSON.parse(seen[0]!.data) as { stream_id: string; resume: string };
    expect(seen[0]!.event).toBe('hello');
    expect(hello.resume).toBe('live');
    const lastSeq = asDelta(seen.filter(isDelta).at(-1)!).seq;

    // Disconnected. Two more envelopes land while nobody is listening.
    await post(
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );

    const second = await openSse(
      `${STREAM}?from_seq=${lastSeq + 1}&stream_id=${hello.stream_id}`,
    );
    const resumed = await readSseFrames(
      second,
      (_f, all) => all.filter(isDelta).length >= 3,
      3000,
    );

    expect((JSON.parse(resumed[0]!.data) as { resume: string }).resume).toBe('backfill');
    const seqs = resumed.filter(isDelta).map((f) => asDelta(f).seq);
    // Contiguous from where the first connection stopped: nothing missed, nothing repeated.
    expect(seqs[0]).toBe(lastSeq + 1);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]!).toBe(seqs[i - 1]! + 1);
  });

  it('tells a client from a previous collector to refetch (Test 6)', async () => {
    const booted = await bootTestServer({ sweepIntervalMs: 0 });
    server = booted;
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));
    const before = await openSse(STREAM);
    const helloBefore = JSON.parse(
      (await readSseFrames(before, (f) => f.event === 'hello', 2000))[0]!.data,
    ) as { stream_id: string };

    // Restart the collector against the same data dir. The ring is in memory, so
    // it is gone; only the epoch check stops a stale cursor being served a
    // DIFFERENT delta at the same seq.
    await booted.handle.close();
    server = await bootTestServer({ dataDir: booted.dataDir, sweepIntervalMs: 0 });

    const after = await openSse(`${STREAM}?from_seq=1&stream_id=${helloBefore.stream_id}`);
    const frames = await readSseFrames(after, (f) => f.event === 'hello', 2000);
    const hello = JSON.parse(frames[0]!.data) as { resume: string; stream_id: string };

    expect(hello.resume).toBe('refetch');
    expect(hello.stream_id).not.toBe(helloBefore.stream_id);
    cleanupDir(booted.uiDir);
    cleanupDir(booted.transcriptRoot);
  });

  it('keeps the stream open after a refetch verdict (Test 5)', async () => {
    server = await bootTestServer({ sweepIntervalMs: 0 });
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));

    // A cursor with no `stream_id` cannot be proven to address this stream.
    const res = await openSse(`${STREAM}?from_seq=1`);
    await post(hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }));
    const frames = await readSseFrames(res, (_f, all) => all.filter(isDelta).length >= 1, 3000);

    expect((JSON.parse(frames[0]!.data) as { resume: string }).resume).toBe('refetch');
    // Closing here would create a reconnect race; live frames keep coming instead.
    expect(frames.filter(isDelta).length).toBeGreaterThan(0);
  });

  it('rejects a malformed from_seq before the stream opens (Test 7)', async () => {
    server = await bootTestServer({ sweepIntervalMs: 0 });
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));

    for (const bad of ['-1', '1.5', '1e3', 'abc']) {
      const res = await fetch(server.url(`${STREAM}?from_seq=${bad}`), { headers: auth() });
      expect(res.status, bad).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: 'invalid from_seq' });
    }

    const missing = await fetch(server.url('/api/stream/sessions/nope'), { headers: auth() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
  });

  it('parses from_seq the same way the page params do', () => {
    expect(parseFromSeq(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseFromSeq('')).toEqual({ ok: true, value: undefined });
    expect(parseFromSeq('0')).toEqual({ ok: true, value: 0 });
    expect(parseFromSeq('42')).toEqual({ ok: true, value: 42 });
    for (const bad of ['-1', '1.5', '1e3', 'abc', ' 1', '+1', '9'.repeat(30)]) {
      expect(parseFromSeq(bad).ok, bad).toBe(false);
    }
  });
});

describe('stream wiring (AC3)', () => {
  it('emits heartbeats as `event: heartbeat` with an empty data line (Test 9)', async () => {
    server = await bootTestServer({ sweepIntervalMs: 0, heartbeatMs: 20 });
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));

    const res = await openSse(STREAM);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    const deadline = Date.now() + 3000;
    try {
      while (Date.now() < deadline && !raw.includes('event: heartbeat')) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }

    // Exactly this, byte for byte: an empty `data:` LINE, not a `:` comment —
    // hono 4.12.31's SSEMessage has no `comment` field, so a comment is not
    // expressible. And NO `id:` line, so a heartbeat can never advance a cursor.
    expect(raw).toContain('event: heartbeat\ndata: \n\n');
    // No line is a `:`-prefixed SSE comment anywhere on the stream.
    expect(raw.split('\n').filter((line) => line.startsWith(':'))).toEqual([]);
    // And the heartbeat frame carries no `id:`.
    const heartbeat = raw
      .split('\n\n')
      .find((frame) => frame.includes('event: heartbeat'))!;
    expect(heartbeat).not.toContain('id:');
  });

  it('is reachable past the /api/* terminator and the SPA fallback (Test 10)', async () => {
    server = await bootTestServer({ sweepIntervalMs: 0 });

    const list = await openSse('/api/stream/sessions');
    expect(list.status).toBe(200);
    expect(list.headers.get('content-type')).toContain('text/event-stream');
    await list.body!.cancel();

    // The legacy global stream is deliberately left untouched.
    const legacy = await openSse('/api/stream');
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('content-type')).toContain('text/event-stream');
    await legacy.body!.cancel();
  });

  it('gives the list stream its own seq sequence (Test 14)', async () => {
    server = await bootTestServer({ sweepIntervalMs: 0 });
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));

    const list = await openSse('/api/stream/sessions');
    const single = await openSse(STREAM);
    await post(hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }));

    const listFrames = await readSseFrames(
      list,
      (_f, all) => all.filter(isDelta).length >= 1,
      3000,
    );
    const singleFrames = await readSseFrames(
      single,
      (_f, all) => all.filter(isDelta).length >= 2,
      3000,
    );

    expect(JSON.parse(listFrames[0]!.data)).toMatchObject({ session_id: null });
    // Only session rows reach the list stream, and its counter is its own: the
    // same logical change is seq 1 here and seq 2 on the session stream.
    const listDeltas = listFrames.filter(isDelta).map(asDelta);
    expect(listDeltas.every((d) => d.kind === 'session_updated')).toBe(true);
    expect(listDeltas[0]!.seq).toBe(1);
    const sessionUpdate = singleFrames.filter(isDelta).map(asDelta).find(
      (d) => d.kind === 'session_updated',
    )!;
    expect(sessionUpdate.seq).toBeGreaterThan(1);
  });

  it('shuts every stream down cleanly and closes promptly (Test 11)', async () => {
    const booted = await bootTestServer({ sweepIntervalMs: 0 });
    server = booted;
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));
    const res = await openSse(STREAM);
    await readSseFrames(res, (f) => f.event === 'hello', 2000);

    const started = Date.now();
    server = undefined;
    await booted.close();
    // `deltas.shutdown()` is what buys this: without it `server.close` waits on a
    // response that nothing will ever end.
    expect(Date.now() - started).toBeLessThan(3000);
    cleanupDir(booted.dataDir);
  });

  it('tells an attached client why the server went away (Test 11)', async () => {
    const booted = await bootTestServer({ sweepIntervalMs: 0 });
    server = booted;
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));
    const res = await openSse(STREAM);

    const framesPromise = readSseFrames(res, (f) => f.event === 'stream_end', 4000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    server = undefined;
    const closing = booted.close();

    const frames = await framesPromise;
    await closing;
    expect(frames.at(-1)!.event).toBe('stream_end');
    expect(JSON.parse(frames.at(-1)!.data)).toEqual({ reason: 'server_shutdown' });
    cleanupDir(booted.dataDir);
  });
});

describe('inactivity sweep publishes (AC3)', () => {
  it('reports interruption and does NOT end the stream, so a revive lands on it', async () => {
    // A 50 ms silence threshold: long enough that the session is still live when
    // the stream attaches (a scope is minted on SUBSCRIBE, so a sweep that beat
    // the client would have nothing to publish into), short enough to go stale
    // while it watches.
    server = await bootTestServer({ sweepIntervalMs: 5, sweepTimeoutMs: 50 });
    await post(hookEnvelope('SessionStart', { cwd: '/proj' }));
    await post(hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }));
    await post(
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );

    const res = await openSse(STREAM);
    const framesPromise = readSseFrames(
      res,
      (_f, all) =>
        all
          .filter(isDelta)
          .map(asDelta)
          .some((d) => d.kind === 'session_updated' && d.session.status === 'live'),
      5000,
    );

    // Let the session go stale and get swept, then speak again.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await post(
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { ok: true } },
        { tool_use_id: 'toolu_1', prompt_id: 'p1', ts: '2026-07-26T02:00:00.000Z' },
      ),
    );

    const frames = await framesPromise;
    const deltas = frames.filter(isDelta).map(asDelta);

    // The sweep writes outside ingest, so without publishing from `SweepResult`
    // a quiet session would go stale on screen with no way to find out.
    expect(
      deltas.some((d) => d.kind === 'session_updated' && d.session.status === 'interrupted'),
    ).toBe(true);
    expect(
      deltas.some((d) => d.kind === 'trace_updated' && d.trace.status === 'interrupted'),
    ).toBe(true);
    expect(deltas.some((d) => d.kind === 'span_closed' && d.span.id === 'toolu_1')).toBe(true);
    // `interrupted` is NOT terminal — ending here would hide the revive below.
    expect(frames.some((f) => f.event === 'stream_end')).toBe(false);
    expect(
      deltas.some((d) => d.kind === 'session_updated' && d.session.status === 'live'),
    ).toBe(true);
  });
});

describe('delta staging inside ingest', () => {
  let db: DatabaseSync;

  function harness() {
    db = freshDb();
    const bc = new Broadcaster();
    const deltas = new DeltaPublisher();
    const sink = collector();
    deltas.subscribe(SESSION, sink).start();
    return { db, bc, deltas, sink };
  }

  it('emits one trace_updated per touched trace per batch, contiguously (Test 2)', async () => {
    const { db, bc, deltas, sink } = harness();
    const BURST = 500;
    ingestBatch(
      db,
      bc,
      items([
        hookEnvelope('SessionStart', { cwd: '/proj' }),
        hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }),
      ]),
      { deltas },
    );
    await settle();
    const before = sink.seen.length;

    const burst = Array.from({ length: BURST }, (_, i) =>
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { cmd: `c${i}` } },
        { tool_use_id: `tool-${i}`, prompt_id: 'p1' },
      ),
    );
    ingestBatch(db, bc, items(burst), { deltas });
    await settle();

    const batch = sink.seen.slice(before);
    const spanIds = batch
      .filter((d): d is Delta & { span: Span } => d.kind === 'span_opened')
      .map((d) => d.span.id);
    expect(new Set(spanIds).size).toBe(BURST);
    // Distinct entity keys, so coalescing provably cannot fire: contiguous seqs.
    const seqs = sink.seen.map((d) => d.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    // One rollup flush per batch means one parent delta per batch, not 500.
    expect(batch.filter((d) => d.kind === 'trace_updated')).toHaveLength(1);
    expect(batch.filter((d) => d.kind === 'session_updated')).toHaveLength(1);
    db.close();
  });

  it('carries POST-rollup values on parent deltas (Test 3)', async () => {
    const { db, bc, deltas, sink } = harness();
    ingestBatch(
      db,
      bc,
      items([
        hookEnvelope('SessionStart', { cwd: '/proj' }),
        hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }),
        hookEnvelope('PreToolUse', { tool_name: 'Bash' }, { tool_use_id: 't1', prompt_id: 'p1' }),
        hookEnvelope(
          'PostToolUse',
          { tool_name: 'Bash', tool_response: { ok: true } },
          { tool_use_id: 't1', prompt_id: 'p1' },
        ),
      ]),
      { deltas },
    );
    await settle();

    ingestBatch(
      db,
      bc,
      items([
        hookEnvelope('PreToolUse', { tool_name: 'Read' }, { tool_use_id: 't2', prompt_id: 'p1' }),
        hookEnvelope(
          'PostToolUse',
          { tool_name: 'Read', tool_response: { ok: true } },
          { tool_use_id: 't2', prompt_id: 'p1' },
        ),
      ]),
      { deltas },
    );
    await settle();

    const row = db
      .prepare('SELECT * FROM traces WHERE id = ?')
      .get(`${SESSION}:1`) as Record<string, unknown>;
    const latest = sink.seen.filter((d) => d.kind === 'trace_updated').at(-1)!;
    // Staged after `flushRollups`, so the chips are the post-flush values. Staged
    // one line earlier and this reads the pre-flush row.
    expect(latest.trace.tool_call_count).toBe(row.tool_call_count);
    expect(latest.trace.total_tokens).toBe(row.total_tokens);
    expect(latest.trace.duration_ms).toBe(row.duration_ms);
    expect(latest.trace.tool_call_count).toBe(2);
    db.close();
  });

  it('ships no delta for an item that rolled back (Test 19)', async () => {
    const { db, bc, deltas, sink } = harness();
    ingestBatch(
      db,
      bc,
      items([
        hookEnvelope('SessionStart', { cwd: '/proj' }),
        hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }),
      ]),
      { deltas },
    );
    await settle();
    const before = sink.seen.length;

    // A BigInt in the overflow attrs makes `upsertSpan`'s `JSON.stringify` throw
    // AFTER the span was marked in the collector — the exact window where staging
    // inside the savepoint would ship a delta for a row that no longer exists.
    const poison = hookEnvelope(
      'PreToolUse',
      { tool_name: 'Bash', overflow: 1n },
      { tool_use_id: 'poisoned', prompt_id: 'p1' },
    );
    const results = ingestBatch(
      db,
      bc,
      items([
        hookEnvelope('PreToolUse', { tool_name: 'Bash' }, { tool_use_id: 'ok-1', prompt_id: 'p1' }),
        poison,
        hookEnvelope('PreToolUse', { tool_name: 'Bash' }, { tool_use_id: 'ok-2', prompt_id: 'p1' }),
      ]),
      { deltas },
    );
    await settle();

    expect(results[1]!.deadLettered).toBe(true);
    expect(results[0]!.deadLettered).toBeUndefined();
    expect(results[2]!.deadLettered).toBeUndefined();

    const spanIds = sink.seen
      .slice(before)
      .filter((d) => d.kind.startsWith('span_'))
      .map((d) => (d as Delta & { span: Span }).span.id);
    expect(spanIds).toContain('ok-1');
    expect(spanIds).toContain('ok-2');
    expect(spanIds).not.toContain('poisoned');
    db.close();
  });

  it('drops every staged delta when the whole batch rolls back (Test 19)', async () => {
    const { db, bc, deltas, sink } = harness();

    const results = ingestBatch(
      db,
      bc,
      items([
        hookEnvelope('SessionStart', { cwd: '/proj' }),
        hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }),
      ]),
      {
        deltas,
        beforeCommit: () => {
          throw new Error('offset write failed');
        },
      },
    );
    await settle();

    // Nothing committed, so nothing may be published: the drain sits after
    // `COMMIT` precisely so a top-level rollback drops the staged array with it.
    expect(results.every((r) => r.deadLettered)).toBe(true);
    expect(sink.seen).toEqual([]);
    db.close();
  });

  it('costs one delta, not the batch, when the re-read throws (Test 19b)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, bc, deltas, sink } = harness();
    ingestBatch(
      db,
      bc,
      items([
        hookEnvelope('SessionStart', { cwd: '/proj' }),
        hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }),
        hookEnvelope(
          'PreToolUse',
          { tool_name: 'Bash' },
          { tool_use_id: 'unreadable', prompt_id: 'p1' },
        ),
      ]),
      { deltas },
    );
    await settle();
    const before = sink.seen.length;

    // Corrupt the row so `toSpan`'s `JSON.parse(attrs)` throws on the re-read.
    // `Stop` closes it via `closeRunningSpans` WITHOUT upserting it, so the item
    // itself commits cleanly and the throw lands only in the staging step.
    db.prepare('UPDATE spans SET attrs = ? WHERE id = ?').run('not json', 'unreadable');

    const siblings = Array.from({ length: 63 }, (_, i) =>
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash' },
        { tool_use_id: `sib-${i}`, prompt_id: 'p1' },
      ),
    );
    const results = ingestBatch(
      db,
      bc,
      items([hookEnvelope('Stop', {}, { ts: '2026-07-26T03:00:00.000Z' }), ...siblings]),
      { deltas },
    );
    await settle();

    // Staged at the `sink.publish` site rather than one line earlier: inside the
    // item `try` this would `ROLLBACK TO item` after `RELEASE item`, which throws
    // `no such savepoint: item` and dead-letters all 64.
    expect(results).toHaveLength(64);
    expect(results.some((r) => r.deadLettered)).toBe(false);
    expect(warn).toHaveBeenCalled();

    const spanIds = sink.seen
      .slice(before)
      .filter((d) => d.kind.startsWith('span_'))
      .map((d) => (d as Delta & { span: Span }).span.id);
    expect(spanIds).not.toContain('unreadable');
    expect(spanIds).toHaveLength(63);
    db.close();
  });

  it('emits span_closed from all three closeRunningSpans callers (Test 16)', async () => {
    // `Stop` (closeActiveTrace) and `SessionEnd` (closeSession); the sweep's
    // caller is covered end-to-end by the inactivity-sweep test above.
    for (const closer of ['Stop', 'SessionEnd'] as const) {
      const { db, bc, deltas, sink } = harness();
      ingestBatch(
        db,
        bc,
        items([
          hookEnvelope('SessionStart', { cwd: '/proj' }),
          hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }),
          hookEnvelope(
            'PreToolUse',
            { tool_name: 'Bash' },
            { tool_use_id: 'still-open', prompt_id: 'p1' },
          ),
        ]),
        { deltas },
      );
      await settle();

      ingestBatch(db, bc, items([hookEnvelope(closer, {}, { ts: '2026-07-26T04:00:00.000Z' })]), {
        deltas,
      });
      await settle();

      const closed = sink.seen.find(
        (d): d is Delta & { span: Span } =>
          d.kind === 'span_closed' && d.span.id === 'still-open',
      );
      expect(closed, closer).toBeDefined();
      const row = db
        .prepare('SELECT status FROM spans WHERE id = ?')
        .get('still-open') as { status: string };
      expect(closed!.span.status).toBe(row.status);
      db.close();
    }
  });

  it('publishes nothing at all when no publisher is supplied', async () => {
    const db = freshDb();
    const bc = new Broadcaster();
    const deltas = new DeltaPublisher();
    const sink = collector();
    deltas.subscribe(SESSION, sink).start();
    deltas.subscribe(LIST_SCOPE, collector()).start();

    // The replay/catch-up mode: same ingest, no `deltas` option.
    ingestBatch(db, bc, items(openingEnvelopes()));
    await settle();

    expect(sink.seen).toEqual([]);
    db.close();
  });
});
