import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  onSweep?: (result: SweepResult) => void;
  /** `ui/dist` override; defaults to a fresh `makeFakeUiDist()`. */
  uiDir?: string;
  /** Transcript root override; defaults to a fresh EMPTY temp dir. */
  transcriptRoot?: string;
  /** Tail period in ms; defaults to `0` — a test opts IN to tailing. */
  tailIntervalMs?: number;
  onTail?: (result: TailResult) => void;
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
    onSweep: opts.onSweep,
    uiDir,
    transcriptRoot,
    tailIntervalMs: opts.tailIntervalMs ?? 0,
    onTail: opts.onTail,
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
