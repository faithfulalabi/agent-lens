import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import { readOrCreateToken } from '../../shared/index.js';
import { bootTestServer, cleanupDir, type TestServer } from '../../server/__tests__/helpers.js';
import { runHook } from '../hook.js';
import { spoolFile } from '../../capture/spool.js';

let dataDir: string;
let server: TestServer | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-hook-'));
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  cleanupDir(dataDir);
});

/** Load a hook fixture as a fresh Readable stream. */
function fixtureStream(name: string): Readable {
  const raw = readFileSync(join(__dirname, 'fixtures', 'hooks', name), 'utf8');
  return Readable.from([raw]);
}

/** Read every spooled line for a session as parsed objects. */
function readSpool(sessionId: string): Record<string, unknown>[] {
  const contents = readFileSync(spoolFile(sessionId, dataDir), 'utf8');
  return contents
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const FIXTURES = [
  'session-start.json',
  'user-prompt-submit.json',
  'pre-tool-use.json',
  'post-tool-use.json',
  'stop.json',
];

describe('runHook — success path (collector up)', () => {
  it('POSTs each fixture as a hook envelope and exits 0', async () => {
    // Point the adapter and the server at the same data dir so the token +
    // config.json line up, then boot the server on that dir.
    readOrCreateToken(dataDir);
    server = await bootTestServer(dataDir);

    for (const name of FIXTURES) {
      process.exitCode = undefined;
      const result = await runHook({
        stdin: fixtureStream(name),
        dataDir,
        port: server.handle.port,
      });
      expect(result.outcome).toBe('posted');
      expect(process.exitCode).toBe(0);
    }

    const events = (await (
      await fetch(server.url('/api/events'), {
        headers: { 'x-agentlens-token': server.token },
      })
    ).json()) as { source: string; hook_name: string }[];
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.source === 'hook')).toBe(true);
    expect(events.map((e) => e.hook_name).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
    // Nothing spooled when the collector accepted everything (dir never created).
    expect(existsSync(join(dataDir, 'spool'))).toBe(false);
  });
});

describe('runHook — exits 0 on every failure', () => {
  it('spools and exits 0 on connection refused (no listener)', async () => {
    process.exitCode = undefined;
    // Port 1 has nothing listening -> ECONNREFUSED.
    const result = await runHook({
      stdin: fixtureStream('pre-tool-use.json'),
      dataDir,
      port: 1,
    });
    expect(result.outcome).toBe('spooled');
    expect(process.exitCode).toBe(0);
    const lines = readSpool('sess-fixture');
    expect(lines).toHaveLength(1);
    expect((lines[0] as { source: string }).source).toBe('hook');
  });

  it('spools and exits 0 on timeout (endpoint slower than deadline)', async () => {
    process.exitCode = undefined;
    // A listener that accepts the request but never responds -> the adapter's
    // AbortController fires, the fetch rejects with AbortError, and we spool.
    const hung: Server = createServer(() => {
      /* never write a response */
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const port = (hung.address() as { port: number }).port;
    try {
      const result = await runHook({
        stdin: fixtureStream('stop.json'),
        dataDir,
        port,
        timeoutMs: 30,
      });
      expect(result.outcome).toBe('spooled');
      expect(process.exitCode).toBe(0);
      expect(readSpool('sess-fixture')).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  });

  it('dead-letters malformed stdin (no POST) and exits 0', async () => {
    process.exitCode = undefined;
    const bad = fixtureStream('not-json.txt');
    const result = await runHook({ stdin: bad, dataDir, port: 1 });
    expect(result.deadLetter).toBe(true);
    expect(process.exitCode).toBe(0);
    // best-effort session_id regex pulls "sess-broken" out of the raw text.
    const lines = readSpool('sess-broken');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.status).toBe('dead_letter');
    expect(typeof lines[0]!.raw_payload).toBe('string');
  });

  it('exits 0 even when the spool dir is unwritable (data-loss point, logged)', async () => {
    process.exitCode = undefined;
    // Make the data dir read-only so mkdir/append inside spool/ fails.
    chmodSync(dataDir, 0o500);
    let result;
    try {
      result = await runHook({ stdin: fixtureStream('stop.json'), dataDir, port: 1 });
    } finally {
      chmodSync(dataDir, 0o700);
    }
    expect(result!.outcome).toBe('spooled');
    expect(process.exitCode).toBe(0);
  });
});

describe('runHook — port discovery via config.json', () => {
  it('reaches the collector on the port written to config.json (no explicit port)', async () => {
    // Boot the server (writes config.json with the bound port), then invoke the
    // adapter WITHOUT an explicit port so it must read config.json.
    readOrCreateToken(dataDir);
    server = await bootTestServer(dataDir);

    process.exitCode = undefined;
    const result = await runHook({ stdin: fixtureStream('pre-tool-use.json'), dataDir });
    expect(result.outcome).toBe('posted');
    expect(process.exitCode).toBe(0);

    const events = (await (
      await fetch(server.url('/api/events'), {
        headers: { 'x-agentlens-token': server.token },
      })
    ).json()) as unknown[];
    expect(events).toHaveLength(1);
  });
});

describe('runHook — timing instrumentation', () => {
  it('writes adapter-timing.jsonl only when AGENT_LENS_TIMING=1', async () => {
    process.env.AGENT_LENS_TIMING = '1';
    try {
      await runHook({ stdin: fixtureStream('stop.json'), dataDir, port: 1 });
    } finally {
      delete process.env.AGENT_LENS_TIMING;
    }
    const contents = readFileSync(join(dataDir, 'logs', 'adapter-timing.jsonl'), 'utf8');
    const record = JSON.parse(contents.trim().split('\n')[0]!) as {
      duration_ms: number;
      outcome: string;
    };
    expect(typeof record.duration_ms).toBe('number');
    expect(record.outcome).toBe('spooled');
  });
});

describe('runHook — p95 wall-time under threshold (collector up + down)', () => {
  it('collector-down path p95 stays well under the 250ms budget', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      await runHook({ stdin: fixtureStream('pre-tool-use.json'), dataDir, port: 1, timeoutMs: 250 });
      durations.push(performance.now() - start);
      rmSync(join(dataDir, 'spool'), { recursive: true, force: true });
    }
    expect(p95(durations)).toBeLessThan(250);
  });

  it('collector-up path p95 stays well under the 250ms budget', async () => {
    readOrCreateToken(dataDir);
    server = await bootTestServer(dataDir);
    const durations: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      await runHook({ stdin: fixtureStream('pre-tool-use.json'), dataDir, port: server.handle.port });
      durations.push(performance.now() - start);
    }
    expect(p95(durations)).toBeLessThan(250);
  });
});

/** 95th-percentile of a sample (nearest-rank). */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx]!;
}
