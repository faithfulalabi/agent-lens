import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToken } from '../../shared/index.js';
import { startServer, type ServerHandle } from '../start.js';
import { resolveBindHosts } from '../middleware/host-guard.js';
import {
  bootTestServer,
  cleanupDir,
  makeTestEnvelope,
  TOKEN_HEADER,
  type TestServer,
} from './helpers.js';

/**
 * Raw HTTP request that can set a custom Host header — `fetch` forbids Host as a
 * header name, so the host guard can only be exercised via `node:http`.
 *
 * `agent: false` keeps teardown quick: `serveStatic` streams its response, and a
 * client holding the socket open afterwards delays `server.close()` by seconds
 * on the `/assets/*` rows.
 */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers, agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    cleanupDir(server.dataDir);
    server = undefined;
  }
});

async function eventCount(s: TestServer): Promise<number> {
  const events = (await (
    await fetch(s.url('/api/events'), { headers: { [TOKEN_HEADER]: s.token } })
  ).json()) as unknown[];
  return events.length;
}

describe('token auth on /api/*', () => {
  it('rejects ingest without a token (401) and writes no row', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeTestEnvelope()),
    });
    expect(res.status).toBe(401);
    expect(await eventCount(server)).toBe(0);
  });

  it('rejects ingest with a wrong token (401)', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: 'nope', 'content-type': 'application/json' },
      body: JSON.stringify(makeTestEnvelope()),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a stream without a token (401)', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/stream'));
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('rejects /api/events without a token (401)', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/events'));
    expect(res.status).toBe(401);
  });

  it('rejects /api/events with a wrong token (401)', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/events'), {
      headers: { [TOKEN_HEADER]: 'nope' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a stream with a wrong token (401)', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/stream'), {
      headers: { [TOKEN_HEADER]: 'nope' },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  // The Task 6.1 delta streams, both halves of the token check. `sess-1` does
  // NOT exist in a fresh data dir, which is the point: the guards run as
  // middleware, so an unknown session with a bad token is a 401, never the 404
  // the handler would have returned.
  it.each(['/api/stream/sessions', '/api/stream/sessions/sess-1'])(
    'rejects %s without a token (401)',
    async (path) => {
      server = await bootTestServer();
      const res = await fetch(server.url(path));
      expect(res.status).toBe(401);
      await res.body?.cancel();
    },
  );

  it.each(['/api/stream/sessions', '/api/stream/sessions/sess-1'])(
    'rejects %s with a wrong token (401)',
    async (path) => {
      server = await bootTestServer();
      const res = await fetch(server.url(path), { headers: { [TOKEN_HEADER]: 'nope' } });
      expect(res.status).toBe(401);
      await res.body?.cancel();
    },
  );

  it('accepts requests with the correct token', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token, 'content-type': 'application/json' },
      body: JSON.stringify(makeTestEnvelope()),
    });
    expect(res.status).toBe(200);
  });
});

