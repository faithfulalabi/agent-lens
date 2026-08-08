// Test 23 — the real corpus, skipped unless `AGENT_LENS_REAL_CORPUS=1`. Full
// byte-identity is not assertable, since the corpus is appended to while the
// test runs: the assertion is a byte-exact prefix, upgraded to identity only
// where `{size, mtimeNs}` is unchanged across a re-stat.

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
        // Non-vacuity: otherwise only the weaker prefix assertions ever run.
        expect(identical).toBeGreaterThan(0);

        // (d) No source mutation attributable to us. A live append moves size and
        // mtime, but nothing we do changes an inode or mode, or shrinks a source.
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
