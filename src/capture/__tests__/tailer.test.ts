// Task 3.1 — the tailer's ACs, plus a regression test for every design fix the
// approach review forced. Each of those is labelled with what it goes RED on.
//
// Fixtures are SYNTHESIZED in temp dirs. Nothing here reads the developer's real
// `~/.claude/projects` — a test whose meaning depends on local session history is
// not a test. Line shapes and the uuid-less / duplicate ratios are modelled on a
// measured 4197-line corpus: 32.7% of lines carry no `uuid`, 16.6% are
// byte-identical uuid-less duplicates of an earlier line in the same file.

import { afterEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ingestHealth,
  openDb,
  readTailerOffset,
  upsertSession,
} from '../../db/index.js';
import type { TailerOffset } from '../../shared/index.js';
import { Broadcaster } from '../../server/sse.js';
import { ingestBatch } from '../../server/ingest.js';
import { sweepInactive } from '../inactivity.js';
import {
  canonicalizeTranscriptPath,
  tailOnce,
  type TailFileResult,
  type TailOptions,
  type TailResult,
} from '../tailer.js';
import { at, freshDb, hookEnvelope, TS } from './fixtures.js';
import { projectionSnapshot } from './golden.js';

const SESSION = 'sess-uuid-1';
const SLUG = '-Users-dev-proj';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// --- Fixture plumbing ------------------------------------------------------

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-lens-tail-'));
  dirs.push(root);
  return root;
}

/** Path of a transcript inside a root, creating its project slug directory. */
function transcriptPath(root: string, session = SESSION): string {
  mkdirSync(join(root, SLUG), { recursive: true });
  return join(root, SLUG, `${session}.jsonl`);
}

/** Tell the DB about a session and where its transcript lives (discovery source 1). */
function registerSession(db: DatabaseSync, path: string, session = SESSION): void {
  upsertSession(db, {
    id: session,
    harness: 'claude-code',
    project_path: '/Users/dev/proj',
    started_at: TS,
    status: 'live',
    capture_mode: 'full',
    transcript_path: path,
  });
}

function tail(db: DatabaseSync, root: string, options: TailOptions = {}): TailResult {
  return tailOnce(db, new Broadcaster(), { transcriptRoot: root, ...options });
}

/** The single file result of a pass, asserted unique. */
function onlyFile(result: TailResult): TailFileResult {
  expect(result.files).toHaveLength(1);
  return result.files[0]!;
}