describe('host-header guard', () => {
  it('rejects a non-localhost Host (403) even with a valid token, no row', async () => {
    server = await bootTestServer();
    const res = await rawRequest(
      server.handle.port,
      '/api/ingest',
      {
        [TOKEN_HEADER]: server.token,
        'content-type': 'application/json',
        host: 'evil.com',
      },
      'POST',
      JSON.stringify(makeTestEnvelope()),
    );
    expect(res.status).toBe(403);
    expect(await eventCount(server)).toBe(0);
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'allows loopback Host %s',
    async (host) => {
      server = await bootTestServer();
      const res = await rawRequest(server.handle.port, '/api/events', {
        [TOKEN_HEADER]: server.token,
        host: `${host}:${server.handle.port}`,
      });
      expect(res.status).toBe(200);
    },
  );

  // `hostGuard` is registered as `app.use('*', ...)`, so Task 5.1b's UI routes
  // inherit it for free — but "for free" is only true while something asserts
  // it, hence the asset and deep-link rows.
  it.each([
    '/',
    '/api/events',
    '/api/stream',
    // The Task 6.1 delta streams inherit the same guards, and an unknown session
    // id must not become an exception to them.
    '/api/stream/sessions',
    '/api/stream/sessions/sess-1',
    '/assets/app-abc123.js',
    '/session/abc',
    '/session/abc/trace/3',
  ])('rejects a spoofed Host on %s (403)', async (path) => {
    server = await bootTestServer();
    const res = await rawRequest(server.handle.port, path, {
      [TOKEN_HEADER]: server.token,
      host: 'evil.com',
    });
    expect(res.status).toBe(403);
  });

  it.each(['/', '/assets/app-abc123.js'])(
    'serves the UI at %s under a loopback Host (200)',
    async (path) => {
      server = await bootTestServer();
      const res = await rawRequest(server.handle.port, path, {
        host: `localhost:${server.handle.port}`,
      });
      // 200 even on a machine with no `ui/dist`: the placeholder page is a 200,
      // because the server IS up — only the bundle is missing.
      expect(res.status).toBe(200);
    },
  );
});

// AC5: the UI is host-guarded but deliberately NOT token-guarded, while
// `/api/*` stays token-guarded. That split is the recorded ruling from Task 2.5
// — merging them "would lock the UI out or force the token into a URL/cookie",
// and a `<script src>` cannot carry a header at all. Asserted here so a future
// "harden everything" pass argues with a named test, not a comment.
describe('the UI is reachable without a token; /api/* is not', () => {
  it.each(['/', '/assets/app-abc123.js', '/session/abc'])(
    'serves %s with no token at all (200)',
    async (path) => {
      server = await bootTestServer();
      const res = await rawRequest(server.handle.port, path, {
        host: `localhost:${server.handle.port}`,
      });
      expect(res.status).toBe(200);
    },
  );

  it('still 401s /api/* without a token, and never answers it with SPA HTML', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/events'));
    expect(res.status).toBe(401);
    expect((await res.text()).startsWith('<')).toBe(false);
  });
});

// AC4: a non-loopback `--host` bind warns loudly, keeps token auth mandatory,
// admits the resolved interface host/IP so the exposed server is reachable, and
// still rejects a spoofed Host (rebinding defense intact). `0.0.0.0` binds all
// interfaces, so the raw client can reach it via 127.0.0.1 while setting Host.
describe('--host (non-loopback bind)', () => {
  let handle: ServerHandle | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    if (dir) {
      cleanupDir(dir);
      dir = undefined;
    }
    vi.restoreAllMocks();
  });

  it('warns, enforces token, admits the resolved interface Host, and rejects spoofs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'agent-lens-host-'));
    handle = await startServer({
      port: 0,
      dataDir: dir,
      host: '0.0.0.0',
      // Bypasses `bootTestServer`, so opt out of the tailer explicitly: the boot
      // catch-up would otherwise scan the developer's real `~/.claude/projects`.
      tailIntervalMs: 0,
    });
    const token = readToken(dir)!;

    // Loud network-exposure warning was emitted.
    expect(warn).toHaveBeenCalled();
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/warning/i);
    expect(warned).toMatch(/network/i);
    // The literal bind address is never in the admitted host set.
    expect(resolveBindHosts('0.0.0.0')).not.toContain('0.0.0.0');

    const interfaceHost = resolveBindHosts('0.0.0.0').find((h) => !h.startsWith('['));
    expect(interfaceHost).toBeDefined();

    // Auth intact: resolved interface Host + missing token -> 401.
    const noToken = await rawRequest(handle.port, '/api/events', {
      host: `${interfaceHost}:${handle.port}`,
    });
    expect(noToken.status).toBe(401);

    // Rebinding defense intact: spoofed Host -> 403 even with a valid token.
    const spoofed = await rawRequest(handle.port, '/api/events', {
      [TOKEN_HEADER]: token,
      host: 'evil.com',
    });
    expect(spoofed.status).toBe(403);

    // Exposed server actually reachable: resolved interface Host + valid token -> 200.
    const ok = await rawRequest(handle.port, '/api/events', {
      [TOKEN_HEADER]: token,
      host: `${interfaceHost}:${handle.port}`,
    });
    expect(ok.status).toBe(200);
  });

  it('does not warn on a default loopback bind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'agent-lens-host-'));
    handle = await startServer({ port: 0, dataDir: dir, tailIntervalMs: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});
