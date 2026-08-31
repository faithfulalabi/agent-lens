// The boot path: the corpus sweep is wired, provably torn down, and its first
// tick lands BEFORE the socket binds. A surviving interval that fires after the
// database is closed throws inside a timer callback where nothing can catch it,
// so `sweep.close()` must precede the close and these tests prove it rather than
// trusting `.unref()`.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootTestServer, cleanupDir, openTestDb, TOKEN_HEADER, type TestServer } from './helpers.js';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    cleanupDir(server.dataDir);
    server = undefined;
  }
});

const SLUG = '-Users-dev-proj';
const SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function transcriptLine(i: number): unknown {
  return {
    type: 'user',
    uuid: `${String(i).padStart(8, '0')}-1111-4111-8111-000000000000`,
    parentUuid: null,
    sessionId: SESSION,
    version: '2.1.212',
    cwd: '/Users/dev/proj',
    gitBranch: 'main',
    timestamp: new Date(Date.UTC(2026, 7, 14, 9, 0, i)).toISOString(),
    promptId: `p${i}`,
    origin: { kind: 'human' },
    message: { role: 'user', content: `line ${i}` },
  };
}

/** One archived transcript, in the mirror's `<slug>/<stem>.jsonl` layout. */
function seedArchive(dataDir: string, session = SESSION, lines = 2): string {
  const slug = join(dataDir, 'archive', SLUG);
  mkdirSync(slug, { recursive: true });
  const path = join(slug, `${session}.jsonl`);
  writeFileSync(
    path,
    Array.from({ length: lines }, (_, i) => `${JSON.stringify(transcriptLine(i))}\n`).join(''),
  );
  return path;
}

