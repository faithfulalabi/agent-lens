// AC1/AC2/AC3/AC5 against the REAL archive. Opt-in via `AGENT_LENS_REAL_CORPUS=1`,
// the same gate as `db/__tests__/freshness-corpus.test.ts`.
//
// ★ ASSERT PROPERTIES, PRINT COUNTS, PIN NOTHING. A 15-minute cron grows this
// corpus: measured drift in ONE day was 300 -> 304 `.jsonl` and 273 -> 277
// metas. Every count below is a diagnostic in a failure message, never an
// expected value. A test that pinned "244 -> 261" was already wrong within 24
// hours, twice.
//
// Reads `~/.agent-lens/archive` and never `~/.claude/projects`. The database is
// in memory, so nothing here writes to the real data dir.

import { describe, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createArchiveReader } from '../../archive/read.js';
import { readSessionEnvelope, readSidecars } from '../../db/sidecars.js';
import { foldSessionEnvelope, type ParsedLine } from '../../transcript/line.js';
import { openCache } from '../../db/__tests__/fixtures/index.js';
import { runIt } from '../../transcript/__tests__/fixtures.js';
import { createProjectionEnv } from '../env.js';
import { classifyCorpusPath, encodeProjectDir, decodeProjectDir, rowIdOf } from '../paths.js';
import { scanCorpus, type ScanResult } from '../scan.js';
import { conservationOf, createCorpusSweep } from '../watch.js';

const DATA_DIR = join(homedir(), '.agent-lens');
const ARCHIVE_ROOT = join(DATA_DIR, 'archive');
const SOURCE_ROOT = join(homedir(), '.claude', 'projects');

/** Well under anything measured; a lower bound, never a cardinality. */
const MIN_FILES = 100;

const START_WINDOW = 16 * 1024;

function coldScan(): { db: ReturnType<typeof openCache>; result: ScanResult } {
  const db = openCache();
  return { db, result: scanCorpus(db, ARCHIVE_ROOT, SOURCE_ROOT) };
}

/** Every line of a whole transcript, classified. The ground truth for a fold. */
function wholeFileLines(archivePath: string): readonly ParsedLine[] {
  return createProjectionEnv(createArchiveReader(), {
    archiveRoot: ARCHIVE_ROOT,
    transcriptRoot: SOURCE_ROOT,
  }).readLines(archivePath).lines;
}

/** The pre-4.1 answer: the first and last lines only. */
function twoEndFold(lines: readonly ParsedLine[]): ReturnType<typeof foldSessionEnvelope> {
  const ends = lines.length <= 1 ? lines : [lines[0]!, lines[lines.length - 1]!];
  return foldSessionEnvelope(ends);
}

/** The byte offset of the first line carrying a `cwd`, or -1. */
function firstCwdOffset(archivePath: string): number {
  for (const line of wholeFileLines(archivePath)) {
    if (typeof line.raw['cwd'] === 'string') return line.byte_offset;
  }
  return -1;
}

/**
 * The cwd a session STARTED in, which is what the harness names its project
 * directory after.
 *
 * ⚠️ NOT the same as `sessions.project_path`. `foldSessionEnvelope` takes the
 * LAST cwd, and a session that changes directory ends somewhere else — measured,
 * one archived session ends 6 levels below the directory it started in. The
 * encoding is exact against the FIRST; against the last it cannot be.
 */
function firstCwd(archivePath: string): string | undefined {
  for (const line of wholeFileLines(archivePath)) {
    const cwd = line.raw['cwd'];
    if (typeof cwd === 'string') return cwd;
  }
  return undefined;
}

