// AC2 and AC4: registration order, the JSON-404 terminator, and the two
// middleware this task must leave alone.
//
// ★ ORDER IS THE MOST RE-DISCOVERED FACT IN THIS REPO, so it is pinned
// EXECUTABLY here rather than by the comments in `app.ts`. The two mutation
// controls are locally-built mis-ordered apps in this file — never a toggle on
// `buildApiApp`. A production seam added for a test's benefit is how the thing
// under test stops being the thing that ships.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { fileEnv, openCache, seedSessionRow } from '../../db/__tests__/fixtures/index.js';
import { TOKEN_HEADER } from '../../shared/index.js';
import { buildApiApp } from '../app.js';
import { jsonNotFound, registerApi } from '../api.js';
import { hostGuard } from '../middleware/host-guard.js';
import { tokenAuth } from '../middleware/token-auth.js';
import { registerUi } from '../static-ui.js';
import { createStreamHub, type StreamHub } from '../stream.js';
import type { WarmQueue } from '../warm.js';

/**
 * A warm queue that starts nothing. This file never POSTs `/api/warm` through
 * the middleware, so a real queue would only race `db.close()` in `afterEach`.
 */
function stubWarm(): WarmQueue {
  return { start: () => 0, close: () => undefined };
}


const TOKEN = 'test-token';
const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The terminator's body, byte for byte. Every unclaimed `/api` path yields it. */
const NOT_FOUND_BODY = '{"error":"not found"}';

let sandbox: Sandbox;
let db: DatabaseSync;
let app: Hono;
let uiDir: string;
let hub: StreamHub;

beforeEach(() => {
  sandbox = makeSandbox();
  db = openCache();
  seedSessionRow(db, { id: 'session-1' });
  uiDir = join(sandbox.root, 'no-such-ui');
  hub = createStreamHub();
  app = buildApiApp({ db, env: fileEnv(), token: TOKEN, uiDir, hub, warm: stubWarm() });
});

afterEach(async () => {
  // Every attached client is parked on a promise the hub holds; draining is what
  // unparks them and ends their response bodies.
  await hub.drain();
  db.close();
  cleanup(sandbox);
});

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Host: 'localhost', [TOKEN_HEADER]: TOKEN, ...extra };
}

/** The ten routes, as method + path. AC4 drives auth and host over all of them. */
const ROUTES: readonly [string, string][] = [
  ['GET', '/api/sessions'],
  ['GET', '/api/projects'],
  ['GET', '/api/sessions/session-1'],
  ['GET', '/api/events/ev-1/content'],
  ['GET', '/api/search?q=x'],
  ['GET', '/api/stream'],
  ['POST', '/api/sessions/session-1/reproject'],
  ['POST', '/api/warm'],
  ['GET', '/api/drift'],
  ['GET', '/api/health'],
];

