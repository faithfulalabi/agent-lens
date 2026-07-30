import { describe, it, expect } from 'vitest';

import { AuthError } from '../api';
import type { Bootstrap } from '../bootstrap';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  DEFAULT_WATCHDOG_MS,
  HEARTBEAT_MS,
  RESUME_PARAM,
  createSseClient,
  type ConnectionState,
  type SseClient,
  type SseEvent,
} from '../sse';
import { fakeClock, manualSse, sseFrame, sseResponse, type ManualSse } from './helpers';

/*
 * AC2 — the connection state machine.
 *
 * Everything here runs with no DOM, no real timers and no network: `fetchImpl`,
 * `sleepImpl`, `now` and `random` are injected, which is the only way any of it
 * is assertable under `environment: 'node'`.
 *
 * The single most load-bearing behaviour is what happens when the body ENDS.
 * `src/server/app.ts` calls hono's `streamSSE` with two arguments, so a handler
 * crash takes hono's `else` branch — a log to the server's stderr, then
 * `finally { stream.close() }` — and the client sees a bare end-of-body with no
 * error frame. That is indistinguishable from a killed process, a graceful
 * shutdown or a proxy idle-timeout, and all four must reconnect. Only a
 * deliberate `close()` is terminal.
 *
 * The other half of that rule is subtler: the read loop exits TWO ways. Against
 * real fetch, aborting the controller errors the body, so the pending `read()`
 * REJECTS with an AbortError and `{ done: true }` never arrives; only a
 * hand-built stream that ignores the signal resolves. `helpers.ts`'s streams
 * therefore honour the signal exactly as undici does, so the reject path is
 * genuinely exercised rather than simulated.
 */

const BOOTSTRAP: Bootstrap = Object.freeze({
  token: 'tok-stream-secret',
  // Deliberately not the real header name, so a hardcoded one fails here.
  tokenHeader: 'x-test-header-name',
});

const HEARTBEAT_BYTES = 'event: heartbeat\ndata: \n\n';

/** Let queued microtasks and stream reads settle. No fake global timers. */
async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`test harness: ${what} is not set yet`);
  return value;
}

interface Call {
  url: string;
  headers: Headers;
  signal: AbortSignal | undefined;
}

/** A fetch whose Nth call is answered by the Nth step; the last step repeats. */
function scriptedFetch(steps: readonly ((signal: AbortSignal | undefined) => Response)[]): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    if (step === undefined) throw new Error('scriptedFetch needs at least one step');
    const signal = init?.signal ?? undefined;
    calls.push({ url: String(input), headers: new Headers(init?.headers), signal });
    return Promise.resolve(step(signal));
  };
  return { calls, fetchImpl };
}

/** A fetch that hands back a stream the test pushes to frame by frame. */
function manualFetch(): { calls: Call[]; fetchImpl: typeof fetch; source: () => ManualSse } {
  let current: ManualSse | undefined;
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const signal = init?.signal ?? undefined;
    calls.push({ url: String(input), headers: new Headers(init?.headers), signal });
    current = manualSse(signal === undefined ? {} : { signal });
    return Promise.resolve(current.response);
  };
  return { calls, fetchImpl, source: () => must(current, 'the manual stream') };
}