describe('AC2 — the walk over the real archive', () => {
  runIt('classifies every walked file, with zero unaccounted', () => {
    const { db, result } = coldScan();
    try {
      expect(result.walked).toBeGreaterThan(MIN_FILES);
      const { walked, accounted } = {
        walked: result.walked,
        accounted:
          result.changed.length +
          result.unchanged +
          result.deferred +
          result.ignored +
          result.excluded.length +
          result.unkeyable.length,
      };
      expect(accounted, `walked ${walked}, accounted ${accounted}`).toBe(walked);
      console.log(
        `[diagnostic] walked ${result.walked}: changed ${result.changed.length}, deferred ${result.deferred}, ignored ${result.ignored}, excluded ${result.excluded.length}, unkeyable ${result.unkeyable.length}`,
      );
    } finally {
      db.close();
    }
  });

  runIt('is linear and cheap — well inside one 1 Hz tick, warm and cold', () => {
    // ORDER OF MAGNITUDE, not a benchmark. The walk is a readdir per directory
    // plus one `foldArchive` per top-level transcript — the fold is the diff key
    // the schema demands, so this is legitimately more than a readdir-only
    // measurement. NEVER pin 1.5 / 6.9 ms (taken at 157 files) or today's
    // numbers: the corpus grows hourly and every figure taken for it has rotted.
    const db = openCache();
    try {
      const coldStart = performance.now();
      const first = scanCorpus(db, ARCHIVE_ROOT, SOURCE_ROOT);
      const cold = performance.now() - coldStart;

      const timings: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        const at = performance.now();
        scanCorpus(db, ARCHIVE_ROOT, SOURCE_ROOT);
        timings.push(performance.now() - at);
      }
      const warm = timings.sort((a, b) => a - b)[2]!;

      console.log(
        `[diagnostic] ${first.walked} files: cold ${cold.toFixed(1)} ms, warm median ${warm.toFixed(1)} ms`,
      );
      // A quarter of the 1 Hz period. Wave 1 must leave the rest of the tick to
      // wave 2, and the whole design fails if the walk alone approaches it.
      expect(cold, `cold ${cold.toFixed(1)} ms over ${first.walked} files`).toBeLessThan(250);
      expect(warm, `warm ${warm.toFixed(1)} ms over ${first.walked} files`).toBeLessThan(250);
    } finally {
      db.close();
    }
  });
});

