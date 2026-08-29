// The sweep. A 1 Hz `setInterval` running two waves over one archive walk.
//
// A POLL, NOT `fs.watch`. Recursive watching is platform-divergent and
// event-lossy — the reasoning `capture/tailer.ts:246` already recorded — and the
// walk it replaces is a few milliseconds, so a watcher buys nothing measurable
// and costs a whole class of missed events.
//
// ★ TWO WAVES, BECAUSE THE UNIT OF WORK IS NOT THE UNIT OF PAINT. Wave 1 folds,
// reads a window and upserts a Tier-A row: ~20 ms for today's corpus, and every
// row it writes is readable immediately at `rollup_state='own'`, which is the
// DDL default. Wave 2 projects whole trees: measured mean ~178 ms and max ~785 ms
// PER TOP-LEVEL TREE, ~4.6 s for the corpus. Putting the second inside the first
// makes first paint wait on the whole archive.
//
// ★ WAVE 2 IS BUDGETED BY A DEADLINE CHECKED BETWEEN TREES, NEVER BY A COUNT.
// The unit is a tree, so a budget of "4 sessions" admits a 2.1 s synchronous
// tick against a 1 Hz period — the four largest trees sum to ~2,116 ms. A
// deadline bounds the tick at `deadline + one tree`.
//
// ⚠️ RESIDUAL, STATED NOT HIDDEN: a single tree larger than the deadline still
// overruns, because one projection is one `SAVEPOINT` and cannot be split. The
// deadline bounds the NUMBER of overruns to one per tick, not their size. Node
// coalesces a late `setInterval` fire, so an overrun delays the next tick rather
// than stacking ticks.
//
// ★ NOTHING LEAVES THE SWEEP SILENTLY. Every walked file lands in exactly one
// bucket of `SweepReport`, and anything the sweep declines to index is named by
// PATH rather than counted. `conservationOf` states the invariant the tests
// assert; there is no fourth way out.

import type { DatabaseSync } from 'node:sqlite';
import { createArchiveReader, type ArchiveReader } from '../archive/read.js';
import { resolveArchiveRoot, resolveTranscriptRoot } from '../archive/paths.js';
import { ensureProjected } from '../db/freshness.js';
import { readChildSessionIds, readMeta, readTreeRoots } from '../db/read.js';
import { readSessionEnvelope } from '../db/sidecars.js';
import {
  markRollupComplete,
  recomputeSubagentRollups,
  setParentSession,
  upsertSessionIndex,
  writeMeta,
} from '../db/write.js';
import { createProjectionEnv } from './env.js';
import { decodeProjectDir, projectSlugOf, rowIdOf, workflowParentOf } from './paths.js';
import { scanCorpus } from './scan.js';

const INTERVAL_MS = 1000;

/**
 * 250 ms. Bounds a tick at `deadline + one tree` — worst case ~1,035 ms on
 * today's corpus, against a 1,000 ms period.
 */
const WAVE2_DEADLINE_MS = 250;

/**
 * Where every file the sweep walked went.
 *
 * Owned by `src/corpus/`, deliberately NOT by `DriftCounter`: that class lives
 * under `src/transcript/`, which is inside `HASHED_TREES`, so a counter there
 * would force a `PROJECTOR_VERSION` bump for a number about the sweep rather
 * than about the projection.
 */
export interface SweepReport {
  /** Files the walk saw. The left side of the conservation invariant. */
  walked: number;
  /** Transcripts wave 1 wrote a Tier-A row for. */
  indexed: number;
  /** Changed sidecars wave 1 leaves to the projection-time `toolUseId` join. */
  deferred: number;
  /** Of `indexed`: `subagents/workflows/` sidecars given a path-derived parent. */
  deferred_wf_sidecars: number;
  /** Transcripts whose fold already matched their row. */
  unchanged: number;
  /** Ruled out of the corpus by path — a `journal.jsonl` under `subagents/`. */
  excluded: string[];
  /** Never a transcript: metas, tool results, checksums, sealed twins. */
  ignored: number;
  /** Seen, but with no bytes under either the hot or the sealed name. */
  unkeyable: string[];
  /** Read, but with no timestamps to bind to two NOT NULL columns. */
  envelope_incomplete: string[];
  /** Wave 2 could not project this row. */
  projection_failed: string[];
}

