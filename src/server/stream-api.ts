// The live-tail SSE endpoints (Task 6.1):
//
//   GET /api/stream/sessions            -> session_updated for every session
//   GET /api/stream/sessions/:id        -> every entity delta for one session
//
// Both take `?from_seq=<n>&stream_id=<s>` and answer with a `hello` handshake
// naming how the resume was served. **Query params, not `Last-Event-ID`**: the
// tech plan's seq protocol supersedes it, and the fetch-based client gets no
// automatic `Last-Event-ID` replay anyway (native `EventSource` cannot send the
// auth header). The TOKEN stays a header and never becomes a query param.
//
// **Registration position is load-bearing, and this module cannot enforce it.**
// `registerUi`'s `app.get('*')` is the last route in the app and
// `app.all('/api/*', jsonNotFound)` is the last `/api` route, so anything
// registered after `buildApp` returns is dead code — a specific path included
// (`static-serving.test.ts` Test 13 pins exactly that). `registerStreamApi` is
// therefore called from INSIDE `buildApp`, between `/api/stream` and the
// terminator, in the same way `registerReadApi` is. Same reasoning as
// `read-api.ts:21-26`.
//
// **Zero SQL lives here**, and the publisher itself imports neither hono nor the
// DB: this module is the only place the two halves meet.

import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import { sessionExists } from '../db/index.js';
import {
  FROM_SEQ_PARAM,
  SSE_EVENT,
  STREAM_ID_PARAM,
  type Delta,
} from '../shared/delta.js';
import { LIST_SCOPE, type DeltaPublisher } from './deltas.js';
import type { ParseResult } from './read-api.js';

/** Wiring the stream routes need. */
export interface StreamApiDeps {
  db: DatabaseSync;
  deltas: DeltaPublisher;
  /** Heartbeat period in ms; injected so a test can shorten it. */
  heartbeatMs: number;
}

/**
 * A non-negative base-10 integer, and nothing else — no signs, no exponents.
 * Same convention (and same deliberate strictness) as `read-api.ts`'s page params.
 */
const NON_NEGATIVE_INT = /^\d+$/;

/**
 * `?from_seq` — the client's resume cursor, echoed back verbatim from a previous
 * frame's `id:`. Absent means "start live". `-1`, `1.5`, `1e3` and `abc` are all
 * 400s, rejected BEFORE the stream opens so a malformed request gets a JSON error
 * rather than a `text/event-stream` that immediately says something went wrong.
 */
export function parseFromSeq(raw: string | undefined): ParseResult<number | undefined> {
  if (raw === undefined || raw === '') return { ok: true, value: undefined };
  if (!NON_NEGATIVE_INT.test(raw)) return { ok: false, error: `invalid ${FROM_SEQ_PARAM}` };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { ok: false, error: `invalid ${FROM_SEQ_PARAM}` };
  return { ok: true, value };
}

/**
 * Register the two delta streams. Exactly two registrations, no catch-alls, so
 * this is safe to call from any insertion point among `buildApp`'s `/api` routes.
 */
export function registerStreamApi(app: Hono, deps: StreamApiDeps): void {
  // The sessions-list stream. Not `/api/stream/sessions/:id` with a magic id —
  // the list scope is a different thing from any session, and naming it as one
  // would make `LIST_SCOPE`'s sentinel reachable from the outside.
  app.get('/api/stream/sessions', (c) => {
    const parsed = parseFromSeq(c.req.query(FROM_SEQ_PARAM));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    return openStream(c, deps, LIST_SCOPE, parsed.value);
  });

  app.get('/api/stream/sessions/:id', (c) => {
    // Malformed request beats missing resource, as on `/api/sessions`: the param
    // guards run before any lookup.
    const parsed = parseFromSeq(c.req.query(FROM_SEQ_PARAM));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const id = c.req.param('id');
    // A JSON 404, matching `read-api.ts`'s resolution-failure convention — never
    // an empty stream, which would look identical to a session that is merely
    // quiet. The token and Host guards are middleware, so they have already
    // fired: an unknown session with no token is a 401, not a 404.
    if (!sessionExists(deps.db, id)) return c.json({ error: 'not found' }, 404);
    return openStream(c, deps, id, parsed.value);
  });
}

/**
 * Open one delta stream: handshake, backfill, live frames, heartbeats, teardown.
 *
 * Frame order is `hello` -> backfill -> live, and it is guaranteed structurally:
 * `subscribe` loads the backfill into a queue that does not drain until `start()`,
 * which is called only after `hello` is on the wire. Anything published in
 * between lands behind the backfill in that same queue.
 */
function openStream(
  c: Context,
  deps: StreamApiDeps,
  scopeKey: string,
  fromSeq: number | undefined,
): Response {
  const rawStreamId = c.req.query(STREAM_ID_PARAM);

  return streamSSE(c, async (stream) => {
    const subscription = deps.deltas.subscribe(scopeKey, {
      fromSeq,
      streamId: rawStreamId === '' ? undefined : rawStreamId,
      // Each delta kind IS its own event name, so a consumer branches on `event:`
      // and never on the presence of `data:` — see `shared/delta.ts`.
      write: (delta: Delta) =>
        stream.writeSSE({
          event: delta.kind,
          data: JSON.stringify(delta),
          id: String(delta.seq),
        }),
      end: async (frame) => {
        await stream.writeSSE({
          event: SSE_EVENT.streamEnd,
          data: JSON.stringify(frame),
        });
        await stream.close();
      },
    });

    stream.onAbort(() => subscription.close());
    await stream.writeSSE({
      event: SSE_EVENT.hello,
      data: JSON.stringify(subscription.hello),
    });
    subscription.start();

    // Keep the connection open with periodic heartbeats until aborted or closed,
    // structurally as `app.ts`'s legacy stream does. Flag-polling is required
    // because hono's `write` swallows broken-pipe errors, so a throw never breaks
    // the loop and the timer would leak.
    //
    // A heartbeat carries NO `id:` (hono only emits `id:` when truthy), so it can
    // never advance a client's cursor, and its `data:` line is deliberately empty
    // — `SSEMessage` has no `comment` field on hono 4.12.31, so a real `:` comment
    // is not expressible.
    while (!stream.aborted && !stream.closed) {
      await stream.sleep(deps.heartbeatMs);
      if (stream.aborted || stream.closed) break;
      await stream.writeSSE({ event: SSE_EVENT.heartbeat, data: '' });
    }
    subscription.close();
  });
}