/** A line carrying a uuid — the 67.3% majority. */
function line(i: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${i}`,
    sessionId: SESSION,
    timestamp: at(i),
    ...extra,
  });
}

/** A uuid-less control line — the measured 32.7%. */
function uuidless(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, sessionId: SESSION, ...extra });
}

/**
 * A JSONL line of EXACTLY `bytes` bytes including its newline — the head-window
 * tests are about byte arithmetic, so their fixtures have to be byte-exact.
 */
function paddedLine(bytes: number, index: number): string {
  const skeleton = JSON.stringify({
    type: 'x',
    uuid: `p-${index}`,
    sessionId: SESSION,
    pad: '',
  });
  const fill = bytes - 1 - Buffer.byteLength(skeleton);
  expect(fill).toBeGreaterThanOrEqual(0);
  return skeleton.replace('"pad":""', `"pad":"${'z'.repeat(fill)}"`);
}

function writeLines(path: string, lines: readonly string[]): void {
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
}

function appendLines(path: string, lines: readonly string[]): void {
  appendFileSync(path, lines.map((l) => `${l}\n`).join(''));
}

function sizeOf(path: string): number {
  return statSync(path).size;
}

/** The offset row for a path, looked up the way the tailer keys it. */
function offsetFor(db: DatabaseSync, path: string): TailerOffset | undefined {
  return readTailerOffset(db, canonicalizeTranscriptPath(path));
}

function archiveIds(db: DatabaseSync): string[] {
  return (db.prepare('SELECT id FROM raw_events ORDER BY id').all() as { id: string }[]).map(
    (row) => row.id,
  );
}

function offsetRows(db: DatabaseSync): TailerOffset[] {
  return db
    .prepare('SELECT * FROM tailer_offsets ORDER BY transcript_path')
    .all() as unknown as TailerOffset[];
}

/** Replace a file with identical content at a NEW inode — a real rotation. */
function rotate(path: string, lines: readonly string[]): void {
  const before = statSync(path).ino;
  const staging = `${path}.rotated`;
  writeLines(staging, lines);
  renameSync(staging, path);
  // Guard the fixture itself: a rotation that kept the inode proves nothing.
  expect(statSync(path).ino).not.toBe(before);
}

// --- AC1: offsets and resume ----------------------------------------------

describe('tailOnce — AC1: reads from the committed offset', () => {
  it('ingests appended lines only, and commits the offset at EOF', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    writeLines(path, [line(1), line(2), line(3)]);

    const first = tail(db, root);
    expect(onlyFile(first)).toMatchObject({ linesRead: 3, ingested: 3, reset: 'none' });
    expect(archiveIds(db)).toHaveLength(3);
    expect(offsetFor(db, path)?.committed_offset).toBe(sizeOf(path));

    const before = sizeOf(path);
    appendLines(path, [line(4), line(5)]);
    const second = tail(db, root);
    expect(onlyFile(second)).toMatchObject({
      linesRead: 2,
      ingested: 2,
      reset: 'none',
      bytesRead: sizeOf(path) - before,
    });
    expect(archiveIds(db)).toHaveLength(5);

    // A third pass with nothing new reads nothing at all.
    expect(onlyFile(tail(db, root)).bytesRead).toBe(0);
    expect(archiveIds(db)).toHaveLength(5);
  });

  it('resumes exactly across a database restart', () => {
    const dataDir = makeRoot();
    const root = makeRoot();
    const path = transcriptPath(root);
    writeLines(path, [line(1), line(2)]);

    const db = openDb(dataDir);
    registerSession(db, path);
    tail(db, root);
    const idsBefore = archiveIds(db);
    db.close();

    appendLines(path, [line(3), line(4)]);
    const reopened = openDb(dataDir);
    try {
      const result = tail(reopened, root);
      expect(onlyFile(result).linesRead).toBe(2);
      const ids = archiveIds(reopened);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(4);
      expect(ids).toEqual(expect.arrayContaining(idsBefore));
    } finally {
      reopened.close();
    }
  });

  it('commits the offset transactionally with the batch: neither or both', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    writeLines(path, [line(1), line(2), line(3)]);

    // Make the offset write fail from inside `beforeCommit`, which is the only
    // way to observe the atomicity claim end to end.
    db.exec(
      `CREATE TRIGGER block_offsets BEFORE INSERT ON tailer_offsets
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    const blocked = tail(db, root);
    // Never throws — ingest never throws — but nothing landed either.
    expect(blocked.deadLettered).toBe(3);
    expect(archiveIds(db)).toHaveLength(0);
    expect(offsetRows(db)).toHaveLength(0);

    db.exec('DROP TRIGGER block_offsets');
    tail(db, root);
    expect(archiveIds(db)).toHaveLength(3);
    expect(offsetFor(db, path)?.committed_offset).toBe(sizeOf(path));
  });

  it('never ingests a partial trailing line, and picks it up once completed', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    writeFileSync(path, `${line(1)}\n${line(2)}`); // no trailing newline

    const first = tail(db, root);
    expect(onlyFile(first).linesRead).toBe(1);
    expect(offsetFor(db, path)?.committed_offset).toBe(
      Buffer.byteLength(`${line(1)}\n`),
    );

    appendFileSync(path, '\n');
    const second = tail(db, root);
    expect(onlyFile(second).linesRead).toBe(1);
    expect(archiveIds(db)).toHaveLength(2);
    expect(offsetFor(db, path)?.committed_offset).toBe(sizeOf(path));
  });

  it('tracks offsets in BYTES, not characters (multibyte safety)', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    const lines = [
      line(1, { text: '🎉 shipped — ünïcödé' }),
      line(2, { text: '日本語のテキストです' }),
    ];
    writeLines(path, lines);

    tail(db, root);
    const committed = offsetFor(db, path)!.committed_offset;
    expect(committed).toBe(sizeOf(path));
    // The byte size genuinely exceeds the character count, so a `string.length`
    // implementation would desync here rather than coincidentally agreeing.
    expect(committed).toBeGreaterThan(lines.join('\n').length);

    appendLines(path, [line(3, { text: '🚀' })]);
    const second = tail(db, root);
    expect(onlyFile(second).linesRead).toBe(1);
    const payload = db
      .prepare(`SELECT raw FROM raw_events WHERE id = ?`)
      .get('sess-uuid-1:transcript:u-3') as { raw: string };
    expect(JSON.parse(payload.raw).raw_payload.text).toBe('🚀');
  });

  it('dead-letters an oversize line and keeps tailing past it', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    const huge = line(2, { text: 'x'.repeat(400) });
    writeLines(path, [line(1), huge, line(3)]);

    const result = tail(db, root, { maxLineBytes: 128 });
    expect(onlyFile(result)).toMatchObject({ linesRead: 3, ingested: 2, deadLettered: 1 });
    expect(offsetFor(db, path)?.committed_offset).toBe(sizeOf(path));
    expect(ingestHealth(db).dead_letter).toBe(1);
    const marker = db
      .prepare(`SELECT raw FROM raw_events WHERE status = 'dead_letter'`)
      .get() as { raw: string };
    expect(JSON.parse(marker.raw).raw_payload).toMatch(/exceeds the line limit/);
  });

  it('extends past the per-pass window for a line longer than it', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    const long = line(1, { text: 'y'.repeat(500) });
    writeLines(path, [long, line(2)]);

    // A 64-byte window cannot hold the first line, so the tailer must scan
    // forward for its newline rather than stalling forever.
    const result = tail(db, root, { maxBytesPerFilePerPass: 64 });
    expect(onlyFile(result).linesRead).toBe(1);
    expect(archiveIds(db)).toContain('sess-uuid-1:transcript:u-1');

    const second = tail(db, root, { maxBytesPerFilePerPass: 64 });
    expect(onlyFile(second).linesRead).toBe(1);
    expect(offsetFor(db, path)?.committed_offset).toBe(sizeOf(path));
  });
});

