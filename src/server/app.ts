// Build the Hono app: host guard (app-wide) → token auth (/api/*) → routes.
// Exported separately from binding so tests can mount without a listening
// socket. The DB handle, token, and broadcaster are injected by `startServer`.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import { getAllEventsOrdered } from '../db/index.js';
import { hostGuard } from './middleware/host-guard.js';
import { tokenAuth } from './middleware/token-auth.js';
import { ingestEnvelope, isValidEnvelopeShape } from './ingest.js';
import { Broadcaster } from './sse.js';
import { renderPage } from './static-page.js';

/** Wiring the app needs from `startServer`. */
export interface AppDeps {
  db: DatabaseSync;
  token: string;
  broadcaster: Broadcaster;
}

const HEARTBEAT_MS = 15_000;

/** Assemble the Hono app with all Phase-1 routes. */
export function buildApp(deps: AppDeps): Hono {
  const { db, token, broadcaster } = deps;
  const app = new Hono();

  // App-wide host allowlist, before anything else.
  app.use('*', hostGuard());

  // Static page: same-origin token bootstrap, no token header required.
  app.get('/', (c) => c.html(renderPage(token)));

  // Everything under /api/* is token-guarded.
  app.use('/api/*', tokenAuth(token));

  app.post('/api/ingest', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (!isValidEnvelopeShape(body)) {
      return c.json({ error: 'invalid envelope' }, 400);
    }
    const result = ingestEnvelope(db, broadcaster, body);
    return c.json(result, 200);
  });

  app.get('/api/events', (c) => c.json(getAllEventsOrdered(db)));

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
        await stream.sleep(HEARTBEAT_MS);
        if (stream.aborted || stream.closed) break;
        await stream.writeSSE({ event: 'heartbeat', data: '' });
      }
    }),
  );

  return app;
}