/** Records every requested delay; resolves immediately so no clock is needed. */
function instantSleep(): { delays: number[]; sleepImpl: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleepImpl: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

/** Shorthand: the watchdog is off unless a test is about the watchdog. */
const NO_WATCHDOG = Number.POSITIVE_INFINITY;

describe('the SSE client dispatches frames by event name', () => {
  it('decodes a raw_event payload and hands it to onEvent', async () => {
    const { fetchImpl } = scriptedFetch([
      (signal) =>
        sseResponse([sseFrame('raw_event', '{"seq":3,"span_id":"sp"}', '3')], {
          ...(signal === undefined ? {} : { signal }),
          keepOpen: true,
        }),
    ]);
    const events: SseEvent[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      watchdogMs: NO_WATCHDOG,
      onEvent: (event) => events.push(event),
    });

    const running = client.start();
    await tick();
    expect(events).toEqual([{ event: 'raw_event', data: { seq: 3, span_id: 'sp' }, id: '3' }]);
    client.close();
    await running;
  });

  /*
   * ⭐ The heartbeat pin, at the client level. Exact bytes, no helper: an empty
   * data value and no id line at all. A client that branched on "the frame has
   * a data line" would feed '' to JSON.parse here — which is precisely the bug
   * the deleted Task 1.3 parser had, complete with a bare catch that hid it.
   */
  it('treats a heartbeat as liveness only — no event, no error', async () => {
    const { fetchImpl, source } = manualFetch();
    const events: SseEvent[] = [];
    const errors: Error[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      watchdogMs: NO_WATCHDOG,
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    const running = client.start();
    await tick();
    source().push(HEARTBEAT_BYTES);
    await tick();

    expect(events).toEqual([]);
    expect(errors).toEqual([]);
    expect(client.state.kind).toBe('open');
    client.close();
    await running;
  });

  it('surfaces an undecodable payload through onError and stays open', async () => {
    const { fetchImpl, source } = manualFetch();
    const events: SseEvent[] = [];
    const errors: Error[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      watchdogMs: NO_WATCHDOG,
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    const running = client.start();
    await tick();
    source().push(sseFrame('raw_event', 'not json at all', '1'));
    await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message, 'a swallowed parse failure is the bug this pins').toContain(
      'raw_event',
    );
    expect(client.state.kind, 'one bad payload must not tear down the stream').toBe('open');

    source().push(sseFrame('raw_event', '{"seq":2}', '2'));
    await tick();
    expect(events).toHaveLength(1);

    client.close();
    await running;
  });

  /*
   * No server code emits `event: error` today: `app.ts` calls `streamSSE(c, cb)`
   * with two arguments, and hono writes that frame only when a third `onError`
   * argument is supplied. This branch is forward-compat for Task 6.1, which
   * inherits the obligation to pass it. Until then a server-side crash reaches
   * the client as the end-of-body handled further down.
   */
  it('surfaces a server-reported error frame through onError', async () => {
    const { fetchImpl, source } = manualFetch();
    const errors: Error[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      watchdogMs: NO_WATCHDOG,
      onError: (error) => errors.push(error),
    });

    const running = client.start();
    await tick();
    source().push(sseFrame('error', 'db is locked'));
    await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('db is locked');
    client.close();
    await running;
  });

  it('ignores an unknown event name without erroring', async () => {
    const { fetchImpl, source } = manualFetch();
    const events: SseEvent[] = [];
    const errors: Error[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      watchdogMs: NO_WATCHDOG,
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    const running = client.start();
    await tick();
    // Task 6.1 must be able to add event names without touching this module.
    source().push(sseFrame('something_task_9_invents', '{"a":1}', '4'));
    await tick();

    expect(events).toEqual([]);
    expect(errors).toEqual([]);
    expect(client.state.kind).toBe('open');
    client.close();
    await running;
  });
});

describe('the SSE client resumes from an opaque cursor', () => {
  it('tracks the id field, never the payload, and a heartbeat does not clear it', async () => {
    const { fetchImpl, source } = manualFetch();
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      watchdogMs: NO_WATCHDOG,
    });

    const running = client.start();
    await tick();
    expect(client.lastSeq).toBeUndefined();

    source().push(sseFrame('raw_event', '{"seq":5}', '5'));
    await tick();
    expect(client.lastSeq).toBe('5');

    // No id line at all — the cursor must survive untouched.
    source().push(HEARTBEAT_BYTES);
    await tick();
    expect(client.lastSeq).toBe('5');

    source().push(sseFrame('raw_event', '{"seq":9}', '9'));
    await tick();
    expect(client.lastSeq).toBe('9');

    // A payload whose seq disagrees with the wire must not move the cursor.
    source().push(sseFrame('raw_event', '{"seq":999}'));
    await tick();
    expect(client.lastSeq, 'the cursor comes off the wire, never off the payload').toBe('9');

    client.close();
    await running;
  });

  it('replays the last id verbatim on reconnect', async () => {
    const { calls, fetchImpl } = scriptedFetch([
      (signal) =>
        sseResponse(
          [sseFrame('raw_event', '{"a":1}', '7'), sseFrame('raw_event', '{"a":2}', '8')],
          signal === undefined ? {} : { signal },
        ),
      (signal) => sseResponse([], { ...(signal === undefined ? {} : { signal }), keepOpen: true }),
    ]);
    const { delays, sleepImpl } = instantSleep();
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl,
      watchdogMs: NO_WATCHDOG,
      random: () => 0.5,
    });

    const running = client.start();
    await tick();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('/api/stream');
    expect(calls[1]?.url).toBe(`/api/stream?${RESUME_PARAM}=8`);
    expect(
      new URL(calls[1]?.url ?? '', 'https://example.invalid').searchParams.get(RESUME_PARAM),
      'the cursor is a string replayed as-is',
    ).toBe('8');
    // Today's seq is global and Task 6.1's is per-session. Any arithmetic here
    // is correct now and silently wrong then; gap handling stays server-side.
    expect(calls[1]?.url, 'the cursor must never be incremented').not.toContain('=9');
    expect(delays).toHaveLength(1);

    client.close();
    await running;
  });

  it('sends the bootstrap token under the bootstrap header on every attempt', async () => {
    const { calls, fetchImpl } = scriptedFetch([
      (signal) => sseResponse([], signal === undefined ? {} : { signal }),
      (signal) => sseResponse([], { ...(signal === undefined ? {} : { signal }), keepOpen: true }),
    ]);
    const { sleepImpl } = instantSleep();
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl,
      watchdogMs: NO_WATCHDOG,
      random: () => 0.5,
    });

    const running = client.start();
    await tick();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.headers.get(BOOTSTRAP.tokenHeader)).toBe(BOOTSTRAP.token);
      expect(call.url, 'the token must never reach a URL').not.toContain(BOOTSTRAP.token);
      expect(call.url, 'the stream path is origin-relative like every other').toMatch(
        /^\/api\/stream/,
      );
    }

    client.close();
    await running;
  });
});