// --- AC2: fingerprint resets converge, never duplicate ---------------------

describe('tailOnce — AC2: resets re-read and converge', () => {
  it('detects truncation and converges on the pre-truncation archive', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    writeLines(path, [line(1), line(2), line(3), line(4)]);
    tail(db, root);
    const before = projectionSnapshot(db);

    truncateSync(path, Buffer.byteLength(`${line(1)}\n${line(2)}\n`));
    const result = tail(db, root);
    expect(onlyFile(result).reset).toBe('truncation');
    expect(onlyFile(result).bytesRead).toBe(sizeOf(path));
    // Surviving lines dedupe; the removed ones stay archived. Nothing doubles.
    expect(projectionSnapshot(db)).toBe(before);
  });

  it('detects rotation and converges — the path-keyed-identity regression', () => {
    // Goes RED under a `${dev}:${ino}` event-id identity: rotation changes the
    // inode by definition, so every uuid-less line re-keys and the archive GROWS
    // instead of converging. Row counts are the assertion that catches it.
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    const lines = [
      line(1),
      uuidless('mode', { mode: 'acceptEdits' }),
      line(2),
      uuidless('permission-mode', { mode: 'plan' }),
      uuidless('ai-title', { title: 'ship the tailer' }),
      line(3),
    ];
    writeLines(path, lines);
    tail(db, root);
    const before = projectionSnapshot(db);
    expect(archiveIds(db)).toHaveLength(6);

    rotate(path, lines);
    const result = tail(db, root);
    expect(onlyFile(result).reset).toBe('rotation');
    expect(onlyFile(result).bytesRead).toBe(sizeOf(path));
    expect(archiveIds(db)).toHaveLength(6);
    expect(projectionSnapshot(db)).toBe(before);
  });

  it('detects a same-size in-place rewrite via the head hash', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    // A uuid-LESS head line, so the rewrite genuinely re-keys it: a uuid line
    // would dedupe on its uuid and hide whether the re-read happened at all.
    writeLines(path, [uuidless('mode', { mode: 'aaaa' }), line(2), line(3)]);
    tail(db, root);
    const sizeBefore = sizeOf(path);

    // Same byte length, mutated head — the case only the head hash can see.
    writeLines(path, [uuidless('mode', { mode: 'bbbb' }), line(2), line(3)]);
    expect(sizeOf(path)).toBe(sizeBefore);

    const result = tail(db, root);
    expect(onlyFile(result).reset).toBe('rewrite');
    expect(onlyFile(result).bytesRead).toBe(sizeOf(path));
    // The changed line is a genuinely new event; the untouched ones dedupe.
    expect(archiveIds(db)).toHaveLength(4);

    const converged = projectionSnapshot(db);
    expect(onlyFile(tail(db, root)).bytesRead).toBe(0);
    expect(projectionSnapshot(db)).toBe(converged);
  });

  it('does not mistake a small append for a rewrite (fixed head window)', () => {
    // Goes RED under a `min(size, 1024)` head window: the hashed region shrinks
    // and grows with the file, so every append below 1 KB looks like a rewrite
    // and the whole file is re-read on every tick. Archive dedupe hides that in
    // row counts — only these counters can see it.
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);

    writeLines(path, [paddedLine(200, 1)]);
    expect(sizeOf(path)).toBe(200);
    tail(db, root);

    appendLines(path, [paddedLine(150, 2)]);
    const second = tail(db, root);
    expect(onlyFile(second)).toMatchObject({ reset: 'none', bytesRead: 150 });

    // Same again across the 1 KB boundary: 900 -> 1100 bytes.
    const wide = transcriptPath(root, 'sess-uuid-2');
    registerSession(db, wide, 'sess-uuid-2');
    writeLines(wide, [paddedLine(900, 3)]);
    tail(db, root);
    appendLines(wide, [paddedLine(200, 4)]);
    const crossed = tail(db, root).files.find((f) => f.path.includes('sess-uuid-2'))!;
    expect(crossed).toMatchObject({ reset: 'none', bytesRead: 200 });
  });

  it('keeps byte-identical uuid-less lines as distinct events', () => {
    // Goes RED under a `file_identity + line` hash with no offset: the two
    // `last-prompt` lines collide, the archive holds 2 rows instead of 4, and a
    // user prompt is lost permanently — `raw_events` is its only record.
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    const prompt = uuidless('last-prompt', { prompt: 'ship it' });
    const mode = uuidless('mode', { mode: 'acceptEdits' });
    writeLines(path, [prompt, mode, prompt, mode]);

    tail(db, root);
    expect(archiveIds(db)).toHaveLength(4);

    // Truncate to the first three lines: the survivors keep their offsets, so a
    // full re-read dedupes them rather than minting new ids.
    truncateSync(path, Buffer.byteLength(`${prompt}\n${mode}\n${prompt}\n`));
    const result = tail(db, root);
    expect(onlyFile(result).reset).toBe('truncation');
    expect(archiveIds(db)).toHaveLength(4);
  });

  it('re-reads through ingestBatch, so re-projection cannot happen', () => {
    // The Task 2.6a constraint, as an executable assertion. A direct
    // `normalize()` loop over re-read lines would re-run `reviveSession` for
    // every already-ingested line and resurrect a session the sweep correctly
    // marked `interrupted`. Through `ingestBatch` the archive dedupe returns
    // before `normalize` ever runs, so a rotation re-read is inert.
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    const broadcaster = new Broadcaster();
    ingestBatch(db, broadcaster, [
      { envelope: hookEnvelope('SessionStart', { cwd: '/proj' }, { session_id: SESSION }) },
      {
        envelope: hookEnvelope('UserPromptSubmit', { prompt: 'one' }, {
          prompt_id: 'p1',
          session_id: SESSION,
        }),
      },
      {
        envelope: hookEnvelope('UserPromptSubmit', { prompt: 'two' }, {
          prompt_id: 'p2',
          session_id: SESSION,
        }),
      },
    ]);
    registerSession(db, path);

    const lines = [line(1), uuidless('mode', { mode: 'plan' }), line(2)];
    writeLines(path, lines);
    tail(db, root);

    // Two turns are live; the sweep then interrupts the silent session.
    sweepInactive(db, { now: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    const afterSweep = projectionSnapshot(db);
    expect(
      (db.prepare('SELECT status FROM sessions WHERE id = ?').get(SESSION) as {
        status: string;
      }).status,
    ).toBe('interrupted');

    rotate(path, lines);
    const result = tail(db, root);
    expect(onlyFile(result).reset).toBe('rotation');
    expect(projectionSnapshot(db)).toBe(afterSweep);
  });
});

