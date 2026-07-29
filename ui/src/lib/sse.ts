/*
 * The live-stream primitive (Task 5.1c, AC2): an incremental frame parser and
 * the connection state machine over it.
 *
 * Native `EventSource` is unusable here — it cannot send an auth header — so
 * this is fetch plus a `ReadableStream`, which is also what lets the whole
 * thing be driven from a DOM-free test.
 *
 * Three rules are load-bearing, and each one exists because getting it wrong
 * goes green and then misbehaves in production:
 *
 * 1. **Branch on the event name, never on the presence of a data field.** Hono
 *    serialises `writeSSE({ event: 'heartbeat', data: '' })` as an `event:` line
 *    plus an EMPTY data line and no id line — a real frame, not a comment. The
 *    parser deleted by Task 5.1b looked for a data line, fed `''` to
 *    `JSON.parse`, and swallowed the throw.
 *
 * 2. **A body that ends is a reconnect, not a close.** `src/server/app.ts`
 *    passes no `onError` to `streamSSE`, so hono's `run()` logs a handler crash
 *    to the server's stderr and then closes the stream in its `finally`. What
 *    reaches the client is a bare end-of-body, indistinguishable from a killed
 *    process or a proxy idle-timeout — and every one of those must reconnect.
 *    Only a deliberate `close()` is terminal, which is what `closedByConsumer`
 *    records. That flag is checked AFTER the try/catch because the read loop
 *    exits two ways: against real fetch, aborting the controller REJECTS the
 *    pending read with an AbortError, and `{ done: true }` never arrives.
 *
 * 3. **`lastSeq` is an opaque cursor.** It is read off the wire's id field,
 *    stored as a string and replayed verbatim. It is never parsed, incremented
 *    or compared for gaps — today's sequence is global and Task 6.1's is
 *    per-session, and only arithmetic-free code survives that change. Gap
 *    handling stays server-side.
 */

import { AuthError } from './api.js';
import { readBootstrap, type Bootstrap } from './bootstrap.js';

/** The stream endpoint. Origin-relative, like every other path in this client. */
const STREAM_PATH = '/api/stream';

/**
 * The resume cursor's query-parameter name — the seam Task 6.1 owns. If 6.1
 * locks a different name, this constant changes and nothing else does.
 */
export const RESUME_PARAM = 'from_seq';

/** `src/server/app.ts`'s HEARTBEAT_MS, mirrored to derive the watchdog default. */
export const HEARTBEAT_MS = 15_000;

/**
 * How long the client tolerates total silence before assuming the socket is
 * wedged. 2.5x the heartbeat interval: the server sleeps a full interval BEFORE
 * its first beat, so a healthy stream is legitimately silent for 15s and a
 * tighter multiplier would reconnect-loop it on any scheduling hiccup.
 */
const WATCHDOG_MULTIPLIER = 2.5;
export const DEFAULT_WATCHDOG_MS = HEARTBEAT_MS * WATCHDOG_MULTIPLIER;

/** Full-jitter backoff bounds: `random() * min(cap, base * 2^attempt)`. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;

/**
 * Event names whose data field carries JSON. `raw_event` is what the server
 * publishes today; the rest are Task 6.1's delta names, listed now so 6.1 can
 * start emitting them without touching this file. Anything not in here is
 * ignored, which is the same forward-compatibility from the other direction.
 */
const DATA_EVENTS: ReadonlySet<string> = new Set([
  'raw_event',
  'span_opened',
  'span_updated',
  'span_closed',
  'trace_updated',
  'session_updated',
]);

/** One dispatched server-sent event, fields decoded but data still raw text. */
export interface SseFrame {
  /** Defaults to `message` when the frame carries no event field. */
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/** A decoded data frame handed to the consumer. */
export interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

/** What the UI renders a connection badge from. */
export type ConnectionState =
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'reconnecting'; attempt: number; nextRetryAt: number }
  | { kind: 'closed' }
  | { kind: 'auth_error'; error: AuthError };

/** Feed it decoded text; it hands back every frame the buffer now completes. */
export interface SseFrameParser {
  push(chunk: string): SseFrame[];
}

/**
 * An incremental parser over the wire format, and nothing else — no transport,
 * no state, so the format is testable on its own.
 *
 * Per the spec: `\r\n` and `\r` are line terminators, a blank line dispatches,
 * a line beginning with a colon is a comment, one leading space is stripped
 * from a field value, and repeated data fields join with a newline. A block
 * that yields no field at all dispatches nothing.
 */