/*
 * ⭐⭐ The most important block in this file.
 *
 * Two mutation checks it must survive:
 *   - making `{ done: true }` transition to `closed` reds case 1;
 *   - checking `closedByConsumer` only on the resolve path, and treating the
 *     catch as an unconditional reconnect, reds case 2 (a spurious retry after
 *     every real close() in a browser).
 */
describe('a body that ends reconnects; only close() closes', () => {
  it('case 1 (resolve): a clean end of body reconnects and never reports closed', async () => {
    const { calls, fetchImpl } = scriptedFetch([
      // Ends cleanly with the signal never firing — a killed server, a graceful
      // shutdown, or a handler crash hono logged and swallowed.
      (signal) =>
        sseResponse(
          [sseFrame('raw_event', '{"a":1}', '1'), sseFrame('raw_event', '{"a":2}', '2')],
          signal === undefined ? {} : { signal },
        ),
      (signal) => sseResponse([], { ...(signal === undefined ? {} : { signal }), keepOpen: true }),
    ]);
    const { delays, sleepImpl } = instantSleep();
    const states: ConnectionState[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl,
      watchdogMs: NO_WATCHDOG,
      random: () => 0.5,
      onState: (state) => states.push(state),
    });

    const running = client.start();
    await tick();

    expect(states.map((state) => state.kind)).toEqual([
      'connecting',
      'open',
      'reconnecting',
      'connecting',
      'open',
    ]);
    expect(
      states.some((state) => state.kind === 'closed'),
      'an end of body is the commonest real failure — it must never be terminal',
    ).toBe(false);
    expect(delays).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain(`${RESUME_PARAM}=2`);

    client.close();
    await running;
  });

  it('case 2 (reject): close() while open is terminal, silent and retry-free', async () => {
    const { calls, fetchImpl } = scriptedFetch([
      (signal) => sseResponse([], { ...(signal === undefined ? {} : { signal }), keepOpen: true }),
    ]);
    const { delays, sleepImpl } = instantSleep();
    const errors: Error[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl,
      watchdogMs: NO_WATCHDOG,
      onError: (error) => errors.push(error),
    });

    const running = client.start();
    await tick();
    expect(client.state.kind).toBe('open');

    // The production path: the abort errors the body, so the pending read
    // REJECTS with an AbortError. `{ done: true }` never arrives.
    client.close();
    await running;

    expect(client.state.kind).toBe('closed');
    expect(delays, 'a deliberate close must not schedule a retry').toEqual([]);
    expect(calls, 'a deliberate close must not reconnect').toHaveLength(1);
    expect(errors, 'our own abort is not a stream failure to report').toEqual([]);
  });

  it('case 3 (reject): the same AbortError from the watchdog reconnects instead', async () => {
    const clock = fakeClock();
    const { fetchImpl } = scriptedFetch([
      (signal) => sseResponse([], { ...(signal === undefined ? {} : { signal }), keepOpen: true }),
    ]);
    const errors: Error[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl: clock.sleep,
      now: clock.now,
      random: () => 0.5,
      watchdogMs: 1_000,
      onError: (error) => errors.push(error),
    });

    const running = client.start();
    await clock.flush();
    expect(client.state.kind).toBe('open');

    await clock.advance(1_000);

    // Identical exception to case 2, opposite outcome — decided only by whether
    // the consumer asked for the close. This pair is the whole point.
    expect(client.state.kind).toBe('reconnecting');
    expect(errors).toEqual([]);

    client.close();
    await running;
  });

  it('case 4 (resolve after close): the flag wins over a late {done:true}', async () => {
    // Harness-only: this stream ignores the signal, so it resolves where real
    // fetch would reject. It pins the flag's precedence, not a browser race.
    const calls: Call[] = [];
    let current: ManualSse | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), signal: undefined });
      current = manualSse({});
      return Promise.resolve(current.response);
    };
    const { delays, sleepImpl } = instantSleep();
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl,
      watchdogMs: NO_WATCHDOG,
    });

    const running = client.start();
    await tick();
    expect(client.state.kind).toBe('open');

    client.close();
    must(current, 'the manual stream').end();
    await running;

    expect(client.state.kind).toBe('closed');
    expect(delays).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('the SSE client backs off with full jitter', () => {
  it('bounds every delay by min(cap, base * 2^attempt) and varies with random', async () => {
    const randoms = [0.1, 0.9, 0.5, 0.25, 0.75, 0.4, 0.99, 0.8, 0.3];
    let index = 0;
    const holder: { client?: SseClient } = {};
    const delays: number[] = [];
    const client = createSseClient({
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
      bootstrap: BOOTSTRAP,
      random: () => randoms[index++ % randoms.length] ?? 0.5,
      sleepImpl: (ms) => {
        delays.push(ms);
        if (delays.length >= randoms.length) holder.client?.close();
        return Promise.resolve();
      },
      watchdogMs: NO_WATCHDOG,
    });
    holder.client = client;

    await client.start();

    expect(delays).toHaveLength(randoms.length);
    for (const [attempt, delay] of delays.entries()) {
      const bound = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
      expect(delay, `attempt ${attempt} exceeded its bound`).toBeGreaterThanOrEqual(0);
      expect(delay, `attempt ${attempt} exceeded its bound`).toBeLessThan(bound);
    }
    expect(new Set(delays).size, 'a constant delay is not jitter').toBeGreaterThan(1);

    // Attempt 6 would be 0.99 * 32_000 uncapped. The cap is what makes it 29_700.
    expect(BACKOFF_BASE_MS * 2 ** 6).toBeGreaterThan(BACKOFF_CAP_MS);
    expect(delays[6]).toBeCloseTo(0.99 * BACKOFF_CAP_MS, 6);
  });

  it('resets the attempt counter after a successful open', async () => {
    const opens = (signal: AbortSignal | undefined): Response =>
      sseResponse([sseFrame('raw_event', '{"a":1}', '1')], signal === undefined ? {} : { signal });
    const holder: { client?: SseClient } = {};
    const delays: number[] = [];
    const attempts: number[] = [];
    const client = createSseClient({
      // open+EOF, then a dead server, then open+EOF again.
      fetchImpl: scriptedFetch([opens, () => new Response(null, { status: 503 }), opens]).fetchImpl,
      onState: (state) => {
        if (state.kind === 'reconnecting') attempts.push(state.attempt);
      },
      bootstrap: BOOTSTRAP,
      random: () => 0.9,
      sleepImpl: (ms) => {
        delays.push(ms);
        if (delays.length >= 3) holder.client?.close();
        return Promise.resolve();
      },
      watchdogMs: NO_WATCHDOG,
    });
    holder.client = client;

    await client.start();

    // 0.9 * 500, then 0.9 * 1000 (no open in between), then 0.9 * 500 again —
    // the third delay is the assertion: without the reset it would be ~3600.
    expect(delays).toEqual([450, 900, 450]);
    expect(attempts, 'the reported attempt number resets with the delay').toEqual([1, 2, 1]);
  });
});