export function emptyReport(): SweepReport {
  return {
    walked: 0,
    indexed: 0,
    deferred: 0,
    deferred_wf_sidecars: 0,
    unchanged: 0,
    excluded: [],
    ignored: 0,
    unkeyable: [],
    envelope_incomplete: [],
    projection_failed: [],
  };
}

/**
 * The two sides of "no file left quietly". Equal on every tick — a mismatch
 * means a walked file took a path nothing reports.
 */
export function conservationOf(report: SweepReport): { walked: number; accounted: number } {
  return {
    walked: report.walked,
    accounted:
      report.indexed +
      report.deferred +
      report.unchanged +
      report.ignored +
      report.excluded.length +
      report.unkeyable.length +
      report.envelope_incomplete.length,
  };
}

export interface SweepOptions {
  db: DatabaseSync;
  dataDir?: string;
  transcriptRoot?: string;
  intervalMs?: number;
  wave2DeadlineMs?: number;
  /** Injected so a test can drive the deadline without sleeping. */
  now?: () => number;
  /** Shared between the envelope read and the projection, so one sealed frame
   *  decompresses once per pass rather than once per child. */
  reader?: ArchiveReader;
}

export interface CorpusSweep {
  /** One full pass. Wave 1 whole, then wave 2 until its deadline. */
  tick(): SweepReport;
  /** Wave 1 alone. Every row it writes is readable at `rollup_state='own'`. */
  wave1(): SweepReport;
  /** Wave 2 alone. Walks nothing — it reads the rows wave 1 already wrote. */
  wave2(): SweepReport;
  /** The most recent pass. */
  report(): SweepReport;
  close(): void;
}

/**
 * Start the corpus sweep. Returns a handle; nothing wires it into the CLI yet —
 * the running server still opens the plan-001 database, and two schemas in one
 * process is the cutover task's problem, not this one's.
 *
 * The first tick is SYNCHRONOUS and the interval is bound after it, so a caller
 * that has this call return holds a readable index rather than an empty one.
 * The timer is `unref`'d, so it never holds the process open.
 */
export function startCorpusSweep(options: SweepOptions): CorpusSweep {
  const sweep = createCorpusSweep(options);
  sweep.tick();
  return sweep.bind();
}

/**
 * The same sweep with no timer and no first tick. `bind()` starts the interval.
 * Separated so a caller — a test, or 4.5's wiring — can drive one wave at a time
 * and observe the state between them, which is the first-paint contract.
 */
