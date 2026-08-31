// Task 5.1b: serving the built UI. Everything here runs against a FAKE
// `ui/dist` in a temp dir — the real one is gitignored, so a test that read it
// would mean something different depending on whether the machine had run
// `npm run build`, and how long ago. The server cannot tell the two apart: it
// only does `readFile` and `stat`.
//
// The one place a real `vite build` is exercised is the ui project's
// `bootstrap-marker.test.ts`, which is the other half of the marker contract.

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { request, type IncomingHttpHeaders } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApiApp } from '../app.js';
import { openCache } from '../../db/__tests__/fixtures/index.js';
import { fileEnv } from '../../db/__tests__/fixtures/index.js';
import { BOOTSTRAP_MARKER, resolveUiDir } from '../static-ui.js';
import { createStreamHub } from '../stream.js';
import {
  bootTestServer,
  cleanupDir,
  makeFakeUiDist,
  TOKEN_HEADER,
  type BootOptions,
  type TestServer,
} from './helpers.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let server: TestServer | undefined;
const tempDirs: string[] = [];

/** Boot and register for teardown. */
async function boot(options: BootOptions = {}): Promise<TestServer> {
  server = await bootTestServer(options);
  return server;
}

/** A temp dir this file owns; removed in `afterEach`. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agent-lens-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (server) {
    await server.close();
    cleanupDir(server.dataDir);
    server = undefined;
  }
  for (const dir of tempDirs.splice(0)) cleanupDir(dir);
});

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Raw HTTP GET returning headers plus the body as bytes, with keep-alive off
 * and the path sent VERBATIM. Every `/assets/*` request in this file goes
 * through it, for two independent reasons:
 *
 *  * Verbatim paths are the whole point of the traversal rows — `fetch`
 *    normalises `..` and `%2e%2e` client-side, which would make them vacuous.
 *  * `serveStatic` streams its response, and a client that keeps the socket
 *    alive afterwards holds `server.close()` open for ~3s (reproduced outside
 *    vitest too). Harmless in a browser; three seconds per test here.
 */
