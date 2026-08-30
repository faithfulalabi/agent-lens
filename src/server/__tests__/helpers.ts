import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { readToken, TOKEN_HEADER } from '../../shared/index.js';
import { CACHE_DB_FILE } from '../../db/open.js';
import { startServer, type ServerHandle } from '../start.js';

/** A booted test server plus its temp data dir and convenience accessors. */
export interface TestServer {
  handle: ServerHandle;
  dataDir: string;
  /** The `ui/dist` the server was booted against — a fake bundle by default. */
  uiDir: string;
  /** The transcript root the server was booted against — a fresh empty dir by default. */
  transcriptRoot: string;
  token: string;
  url: (path: string) => string;
  close: () => Promise<void>;
}

/** Extra `startServer` wiring a test can request. */
export interface BootOptions {
  dataDir?: string;
  /** Corpus-sweep period in ms; defaults to `0` — a test opts IN to sweeping. */
  sweepIntervalMs?: number;
  /** `ui/dist` override; defaults to a fresh `makeFakeUiDist()`. */
  uiDir?: string;
  /** Transcript root override; defaults to a fresh EMPTY temp dir. */
  transcriptRoot?: string;
}

/** The fingerprint-shaped basename every fake bundle's assets share. */
const FAKE_ASSET_BASENAME = 'app-abc123';

/**
 * Build a throwaway `ui/dist`: a marker-carrying `index.html` plus
 * `assets/app-abc123.{js,css,woff2}` — the three content types AC1 names.
 *
 * The server cannot tell this from a real bundle — it only does `readFile` and
 * `stat` — so no fidelity is lost, and it keeps every server test off the real
 * `ui/dist`, which is gitignored and therefore present, absent, or *stale*
 * depending on the machine. Without this default a test's meaning would change
 * silently with local build state.
 */
export function makeFakeUiDist(dir = mkdtempSync(join(tmpdir(), 'agent-lens-ui-'))): string {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8" /><title>agent-lens</title>',
      '<!--agent-lens-bootstrap-->',
      '</head><body><div id="root"></div>',
      `<script type="module" src="/assets/${FAKE_ASSET_BASENAME}.js"></script>`,
      '</body></html>',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'assets', `${FAKE_ASSET_BASENAME}.js`), 'export const app = 1;\n');
  writeFileSync(join(dir, 'assets', `${FAKE_ASSET_BASENAME}.css`), ':root{--x:1}\n');
  // Real woff2 magic bytes, so nothing downstream can mistake this for text.
  writeFileSync(
    join(dir, 'assets', `${FAKE_ASSET_BASENAME}.woff2`),
    Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00]),
  );
  return dir;
}

/**
 * Boot a hermetic server on an ephemeral port in a fresh temp data dir. Accepts
 * either the legacy positional data dir or an options bag forwarded to
 * `startServer`.
 *
 * `transcriptRoot` and `sweepIntervalMs` default the same way `uiDir` does, and
 * for the same reason spelled out on {@link makeFakeUiDist}: the production
 * default is the developer's real `~/.claude/projects` and `~/.agent-lens`
 * (a dozen unrelated projects on a working machine), which every server test
 * would otherwise walk synchronously before the socket binds. A fresh EMPTY root
 * plus the sweep OFF means a test opts IN and says exactly what it feeds it.
 */
export async function bootTestServer(
  options: string | BootOptions = {},
): Promise<TestServer> {
  const opts: BootOptions = typeof options === 'string' ? { dataDir: options } : options;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'agent-lens-'));
  const uiDir = opts.uiDir ?? makeFakeUiDist();
  const transcriptRoot =
    opts.transcriptRoot ?? mkdtempSync(join(tmpdir(), 'agent-lens-transcripts-'));
  // Only a dir we created ourselves gets removed on close; a caller-supplied one
  // is the caller's to manage.
  const ownedUiDir = opts.uiDir === undefined ? uiDir : undefined;
  const ownedTranscriptRoot = opts.transcriptRoot === undefined ? transcriptRoot : undefined;
  const handle = await startServer({
    port: 0,
    dataDir,
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
    uiDir,
    transcriptRoot,
  });
  const token = readToken(dataDir)!;
  return {
    handle,
    dataDir,
    uiDir,
    transcriptRoot,
    token,
    url: (path) => `http://127.0.0.1:${handle.port}${path}`,
    close: async () => {
      await handle.close();
      if (ownedUiDir !== undefined) cleanupDir(ownedUiDir);
      if (ownedTranscriptRoot !== undefined) cleanupDir(ownedTranscriptRoot);
    },
  };
}

/**
 * Open a second read connection to a booted server's cache.db, so an HTTP-level
 * test can assert on tables the API does not expose. WAL allows the concurrent
 * reader; the caller closes the handle. It takes NO lock — `openDb`'s
 * single-instance lock is held by the server under test.
 */
export function openTestDb(dataDir: string): DatabaseSync {
  return new DatabaseSync(join(dataDir, CACHE_DB_FILE));
}

/** Delete a temp data dir tree. */
export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// --- Raw HTTP, and reading the served page ---------------------------------
// Shared with the dev-server suite, which needs these against a Vite proxy too.

/** Status, headers and body of a raw HTTP response. */
export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Raw HTTP request that can set a custom Host header — `fetch` forbids Host, so
 * the host guard can only be exercised via `node:http`.
 */
export function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers, agent: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The published global, shaped as a browser would see it after parsing `html`. */
export interface Bootstrap {
  token: string;
  tokenHeader: string;
}

/**
 * Run every inline CLASSIC script in `html` against a stub `window` and return
 * what they defined — a source-text match could be satisfied by a string that
 * only looks right. Modules are skipped: a `vm` realm has no module loader.
 */
export function bootstrapFromHtml(html: string): Bootstrap | undefined {
  const window: Record<string, unknown> = {};
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\btype\s*=\s*["']?module\b/i.test(match[1] ?? '')) continue;
    const body = match[2] ?? '';
    if (body.trim() === '') continue;
    runInNewContext(body, { window });
  }
  return window.__AGENT_LENS__ as Bootstrap | undefined;
}

/** Anything in `html` a browser could turn into a request target. */
export function urlLiterals(html: string): string[] {
  return [
    ...[...html.matchAll(/\b(?:src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)].map((m) => m[1]!),
    ...[...html.matchAll(/https?:\/\/[^\s"'`<>]+/g)].map((m) => m[0]),
    ...[...html.matchAll(/\?[^\s"'`<>]*=[^\s"'`<>]*/g)].map((m) => m[0]),
  ];
}

export { TOKEN_HEADER };
