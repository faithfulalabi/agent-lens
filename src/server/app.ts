// Build the Hono app: host guard (app-wide) -> token auth (/api/*) -> routes.
// Exported separately from binding so tests can mount without a listening socket.
// The DB handle, token, projection env and content resolver are injected by
// `startServer`.

import { Hono } from 'hono';
import type { ErrorHandler } from 'hono';
import { hostGuard, resolveBindHosts } from './middleware/host-guard.js';
import { tokenAuth } from './middleware/token-auth.js';
import { jsonNotFound as apiNotFound, registerApi, type ApiDeps } from './api.js';
import { makeServeIndex, registerUi } from './static-ui.js';

/**
 * An uncaught throw would otherwise be hono's `500 text/plain`, which every
 * `/api/*` contract forbids. Scoped to `/api/` so `/` keeps today's behaviour;
 * `onError` is a hook, so where it is registered does not matter.
 */
const jsonErrorOnApiPaths: ErrorHandler = (err, c) => {
  if ('getResponse' in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'internal error' }, 500);
  }
  return c.text('Internal Server Error', 500);
};

/** Wiring the v2 app needs. `ApiDeps.env` is required and stays required. */
export interface ApiAppDeps extends ApiDeps {
  token: string;
  /** Configured bind host; a non-loopback value widens the Host allowlist. */
  host?: string;
  /** `ui/dist` override; defaults to `resolveUiDir()`. Tests inject a fake bundle. */
  uiDir?: string;
}

/**
 * The app: the ten routes of `api.ts`, the same middleware, the same order.
 *
 * ★ REGISTRATION ORDER IS THE LOAD-BEARING PART, and every step below was
 * re-probed on hono 4.12.31. Hono matches in registration order, first match
 * wins. Each position carries its reason at the line that depends on it.
 *
 * The routes plan 001 had — `POST /api/ingest`, `GET /api/events`, the
 * broadcaster stream and every hook-facing route (spec:398-399) — are simply
 * never registered, so they reach the JSON-404 terminator like any other
 * unclaimed API path. `server/__tests__/api-order.test.ts` pins that they 404.
 */
export function buildApiApp(deps: ApiAppDeps): Hono {
  const { token, host, uiDir } = deps;
  const app = new Hono();

  // App-wide host allowlist, before anything else.
  app.use('*', hostGuard(host === undefined ? [] : resolveBindHosts(host)));

  // The index with the token bootstrap injected: deliberately NOT token-guarded,
  // and registered ahead of `tokenAuth` so it stays that way.
  app.get('/', makeServeIndex({ token, uiDir }));

  // Everything under /api/* is token-guarded.
  app.use('/api/*', tokenAuth(token));

  registerApi(app, deps);

  // Terminator, and its position is load-bearing: an `app.all('/api/*')` placed
  // before `/api/stream` shadows it and 404s the SSE endpoint (probed). Last
  // among the `/api` routes, it turns an unmatched API path into a JSON 404 and
  // stops it falling through to the SPA fallback registered just below.
  app.all('/api/*', apiNotFound);

  // The UI, LAST. `registerUi` ends in a catch-all `app.get('*')`, so every
  // `/api` route above — terminator included — must be claimed before it, and
  // nothing may be registered after `buildApiApp` returns, not even a specific
  // path (`static-serving.test.ts` Test 13 pins it).
  registerUi(app, { token, uiDir });

  app.onError(jsonErrorOnApiPaths);

  return app;
}
