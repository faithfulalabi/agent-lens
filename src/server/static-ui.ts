// Serve the built UI (`ui/dist`): the token bootstrap injected into
// `index.html`, the fingerprinted `/assets/*` bundle, and an SPA fallback so
// deep links cold-load. Replaces the Task 1.3 tracer-bullet page.
//
// ── PUBLISHED CONTRACT (Task 5.1c reads this) ───────────────────────────────
// The served HTML carries exactly one injected global:
//
//     window.__AGENT_LENS__ = Object.freeze({ token, tokenHeader })
//
// `token` is this server's token; `tokenHeader` is always `TOKEN_HEADER`
// (`'x-agentlens-token'`). The client sends `{ [tokenHeader]: token }` as a
// REQUEST HEADER — never a query param, never a cookie, so the credential
// never lands in a URL, a referrer, or a server log. Shipping `tokenHeader`
// beside the token is deliberate: the UI cannot import `src/shared/index.ts`
// (that barrel pulls `node:crypto`/`node:fs`), so without it the header name
// would be hardcoded in a second place and drift silently.
// ────────────────────────────────────────────────────────────────────────────
//
// Every filesystem touch happens inside a request handler. A module-load read
// would throw on a fresh clone — `ui/dist` is gitignored and unbuilt there —
// taking every `bootTestServer` test down with it.

import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Handler, Hono, MiddlewareHandler } from 'hono';
import { TOKEN_HEADER } from '../shared/index.js';

/** The literal comment in `ui/index.html` that the bootstrap script replaces. */
export const BOOTSTRAP_MARKER = '<!--agent-lens-bootstrap-->';

/** Fingerprinted filenames make the bundle safe to cache indefinitely. */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Wiring the UI routes need from `buildApp`. */
export interface UiOptions {
  token: string;
  /** `ui/dist` override; defaults to `resolveUiDir()`. Tests inject a fake bundle. */
  uiDir?: string;
}

/**
 * Locate `ui/dist` by walking up to the nearest ancestor holding a
 * `package.json` and appending `ui/dist`.
 *
 * A fixed relative path cannot work. This file lives at `src/server/` under tsx
 * but at `dist/src/server/` once compiled, and `package.json`'s `files` ships
 * `ui/dist` as a sibling of `dist/` — so `../../ui/dist` is right in dev and
 * one directory short from the published package. Walking to the package root
 * is depth-invariant across the source, built, and installed layouts alike.
 *
 * `fromDir` is the seam that lets a test exercise a built layout with no
 * compiler in the loop.
 */
export function resolveUiDir(fromDir?: string): string {
  const start = fromDir ?? dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return join(dir, 'ui', 'dist');
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`agent-lens: no package.json above ${start}; cannot locate ui/dist`);
    }
    dir = parent;
  }
}

/** A JS string literal that cannot break out of the enclosing `<script>`. */
function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003C');
}

/** True when `html` still carries the injection marker. */
function hasBootstrapMarker(html: string): boolean {
  return html.includes(BOOTSTRAP_MARKER);
}

/**
 * Replace the marker with the bootstrap script (contract at the top of this
 * file).
 *
 * Throws when the marker is absent rather than serving an un-injected page: the
 * UI would then 401 on every request with nothing to explain why. Callers that
 * can recover — `makeServeIndex` — test `hasBootstrapMarker` first.
 */
export function injectToken(html: string, token: string): string {
  if (!hasBootstrapMarker(html)) {
    throw new Error(
      `agent-lens: ${BOOTSTRAP_MARKER} not found in index.html — the UI build is missing or stale`,
    );
  }
  const script =
    `<script>window.__AGENT_LENS__=Object.freeze(` +
    `{token:${jsLiteral(token)},tokenHeader:${jsLiteral(TOKEN_HEADER)}})</script>`;
  // A replacer function, not a string: `$&` / `$'` in a token read off disk
  // would otherwise be expanded by `String.prototype.replace`.
  return html.replace(BOOTSTRAP_MARKER, () => script);
}

/**
 * Stand-in page for a missing or stale `ui/dist`, returned with 200 rather than
 * 503: the server is fine and `/api/*` answers normally — only the bundle is
 * absent. Self-contained by necessity, since the missing thing is the bundle.
 */
