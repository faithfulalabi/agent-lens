// The corpus walk. One `readdir` per directory over the ARCHIVE ROOT ONLY, then
// one `foldArchive` per transcript the walk kept.
//
// The archive, never `~/.claude/projects`, for the reason `freshness.ts:11-14`
// gives: the projector reads archived bytes, so a freshness key taken from the
// source describes a file nobody projected, and the source stops existing
// entirely once Claude Code expires the original at 41 days.
//
// ★ THE DIFF KEY IS THE FOLD, NOT THE FILE'S OWN STAT. `sessions.file_mtime_ms`
// and `file_size` hold `max(child mtime)` and `sum(child size)` over the whole
// session directory (`schema.ts:71-75`), because a parent measured 1,814 s
// without a write while 11 of its sidecars grew by 3.76 MB. Diffing the parent's
// own stat against those columns would report every session changed on every
// tick — and would miss the sidecar growth the columns exist to catch. A
// sidecar's own fold degrades to a plain stat, which is the key `readSidecars`
// already uses for it, so one code path serves both kinds.
//
// EVERY PHYSICAL NAME IS KEYED ON ITS LOGICAL ONE. A hot `x.jsonl` and a sealed
// `x.jsonl.zst` are the same session and must produce one entry, not two — the
// same rule `metaEntries` applies to sealed metas and `discover.ts` to the
// mirror union.
//
// EXCLUDED FILES ARE DROPPED BEFORE THE FOLD, so a repeated sweep over an
// unchanged tree opens and stats `journal.jsonl` zero times.

import { readdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { relativeUnder } from '../archive/paths.js';
import { foldArchive, type ArchiveFold } from '../db/freshness.js';
import { readIndexedFolds, type IndexedRow } from '../db/read.js';
import { classifyCorpusPath, logicalPathOf, workflowParentOf } from './paths.js';

/** One walked transcript whose fold differs from what `sessions` recorded. */
export interface ScanEntry {
  /** Archive-root relative and LOGICAL — the key a hot/sealed pair shares. */
  relPath: string;
  archivePath: string;
  sourcePath: string;
  kind: 'session' | 'sidecar';
  sealed: boolean;
  /** The invalidation key, and the newest-first sort key wave 1 orders on. */
  fold: ArchiveFold;
}

/**
 * What one walk saw. EVERY walked file lands in exactly one bucket, and the
 * conservation invariant below is asserted, not assumed:
 *
 * `walked === changed.length + unchanged + deferred + excluded.length + ignored + unkeyable.length`
 */
export interface ScanResult {
  changed: ScanEntry[];
  /** Transcripts whose fold already matched their row. */
  unchanged: number;
  /**
   * Sidecars 3.3 owns. `readSidecars` folds each one at projection time, keyed
   * on its own `agent-*.meta.json`, so folding it a second time here would be a
   * second freshness key for the same file — and 267 of today's 307 changed
   * transcripts are these, which is most of the walk's cost for no answer.
   */
  deferred: number;
  /** Ruled out of the corpus by path. Reported individually, never as a count. */
  excluded: string[];
  /** Never a transcript: metas, tool results, checksums, sealed twins. */
  ignored: number;
  /** A transcript that vanished between the listing and the fold. */
  unkeyable: string[];
  walked: number;
}

/**
 * Walk the archive and return only the transcripts whose bytes moved.
 *
 * `sourceRoot` is used for path math alone: nothing here reads it, and nothing
 * here writes anywhere.
 */
export function scanCorpus(db: DatabaseSync, archiveRoot: string, sourceRoot: string): ScanResult {
  const result: ScanResult = {
    changed: [],
    unchanged: 0,
    deferred: 0,
    excluded: [],
    ignored: 0,
    unkeyable: [],
    walked: 0,
  };
  walk(archiveRoot, {
    archiveRoot,
    sourceRoot,
    indexed: readIndexedFolds(db),
    // A hot file and its sealed twin share a logical name; the first one walked
    // wins, and the second is not a second file.
    seen: new Set<string>(),
    result,
  });
  return result;
}

interface WalkState {
  archiveRoot: string;
  sourceRoot: string;
  indexed: ReadonlyMap<string, IndexedRow>;
  seen: Set<string>;
  result: ScanResult;
}

function walk(dir: string, state: WalkState): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, state);
      continue;
    }
    if (entry.isFile()) visitFile(path, state);
  }
}

function visitFile(path: string, state: WalkState): void {
  const { result } = state;
  result.walked += 1;

  const archivePath = logicalPathOf(path);
  const relPath = relativeUnder(state.archiveRoot, archivePath);
  if (relPath === undefined) {
    result.ignored += 1;
    return;
  }

  const kind = classifyCorpusPath(relPath);
  if (kind === 'excluded') {
    result.excluded.push(relPath);
    return;
  }
  // `ignored` and the second half of a hot/sealed pair are the same outcome:
  // counted, not indexed, and not a file the sweep declined to handle.
  if (kind === 'ignored' || state.seen.has(relPath)) {
    result.ignored += 1;
    return;
  }
  state.seen.add(relPath);

  // BEFORE THE FOLD, which is what keeps the warm walk cheap: an ordinary
  // sidecar is resolved and folded by `readSidecars` when its parent projects,
  // and the sweep indexes only what that join cannot reach — the `workflows/`
  // sidecars, whose metas carry no `toolUseId`.
  if (kind === 'sidecar' && workflowParentOf(relPath) === undefined) {
    result.deferred += 1;
    return;
  }

  const fold = foldArchive(archivePath);
  if (fold === undefined) {
    // Vanished between the listing and the fold, or present under neither name.
    // Reported by path: a file the sweep saw and could not key is exactly what
    // must never disappear quietly.
    result.unkeyable.push(relPath);
    return;
  }

  const row = state.indexed.get(archivePath);
  if (row !== undefined && row.file_mtime_ms === fold.mtime_ms && row.file_size === fold.size) {
    result.unchanged += 1;
    return;
  }

  result.changed.push({
    relPath,
    archivePath,
    sourcePath: join(state.sourceRoot, relPath),
    kind,
    sealed: path !== archivePath,
    fold,
  });
}
