/*
 * Test doubles for the client spine (Task 5.1c). Not a test file — the `ui`
 * project only collects `*.test.ts(x)`, the same way `__tests__/build-ui.ts`
 * sits beside the suites that import it.
 *
 * Everything here exists because the `ui` vitest project has NO DOM
 * (`ui/vitest.config.ts`: `environment: 'node'`). There is no window, no
 * address bar and no timer to fake, so the seams the production modules expose
 * are the only way in.
 *
 * What IS global under Node is `fetch`, `Response`, `ReadableStream`,
 * `TextEncoder`, `AbortController` and `DOMException` — which is why a
 * hand-built streaming `Response` is a faithful stand-in for the real thing.
 */

import type { HistoryPort } from '../router.js';

/* ---------------------------------------------------------------- SSE --- */

/**
 * One frame, serialised byte-for-byte the way hono's SSE helper does it:
 * an `event:` line, then ONE `data:` line per line of payload (so an empty
 * payload still emits `data: `), then `id:` only when the id is truthy.
 *
 * That last detail is the whole reason the deleted Task 1.3 parser crashed:
 * a heartbeat is a real frame with an empty data value and no id at all.
 */
export function sseFrame(event: string, data: string, id?: string): string {
  const lines = [`event: ${event}`, ...data.split('\n').map((line) => `data: ${line}`)];
  if (id !== undefined && id !== '') lines.push(`id: ${id}`);
  return `${lines.join('\n')}\n\n`;
}

export interface ManualSseOptions {
  /**
   * REQUIRED wherever an abort is under test. When it fires, the body errors
   * with an AbortError exactly as undici's does — which means the consumer's
   * pending `read()` REJECTS rather than resolving `{ done: true }`. Without
   * this wiring the abort path is never exercised and the tests that claim to
   * cover it hang or pass vacuously.
   */
  signal?: AbortSignal;
}

/** A streaming `Response` whose body the test pushes to by hand. */
export interface ManualSse {
  response: Response;
  push(text: string): void;
  /** Clean end of body — what a killed server looks like from the client. */
  end(): void;
}

export function manualSse(options: ManualSseOptions = {}): ManualSse {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;

  // `start` runs synchronously inside the constructor, so `controller` is
  // assigned before anything below can reach for it.
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const settle = (act: (c: ReadableStreamDefaultController<Uint8Array>) => void): void => {
    if (settled || controller === undefined) return;
    settled = true;
    act(controller);
  };

  const { signal } = options;
  if (signal !== undefined) {
    const abort = (): void => {
      settle((c) => {
        c.error(new DOMException('aborted', 'AbortError'));
      });
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  return {
    response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    push(text) {
      if (!settled && controller !== undefined) controller.enqueue(encoder.encode(text));
    },
    end() {
      settle((c) => {
        c.close();
      });
    },
  };
}

export interface SseResponseOptions extends ManualSseOptions {
  /** Leave the body open after the last frame instead of ending it. */
  keepOpen?: boolean;
}

/** A finished `Response` carrying `frames`, ready to hand back from a fake fetch. */
export function sseResponse(frames: readonly string[], options: SseResponseOptions = {}): Response {
  const source = manualSse(options);
  for (const frame of frames) source.push(frame);
  if (options.keepOpen !== true) source.end();
  return source.response;
}

/* -------------------------------------------------------------- clock --- */

export interface FakeClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Every sleep duration asked for, in call order. */
  readonly delays: readonly number[];
  /** Move time forward, firing due sleeps in order and draining between them. */
  advance(ms: number): Promise<void>;
  /** Let queued microtasks and stream reads settle without moving time. */
  flush(): Promise<void>;
}

export function fakeClock(start = 0): FakeClock {
  interface Timer {
    at: number;
    fired: boolean;
    resolve: () => void;
  }

  let current = start;
  const timers: Timer[] = [];
  const delays: number[] = [];

  // A real macrotask turn: stream reads resolve through the host queue, not
  // just the microtask queue, so `await Promise.resolve()` is not enough.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    now: () => current,
    delays,
    sleep(ms, signal) {
      delays.push(ms);
      return new Promise<void>((resolve) => {
        const timer: Timer = { at: current + ms, fired: false, resolve: () => undefined };
        const fire = (): void => {
          if (timer.fired) return;
          timer.fired = true;
          resolve();
        };
        timer.resolve = fire;
        timers.push(timer);
        if (signal !== undefined) {
          if (signal.aborted) fire();
          else signal.addEventListener('abort', fire, { once: true });
        }
      });
    },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.fired && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        current = Math.max(current, due.at);
        due.resolve();
        await flush();
      }
      current = target;
      await flush();
    },
    flush,
  };
}

/* ------------------------------------------------------------- router --- */

export interface FakeHistoryPort extends HistoryPort {
  /** The whole stack, oldest first. */
  readonly entries: readonly string[];
  /** The back button: drop the top entry and fire the pop listeners. */
  back(): void;
}

export function fakeHistoryPort(initial = '/'): FakeHistoryPort {
  const entries: string[] = [initial];
  const listeners = new Set<() => void>();

  return {
    get entries() {
      return entries;
    },
    path: () => entries[entries.length - 1] ?? '/',
    push(href) {
      entries.push(href);
    },
    replace(href) {
      entries[entries.length - 1] = href;
    },
    onPopState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    back() {
      if (entries.length > 1) entries.pop();
      for (const listener of [...listeners]) listener();
    },
  };
}