// --- AC3: defensive parsing -----------------------------------------------

describe('tailOnce — AC3: bad lines never stop the tail', () => {
  it('dead-letters malformed lines and keeps processing the good ones', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    writeLines(path, [line(1), '{"type":', line(2), '[]', line(3)]);

    const result = tail(db, root);
    expect(onlyFile(result)).toMatchObject({ linesRead: 5, ingested: 3, deadLettered: 2 });
    expect(ingestHealth(db)).toMatchObject({ processed: 3, dead_letter: 2 });
    expect(offsetFor(db, path)?.committed_offset).toBe(sizeOf(path));
  });

  it('advances the offset for a region that yields ZERO envelopes', () => {
    // Goes RED with `replayFile`'s `if (batch.length === 0) return` flush guard:
    // a blank-line region never reaches `ingestBatch`, its offset never commits,
    // and the tailer re-reads that region every tick forever.
    const db = freshDb();
    const root = makeRoot();
    const blank = transcriptPath(root, 'sess-blank');
    registerSession(db, blank, 'sess-blank');
    writeFileSync(blank, '\n   \n\t\n\n');

    const first = tail(db, root).files.find((f) => f.path.includes('sess-blank'))!;
    expect(first.linesRead).toBe(0);
    expect(first.bytesRead).toBe(sizeOf(blank));
    expect(offsetFor(db, blank)?.committed_offset).toBe(sizeOf(blank));

    const second = tail(db, root).files.find((f) => f.path.includes('sess-blank'))!;
    expect(second.bytesRead).toBe(0);

    // Same rule mid-file: blanks between real lines are consumed, not ingested.
    const mixed = transcriptPath(root, 'sess-mixed');
    registerSession(db, mixed, 'sess-mixed');
    writeFileSync(mixed, `${line(1)}\n\n   \n${line(2)}\n`);
    const mixedResult = tail(db, root).files.find((f) => f.path.includes('sess-mixed'))!;
    expect(mixedResult.linesRead).toBe(2);
    expect(offsetFor(db, mixed)?.committed_offset).toBe(sizeOf(mixed));
  });

  it('ingests unknown-but-valid shapes verbatim', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    const snapshot = JSON.stringify({
      type: 'file-history-snapshot',
      messageId: 'msg-1',
      snapshot: { trackedFileBackups: {} },
    });
    writeLines(path, [
      uuidless('mode', { mode: 'acceptEdits' }),
      uuidless('ai-title', { title: 'tailer core' }),
      snapshot,
    ]);

    const result = tail(db, root);
    expect(onlyFile(result)).toMatchObject({ linesRead: 3, ingested: 3, deadLettered: 0 });
    expect(ingestHealth(db)).toMatchObject({ processed: 3, degraded: 0, dead_letter: 0 });

    const rows = db
      .prepare(`SELECT session_id, raw FROM raw_events`)
      .all() as { session_id: string; raw: string }[];
    // The sessionId-less line falls back to the filename stem.
    const fromFile = rows.find(
      (r) => (JSON.parse(r.raw).raw_payload as { type: string }).type === 'file-history-snapshot',
    )!;
    expect(fromFile.session_id).toBe(SESSION);
    expect(JSON.parse(fromFile.raw).raw_payload).toEqual(JSON.parse(snapshot));
  });

  it('preserves the tool-output pointer without opening the sidecar', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    const sidecar = join(root, SLUG, SESSION, 'tool-results', 'toolu_1.txt');
    mkdirSync(join(root, SLUG, SESSION, 'tool-results'), { recursive: true });
    writeFileSync(sidecar, 'THE-FULL-OUTPUT-BYTES');
    const marker = `<persisted-output>preview\nFull output saved to: ${sidecar}</persisted-output>`;
    writeLines(path, [line(1, { content: marker })]);

    tail(db, root);
    const row = db.prepare(`SELECT raw FROM raw_events`).get() as { raw: string };
    const payload = JSON.parse(row.raw).raw_payload as { content: string };
    expect(payload.content).toBe(marker);
    // The sidecar bytes are NOT pulled in; resolving the pointer is a separate task.
    expect(row.raw).not.toContain('THE-FULL-OUTPUT-BYTES');
  });
});

