// Build the Hono app: host guard (app-wide) → token auth (/api/*) → routes.
// Exported separately from binding so tests can mount without a listening
// socket. The DB handle, token, and broadcaster are injected by `startServer`.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import { deadLetterRaw, getAllEventsOrdered, ingestHealth } from '../db/index.js';
import { hostGuard, resolveBindHosts } from './middleware/host-guard.js';
import { tokenAuth } from './middleware/token-auth.js';
import { ingestEnvelope, isValidEnvelopeShape } from './ingest.js';
import { jsonNotFound, registerReadApi } from './read-api.js';
import { Broadcaster } from './sse.js';
import { DeltaPublisher } from './deltas.js';
import { registerStreamApi } from './stream-api.js';
import { makeServeIndex, registerUi } from './static-ui.js';

/** Wiring the app needs from `startServer`. */
export interface AppDeps {
  db: DatabaseSync;
  token: string;
  broadcaster: Broadcaster;
  /** Configured bind host; a non-loopback value widens the Host allowlist. */
  host?: string;
  /** `ui/dist` override; defaults to `resolveUiDir()`. Tests inject a fake bundle. */
  uiDir?: string;
  /**
   * Live-tail publisher (Task 6.1). **Optional on purpose:** several tests
   * construct `buildApp` directly, and a required field would break them for no
   * gain. Absent -> a private instance nobody else can publish into, so the
   * stream routes still answer correctly (with `refetch`) instead of 404ing.
   */
  deltas?: DeltaPublisher;
  /** Heartbeat period in ms for both stream surfaces. Tests shorten it. */
  heartbeatMs?: number;
}

const HEARTBEAT_MS = 15_000;

/** Best-effort string field off a shape-rejected body, for dead-letter triage. */
function readString(body: unknown, key: string): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Assemble the Hono app with all Phase-1 routes. */
export function buildApp(deps: AppDeps): Hono {
  const { db, token, broadcaster, host, uiDir } = deps;
  const deltas = deps.deltas ?? new DeltaPublisher();
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const app = new Hono();

  // App-wide host allowlist, before anything else. A non-loopback bind widens
  // it to the machine's resolved interface addresses (token stays mandatory).
  app.use('*', hostGuard(host === undefined ? [] : resolveBindHosts(host)));

  // The built UI's index.html with the token bootstrap injected: deliberately
  // NOT token-guarded, and registered ahead of `tokenAuth` so that stays
  // visible. `/assets/*` and the SPA fallback go in at the bottom, after the
  // `/api/*` terminator — see `registerUi`.
  app.get('/', makeServeIndex({ token, uiDir }));

  // Everything under /api/* is token-guarded.
  app.use('/api/*', tokenAuth(token));

  // Garbage at the boundary is archived, not discarded: a mangled body is still
  // evidence that something tried to report activity, and after a parser fix
  // `reprocessDeadLetters` can replay it. Status stays 400 (the adapter treats
  // non-2xx as "spool it", so the event also survives on the client side).
  // Deliberately no spans_lite row and no broadcast — there is no trustworthy
  // event_id, and polluting the live list with garbage helps nobody.
  app.post('/api/ingest', async (c) => {
    const text = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (err) {
      deadLetterRaw(db, { rawText: text, error: `invalid json: ${String(err)}` });
      return c.json({ error: 'invalid json' }, 400);
    }
    if (!isValidEnvelopeShape(body)) {
      deadLetterRaw(db, {
        rawText: text,
        error: 'invalid envelope shape',
        sessionId: readString(body, 'session_id'),
        hookName: readString(body, 'hook_name'),
      });
      return c.json({ error: 'invalid envelope' }, 400);
    }
    const result = ingestEnvelope(db, broadcaster, body, 'processed', { deltas });
    return c.json(result, 200);
  });

  app.get('/api/events', (c) => c.json(getAllEventsOrdered(db)));

  // Drift/dead-letter counters. Phase 5 renders the degradation banner from this.
  app.get('/api/health', (c) => c.json(ingestHealth(db)));

  // The five read endpoints (Task 5.0). Five plain routes, no catch-all — the
  // `/api/*` terminator is registered below, after `/api/stream`.
  registerReadApi(app, db);

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = broadcaster.subscribe((event) => {
        void stream.writeSSE({
          event: 'raw_event',
          data: JSON.stringify(event),
          id: String(event.seq),
        });
      });
      stream.onAbort(unsubscribe);

      // Keep the connection open with periodic heartbeats until aborted or
      // closed. `write` swallows broken-pipe errors, so poll the flags rather
      // than relying on a throw to break the loop (else the timer leaks).
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(heartbeatMs);
        if (stream.aborted || stream.closed) break;
        await stream.writeSSE({ event: 'heartbeat', data: '' });
      }
    }),
  );

  // The per-session delta streams (Task 6.1). Registered HERE, inside `buildApp`,
  // because everything below claims paths ahead of the SPA catch-all — see
  // `stream-api.ts`'s header. `/api/stream` above is an exact-path route, so it
  // does not shadow `/api/stream/sessions`.
  registerStreamApi(app, { db, deltas, heartbeatMs });

  // --- Nothing under /api/* escapes as HTML (Task 5.0) ----------------------
  // Both registrations belong to `buildApp`, not to `registerReadApi`.

  // Terminator, and its position is load-bearing: hono matches in registration
  // order, so an `app.all('/api/*')` placed before `/api/stream` shadows it and
  // 404s the SSE endpoint (probed on hono 4.12.31). Registered LAST among the
  // `/api` routes, it turns an unmatched API path into a JSON 404 and stops it
  // falling through to the SPA `app.get('*')` fallback registered just below.
  app.all('/api/*', jsonNotFound);

  // --- The UI, last (Task 5.1b) ---------------------------------------------
  // `/assets/*` (+ its own terminator) and the SPA `app.get('*')` fallback.
  // Registered here because the fallback is a catch-all: every `/api` route
  // above, terminator included, must be claimed before it. It is the LAST route
  // in the app — a route registered after `buildApp` returns is shadowed, even
  // a specific one (`static-serving.test.ts` Test 13 pins this).
  registerUi(app, { token, uiDir });

  // The other half of that guarantee: an uncaught throw in a handler would
  // otherwise be hono's `500 text/plain "Internal Server Error"`, which AC5
  // forbids on the read endpoints. Scoped to `/api/` so `/` keeps today's
  // behaviour; `onError` is a hook, so its registration point does not matter —
  // it sits here to read alongside the terminator.
  app.onError((err, c) => {
    if ('getResponse' in err) {
      const res = err.getResponse();
      return c.newResponse(res.body, res);
    }
    console.error(err);
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'internal error' }, 500);
    }
    return c.text('Internal Server Error', 500);
  });

  return app;
}