function rawGet(port: number, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

// --- AC1: the bundle is served, with the right types and caching -------------

describe('AC1 — the built UI is served at / and /assets/*', () => {
  it('serves the injected index.html at / with a 200 and no-store', async () => {
    const s = await boot();
    const res = await fetch(s.url('/'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // The page carries the token, so it must never be cached to disk.
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = await res.text();
    expect(body).toContain('<div id="root">');
    // The marker was consumed, not served through.
    expect(body).not.toContain(BOOTSTRAP_MARKER);
  });

  it.each([
    ['app-abc123.js', 'text/javascript'],
    ['app-abc123.css', 'text/css'],
    // The six vendored faces from Task 5.1a all arrive this way.
    ['app-abc123.woff2', 'font/woff2'],
  ])('serves /assets/%s as %s, byte for byte', async (name, mime) => {
    const s = await boot();
    const res = await rawGet(s.handle.port, `/assets/${name}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(mime);
    expect(res.body.equals(readFileSync(join(s.uiDir, 'assets', name)))).toBe(true);
  });

  it('serves fingerprinted assets as immutable, and never caches a 404', async () => {
    const s = await boot();

    const hit = await rawGet(s.handle.port, '/assets/app-abc123.js');
    expect(hit.status).toBe(200);
    expect(hit.headers['cache-control']).toContain('max-age=31536000');
    expect(hit.headers['cache-control']).toContain('immutable');

    const miss = await rawGet(s.handle.port, '/assets/does-not-exist.js');
    expect(miss.status).toBe(404);
    expect(miss.headers['cache-control']).toBeUndefined();
  });

  it('serves ui/dist regardless of process.cwd()', async () => {
    // A globally installed `agent-lens` runs from whatever directory the user
    // happens to be in. `serveStatic`'s `root` is only cwd-independent because
    // it is absolute — this is the test that keeps it that way.
    const s = await boot();
    const cwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const asset = await rawGet(s.handle.port, '/assets/app-abc123.js');
      expect(asset.status).toBe(200);
      const index = await fetch(s.url('/'));
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<div id="root">');
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('AC1 — locating ui/dist', () => {
  it('resolves ui/dist identically from a source and a built layout', () => {
    // The off-by-one-directory regression: this module sits at `src/server/`
    // under tsx and at `dist/src/server/` once compiled, while `ui/dist` stays
    // a sibling of `dist/`. A fixed `../../ui/dist` is right in exactly one of
    // those. Synthesized rather than compiled — same guarantee, milliseconds,
    // no `tsc` in a unit test.
    const pkg = tempDir('pkg');
    writeFileSync(join(pkg, 'package.json'), '{"name":"agent-lens"}\n');
    for (const rel of [
      ['ui', 'dist'],
      ['src', 'server'],
      ['dist', 'src', 'server'],
    ]) {
      mkdirSync(join(pkg, ...rel), { recursive: true });
    }

    const expected = join(pkg, 'ui', 'dist');
    expect(resolveUiDir(join(pkg, 'src', 'server'))).toBe(expected);
    expect(resolveUiDir(join(pkg, 'dist', 'src', 'server'))).toBe(expected);
  });

  it('ui/index.html carries the bootstrap marker exactly once', () => {
    // Half of the marker contract, which spans two packages with no shared
    // import. Catches removal at edit time; the ui project's
    // `bootstrap-marker.test.ts` catches a build that drops it.
    const html = readFileSync(join(REPO_ROOT, 'ui', 'index.html'), 'utf8');
    expect(html.split(BOOTSTRAP_MARKER)).toHaveLength(2);
  });
});

// --- AC2: deep links, JSON API 404s, missing assets --------------------------

describe('AC2 — deep links, API 404s, and missing assets', () => {
  it.each(['/session/abc', '/session/abc/trace/3', '/session/abc/trace/0'])(
    'cold-loads %s with the same HTML as /',
    async (path) => {
      const s = await boot();
      const root = await fetch(s.url('/'));
      const deep = await fetch(s.url(path));

      expect(deep.status).toBe(200);
      expect(deep.headers.get('content-type')).toContain('text/html');
      // Byte-identical: same document, same injected token — the client router
      // is what makes them different pages.
      expect(await deep.text()).toBe(await root.text());
    },
  );

  it('404s a missing asset instead of returning the SPA HTML', async () => {
    // `serveStatic` calls `next()` on a miss, so without the `/assets/*`
    // terminator this falls through to the SPA fallback and answers 200 HTML.
    const s = await boot();
    const res = await rawGet(s.handle.port, '/assets/does-not-exist.js');

    expect(res.status).toBe(404);
    expect(res.body.toString('utf8').startsWith('<')).toBe(false);
  });

  it('still answers an unmatched /api path with JSON, not the SPA HTML', async () => {
    const s = await boot();
    const res = await fetch(s.url('/api/nope'), { headers: { [TOKEN_HEADER]: s.token } });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.text();
    expect(body.startsWith('<')).toBe(false);
    expect(JSON.parse(body)).toEqual({ error: 'not found' });
  });

  it('still streams /api/stream with the SPA fallback registered', async () => {
    const s = await boot();
    const res = await fetch(s.url('/api/stream'), { headers: { [TOKEN_HEADER]: s.token } });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });
});

describe('AC2 — path traversal', () => {
  const SENTINEL = 'agent-lens-traversal-sentinel-do-not-serve';

  /**
   * A fake `ui/dist` with `secret.txt` in its PARENT — exactly where a `..`
   * escape lands, which is what makes the sentinel assertion below meaningful
   * rather than decorative.
   */
  function traversalUiDir(): string {
    const root = tempDir('traversal');
    writeFileSync(join(root, 'secret.txt'), SENTINEL);
    return makeFakeUiDist(join(root, 'dist'));
  }

  // Two independent mechanisms defeat these, which is why the expected status
  // differs per row and a blanket `404` assertion would be wrong:
  //   * `@hono/node-server` builds a WHATWG `URL`, which collapses `..`,
  //     `%2e%2e` and `.%2e` BEFORE routing — the path then no longer starts
  //     with `/assets`, never reaches `serveStatic`, and lands on the SPA
  //     fallback as a perfectly ordinary 200.
  //   * `serveStatic`'s own `/(?:^|[\/\\])\.{1,2}(?:$|[\/\\])|[\/\\]{2,}|\\/`
  //     rejects what survives, which `next()`s into the `/assets/*` terminator.
  // The statuses below were reproduced row for row; the sentinel assertion is
  // the net that actually matters.
  it.each([
    ['/assets/../secret.txt', 200],
    ['/assets/../../../../etc/passwd', 200],
    ['/assets/%2e%2e/secret.txt', 200],
    ['/assets/.%2e/secret.txt', 200],
    ['/assets/%2e%2e%2fsecret.txt', 404],
    ['/assets/..%2f..%2fsecret.txt', 404],
    ['/assets/....//secret.txt', 404],
    ['/assets//etc/passwd', 404],
  ])('never serves a file outside ui/dist for %s', async (path, expected) => {
    const s = await boot({ uiDir: traversalUiDir() });

    const res = await rawGet(s.handle.port, path);
    expect(res.status).toBe(expected);
    const body = res.body.toString('utf8');
    expect(body).not.toContain(SENTINEL);
    // /etc/passwd's first line, in case a row ever escapes to a real system file.
    expect(body).not.toContain('root:x:0:0');
  });
});

describe('AC2 — the SPA fallback is the last route in the app', () => {
  it('shadows anything registered after buildApiApp, specific paths included', async () => {
    // The one-way door, documented executably. Hono matches in registration
    // order and first match wins, so `buildApiApp`'s `app.get('*')` claims every
    // later registration — which is why the UI routes go in last and why
    // nothing may be bolted on afterwards.
    const db = openCache();
    try {
      const app = buildApiApp({
        db,
        token: 'tok',
        env: fileEnv(),
        hub: createStreamHub(),
        uiDir: makeFakeUiDist(join(tempDir('ui'), 'dist')),
      });
      app.get('/later-specific', (c) => c.text('LATE SPECIFIC'));
      app.get('*', (c) => c.text('LATE WILDCARD'));

      for (const path of ['/later-specific', '/session/abc']) {
        const res = await app.request(path, { headers: { host: 'localhost' } });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body, `${path} reached a handler registered after buildApiApp`).toContain(
          '<div id="root">',
        );
        expect(body).not.toContain('LATE');
      }
    } finally {
      db.close();
    }
  });
});

// --- AC4: ui/dist absent or stale --------------------------------------------

describe('AC4 — a missing or stale ui/dist degrades, never crashes', () => {
  /** A path that does not exist, so the server behaves like a fresh clone. */
  function absentUiDir(): string {
    return join(tempDir('absent'), 'never-built');
  }

  it('boots and serves build instructions at / when ui/dist is absent', async () => {
    const s = await boot({ uiDir: absentUiDir() });
    const res = await fetch(s.url('/'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('npm run build');
  });

  it('renders the same placeholder on a deep link when ui/dist is absent', async () => {
    // A bookmarked deep link on a fresh clone has to explain itself too.
    const s = await boot({ uiDir: absentUiDir() });
    const res = await fetch(s.url('/session/abc/trace/3'));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('npm run build');
  });

  it('keeps /api/* working when ui/dist is absent', async () => {
    const s = await boot({ uiDir: absentUiDir() });

    const health = await fetch(s.url('/api/health'), { headers: { [TOKEN_HEADER]: s.token } });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, sessions_indexed: expect.any(Number) });

    const missing = await fetch(s.url('/api/nope'), { headers: { [TOKEN_HEADER]: s.token } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
  });

  it('serves the placeholder when index.html exists but predates the marker', async () => {
    // The trap this guards is the repo's own state at the time this task was
    // written: a `ui/dist` built before the marker existed. An escaping
    // `injectToken` throw becomes `app.onError`'s 500 text/plain on `/` AND on
    // every deep link, so suite greenness would depend on how stale the
    // developer's local build happened to be.
    const uiDir = makeFakeUiDist(join(tempDir('stale'), 'dist'));
    writeFileSync(join(uiDir, 'index.html'), '<!doctype html><html><body>stale</body></html>');

    const s = await boot({ uiDir });
    const res = await fetch(s.url('/'));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('npm run build');
  });

  it('imports static-ui without touching the filesystem', () => {
    // THE ONLY SUBPROCESS-SPAWNING TEST IN THE SUITE, and it should stay that
    // way — this is not a precedent for shelling out. It earns the exception
    // because an eager module-load read of `ui/dist` breaks all eleven
    // `bootTestServer` files at once, and only on a fresh clone, which is
    // exactly when nobody is looking. In-process forms do not work: vitest 3
    // cannot spy on an ESM builtin's exports, and `await import()` in a file
    // that already imports the module returns the memoized copy and executes
    // nothing.
    const uiDist = join(REPO_ROOT, 'ui', 'dist');
    const stashed = `${uiDist}.stashed-by-test`;
    const present = existsSync(uiDist);
    if (present) {
      rmSync(stashed, { recursive: true, force: true });
      renameSync(uiDist, stashed);
    }
    try {
      const entry = join(REPO_ROOT, 'src', 'server', 'static-ui.ts');
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '-e', `import(${JSON.stringify(entry)})`],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      if (present) renameSync(stashed, uiDist);
    }
  });
});