// --- AC4: discovery scope --------------------------------------------------

describe('tailOnce — AC4: discovery', () => {
  it('tails a path known only from sessions.transcript_path', () => {
    const db = freshDb();
    const root = makeRoot();
    // Deliberately NOT under a slug dir the scan would find: sessions-derived
    // discovery has to stand on its own.
    const path = join(root, 'loose.jsonl');
    writeLines(path, [line(1), line(2)]);
    registerSession(db, path);

    const result = tail(db, root);
    expect(onlyFile(result).linesRead).toBe(2);
  });

  it('first-sights a path found only on disk, recording EOF without ingesting', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root, 'sess-unknown');
    writeLines(path, Array.from({ length: 20 }, (_, i) => line(i)));

    const result = tail(db, root);
    expect(onlyFile(result)).toMatchObject({
      reset: 'first-sight',
      linesRead: 0,
      ingested: 0,
    });
    expect(archiveIds(db)).toHaveLength(0);
    expect(offsetFor(db, path)?.committed_offset).toBe(sizeOf(path));

    // Growth from first sight forward IS captured — the backstop's real job.
    appendLines(path, [line(99)]);
    const second = tail(db, root);
    expect(onlyFile(second)).toMatchObject({ reset: 'none', linesRead: 1 });
  });

  it('tails a doubly-discovered file exactly once', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    registerSession(db, path);
    writeLines(path, [line(1), line(2)]);

    const result = tail(db, root);
    expect(result.files).toHaveLength(1);
    expect(offsetRows(db)).toHaveLength(1);
    expect(archiveIds(db)).toHaveLength(2);
  });

  // The inversion of the first-sight test above, which stays untouched as the
  // proof that the default is preserved.
  it('backfills a never-before-seen file from zero under firstSight: backfill', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root, 'sess-unknown');
    writeLines(path, Array.from({ length: 20 }, (_, i) => line(i)));

    const result = tail(db, root, { firstSight: 'backfill' });
    // `reset: 'none'` — nothing was RE-read, and `'first-sight'` keeps meaning
    // exactly "recorded EOF, ingested nothing".
    expect(onlyFile(result)).toMatchObject({
      reset: 'none',
      bytesRead: sizeOf(path),
      linesRead: 20,
      ingested: 20,
    });
    expect(archiveIds(db)).toHaveLength(20);
    expect(offsetFor(db, path)?.committed_offset).toBe(sizeOf(path));
  });

  it('scopes the directory scan to the named projects', () => {
    const db = freshDb();
    const root = makeRoot();
    const wanted = transcriptPath(root, 'sess-a');
    writeLines(wanted, [line(1)]);
    const otherSlug = '-Users-dev-other';
    mkdirSync(join(root, otherSlug), { recursive: true });
    const unwanted = join(root, otherSlug, 'sess-b.jsonl');
    writeLines(unwanted, [line(2)]);

    const result = tail(db, root, { projects: [SLUG], firstSight: 'backfill' });
    expect(result.files.map((f) => f.path)).toEqual([canonicalizeTranscriptPath(wanted)]);
    // Zero ROWS, not merely zero ingest: an excluded file must not even be
    // recorded, or the filter is a "read nothing once" rather than a scope.
    expect(offsetFor(db, unwanted)).toBeUndefined();
    expect(offsetRows(db)).toHaveLength(1);
  });

  it('scopes the sessions source too, not just the scan', () => {
    // Goes RED if `projects` is applied only to `scanTranscriptRoot`: the
    // sessions source is a DB column that can name any path on the machine.
    const db = freshDb();
    const root = makeRoot();
    const otherSlug = '-Users-dev-other';
    mkdirSync(join(root, otherSlug), { recursive: true });
    const unwanted = join(root, otherSlug, 'sess-b.jsonl');
    writeLines(unwanted, [line(1), line(2)]);
    registerSession(db, unwanted, 'sess-b');

    const wanted = transcriptPath(root, 'sess-a');
    writeLines(wanted, [line(3)]);
    registerSession(db, wanted, 'sess-a');

    const result = tail(db, root, { projects: [SLUG] });
    expect(result.files.map((f) => f.path)).toEqual([canonicalizeTranscriptPath(wanted)]);
    expect(archiveIds(db)).toHaveLength(1);
  });

  it('scans depth one only: no sub-agent files, no non-jsonl siblings', () => {
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    writeLines(path, [line(1)]);
    mkdirSync(join(root, SLUG, SESSION, 'subagents'), { recursive: true });
    writeLines(join(root, SLUG, SESSION, 'subagents', 'agent-1.jsonl'), [line(2)]);
    writeFileSync(join(root, SLUG, 'sessions-index.json'), '{}');
    mkdirSync(join(root, SLUG, 'memory'), { recursive: true });
    writeFileSync(join(root, SLUG, 'memory', 'notes.md'), '# notes');

    const result = tail(db, root);
    expect(result.files.map((f) => f.path)).toEqual([canonicalizeTranscriptPath(path)]);
  });
});

