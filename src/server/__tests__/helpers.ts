import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { readToken, TOKEN_HEADER } from '../../shared/index.js';
import { DB_FILE } from '../../db/index.js';
import type { SweepResult } from '../../capture/inactivity.js';
import type { TailResult } from '../../capture/tailer.js';
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
  sweepIntervalMs?: number;
  /** Silence threshold the sweep applies; without it a test cannot age a session. */
  sweepTimeoutMs?: number;
  onSweep?: (result: SweepResult) => void;
  /** `ui/dist` override; defaults to a fresh `makeFakeUiDist()`. */
  uiDir?: string;
  /** Transcript root override; defaults to a fresh EMPTY temp dir. */
  transcriptRoot?: string;
  /** Tail period in ms; defaults to `0` — a test opts IN to tailing. */
  tailIntervalMs?: number;
  /** Forwarded to the tailer; `'backfill'` reads unknown files from zero. */
  firstSight?: 'eof' | 'backfill';
  /** Forwarded to the tailer; restricts discovery to these slug directories. */
  projects?: readonly string[];
  onTail?: (result: TailResult) => void;
  /** SSE heartbeat period in ms; defaults to the production 15s. */
  heartbeatMs?: number;
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
 * `transcriptRoot` and `tailIntervalMs` default the same way `uiDir` does, and
 * for the same reason spelled out on {@link makeFakeUiDist}: the production
 * default is the developer's real `~/.claude/projects` (20 MB / 4000 lines / a
 * dozen unrelated projects on a working machine), which every server test would
 * otherwise scan synchronously before the socket binds. A fresh EMPTY root plus
 * tailing OFF means a test opts IN to the tailer and says exactly what it feeds it.
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
    sweepIntervalMs: opts.sweepIntervalMs,
    sweepTimeoutMs: opts.sweepTimeoutMs,
    onSweep: opts.onSweep,
    uiDir,
    transcriptRoot,
    tailIntervalMs: opts.tailIntervalMs ?? 0,
    firstSight: opts.firstSight,
    projects: opts.projects,
    onTail: opts.onTail,
    heartbeatMs: opts.heartbeatMs,
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
 * Open a second read connection to a booted server's SQLite file, so an
 * HTTP-level test can assert on tables the API does not expose. WAL allows the
 * concurrent reader; the caller closes the handle.
 */
export function openTestDb(dataDir: string): DatabaseSync {
  return new DatabaseSync(join(dataDir, DB_FILE));
}

/** Delete a temp data dir tree. */
export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// --- SSE frame reading -----------------------------------------------------
// One reader, shared. This lived as byte-near copies in `ingest.test.ts` and
// `read-api.test.ts` (the second literally said "mirrors ingest.test.ts") until
// Task 6.1 needed a third; both call sites now import from here.

/** One parsed SSE frame: its `event:` name, raw `data:` text, and `id:` if present. */
export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** Split one `\n\n`-terminated SSE frame into its fields. */
function parseFrame(raw: string): SseFrame {
  const frame: SseFrame = { event: '', data: '' };
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) frame.event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    else if (line.startsWith('id:')) frame.id = line.slice('id:'.length).trim();
  }
  frame.data = dataLines.join('\n');
  return frame;
}

/**
 * Read SSE frames off a streaming response until `stop` says to finish (or the
 * deadline passes), then cancel the reader. Every frame is yielded to `stop`,
 * heartbeats included, so a caller can assert on frame ORDER rather than just
 * on the presence of the one it wanted.
 *
 * Deliberately returns raw `data` text: the parse belongs to the caller, because
 * a heartbeat's `data` is the empty string and `JSON.parse('')` is exactly the
 * crash this repo's SSE contract exists to prevent.
 */
export async function readSseFrames(
  res: Response,
  stop: (frame: SseFrame, all: SseFrame[]) => boolean,
  timeoutMs = 1000,
): Promise<SseFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const frame = parseFrame(raw);
        frames.push(frame);
        if (stop(frame, frames)) return frames;
      }
    }
    return frames;
  } finally {
    await reader.cancel();
  }
}

/**
 * Read one SSE frame of the given event type and JSON-parse its data. Throws if
 * no such frame arrives inside `timeoutMs`.
 */
export async function readOneEvent(
  res: Response,
  eventType: string,
  timeoutMs = 1000,
): Promise<Record<string, unknown>> {
  const frames = await readSseFrames(res, (f) => f.event === eventType, timeoutMs);
  const match = frames.find((f) => f.event === eventType);
  if (match === undefined) {
    throw new Error(`no "${eventType}" frame within ${timeoutMs}ms`);
  }
  return JSON.parse(match.data) as Record<string, unknown>;
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

/** A minimal valid hook envelope for ingest tests. */
export function makeTestEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'sess-1:hook:PreToolUse:tool-abc',
    session_id: 'sess-1',
    harness: 'claude-code',
    source: 'hook',
    hook_name: 'PreToolUse',
    ts: '2026-07-22T00:00:00.000Z',
    raw_payload: { tool: 'bash', cmd: 'ls' },
    ...overrides,
  };
}

export { TOKEN_HEADER };
