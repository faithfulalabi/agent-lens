import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readToken, TOKEN_HEADER } from '../../shared/index.js';
import { DB_FILE } from '../../db/index.js';
import type { SweepResult } from '../../capture/inactivity.js';
import { startServer, type ServerHandle } from '../start.js';

/** A booted test server plus its temp data dir and convenience accessors. */
export interface TestServer {
  handle: ServerHandle;
  dataDir: string;
  token: string;
  url: (path: string) => string;
  close: () => Promise<void>;
}

/** Extra `startServer` wiring a test can request. */
export interface BootOptions {
  dataDir?: string;
  sweepIntervalMs?: number;
  onSweep?: (result: SweepResult) => void;
}

/**
 * Boot a hermetic server on an ephemeral port in a fresh temp data dir. Accepts
 * either the legacy positional data dir or an options bag forwarded to
 * `startServer`.
 */
export async function bootTestServer(
  options: string | BootOptions = {},
): Promise<TestServer> {
  const opts: BootOptions = typeof options === 'string' ? { dataDir: options } : options;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'agent-lens-'));
  const handle = await startServer({
    port: 0,
    dataDir,
    sweepIntervalMs: opts.sweepIntervalMs,
    onSweep: opts.onSweep,
  });
  const token = readToken(dataDir)!;
  return {
    handle,
    dataDir,
    token,
    url: (path) => `http://127.0.0.1:${handle.port}${path}`,
    close: async () => {
      await handle.close();
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