export function parseSseChunks(): SseFrameParser {
  let buffer = '';
  let swallowLf = false;

  return {
    push(chunk: string): SseFrame[] {
      if (chunk === '') return [];

      // A CR that ended the previous chunk already terminated its line. An LF
      // arriving now COMPLETES that one terminator rather than starting a blank
      // line — normalising each chunk on its own would fabricate a frame
      // boundary out of a CRLF that straddles a read.
      const text = swallowLf && chunk.startsWith('\n') ? chunk.slice(1) : chunk;
      swallowLf = text.endsWith('\r');
      buffer += text.replace(/\r\n|\r/g, '\n');

      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      const frames: SseFrame[] = [];
      for (const block of blocks) {
        const frame = parseBlock(block);
        if (frame !== undefined) frames.push(frame);
      }
      return frames;
    },
  };
}

function parseBlock(block: string): SseFrame | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let sawField = false;

  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;

    switch (field) {
      case 'event':
        event = value;
        sawField = true;
        break;
      case 'data':
        data.push(value);
        sawField = true;
        break;
      case 'id':
        id = value;
        sawField = true;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) retry = Number(value);
        sawField = true;
        break;
      default:
        break;
    }
  }

  if (!sawField) return undefined;
  const frame: SseFrame = { event: event ?? 'message', data: data.join('\n') };
  if (id !== undefined) frame.id = id;
  if (retry !== undefined) frame.retry = retry;
  return frame;
}

export interface SseClientOptions {
  /** Origin-relative stream path. Defaults to `STREAM_PATH`. */
  path?: string;
  bootstrap?: Bootstrap;
  fetchImpl?: typeof fetch;
  /** Resolves after `ms`, or early when `signal` fires. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Injected so the backoff jitter is assertable. */
  random?: () => number;
  /**
   * Silence tolerated before the socket is assumed wedged. A non-finite value
   * disables the watchdog entirely — the deadline then never elapses.
   */
  watchdogMs?: number;
  /** A decoded data frame. Heartbeats and unknown event names never reach it. */
  onEvent?: (event: SseEvent) => void;
  onState?: (state: ConnectionState) => void;
  /**
   * Stream-level failures: undecodable payloads, server-reported errors, and
   * transport failures. Never called for an abort — that is either a deliberate
   * close or the watchdog, and both are already reported as state.
   */
  onError?: (error: Error) => void;
}

export interface SseClient {
  /** Runs the connect/backoff loop until it reaches a terminal state. */
  start(): Promise<void>;
  /** Terminal, and the only terminal outcome that is not a failure. */
  close(): void;
  readonly state: ConnectionState;
  /** The last id field seen, verbatim. Replayed on reconnect. */
  readonly lastSeq: string | undefined;
}

/** How one connection attempt ended, before the loop decides what to do. */
type Attempt =
  { kind: 'closed' } | { kind: 'auth'; error: AuthError } | { kind: 'retry'; reachedOpen: boolean };