describe('the SSE client refuses to retry a rejected token', () => {
  it.each([401, 403] as const)('HTTP %i is terminal and never sleeps', async (status) => {
    const { calls, fetchImpl } = scriptedFetch([
      // The real shape: plain text from token-auth.ts / host-guard.ts.
      () => new Response(status === 401 ? 'Unauthorized' : 'Forbidden', { status }),
    ]);
    const { delays, sleepImpl } = instantSleep();
    const client = createSseClient({ fetchImpl, bootstrap: BOOTSTRAP, sleepImpl });

    await client.start();

    expect(calls, 'a bad token must not hammer the server').toHaveLength(1);
    expect(delays).toEqual([]);
    expect(client.state.kind).toBe('auth_error');
    const state = client.state as Extract<ConnectionState, { kind: 'auth_error' }>;
    expect(state.error).toBeInstanceOf(AuthError);
    expect(state.error.status).toBe(status);
  });
});

describe('the SSE client reports its connection state', () => {
  it('walks connecting → open → reconnecting → open → closed, EOF-driven', async () => {
    const { fetchImpl } = scriptedFetch([
      (signal) =>
        sseResponse(
          [sseFrame('raw_event', '{"a":1}', '1')],
          signal === undefined ? {} : { signal },
        ),
      (signal) => sseResponse([], { ...(signal === undefined ? {} : { signal }), keepOpen: true }),
    ]);
    const { sleepImpl } = instantSleep();
    const states: ConnectionState[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl,
      random: () => 0.5,
      watchdogMs: NO_WATCHDOG,
      onState: (state) => states.push(state),
    });

    const running = client.start();
    await tick();
    client.close();
    await running;

    // The second `connecting` is real, not noise: every attempt re-enters it,
    // and a badge that skipped it would show `reconnecting` through the whole
    // of the next request.
    expect(states.map((state) => state.kind)).toEqual([
      'connecting',
      'open',
      'reconnecting',
      'connecting',
      'open',
      'closed',
    ]);
    const reconnecting = states.find((state) => state.kind === 'reconnecting');
    expect(reconnecting).toEqual({
      kind: 'reconnecting',
      attempt: 1,
      nextRetryAt: expect.any(Number),
    });
  });

  it('goes straight from open to closed, without passing through reconnecting', async () => {
    const { fetchImpl } = scriptedFetch([
      (signal) => sseResponse([], { ...(signal === undefined ? {} : { signal }), keepOpen: true }),
    ]);
    const { delays, sleepImpl } = instantSleep();
    const states: ConnectionState[] = [];
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl,
      watchdogMs: NO_WATCHDOG,
      onState: (state) => states.push(state),
    });

    const running = client.start();
    await tick();
    client.close();
    await running;

    expect(states.map((state) => state.kind)).toEqual(['connecting', 'open', 'closed']);
    expect(delays).toEqual([]);
  });
});

