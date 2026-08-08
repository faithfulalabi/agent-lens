// Test 23 — the real corpus, opt-in and flake-free.
//
// SKIPPED BY DEFAULT. Every other test in this directory synthesizes its
// fixtures in a temp dir and never reads the developer's real
// `~/.claude/projects`; this is the single deliberate exception, gated on
// `AGENT_LENS_REAL_CORPUS=1`. It never writes to the corpus — only into a temp
// archive root.
//
// BYTE-IDENTITY IS NOT ASSERTABLE HERE, and that is the whole design of this
// test rather than a concession. The developer's own transcripts are appended to
// WHILE THE TEST RUNS — ten files under one slug changed within ten minutes of
// this being written, and the in-scope file count drifted 376 -> 384 across three
// measurements taken a day apart. So the assertion is a byte-exact PREFIX for
// every live file, upgraded to full identity only for the files whose
// `{size, mtimeNs}` is provably unchanged across a re-stat after the pass.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveOnce } from '../mirror.js';
import { discover } from '../discover.js';
import { canonicalizeTranscriptPath, resolveTranscriptRoot, statSafeBig } from '../paths.js';

const ENABLED = process.env.AGENT_LENS_REAL_CORPUS === '1';
const runIt = ENABLED ? it : it.skip;

interface SourceStat {
  size: bigint;
  mtimeNs: bigint;
  ino: bigint;
  mode: bigint;
}

function statOf(path: string): SourceStat | undefined {
  const stat = statSafeBig(path);
  return stat === undefined
    ? undefined
    : { size: stat.size, mtimeNs: stat.mtimeNs, ino: stat.ino, mode: stat.mode };
}

describe('real corpus (opt-in via AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt(
    'mirrors ~/.claude/projects as a byte-exact prefix without mutating a single source',
    () => {
      const sourceRoot = canonicalizeTranscriptPath(resolveTranscriptRoot());
      const dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-real-corpus-'));
      try {
        const archiveRoot = join(dataDir, 'archive');
        const discoveredAtStart = discover(sourceRoot, archiveRoot);
        expect(discoveredAtStart.length).toBeGreaterThan(0);

        const before = new Map<string, SourceStat>();
        for (const entry of discoveredAtStart) {
          const stat = statOf(entry.sourcePath);
          if (stat !== undefined) before.set(entry.sourcePath, stat);
        }

        const result = archiveOnce({ dataDir, transcriptRoot: sourceRoot });

        expect(result.lock.state).toBe('acquired');
        // (c) The pass saw at least as many files as were there when it started.
        expect(result.filesSeen).toBeGreaterThanOrEqual(discoveredAtStart.length);

        let identical = 0;
        for (const file of result.files) {
          if (file.source_state !== 'present' || file.archive_size === 0) continue;
          const archived = readFileSync(file.archive_path);
          const source = readFileSync(file.source_path);

          // (a) A byte-exact PREFIX, for every source that still exists.
          expect(archived.length, file.source_path).toBeLessThanOrEqual(source.length);
          expect(source.subarray(0, archived.length).equals(archived), file.source_path).toBe(true);

          // (b) Full identity only where the source provably did not move.
          const after = statOf(file.source_path);
          const start = before.get(file.source_path);
          if (
            after !== undefined &&
            start !== undefined &&
            after.size === start.size &&
            after.mtimeNs === start.mtimeNs
          ) {
            expect(archived.equals(source), file.source_path).toBe(true);
            identical++;
          }
        }
        // A live corpus still leaves the overwhelming majority of files quiescent;
        // if none were, the prefix assertions above would be the only real ones.
        expect(identical).toBeGreaterThan(0);

        // (d) Zero source mutations attributable to us. A live append grows a file
        // and moves its mtime, which we cannot forbid — but nothing we do could
        // ever change an inode or a mode, or make a source SHRINK.
        for (const [path, start] of before) {
          const after = statOf(path);
          if (after === undefined) continue; // expired mid-pass: legitimate
          expect(after.ino, path).toBe(start.ino);
          expect(after.mode, path).toBe(start.mode);
          expect(after.size >= start.size, `${path} shrank`).toBe(true);
        }

        // The archive tree exists and is non-empty.
        expect(readdirSync(archiveRoot).length).toBeGreaterThan(0);
        expect(statSync(archiveRoot).isDirectory()).toBe(true);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
    600000,
  );
});