export function renderNotBuilt(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark" />
<title>agent-lens — UI not built</title>
<style>
  body { background: #0b0b0e; color: #e6e6ea; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
         margin: 0; display: grid; place-items: center; min-height: 100vh; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  code { background: #1a1a20; border-radius: 4px; padding: .15rem .4rem;
         font-family: ui-monospace, SFMono-Regular, monospace; }
  p { margin: 0 0 .75rem; color: #a1a1ad; }
</style>
</head>
<body>
<main>
  <h1>The agent-lens UI is not built</h1>
  <p>The UI bundle is missing or stale. Build it, then reload this page:</p>
  <p><code>npm run build</code></p>
  <p>The collector itself is running — the API under <code>/api/</code> is
     serving normally, so nothing that was captured has been lost.</p>
</main>
</body>
</html>`;
}

/**
 * Read `<uiDir>/index.html`, or `undefined` when it is missing or predates the
 * bootstrap marker. Any other error still throws — a permissions fault is a
 * real fault, not a "run npm run build".
 */
async function readIndexHtml(uiDir: string): Promise<string | undefined> {
  let html: string;
  try {
    html = await readFile(join(uiDir, 'index.html'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return hasBootstrapMarker(html) ? html : undefined;
}

/**
 * Build the handler shared by `/` and the SPA fallback.
 *
 * `index.html` is read per request, deliberately un-memoized: the built file
 * names *fingerprinted* assets, so a copy cached before a rebuild would point
 * at hashes that no longer exist. One small read on a loopback tool is cheaper
 * than that bug, and it removes the cache-invalidation surface entirely.
 *
 * Two recoverable states both render the placeholder: no `ui/dist` at all (a
 * fresh clone), and a present-but-marker-less `index.html` (a bundle built
 * before this marker existed). The second is the one that bites — an escaping
 * `injectToken` throw becomes `app.onError`'s `500 text/plain` on `/` and on
 * every deep link, purely because the developer's local build is stale.
 */
export function makeServeIndex(options: UiOptions): Handler {
  return async (c) => {
    const html = await readIndexHtml(options.uiDir ?? resolveUiDir());
    // The page carries the token; keep it out of every shared and disk cache.
    c.header('Cache-Control', 'no-store');
    return c.html(html === undefined ? renderNotBuilt() : injectToken(html, options.token));
  };
}

/**
 * Register the UI routes. MUST be called after every `/api/*` route, including
 * the `app.all('/api/*')` terminator, because step 4 below is a catch-all.
 *
 * `/` is deliberately NOT registered here: `buildApp` registers it directly,
 * ahead of `tokenAuth`, so that the "the UI is host-guarded but not
 * token-guarded" split stays visible where the security decisions are read.
 * Both call the same `makeServeIndex` factory, so they serve the same document.
 *
 * ⚠️ After this runs, `app.get('*')` is the last route in the app, full stop.
 * Hono matches in registration order and first match wins, so anything
 * registered once `buildApp` has returned is dead code — *specific* paths
 * included, not just wildcards. `static-serving.test.ts`'s Test 13 pins that
 * executably rather than trusting this comment.
 */
export function registerUi(app: Hono, options: UiOptions): void {
  // 1. Cache-Control on hits only, so a 404 is never cached. Runs before
  //    `serveStatic` so that it can set the header on the way back out.
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.header('Cache-Control', IMMUTABLE_CACHE_CONTROL);
  });

  // 2. `serveStatic` joins `root` with the whole request path, so `root` is
  //    `ui/dist` and `/assets/x.js` lands on `ui/dist/assets/x.js`. The root is
  //    ABSOLUTE, which is what makes it cwd-independent — required for a
  //    globally installed package. Constructed on first use because
  //    construction `console.error`s when the root is missing, which on a fresh
  //    clone would be one line of noise per booted test server.
  let assets: MiddlewareHandler | undefined;
  app.use('/assets/*', (c, next) => {
    assets ??= serveStatic({ root: options.uiDir ?? resolveUiDir() });
    return assets(c, next);
  });

  // 3. Terminator, and its position is load-bearing exactly like `/api/*`'s:
  //    `serveStatic` calls `next()` on a miss, so without this a missing asset
  //    falls through to step 4 and answers `200 text/html` (probed).
  app.all('/assets/*', (c) => c.text('not found', 404));

  // 4. SPA fallback: `/session/:id/trace/:n` and friends cold-load the same
  //    document and the client router takes it from there.
  app.get('*', makeServeIndex(options));
}