describe('AC1 — the slug encoding over the real corpus', () => {
  runIt('encode agrees with every slug whose sessions carry a cwd', () => {
    const { db, result } = coldScan();
    try {
      let checked = 0;
      const disagreed: string[] = [];

      for (const entry of result.changed) {
        if (entry.kind !== 'session') continue;
        const slug = entry.relPath.slice(0, entry.relPath.indexOf('/'));
        const started = firstCwd(entry.archivePath);
        if (started === undefined) continue;
        checked += 1;
        if (encodeProjectDir(started) !== slug) disagreed.push(entry.relPath);
      }

      console.log(
        `[diagnostic] encode exact for ${checked - disagreed.length}/${checked} transcripts`,
      );
      expect(checked, 'no transcript yielded a cwd').toBeGreaterThan(0);
      expect(disagreed, 'encode must be exact against the cwd a session started in').toEqual([]);
    } finally {
      db.close();
    }
  });

  runIt('decode is a seed: SOME slugs disagree, and every one is repairable', () => {
    const { db, result } = coldScan();
    try {
      let agreed = 0;
      let total = 0;
      let repaired = 0;

      for (const entry of result.changed) {
        if (entry.kind !== 'session') continue;
        const slug = entry.relPath.slice(0, entry.relPath.indexOf('/'));
        const envelope = readSessionEnvelope(
          createArchiveReader(),
          entry.archivePath,
          decodeProjectDir(slug),
        );
        if (envelope === undefined) continue;
        total += 1;
        if (decodeProjectDir(slug) === envelope.project_path) agreed += 1;
        // The repair the round-trip actually relies on: whatever the seed said,
        // the projection installs the session's OWN cwd through the COALESCE.
        if (envelope.project_path !== decodeProjectDir(slug)) repaired += 1;
      }

      console.log(
        `[diagnostic] naive decode agreed for ${agreed}/${total} transcripts; ${repaired} repaired by the fold`,
      );
      expect(total).toBeGreaterThan(0);
      // A PROPERTY, not a ratio: the encoding is lossy, so decode cannot be
      // total. Asserting a count here is what rotted twice already.
      expect(agreed).toBeLessThan(total);
      expect(repaired).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe('AC3 — the journal exclusion over the real archive', () => {
  runIt('excludes every journal, and keeps its sibling agent transcripts', () => {
    const { db, result } = coldScan();
    try {
      for (const rel of result.excluded) expect(rel.endsWith('journal.jsonl')).toBe(true);

      const wfSidecars = result.changed.filter(
        (entry) => entry.kind === 'sidecar' && entry.relPath.includes('/subagents/workflows/'),
      );
      console.log(
        `[diagnostic] excluded ${result.excluded.length} journal(s), kept ${wfSidecars.length} workflow sidecar(s)`,
      );
      expect(wfSidecars.length).toBeGreaterThan(0);
      for (const entry of wfSidecars) {
        expect(classifyCorpusPath(entry.relPath)).toBe('sidecar');
      }
    } finally {
      db.close();
    }
  });

  runIt('none of those workflow sidecars is reachable through readSidecars', () => {
    // 4.1 is their producer, not 3.3: a `wf_*` meta carries no `toolUseId`, so
    // the two sets must be disjoint.
    const { db, result } = coldScan();
    try {
      const wfIds = new Set(
        result.changed
          .filter((entry) => entry.relPath.includes('/subagents/workflows/'))
          .map((entry) => rowIdOf(entry.relPath)),
      );
      expect(wfIds.size).toBeGreaterThan(0);

      const reader = createArchiveReader();
      const linked = new Set<string>();
      for (const entry of result.changed) {
        if (entry.kind !== 'session') continue;
        const ids = new Set(
          wholeFileLines(entry.archivePath).flatMap((line) => toolUseIdsOf(line)),
        );
        if (ids.size === 0) continue;
        for (const found of readSidecars(entry.archivePath, entry.sourcePath, ids, reader)) {
          linked.add(found.agent_id);
        }
      }

      console.log(`[diagnostic] ${wfIds.size} workflow sidecars, ${linked.size} linked by 3.3`);
      for (const id of wfIds) expect(linked.has(id)).toBe(false);
    } finally {
      db.close();
    }
  });
});

/** Every `tool_use` id a line carries, read through the classifier's own view. */
function toolUseIdsOf(line: ParsedLine): string[] {
  const message = line.raw['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (block): block is Record<string, unknown> =>
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>)['type'] === 'tool_use',
    )
    .map((block) => block['id'])
    .filter((id): id is string => typeof id === 'string');
}

describe('BLOCKING 3 — the window headroom, asserted as a tripwire', () => {
  runIt('every top-level transcript carries its first cwd inside START_WINDOW', () => {
    const { db, result } = coldScan();
    try {
      let worst = 0;
      let worstPath = '';
      let checked = 0;

      for (const entry of result.changed) {
        if (entry.kind !== 'session') continue;
        const at = firstCwdOffset(entry.archivePath);
        if (at < 0) continue;
        checked += 1;
        if (at > worst) {
          worst = at;
          worstPath = entry.relPath;
        }
      }

      console.log(
        `[diagnostic] max first-cwd offset ${worst} B over ${checked} transcripts (${worstPath}), margin ${(START_WINDOW / Math.max(worst, 1)).toFixed(1)}x`,
      );
      expect(checked).toBeGreaterThan(0);
      // A TRIPWIRE, not a pin. If the harness moves that line past 16 KB this
      // reds with a readable number — and the growth loop already handles it,
      // which `sidecars.test.ts`'s BLOCKING 3 arm proves independently.
      expect(worst, `first cwd at ${worst} B in ${worstPath}`).toBeLessThan(START_WINDOW);
    } finally {
      db.close();
    }
  });

  runIt('the windowed fold beats the two-end fold on real sessions', () => {
    const { db, result } = coldScan();
    try {
      const reader = createArchiveReader();
      let checked = 0;
      const exact = { project_path: 0, last_activity_at: 0, started_at: 0 };
      const twoEnd = { project_path: 0, last_activity_at: 0, started_at: 0 };

      for (const entry of result.changed) {
        if (entry.kind !== 'session') continue;
        const lines = wholeFileLines(entry.archivePath);
        const truth = foldSessionEnvelope(lines);
        if (truth.project_path === undefined || truth.started_at === undefined) continue;
        checked += 1;

        const windowed = readSessionEnvelope(reader, entry.archivePath);
        const ends = twoEndFold(lines);

        if (windowed?.project_path === truth.project_path) exact.project_path += 1;
        if (windowed?.last_activity_at === truth.last_activity_at) exact.last_activity_at += 1;
        if (windowed !== undefined && withinMs(windowed.started_at, truth.started_at, 2)) {
          exact.started_at += 1;
        }

        if (ends.project_path === truth.project_path) twoEnd.project_path += 1;
        if (ends.last_activity_at === truth.last_activity_at) twoEnd.last_activity_at += 1;
        if (ends.started_at === truth.started_at) twoEnd.started_at += 1;
      }

      console.log(
        `[diagnostic] over ${checked} transcripts — windowed ${JSON.stringify(exact)}, two-end ${JSON.stringify(twoEnd)}`,
      );
      expect(checked).toBeGreaterThan(0);
      expect(exact.project_path, 'windowed project_path must be exact').toBe(checked);
      expect(exact.last_activity_at, 'windowed last_activity_at must be exact').toBe(checked);
      expect(exact.started_at, 'windowed started_at within 2 ms').toBe(checked);
      // Strictly worse, which is the whole reason the windowed fold exists.
      expect(twoEnd.started_at).toBeLessThan(exact.started_at);
    } finally {
      db.close();
    }
  });
});

function withinMs(a: string, b: string, tolerance: number): boolean {
  return Math.abs(Date.parse(a) - Date.parse(b)) <= tolerance;
}

describe('AC5 — the whole sweep over the real archive', () => {
  runIt('indexes every top-level transcript, hot and sealed alike', () => {
    const db = openCache();
    const sweep = createCorpusSweep({ db, dataDir: DATA_DIR, transcriptRoot: SOURCE_ROOT });
    try {
      const report = sweep.wave1();

      const { walked, accounted } = conservationOf(report);
      expect(accounted, `walked ${walked}, accounted ${accounted}`).toBe(walked);

      const topLevel = db
        .prepare(
          `SELECT count(*) AS n FROM sessions
             WHERE parent_session_id IS NULL AND archive_path NOT LIKE '%/subagents/%'`,
        )
        .get() as { n: number };
      console.log(
        `[diagnostic] wave 1 indexed ${report.indexed} (${topLevel.n} top-level), reported ${report.envelope_incomplete.length} incomplete, ${report.unkeyable.length} unkeyable, deferred ${report.deferred}`,
      );

      expect(topLevel.n).toBeGreaterThan(0);
      // Every declined file is NAMED. Nothing is a bare count here.
      expect(report.unkeyable).toEqual([]);
      expect(report.envelope_incomplete).toEqual([]);
      expect(report.deferred_wf_sidecars).toBeGreaterThan(0);
    } finally {
      sweep.close();
      db.close();
    }
  });

  runIt('wave 2 reaches a fixpoint, and every resulting row is ready', { timeout: 300_000 }, () => {
    const db = openCache();
    const sweep = createCorpusSweep({
      db,
      dataDir: DATA_DIR,
      transcriptRoot: SOURCE_ROOT,
      wave2DeadlineMs: Number.MAX_SAFE_INTEGER,
    });
    try {
      sweep.wave1();
      const before = countRows(db);
      const at = performance.now();
      const report = sweep.wave2();
      const elapsed = performance.now() - at;
      const after = countRows(db);

      const failed = db
        .prepare(`SELECT count(*) AS n FROM sessions WHERE projection_state = 'failed'`)
        .get() as { n: number };
      const states = db
        .prepare('SELECT projection_state AS state, count(*) AS n FROM sessions GROUP BY 1')
        .all() as unknown as { state: string; n: number }[];

      console.log(
        `[diagnostic] rows ${before} -> ${after} in ${(elapsed / 1000).toFixed(1)} s; states ${JSON.stringify(states)}; projection_failed ${report.projection_failed.length}`,
      );

      // PROPERTIES, not counts: the row set strictly grows as children are
      // discovered, then every row settles at a terminal state.
      expect(after).toBeGreaterThan(before);
      expect(failed.n, `failed: ${report.projection_failed.slice(0, 5).join(', ')}`).toBe(0);
      for (const entry of states) expect(['ready', 'empty']).toContain(entry.state);

      const own = db
        .prepare(
          `SELECT count(*) AS n FROM sessions WHERE parent_session_id IS NULL AND rollup_state = 'own'`,
        )
        .get() as { n: number };
      expect(own.n, 'every top-level tree reached complete').toBe(0);
    } finally {
      sweep.close();
      db.close();
    }
  });

  runIt('every projected event slices back out of the archive bytes', { timeout: 300_000 }, () => {
    const db = openCache();
    const sweep = createCorpusSweep({
      db,
      dataDir: DATA_DIR,
      transcriptRoot: SOURCE_ROOT,
      wave2DeadlineMs: Number.MAX_SAFE_INTEGER,
    });
    try {
      sweep.tick();

      const bad = db
        .prepare('SELECT count(*) AS n FROM events WHERE src_len IS NULL OR src_len <= 0')
        .get() as { n: number };
      const total = db.prepare('SELECT count(*) AS n FROM events').get() as { n: number };
      console.log(`[diagnostic] ${total.n} events, ${bad.n} with a bad src_len`);

      expect(total.n).toBeGreaterThan(0);
      expect(bad.n).toBe(0);
    } finally {
      sweep.close();
      db.close();
    }
  });
});

function countRows(db: ReturnType<typeof openCache>): number {
  return (db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;
}