export function createSseClient(options: SseClientOptions = {}): SseClient {
  const path = options.path ?? STREAM_PATH;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const bootstrap = options.bootstrap ?? readBootstrap();

  const lifetime = new AbortController();
  let closedByConsumer = false;
  let inflight: AbortController | undefined;
  let state: ConnectionState = { kind: 'connecting' };
  let lastSeq: string | undefined;
  let running: Promise<void> | undefined;

  // Bumped on every arm/disarm so a superseded watchdog loop retires itself.
  let watchdogGeneration = 0;
  let watchdogDeadline = 0;

  function setState(next: ConnectionState): void {
    if (state.kind === 'closed' || state.kind === 'auth_error') return;
    state = next;
    options.onState?.(next);
  }

  function report(error: Error): void {
    options.onError?.(error);
  }

  function streamUrl(): string {
    if (lastSeq === undefined) return path;
    const params = new URLSearchParams();
    params.set(RESUME_PARAM, lastSeq);
    return `${path}?${params.toString()}`;
  }

  function armWatchdog(controller: AbortController): void {
    if (!Number.isFinite(watchdogMs)) return;
    const generation = ++watchdogGeneration;
    watchdogDeadline = now() + watchdogMs;
    void (async () => {
      while (generation === watchdogGeneration && !controller.signal.aborted) {
        const remaining = watchdogDeadline - now();
        if (remaining <= 0) {
          controller.abort(new DOMException('agent-lens: stream went silent', 'AbortError'));
          return;
        }
        await sleepImpl(remaining, controller.signal);
      }
    })();
  }

  function touchWatchdog(): void {
    if (Number.isFinite(watchdogMs)) watchdogDeadline = now() + watchdogMs;
  }

  function disarmWatchdog(): void {
    watchdogGeneration += 1;
  }

  function handleFrame(frame: SseFrame): void {
    touchWatchdog();
    // Any frame carrying an id advances the cursor, whatever its type.
    if (frame.id !== undefined && frame.id !== '') lastSeq = frame.id;

    if (frame.event === 'heartbeat') return;
    if (frame.event === 'error') {
      // Forward-compatible only: no server code emits this today, because
      // `app.ts` calls `streamSSE` with two arguments and hono writes the error
      // frame only when a third `onError` argument is supplied. Until Task 6.1
      // opts in, a handler crash arrives as an end-of-body instead.
      report(new Error(`agent-lens: the stream reported an error (${frame.data})`));
      return;
    }
    if (!DATA_EVENTS.has(frame.event)) return;

    let payload: unknown;
    try {
      payload = JSON.parse(frame.data) as unknown;
    } catch (cause) {
      // Surfaced, never swallowed — and the stream stays open.
      report(
        new Error(
          `agent-lens: could not decode a "${frame.event}" payload ` +
            `(${cause instanceof Error ? cause.message : String(cause)})`,
        ),
      );
      return;
    }
    options.onEvent?.({
      event: frame.event,
      data: payload,
      ...(frame.id === undefined ? {} : { id: frame.id }),
    });
  }

  async function connectOnce(): Promise<Attempt> {
    const controller = new AbortController();
    inflight = controller;
    let reachedOpen = false;
    let authError: AuthError | undefined;
    let failure: unknown;

    try {
      const res = await fetchImpl(streamUrl(), {
        method: 'GET',
        headers: { [bootstrap.tokenHeader]: bootstrap.token },
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        authError = new AuthError(res.status, await authMessage(res));
      } else if (!res.ok) {
        failure = new Error(`agent-lens: the stream returned HTTP ${res.status}`);
      } else if (res.body === null) {
        failure = new Error('agent-lens: the stream response carried no body');
      } else {
        reachedOpen = true;
        setState({ kind: 'open' });
        armWatchdog(controller);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = parseSseChunks();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            handleFrame(frame);
          }
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      disarmWatchdog();
      inflight = undefined;
    }

    // Checked here, after the try/catch, so the two exits are treated
    // identically: a real abort REJECTS the pending read, while a hand-built
    // stream that ignores the signal RESOLVES `{ done: true }`. Deciding on the
    // resolve path alone would emit a spurious reconnect after every close()
    // in a browser while passing every test that uses a fake stream.
    if (closedByConsumer) return { kind: 'closed' };
    if (authError !== undefined) return { kind: 'auth', error: authError };
    if (failure !== undefined && !isAbortError(failure)) report(asError(failure));
    return { kind: 'retry', reachedOpen };
  }

  async function run(): Promise<void> {
    let failures = 0;
    while (!closedByConsumer) {
      setState({ kind: 'connecting' });
      const attempt = await connectOnce();
      if (attempt.kind === 'closed') break;
      if (attempt.kind === 'auth') {
        // Terminal on purpose: a rejected token cannot be repaired by waiting, and
        // retrying it would hammer the server forever.
        setState({ kind: 'auth_error', error: attempt.error });
        return;
      }
      if (attempt.reachedOpen) failures = 0;
      const delay = backoffDelay(failures, random);
      failures += 1;
      setState({ kind: 'reconnecting', attempt: failures, nextRetryAt: now() + delay });
      await sleepImpl(delay, lifetime.signal);
    }
    setState({ kind: 'closed' });
  }

  return {
    start(): Promise<void> {
      running ??= run();
      return running;
    },
    close(): void {
      if (closedByConsumer) return;
      closedByConsumer = true;
      setState({ kind: 'closed' });
      disarmWatchdog();
      lifetime.abort();
      inflight?.abort(new DOMException('agent-lens: stream closed', 'AbortError'));
    },
    get state(): ConnectionState {
      return state;
    },
    get lastSeq(): string | undefined {
      return lastSeq;
    },
  };
}

/** Full jitter: anywhere in `[0, min(cap, base * 2^attempt))`. */
function backoffDelay(attempt: number, random: () => number): number {
  return random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

/** The stream's 401/403 body is plain text, exactly like the read API's. */
async function authMessage(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text === '' ? `HTTP ${res.status}` : text;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function isAbortError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'AbortError'
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