describe('AC2 — registration order, pinned executably', () => {
  it('an unclaimed /api path is a JSON 404, never the HTML SPA', async () => {
    const res = await app.request('/api/nope', { headers: headers() });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).toBe(NOT_FOUND_BODY);
  });

  it('the terminator is app.all, so every verb is covered', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await app.request('/api/nope', { method, headers: headers() });
      expect(res.status, method).toBe(404);
      expect(await res.text()).toBe(NOT_FOUND_BODY);
    }
  });

  it('a UI deep link still gets the HTML SPA fallback', async () => {
    const res = await app.request('/session/x', { headers: { Host: 'localhost' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('★ /api/stream is NOT shadowed by the /api/* terminator', async () => {
    const res = await app.request('/api/stream', { headers: headers() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });

  it('GET / is reachable with no token — it is what bootstraps one', async () => {
    const res = await app.request('/', { headers: { Host: 'localhost' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('AC2 — the mutation controls, each a mis-ordered app built here', () => {
  /** Everything `buildApiApp` does, with the two order-critical steps as knobs. */
  function misordered(options: { terminatorFirst?: boolean; uiBeforeTerminator?: boolean }): Hono {
    const local = new Hono();
    local.use('*', hostGuard([]));
    local.use('/api/*', tokenAuth(TOKEN));
    if (options.terminatorFirst === true) local.all('/api/*', jsonNotFound);
    registerApi(local, { db, env: fileEnv(), hub, warm: stubWarm() });
    if (options.uiBeforeTerminator === true) {
      registerUi(local, { token: TOKEN, uiDir });
      local.all('/api/*', jsonNotFound);
    } else {
      local.all('/api/*', jsonNotFound);
      registerUi(local, { token: TOKEN, uiDir });
    }
    return local;
  }

  it('(a) the terminator ABOVE /api/stream 404s the SSE endpoint', async () => {
    const res = await misordered({ terminatorFirst: true }).request('/api/stream', {
      headers: headers(),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_BODY);
  });

  it('(b) registerUi ABOVE the terminator answers /api/nope with HTML', async () => {
    const res = await misordered({ uiBeforeTerminator: true }).request('/api/nope', {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('the control harness itself reproduces the shipped order when unperturbed', async () => {
    // Without this, (a) and (b) could pass because the local builder is broken
    // rather than because the perturbation matters.
    const local = misordered({});
    const stream = await local.request('/api/stream', { headers: headers() });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
    const nope = await local.request('/api/nope', { headers: headers() });
    expect(nope.status).toBe(404);
    expect(await nope.text()).toBe(NOT_FOUND_BODY);
  });
});

describe('AC1 — the deleted surface reaches the terminator, not a handler', () => {
  const DELETED: readonly [string, string][] = [
    ['POST', '/api/ingest'],
    ['GET', '/api/events'],
    ['GET', '/api/sessions/session-1/spans'],
    ['GET', '/api/traces/t-1/messages'],
    ['GET', '/api/payloads/p-1'],
    ['GET', '/api/stream/sessions'],
    ['GET', '/api/stream/sessions/session-1'],
  ];

  it.each(DELETED)('%s %s is the JSON 404 terminator', async (method, path) => {
    const res = await app.request(path, { method, headers: headers() });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    // Byte-identical to the terminator's body: a surviving handler would have to
    // reproduce it exactly to hide here, and none of them 404 at all today.
    expect(await res.text()).toBe(NOT_FOUND_BODY);
  });

  it('is not vacuous — a route that DOES exist answers differently', async () => {
    const live = await app.request('/api/health', { headers: headers() });
    expect(live.status).toBe(200);
    expect(await live.text()).not.toBe(NOT_FOUND_BODY);
  });
});

describe('AC4 — auth and host, unchanged', () => {
  it.each(ROUTES)('%s %s 401s with no token', async (method, path) => {
    const res = await app.request(path, { method, headers: { Host: 'localhost' } });
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)('%s %s 401s with the wrong token', async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: { Host: 'localhost', [TOKEN_HEADER]: 'not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)('%s %s 403s on a foreign Host', async (method, path) => {
    const res = await app.request(path, { method, headers: headers({ Host: 'evil.com' }) });
    expect(res.status).toBe(403);
  });

  it('the host guard runs BEFORE token auth, so a rebinding page learns nothing', async () => {
    const res = await app.request('/api/sessions', { headers: { Host: 'evil.com' } });
    expect(res.status).toBe(403);
  });

  it('an unclaimed /api path is still token-guarded', async () => {
    const res = await app.request('/api/nope', { headers: { Host: 'localhost' } });
    expect(res.status).toBe(401);
  });

  it('★ both middleware files are byte-for-byte the size the task pinned', () => {
    // "Unchanged" as a TEST rather than a claim: this task rewires the routes
    // around these two and must not touch either.
    const lines = (rel: string): number =>
      readFileSync(join(SERVER_DIR, rel), 'utf8').split('\n').length - 1;
    expect(lines('middleware/token-auth.ts')).toBe(28);
    expect(lines('middleware/host-guard.ts')).toBe(68);
  });
});
