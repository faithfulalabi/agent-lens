// AC4's corpus half. Opt-in via `AGENT_LENS_REAL_CORPUS=1`, the same gate as
// `src/transcript/__tests__/archive-invariants.test.ts`.
//
// Reads `~/.agent-lens/archive` and NEVER `~/.claude/projects`. Every assertion
// is an INVARIANT or a LOWER BOUND, never an absolute count: the archive grows
// under a 15-minute cron and moved 289 -> 293 files during one review. The
// measured silence, child and byte figures are PRINTED as diagnostics.
//
// THIS FILE FOLDS DIRECTORIES ONLY. It never projects a real file and never
// asserts that any archived file tombstones — `subagents/workflows/**/journal.jsonl`
// is excluded upstream by the corpus sweep, so the tombstone's witnesses are
// synthetic and live in `write.test.ts`.

import { describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { archiveJsonlFiles } from '../../transcript/__tests__/fixtures.js';
import { fingerprint, foldArchive } from '../freshness.js';

const ENABLED = process.env.AGENT_LENS_REAL_CORPUS === '1';
const runIt = ENABLED ? it : it.skip;

const ARCHIVE_ROOT = join(homedir(), '.agent-lens', 'archive');

/** Well under what was measured on 2026-08-19 (291 files). */
const MIN_FILES = 100;

interface Folded {
  path: string;
  parentMtime: number;
  parentSize: number;
  mtime_ms: number;
  size: number;
  sidecar_count: number;
  micros: number;
}

function foldCorpus(): Folded[] {
  const folded: Folded[] = [];
  for (const path of archiveJsonlFiles(ARCHIVE_ROOT)) {
    const parent = statSync(path);
    const started = performance.now();
    const fold = foldArchive(path);
    const micros = (performance.now() - started) * 1000;
    if (fold === undefined) continue;
    folded.push({
      path,
      parentMtime: Math.floor(parent.mtimeMs),
      parentSize: parent.size,
      ...fold,
      micros,
    });
  }
  return folded;
}

describe('foldArchive over the real archive (opt-in via AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt('folds every transcript without throwing', () => {
    const folded = foldCorpus();
    expect(folded.length).toBeGreaterThanOrEqual(MIN_FILES);
  });

  runIt('a folded key is never smaller than the parent-only key it replaces', () => {
    for (const entry of foldCorpus()) {
      expect(entry.mtime_ms, entry.path).toBeGreaterThanOrEqual(entry.parentMtime);
      expect(entry.size, entry.path).toBeGreaterThanOrEqual(entry.parentSize);
    }
  });

  runIt('sidecar_count never exceeds the tree it was counted over', () => {
    // The count is the `.jsonl` transcripts below one session directory, so it
    // is bounded by every `.jsonl` under the archive. A bound, never a count.
    const ceiling = archiveJsonlFiles(ARCHIVE_ROOT).length;
    for (const entry of foldCorpus()) {
      expect(entry.sidecar_count, entry.path).toBeGreaterThanOrEqual(0);
      expect(entry.sidecar_count, entry.path).toBeLessThan(ceiling);
    }
  });

  runIt('at least one session folds to something a parent-only key would miss', () => {
    const folded = foldCorpus();
    const differing = folded.filter(
      (entry) => entry.mtime_ms !== entry.parentMtime || entry.size !== entry.parentSize,
    );

    expect(differing.length).toBeGreaterThan(0);

    // DIAGNOSTICS ONLY, never asserted: every one of these moves under the cron.
    const widest = [...differing].sort((a, b) => b.size - a.size)[0]!;
    const slowest = [...folded].sort((a, b) => b.micros - a.micros)[0]!;
    console.log(
      `[diagnostic] ${folded.length} transcripts folded; ${differing.length} differ from a parent-only key`,
    );
    console.log(
      `[diagnostic] widest fold: ${fingerprint(widest)} over ${widest.sidecar_count} sidecars ` +
        `(parent ${widest.parentSize} bytes)`,
    );
    console.log(`[diagnostic] slowest fold: ${slowest.micros.toFixed(1)} us`);
  });
});
