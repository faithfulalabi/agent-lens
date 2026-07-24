import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToken, TOKEN_HEADER } from '../../shared/index.js';
import { startServer, type ServerHandle } from '../start.js';

/** A booted test server plus its temp data dir and convenience accessors. */
export interface TestServer {
  handle: ServerHandle;
  dataDir: string;
  token: string;
  url: (path: string) => string;
  close: () => Promise<void>;
}

/** Boot a hermetic server on an ephemeral port in a fresh temp data dir. */
export async function bootTestServer(existingDir?: string): Promise<TestServer> {
  const dataDir = existingDir ?? mkdtempSync(join(tmpdir(), 'agent-lens-'));
  const handle = await startServer({ port: 0, dataDir });
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