function countRows(dataDir: string, sql: string): number {
  const db = openTestDb(dataDir);
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

async function listedIds(s: TestServer): Promise<string[]> {
  const body = (await (
    await fetch(s.url('/api/sessions'), { headers: { [TOKEN_HEADER]: s.token } })
  ).json()) as { items: { id: string }[] };
  return body.items.map((item) => item.id);
}

describe('startServer — corpus sweep on boot', () => {
  it('indexes the archive before the socket binds, so the FIRST request sees it', async () => {
    // The successor to the plan-001 boot catch-up test, and the same claim: the
    // pass runs in the before-bind slot, so no client can observe an empty index
    // that is about to fill.
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
    seedArchive(dataDir);
    // A long period, not a short one: the FIRST tick is synchronous and runs
    // before `bind()`, so the assertion is about that pass and never about a
    // timer firing in time.
    server = await bootTestServer({ dataDir, sweepIntervalMs: 60_000 });

    expect(await listedIds(server)).toEqual([SESSION]);
  });

  it('reports what the sweep walked on /api/health', async () => {
    // `files_indexed` lives only in the sweep's in-memory report, so a non-null
    // number here is the proof that `ApiDeps.sweep` is actually wired — it reads
    // null when it is not.
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
    seedArchive(dataDir);
    server = await bootTestServer({ dataDir, sweepIntervalMs: 60_000 });

    const health = (await (
      await fetch(server.url('/api/health'), { headers: { [TOKEN_HEADER]: server.token } })
    ).json()) as { files_indexed: number | null };
    expect(health.files_indexed).toBe(1);
  });

  it('sweepIntervalMs: 0 performs no pass at all', async () => {
    // An off switch that still runs one full walk is not an off switch. Zero
    // SESSION ROWS is the assertion — an absent timer would not prove it.
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
    seedArchive(dataDir);
    server = await bootTestServer({ dataDir, sweepIntervalMs: 0 });

    expect(countRows(dataDir, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });

  it('walks the archive under its own data dir and nothing else', async () => {
    // A transcript elsewhere on the machine is structurally unreachable: the
    // sweep is anchored on `resolveArchiveRoot(dataDir)`, never on a path a row
    // supplies. Pinned rather than left to a code reading — the plan-001 tailer
    // took its paths off session rows and needed a confinement check for it.
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
    const outside = mkdtempSync(join(tmpdir(), 'agent-lens-outside-'));
    writeFileSync(join(outside, 'stray.jsonl'), `${JSON.stringify(transcriptLine(0))}\n`);

    try {
      server = await bootTestServer({ dataDir, sweepIntervalMs: 60_000 });
      expect(countRows(dataDir, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    } finally {
      cleanupDir(outside);
    }
  });
});

describe('startServer — sweep timer lifecycle', () => {
  it('stops the interval before closing the database', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
    seedArchive(dataDir);
    const booted = await bootTestServer({ dataDir, sweepIntervalMs: 5 });

    const uncaught: unknown[] = [];
    const spy = (err: unknown): number => uncaught.push(err);
    process.on('uncaughtException', spy);

    try {
      await booted.handle.close();
      // Ten interval periods with the handle closed. Without `sweep.close()` a
      // tick lands on a closed database and throws where no caller can catch it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', spy);
      cleanupDir(dataDir);
      cleanupDir(booted.uiDir);
      cleanupDir(booted.transcriptRoot);
    }
  });
});

describe('startServer — boot hermeticity', () => {
  it('defaults to a fresh empty transcript root, never the real ~/.claude/projects', async () => {
    server = await bootTestServer({ sweepIntervalMs: 60_000 });

    // The default root is a throwaway temp dir, so no local session history can
    // change what this (or any other) server test means.
    expect(server.transcriptRoot.startsWith(tmpdir())).toBe(true);
    expect(server.transcriptRoot.includes(join(homedir(), '.claude'))).toBe(false);
    expect(readdirSync(server.transcriptRoot)).toEqual([]);
    expect(countRows(server.dataDir, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });
});

/**
 * Task 0.4 / AC2b — the bounded-exit guard, and after the cutover it is the ONLY
 * thing standing between `agent-lens start` and a shutdown that hangs forever.
 *
 * `/api/stream` parks its client on the hub and holds the response body open,
 * and `server.close()` waits on every open connection. Plan 001 drained through
 * `broadcaster.shutdown()`; task 4.5 deleted that, and `closeAllConnections()`
 * stood in until Task 6.1 built the real registry. It is `hub.drain()` that ends
 * this body now — `closeAllConnections()` remains behind it, for the non-stream
 * requests the hub cannot see.
 *
 * Every other stream test cancels the client BEFORE the server closes. The
 * production sequence is the inverse — the server goes down with a browser tab
 * still attached — which is exactly the case that once hung.
 */
describe('startServer — closing with an /api/stream client attached (AC2b)', () => {
  it('ends the attached body immediately and never waits on it forever', async () => {
    const booted = await bootTestServer({ sweepIntervalMs: 0 });
    const res = await fetch(booted.url('/api/stream'), {
      headers: { [TOKEN_HEADER]: booted.token },
    });
    expect(res.status).toBe(200);
    // Deliberately NOT cancelled before the close.
    const reader = res.body!.getReader();

    try {
      // Drain in the background so the body's END can be timestamped: that
      // instant, not the `close()` callback, is the direct evidence that the
      // connection was dropped rather than waited on. A killed connection surfaces
      // as a rejected read, not as `done`, so both endings land here.
      let endedAt = 0;
      const drained = (async () => {
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // A drained body ends as `done`; if `closeAllConnections` gets there
          // first the socket dies mid-body and the read rejects. Both are
          // endings, and this test asserts only that one of them arrives.
        }
        endedAt = Date.now();
      })();

      const started = Date.now();
      const closing = booted.handle.close();

      await drained;
      // The tight assertion, and the one that inverts cleanly: with no drain at
      // all this body never ends and `close()` never resolves.
      expect(endedAt - started).toBeLessThan(3000);

      await closing;
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await reader.cancel().catch(() => undefined);
      cleanupDir(booted.dataDir);
      cleanupDir(booted.transcriptRoot);
      cleanupDir(booted.uiDir);
    }
  }, 30_000);
});