describe('the watchdog covers silent staleness, and only that', () => {
  /** A stream that opens and then says nothing at all. */
  function silentStream(): { calls: Call[]; fetchImpl: typeof fetch } {
    return scriptedFetch([
      (signal) => sseResponse([], { ...(signal === undefined ? {} : { signal }), keepOpen: true }),
    ]);
  }

  it('aborts the in-flight request and reconnects after the default silence', async () => {
    const clock = fakeClock();
    const { calls, fetchImpl } = silentStream();
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl: clock.sleep,
      now: clock.now,
      random: () => 0.5,
      onState: () => undefined,
    });

    const running = client.start();
    await clock.flush();
    expect(client.state.kind).toBe('open');

    await clock.advance(DEFAULT_WATCHDOG_MS);

    // Distinct from the end-of-body path: here the body never ends, so there is
    // no EOF to notice and nothing else would ever fire.
    expect(calls[0]?.signal?.aborted, 'the wedged request must be aborted').toBe(true);
    expect(client.state.kind).toBe('reconnecting');

    client.close();
    await running;
  });

  it('tolerates the real server sleeping a full interval before its first beat', async () => {
    const clock = fakeClock();
    const { calls, fetchImpl } = silentStream();
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl: clock.sleep,
      now: clock.now,
    });

    const running = client.start();
    await clock.flush();
    await clock.advance(HEARTBEAT_MS);

    // app.ts sleeps HEARTBEAT_MS BEFORE writing its first beat, so a healthy
    // stream is legitimately silent this long. 2.5x leaves 22.5s of slack; the
    // 1.5x alternative would leave 7.5s and reconnect-loop a healthy server on
    // any GC pause.
    expect(client.state.kind, 'a healthy server must not be reconnected').toBe('open');
    expect(calls[0]?.signal?.aborted).toBe(false);
    expect(DEFAULT_WATCHDOG_MS - HEARTBEAT_MS).toBe(22_500);

    client.close();
    await running;
  });

  it.each(['heartbeat', 'raw_event'] as const)('a %s frame resets the deadline', async (event) => {
    const clock = fakeClock();
    const { calls, fetchImpl, source } = manualFetch();
    const client = createSseClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
      sleepImpl: clock.sleep,
      now: clock.now,
      random: () => 0.5,
      watchdogMs: 1_000,
    });

    const running = client.start();
    await clock.flush();
    await clock.advance(900);
    expect(client.state.kind).toBe('open');

    source().push(event === 'heartbeat' ? HEARTBEAT_BYTES : sseFrame('raw_event', '{"a":1}', '1'));
    await clock.flush();

    // Without the reset the deadline is still 1000 and this would abort.
    await clock.advance(900);
    expect(client.state.kind).toBe('open');
    expect(calls[0]?.signal?.aborted).toBe(false);

    // With it, the deadline is now 1800 and silence past that still fires.
    await clock.advance(200);
    expect(client.state.kind).toBe('reconnecting');

    client.close();
    await running;
  });
});
