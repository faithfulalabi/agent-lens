// The SSE hub: ONE stream for the whole app, four event names, one 15 s beat.
//
// Transport only. It knows nothing about sessions, projections or subscriptions
// — `live.ts` decides what to say and the hub only says it. There is no
// subscriber registry on purpose: every frame is keyed by `session_id`, so
// per-client filtering can be added later without a protocol change.
//
// ★ THREE PROTOCOL RULES, all verified against hono 4.12.31 rather than
// remembered:
//
//  1. A CLIENT BRANCHES ON `event:`, NEVER ON THE PRESENCE OF `data:`.
//     `SSEMessage` has no `comment` field, and `writeSSE` maps every data line
//     through `data: ${line}` — so `data: ''` serialises as the literal LINE
//     `data: `, a real frame. `JSON.parse('')` throws, and that throw is the
//     historical swallowed crash (`ui/src/lib/sse.ts:13-14`).
//  2. HEARTBEATS CARRY NO `id:`. `writeSSE` emits the id line only for a truthy
//     `id`, and the client advances its cursor from any frame that has one
//     (`ui/src/lib/sse.ts:293`). A beat must never move a cursor.
//  3. `error` IS HONO'S. `run()` writes `event: error` only when `streamSSE` was
//     given a third `onError` argument, so it is called with TWO. Belt and
//     braces: `StreamEventName` is a closed union over `STREAM_EVENTS`, which
//     makes `'error'` unrepresentable rather than merely unused.
//
// ★ THE HUB PARKS ITS CLIENTS; IT DOES NOT LOOP THEM. The route callback awaits
// the promise `attach` returns instead of looping on `stream.sleep`, which is a
// bare `setTimeout` and not abort-aware — a looping route holds a live 15 s
// timer past the socket's death. Parking costs one thing in exchange: the loop
// used to self-clean on its next wake, so `onAbort` must now BOTH drop the entry
// and resolve its promise. Dropping alone strands the suspended `run()` frame,
// with its stream, transform, writer and reader, for the process lifetime.

import type { SSEStreamingApi } from 'hono/streaming';

/**
 * The whole wire vocabulary, and the single source of truth AC1 asserts against.
 *
 * `warm_progress` is RESERVED and has no producer in Task 6.1. `api.ts` assigns
 * the `/api/warm` background queue that would emit it to this task by name, but
 * no acceptance criterion here mentions warming and that queue is its own
 * containment surface. The name ships so the contract is complete and a client
 * can switch exhaustively; the payload type belongs to the queue's own task.
 */
export const STREAM_EVENTS = [
  'session_changed',
  'session_indexed',
  'warm_progress',
  'heartbeat',
] as const;

export type StreamEventName = (typeof STREAM_EVENTS)[number];

/** `data-model-v2.md:369`, and the value `ui/src/lib/sse.ts:48` already mirrors. */
export const HEARTBEAT_MS = 15_000;

export interface StreamHub {
  /** Register a client and park it. The route awaits this; `drain` ends it. */
  attach(stream: SSEStreamingApi): Promise<void>;
  /** Fan one JSON frame out to every attached client. */
  publish(event: StreamEventName, data: unknown, id?: string): Promise<void>;
  /** One heartbeat: `event: heartbeat`, an empty data line, no `id:`. */
  beat(): Promise<void>;
  /** Stop the beat, unpark every client and end every response body. */
  drain(): Promise<void>;
  /** Attached clients. */
  size(): number;
}

export interface StreamHubOptions {
  /** Beat period. A test injects a short one; nothing in production varies it. */
  heartbeatMs?: number;
}

interface Client {
  stream: SSEStreamingApi;
  unpark: () => void;
}

/**
 * Build the hub and start its heartbeat.
 *
 * ★ THE BEAT IS THE HUB'S OWN WALL-CLOCK TIMER, never derived from the live
 * tick. `startLiveTick` is constructed inside `start.ts`'s `sweepIntervalMs !== 0`
 * gate, so a tick-derived beat stops entirely on a sweepless boot — reachable
 * outside tests through `src/dev/server.ts` — while the per-connection beat this
 * replaces survived it. A tick-derived beat would also scale with the sweep
 * period, and the client hardcodes 15 s to derive its 37.5 s watchdog.
 */
export function createStreamHub(options: StreamHubOptions = {}): StreamHub {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const clients = new Map<SSEStreamingApi, Client>();

  /** Drop AND unpark. Either one alone leaks: see the header. */
  const release = (stream: SSEStreamingApi): void => {
    const client = clients.get(stream);
    if (client === undefined) return;
    clients.delete(stream);
    client.unpark();
  };

  const attach = (stream: SSEStreamingApi): Promise<void> =>
    // The executor runs synchronously, which is what makes a client attached by
    // the time `app.request('/api/stream')` resolves: hono's `streamSSE` invokes
    // the route callback before it builds the Response.
    new Promise<void>((unpark) => {
      clients.set(stream, { stream, unpark });
      stream.onAbort(() => release(stream));
    });

  /** One already-serialised frame to everyone. `write` swallows a broken pipe,
   *  so departure is detected by the flags and by `onAbort`, never by a throw. */
  const fanOut = async (event: StreamEventName, data: string, id?: string): Promise<void> => {
    const message = { event, data, ...(id !== undefined && { id }) };
    await Promise.all(
      [...clients.values()].map(async ({ stream }) => {
        if (stream.aborted || stream.closed) {
          release(stream);
          return;
        }
        await stream.writeSSE(message);
      }),
    );
  };

  const beat = (): Promise<void> => fanOut('heartbeat', '');

  // Unref'd: a beat must never be the reason the process stays up.
  const timer = setInterval(() => void beat(), heartbeatMs);
  timer.unref?.();

  return {
    attach,
    publish: (event, data, id) => fanOut(event, JSON.stringify(data), id),
    beat,
    size: () => clients.size,
    drain: async (): Promise<void> => {
      // The timer FIRST, for the reason `watch.ts:303-309` states: a beat that
      // fires into a closing stream has nowhere to report a failure.
      clearInterval(timer);
      const attached = [...clients.values()];
      clients.clear();
      await Promise.all(
        attached.map(async ({ stream, unpark }) => {
          unpark();
          await stream.close();
        }),
      );
    },
  };
}