// --- Round-2 fixes ---------------------------------------------------------

describe('tailOnce — path canonicalization', () => {
  it('gives one file one identity whichever spelling reaches it', () => {
    // Goes RED under half-canonicalization: canonicalizing only the scan makes
    // the session's spelling an unknown file (first-sighted to EOF, zero rows);
    // canonicalizing neither mints two offset rows and double-ingests every
    // uuid-less line. This is the real macOS `/tmp` vs `/private/tmp` situation,
    // reproduced deterministically with a symlink.
    const db = freshDb();
    const root = makeRoot();
    const path = transcriptPath(root);
    const linkRoot = join(tmpdir(), `agent-lens-link-${process.pid}-${Date.now()}`);
    symlinkSync(root, linkRoot);
    dirs.push(linkRoot);
    const aliased = join(linkRoot, SLUG, `${SESSION}.jsonl`);
    expect(aliased).not.toBe(path);

    writeLines(path, [line(1), uuidless('mode', { mode: 'plan' }), line(2)]);
    // Discovery source 1 carries the aliased spelling; the scan carries the real one.
    registerSession(db, aliased);

    const result = tail(db, root);
    expect(result.files).toHaveLength(1);
    expect(offsetRows(db)).toHaveLength(1);
    expect(archiveIds(db)).toHaveLength(3);

    const identities = new Set(offsetRows(db).map((row) => row.file_identity));
    expect(identities.size).toBe(1);

    // A second pass through either spelling adds nothing.
    tail(db, root);
    expect(archiveIds(db)).toHaveLength(3);
  });

  it('falls back to a lexical resolve for a path whose file is gone', () => {
    expect(canonicalizeTranscriptPath('/no/such/dir/gone.jsonl')).toBe(
      '/no/such/dir/gone.jsonl',
    );

    const db = freshDb();
    const root = makeRoot();
    registerSession(db, join(root, SLUG, 'deleted.jsonl'), 'sess-gone');
    const path = transcriptPath(root);
    registerSession(db, path);
    writeLines(path, [line(1)]);

    // The vanished file is skipped; the live one is still tailed.
    const result = tail(db, root);
    expect(result.files).toHaveLength(1);
    expect(archiveIds(db)).toHaveLength(1);
  });

  it('confines sessions-derived paths to the root when one is set', () => {
    // Existing suites seed real-looking transcript paths (`/tmp/t`,
    // `/tmp/agent-lens/transcripts/<id>.jsonl`). If such a path happens to exist
    // on the machine, an unbounded tailer reads it into a test DB — a
    // machine-dependent failure. Goes RED if the root filter is dropped.
    const db = freshDb();
    const root = makeRoot();
    const outside = makeRoot();
    const stray = join(outside, 'outside.jsonl');
    writeLines(stray, [line(1), line(2)]);
    registerSession(db, stray, 'sess-outside');

    const inside = transcriptPath(root);
    registerSession(db, inside);
    writeLines(inside, [line(3)]);

    const result = tail(db, root);
    expect(result.files.map((f) => f.path)).toEqual([canonicalizeTranscriptPath(inside)]);
    expect(archiveIds(db)).toHaveLength(1);
  });
});
