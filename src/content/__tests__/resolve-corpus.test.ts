// The resolver against the REAL archive. Opt-in via `AGENT_LENS_REAL_CORPUS=1`,
// the same gate as `corpus/__tests__/corpus.test.ts`.
//
// ★ ASSERT PROPERTIES, PRINT COUNTS, PIN NOTHING. A 15-minute cron grows this
// corpus, and every ratio anybody has pinned for it has rotted within a week.
// Nothing here is load-bearing for correctness — the hermetic suite owns that.
// These arms exist to catch a shape the synthetic fixtures never produce.
//
// Reads `~/.agent-lens/archive` and never `~/.claude/projects`. The database is
// in memory, so nothing here writes to the real data dir.

import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveArchiveRoot, resolveTranscriptRoot } from '../../archive/paths.js';
import { createArchiveReader } from '../../archive/read.js';
import { openCache } from '../../db/__tests__/fixtures/index.js';
import { readEventArchivePath, readEventContentRow, type EventContentRow } from '../../db/read.js';
import { createCorpusSweep } from '../../corpus/watch.js';
import { INLINE_MAX } from '../../project/tools.js';
import { createContentEnv, resolveContent, type ContentField } from '../resolve.js';

const ENABLED = process.env['AGENT_LENS_REAL_CORPUS'] === '1';
const runIt = ENABLED ? it : it.skip;

const DATA_DIR = join(homedir(), '.agent-lens');
const SOURCE_ROOT = join(homedir(), '.claude', 'projects');

/** How many projected sessions to sample. The point is shape, not coverage. */
const SAMPLE = 30;

interface Corpus {
  db: DatabaseSync;
  rows: { row: EventContentRow; archivePath: string }[];
}

/**
 * Drive the REAL sweep — wave 1 indexes, wave 2 projects — then collect content
 * rows with the archive path each one's offsets are relative to.
 */
function corpus(): Corpus {
  const db = openCache();
  const sweep = createCorpusSweep({
    db,
    dataDir: DATA_DIR,
    transcriptRoot: SOURCE_ROOT,
    wave2DeadlineMs: Number.MAX_SAFE_INTEGER,
  });
  try {
    sweep.wave1();
    sweep.wave2();
  } finally {
    sweep.close();
  }

  const sessions = db
    .prepare(
      `SELECT id FROM sessions WHERE projection_state = 'ready'
       ORDER BY last_activity_at DESC LIMIT ?`,
    )
    .all(SAMPLE) as unknown as { id: string }[];

  const rows: Corpus['rows'] = [];
  for (const { id } of sessions) {
    const archive = readEventArchivePath(db, id);
    if (archive === undefined) continue;
    const events = db.prepare(`SELECT id FROM events WHERE session_id = ?`).all(id) as unknown as {
      id: string;
    }[];
    for (const event of events) {
      const found = readEventContentRow(db, event.id);
      if (found !== undefined) rows.push({ row: found, archivePath: archive.archive_path });
    }
  }
  return { db, rows };
}

const FIELDS: readonly ContentField[] = ['text', 'input'];

describe('the resolver over the real archive (AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt(
    'resolves every row of every storage state without throwing',
    () => {
      const { db, rows } = corpus();
      expect(rows.length).toBeGreaterThan(0);

      const env = createContentEnv(createArchiveReader(), [resolveArchiveRoot(), resolveTranscriptRoot()]);
      const byStorage = new Map<string, number>();

      for (const { row, archivePath } of rows) {
        for (const field of FIELDS) {
          const slice = resolveContent(row, field, archivePath, env);
          byStorage.set(slice.storage, (byStorage.get(slice.storage) ?? 0) + 1);

          // Total: every answer is a labelled state with a non-negative size.
          expect(typeof slice.content).toBe('string');
          expect(slice.byte_size).toBeGreaterThanOrEqual(0);
          // `content` is either the whole field or a prefix of it.
          expect(Buffer.byteLength(slice.content, 'utf8')).toBeLessThanOrEqual(slice.byte_size);
        }
      }

      // A diagnostic, never an expectation.
      console.log('resolved storage states:', Object.fromEntries(byStorage));
      db.close();
    },
    600_000,
  );

  runIt(
    'the overwhelming majority of rows ship whole, and p99 sits under INLINE_MAX',
    () => {
      const { db, rows } = corpus();
      const sizes: number[] = [];
      let whole = 0;

      for (const { row } of rows) {
        const storage = row.output_storage;
        if (storage === null || storage === 'inline' || storage === 'absent') whole += 1;
        if (row.text_bytes !== null) sizes.push(row.text_bytes);
        if (row.input_bytes !== null) sizes.push(row.input_bytes);
      }

      // A FLOOR, never today's number. Measured 2026-08-25: 99.978%.
      expect(whole / rows.length).toBeGreaterThan(0.99);

      sizes.sort((a, b) => a - b);
      const p99 = sizes[Math.floor(sizes.length * 0.99)] ?? 0;
      expect(p99).toBeLessThan(INLINE_MAX);
      console.log(`rows ${rows.length}, whole ${whole}, p99 ${p99} B`);
      db.close();
    },
    600_000,
  );

  runIt(
    'a line_ref resolve is sub-millisecond',
    () => {
      const { db, rows } = corpus();
      const refs = rows.filter(
        ({ row }) => row.output_storage === 'line_ref' || row.input_storage === 'line_ref',
      );
      if (refs.length === 0) {
        // Legal and expected: measured, 0 of 16,440 tool_result payloads exceed
        // INLINE_MAX. The hermetic suite is what actually pins this arm.
        console.log('no line_ref rows in the sample');
        db.close();
        return;
      }

      const env = createContentEnv(createArchiveReader(), [resolveArchiveRoot(), resolveTranscriptRoot()]);
      const started = performance.now();
      for (const { row, archivePath } of refs) {
        resolveContent(row, row.output_storage === 'line_ref' ? 'text' : 'input', archivePath, env);
      }
      const each = (performance.now() - started) / refs.length;

      expect(each).toBeLessThan(1);
      console.log(`${refs.length} line_ref resolves, ${each.toFixed(3)} ms each`);
      db.close();
    },
    600_000,
  );
});
