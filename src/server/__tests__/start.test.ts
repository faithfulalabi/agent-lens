// AC3 test 14: the inactivity sweep is injectable AND provably torn down. A
// surviving interval that fires after `db.close()` throws inside a timer
// callback, where nothing can catch it — so `clearInterval` must precede the
// close, and this test proves it rather than trusting `.unref()`.

import { afterEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SweepResult } from '../../capture/inactivity.js';
import type { TailResult } from '../../capture/tailer.js';
import { openDb, upsertSession } from '../../db/index.js';
import {
  bootTestServer,
  cleanupDir,
  openTestDb,
  TOKEN_HEADER,
  type TestServer,
} from './helpers.js';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    cleanupDir(server.dataDir);
    server = undefined;
  }
});

/** Resolve once `predicate` holds, or reject after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe('startServer — inactivity sweep lifecycle', () => {
  it('runs the sweep on an interval and stops it before closing the DB', async () => {
    const results: SweepResult[] = [];
    const booted = await bootTestServer({
      sweepIntervalMs: 5,
      onSweep: (r) => results.push(r),
    });

    await waitFor(() => results.length >= 1);
    const uncaught: unknown[] = [];
    const spy = (err: unknown): number => uncaught.push(err);
    process.on('uncaughtException', spy);

    try {
      await booted.handle.close();
      const countAtClose = results.length;
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The interval is gone: no sweep ran after close, and nothing blew up
      // trying to query a closed database from a timer callback.
      expect(results.length).toBe(countAtClose);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', spy);
      cleanupDir(booted.dataDir);
    }
  });

  it('sweepIntervalMs: 0 disables the sweep entirely', async () => {
    let swept = 0;
    server = await bootTestServer({ sweepIntervalMs: 0, onSweep: () => (swept += 1) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(swept).toBe(0);
  });
});

// --- Task 3.1: transcript tailer wiring ------------------------------------

const SLUG = '-Users-dev-proj';

/** Write a transcript inside a root, creating its project slug directory. */
function writeTranscript(
  root: string,
  session: string,
  lines: readonly string[],
  slug = SLUG,
): string {
  mkdirSync(join(root, slug), { recursive: true });
  const path = join(root, slug, `${session}.jsonl`);
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

function transcriptLine(i: number): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${i}`,
    sessionId: 'sess-boot',
    timestamp: new Date(Date.UTC(2026, 6, 26, 0, 0, i)).toISOString(),
    cwd: '/Users/dev/proj',
  });
}

/** Tell a data dir's DB about a session before the server ever opens it. */
function seedSession(dataDir: string, sessionId: string, transcriptPath: string): void {
  const db = openDb(dataDir);
  try {
    upsertSession(db, {
      id: sessionId,
      harness: 'claude-code',
      project_path: '/Users/dev/proj',
      started_at: '2026-07-26T00:00:00.000Z',
      status: 'live',
      capture_mode: 'full',
      transcript_path: transcriptPath,
    });
  } finally {
    db.close();
  }
}

function countRows(dataDir: string, sql: string): number {
  const db = openTestDb(dataDir);
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

describe('startServer — transcript catch-up on boot', () => {
  it('ingests a transcript that grew entirely while the server was down', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
    const root = mkdtempSync(join(tmpdir(), 'agent-lens-transcripts-'));
    const path = writeTranscript(root, 'sess-boot', [transcriptLine(0)]);
    seedSession(dataDir, 'sess-boot', path);

    try {
      // Boot once so the file has a committed offset, then shut down.
      const first = await bootTestServer({ dataDir, transcriptRoot: root, tailIntervalMs: 60_000 });
      await first.close();
      const afterFirst = countRows(
        dataDir,
        `SELECT COUNT(*) AS n FROM raw_events WHERE source = 'transcript'`,
      );

      // The session writes four more lines while nothing is listening.
      appendFileSync(
        path,
        [1, 2, 3, 4].map((i) => `${transcriptLine(i)}\n`).join(''),
      );

      const second = await bootTestServer({
        dataDir,
        transcriptRoot: root,
        tailIntervalMs: 60_000,
      });
      server = second;
      // The catch-up runs in the same before-bind slot as spool replay, so the
      // VERY FIRST request already sees the recovered lines.
      const response = await fetch(second.url('/api/events'), {
        headers: { [TOKEN_HEADER]: second.token },
      });
      const events = (await response.json()) as { source: string }[];
      expect(events.filter((e) => e.source === 'transcript')).toHaveLength(afterFirst + 4);
    } finally {
      cleanupDir(dataDir);
      cleanupDir(root);
    }
  });
});

describe('startServer — boot hermeticity', () => {
  it('defaults to a fresh empty transcript root, never the real ~/.claude/projects', async () => {
    server = await bootTestServer({ tailIntervalMs: 60_000 });

    // The default root is a throwaway temp dir, so no local session history can
    // change what this (or any other) server test means.
    expect(server.transcriptRoot.startsWith(tmpdir())).toBe(true);
    expect(server.transcriptRoot.includes(join(homedir(), '.claude'))).toBe(false);
    expect(readdirSync(server.transcriptRoot)).toEqual([]);
    expect(countRows(server.dataDir, 'SELECT COUNT(*) AS n FROM tailer_offsets')).toBe(0);
    expect(
      countRows(
        server.dataDir,
        `SELECT COUNT(*) AS n FROM raw_events WHERE source = 'transcript'`,
      ),
    ).toBe(0);
  });

  it('first-sights an unknown-session transcript instead of ingesting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-lens-transcripts-'));
    const lines = Array.from({ length: 500 }, (_, i) => transcriptLine(i));
    const path = writeTranscript(root, 'sess-stranger', lines);
    const passes: TailResult[] = [];

    try {
      server = await bootTestServer({
        transcriptRoot: root,
        tailIntervalMs: 60_000,
        onTail: (r) => passes.push(r),
      });
      expect(passes[0]!.files).toHaveLength(1);
      expect(passes[0]!.files[0]).toMatchObject({ reset: 'first-sight', ingested: 0 });
      expect(
        countRows(
          server.dataDir,
          `SELECT COUNT(*) AS n FROM raw_events WHERE source = 'transcript'`,
        ),
      ).toBe(0);
      const offset = openTestDb(server.dataDir);
      try {
        const row = offset.prepare('SELECT * FROM tailer_offsets').get() as {
          committed_offset: number;
        };
        expect(Number(row.committed_offset)).toBe(statSync(path).size);
      } finally {
        offset.close();
      }
    } finally {
      cleanupDir(root);
    }
  });

  // Task 0.2 — the inversion of the test above. Goes RED if `firstSight` /
  // `projects` are threaded by restructuring the `tailOnce(...)` call in
  // `runTailPass` instead of by adding to the already-bound options object:
  // `options.onTail?.(tailOnce(...))` short-circuits its own argument, so the
  // tailer would only run for tests that observe it.
  it('forwards firstSight: backfill and projects into the boot catch-up pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-lens-transcripts-'));
    const lines = Array.from({ length: 12 }, (_, i) => transcriptLine(i));
    const path = writeTranscript(root, 'sess-stranger', lines);
    const other = writeTranscript(root, 'sess-elsewhere', lines, '-Users-dev-other');
    const passes: TailResult[] = [];

    try {
      server = await bootTestServer({
        transcriptRoot: root,
        firstSight: 'backfill',
        projects: [SLUG],
        tailIntervalMs: 60_000,
        onTail: (r) => passes.push(r),
      });
      // Backfilled, not first-sighted: read from zero on a file no session named.
      expect(passes[0]!.files).toHaveLength(1);
      expect(passes[0]!.files[0]).toMatchObject({
        reset: 'none',
        bytesRead: statSync(path).size,
      });
      expect(passes[0]!.ingested).toBe(lines.length);
      // …and the slug filter kept the other project out entirely.
      expect(passes[0]!.files[0]!.path).not.toBe(other);
      expect(countRows(server.dataDir, 'SELECT COUNT(*) AS n FROM tailer_offsets')).toBe(1);
    } finally {
      cleanupDir(root);
    }
  });

  it('reads a KNOWN session transcript from zero', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
    const root = mkdtempSync(join(tmpdir(), 'agent-lens-transcripts-'));
    const path = writeTranscript(root, 'sess-boot', [transcriptLine(0), transcriptLine(1)]);
    seedSession(dataDir, 'sess-boot', path);

    try {
      server = await bootTestServer({ dataDir, transcriptRoot: root, tailIntervalMs: 60_000 });
      expect(
        countRows(
          dataDir,
          `SELECT COUNT(*) AS n FROM raw_events WHERE source = 'transcript'`,
        ),
      ).toBe(2);
    } finally {
      cleanupDir(root);
    }
  });

  it('tailIntervalMs: 0 performs no boot catch-up at all', async () => {
    // An off switch that still runs one full scan is not an off switch. Zero
    // OFFSET ROWS is the assertion — an absent timer would not prove it.
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
    const root = mkdtempSync(join(tmpdir(), 'agent-lens-transcripts-'));
    const path = writeTranscript(root, 'sess-boot', [transcriptLine(0)]);
    seedSession(dataDir, 'sess-boot', path);

    try {
      server = await bootTestServer({ dataDir, transcriptRoot: root, tailIntervalMs: 0 });
      expect(countRows(dataDir, 'SELECT COUNT(*) AS n FROM tailer_offsets')).toBe(0);
    } finally {
      cleanupDir(root);
    }
  });

  it('never tails a session transcript that lives outside the root', async () => {
    // Existing suites seed real-looking paths (`src/db/seed.ts` writes
    // `/tmp/agent-lens/transcripts/<id>.jsonl`). If such a path happens to exist
    // on the machine, an unbounded tailer would read it into a test DB — a
    // machine-dependent failure this pins shut.
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
    const root = mkdtempSync(join(tmpdir(), 'agent-lens-transcripts-'));
    const outside = mkdtempSync(join(tmpdir(), 'agent-lens-outside-'));
    const stray = join(outside, 'stray.jsonl');
    writeFileSync(stray, `${transcriptLine(0)}\n${transcriptLine(1)}\n`);
    seedSession(dataDir, 'sess-boot', stray);

    try {
      server = await bootTestServer({ dataDir, transcriptRoot: root, tailIntervalMs: 60_000 });
      expect(countRows(dataDir, 'SELECT COUNT(*) AS n FROM tailer_offsets')).toBe(0);
      expect(
        countRows(
          dataDir,
          `SELECT COUNT(*) AS n FROM raw_events WHERE source = 'transcript'`,
        ),
      ).toBe(0);
    } finally {
      cleanupDir(root);
      cleanupDir(outside);
    }
  });
});

describe('startServer — tail timer lifecycle', () => {
  it('runs the tail on an interval and stops it before closing the DB', async () => {
    const passes: TailResult[] = [];
    const booted = await bootTestServer({ tailIntervalMs: 5, onTail: (r) => passes.push(r) });

    await waitFor(() => passes.length >= 2);
    const uncaught: unknown[] = [];
    const spy = (err: unknown): number => uncaught.push(err);
    process.on('uncaughtException', spy);

    try {
      await booted.handle.close();
      const countAtClose = passes.length;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(passes.length).toBe(countAtClose);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', spy);
      cleanupDir(booted.dataDir);
      cleanupDir(booted.transcriptRoot);
      cleanupDir(booted.uiDir);
    }
  });

  it('tailIntervalMs: 0 disables the tail timer entirely', async () => {
    let tailed = 0;
    server = await bootTestServer({ tailIntervalMs: 0, onTail: () => (tailed += 1) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tailed).toBe(0);
  });
});
