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
import { Broadcaster } from './sse.js';
import { renderPage } from './static-page.js';

/** Wiring the app needs from `startServer`. */
export interface AppDeps {
  db: DatabaseSync;
  token: string;
  broadcaster: Broadcaster;
  /** Configured bind host; a non-loopback value widens the Host allowlist. */
  host?: string;
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
  const { db, token, broadcaster, host } = deps;
  const app = new Hono();

  // App-wide host allowlist, before anything else. A non-loopback bind widens
  // it to the machine's resolved interface addresses (token stays mandatory).
  app.use('*', hostGuard(host === undefined ? [] : resolveBindHosts(host)));

  // Static page: same-origin token bootstrap, no token header required.
  app.get('/', (c) => c.html(renderPage(token)));

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
    const result = ingestEnvelope(db, broadcaster, body);
    return c.json(result, 200);
  });

  app.get('/api/events', (c) => c.json(getAllEventsOrdered(db)));

  // Drift/dead-letter counters. Phase 5 renders the degradation banner from this.
  app.get('/api/health', (c) => c.json(ingestHealth(db)));

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