export function createCorpusSweep(options: SweepOptions): CorpusSweep & { bind(): CorpusSweep } {
  const { db } = options;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const deadlineMs = options.wave2DeadlineMs ?? WAVE2_DEADLINE_MS;
  const archiveRoot = resolveArchiveRoot(options.dataDir);
  const sourceRoot = resolveTranscriptRoot(options.transcriptRoot);
  const reader = options.reader ?? createArchiveReader();
  const env = createProjectionEnv(reader);

  let last = emptyReport();

  const runWave1 = (report: SweepReport): void => {
    const scan = scanCorpus(db, archiveRoot, sourceRoot);
    report.walked += scan.walked;
    report.unchanged += scan.unchanged;
    report.deferred += scan.deferred;
    report.ignored += scan.ignored;
    report.excluded.push(...scan.excluded);
    report.unkeyable.push(...scan.unkeyable);

    // NEWEST FIRST, so the rows the product opens on exist first. A session's
    // fold mtime is `max(child mtime)`, which is the better recency signal: a
    // parent that has been quiet for 30 minutes while its sub-agents worked is
    // genuinely the most recent thing on screen.
    const queue = [...scan.changed].sort((a, b) => b.fold.mtime_ms - a.fold.mtime_ms);

    for (const entry of queue) {
      // The seed is consulted only if the file carries no `cwd` at all;
      // `WRITE_HEADER_SQL`'s COALESCE replaces it at the first projection.
      const seed = decodeProjectDir(projectSlugOf(entry.relPath));
      const envelope = readSessionEnvelope(reader, entry.archivePath, seed);
      if (envelope === undefined) {
        report.envelope_incomplete.push(entry.relPath);
        continue;
      }

      const id = rowIdOf(entry.relPath);
      upsertSessionIndex(db, {
        id,
        source_path: entry.sourcePath,
        archive_path: entry.archivePath,
        file_mtime_ms: entry.fold.mtime_ms,
        file_size: entry.fold.size,
        project_path: envelope.project_path,
        started_at: envelope.started_at,
        last_activity_at: envelope.last_activity_at,
      });
      report.indexed += 1;

      // `upsertSidecarIndex` cannot serve these: its row type requires a
      // `spawned_by_event_id`, and a `wf_*` meta carries no `toolUseId` for one
      // to be found through. The parent is pure path math instead.
      const parent = workflowParentOf(entry.relPath);
      if (parent !== undefined) {
        setParentSession(db, id, parent);
        report.deferred_wf_sidecars += 1;
      }
    }

    stampIndexMeta(db, sourceRoot, report, now);
  };

  const projectTree = (root: string, report: SweepReport): void => {
    // Breadth-first to a fixpoint: projecting a parent is what CREATES its child
    // rows, so the children cannot be enumerated before it runs. `done` only
    // grows and the row set is finite, so the walk terminates without a round
    // cap — measured 3 rounds over the real archive.
    const done: string[] = [];
    const seen = new Set<string>();
    let frontier = [root];

    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        done.push(id);

        if (ensureProjected(db, id, env) === 'failed') report.projection_failed.push(id);
        for (const child of readChildSessionIds(db, id)) {
          if (!seen.has(child)) next.push(child);
        }
      }
      frontier = next;
    }

    // DEEPEST FIRST. Each row's `sub_*` sums its children's own + sub columns, so
    // a grandchild's totals only reach the root if its parent was rolled up
    // first. `done` is parents-before-children, so reversed is what this needs.
    for (const id of done.reverse()) recomputeSubagentRollups(db, id);

    // Only the root flips. `rollup_state` is the claim that a row's `sub_*` are
    // final, and that is true of the root of a completed fixpoint alone.
    markRollupComplete(db, root);
  };

  const runWave2 = (report: SweepReport, startedAt: number): void => {
    let processed = 0;
    for (const root of readTreeRoots(db)) {
      // BETWEEN trees, never inside one, and never before the first: a zero
      // deadline still makes progress at exactly one tree per tick.
      if (processed > 0 && now() - startedAt >= deadlineMs) break;
      projectTree(root, report);
      processed += 1;
    }
  };

  const tick = (): SweepReport => {
    const startedAt = now();
    const report = emptyReport();
    runWave1(report);
    runWave2(report, startedAt);
    last = report;
    return report;
  };

  const wave1 = (): SweepReport => {
    const report = emptyReport();
    runWave1(report);
    last = report;
    return report;
  };

  const wave2 = (): SweepReport => {
    const report = emptyReport();
    runWave2(report, now());
    last = report;
    return report;
  };

  let timer: ReturnType<typeof setInterval> | undefined;

  const handle = {
    tick,
    wave1,
    wave2,
    report: () => last,
    close: (): void => {
      // FIRST, exactly as `server/start.ts:341-346` does it and for the reason
      // stated there: a timer that fires after `db.close()` throws where no
      // caller can catch it.
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    bind: (): CorpusSweep => {
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      return handle;
    },
  };
  return handle;
}

/**
 * The two `meta` keys `schema.ts:262` promises and nothing else produced.
 *
 * `index_built_at` is written only when the pass drained CLEANLY — nothing
 * unkeyable and no incomplete envelope — because the key is the claim that the
 * list is whole. It is not rewritten on a pass that indexed nothing, so its
 * value stays the moment the index was actually built.
 */
function stampIndexMeta(
  db: DatabaseSync,
  sourceRoot: string,
  report: SweepReport,
  now: () => number,
): void {
  // Only on a change: this runs once a second forever, and a WAL write per tick
  // for a value that never moves is a cost with no reader.
  if (readMeta(db, 'projects_root') !== sourceRoot) writeMeta(db, 'projects_root', sourceRoot);

  if (report.unkeyable.length > 0 || report.envelope_incomplete.length > 0) return;
  if (readMeta(db, 'index_built_at') !== undefined && report.indexed === 0) return;
  writeMeta(db, 'index_built_at', new Date(now()).toISOString());
}
