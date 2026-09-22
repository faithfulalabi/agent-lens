// Task 7.5, Test 11: the spill drain over the REAL archive. Opt-in via
// `AGENT_LENS_REAL_CORPUS=1`, the gate the other corpus suites open-code.
//
// ★ A DIAGNOSTIC, NOT A PIN. It prints what the first drain cost and what a warm
// pass costs, as `[diagnostic]` lines, and asserts only what must hold of any
// corpus: a second pass indexes nothing, and both FTS tables pass integrity.
//
// Reads `~/.agent-lens` unless `AGENT_LENS_DIR` names another data dir — unlike
// its siblings, so the numbers can be taken on a machine whose archive lives
// elsewhere. The database is in memory, so nothing here writes to either tree.

import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createArchiveReader } from '../../archive/read.js';
import { resolveArchiveRoot } from '../../archive/paths.js';
import { createCorpusSweep, createSpillIndexEnv } from '../../corpus/watch.js';
import { readHealthCounts } from '../read.js';
import { indexSpills } from '../spill-index.js';
import { ftsIntegrityCheck, openCache } from './fixtures/index.js';

const ENABLED = process.env['AGENT_LENS_REAL_CORPUS'] === '1';
const runIt = ENABLED ? it : it.skip;

const DATA_DIR = process.env['AGENT_LENS_DIR'] ?? join(homedir(), '.agent-lens');
const SOURCE_ROOT = join(homedir(), '.claude', 'projects');

describe('the spill drain over the real corpus (AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt(
    'prints the first-drain cost and the warm-pass cost',
    () => {
      const db = openCache();
      try {
        const sweep = createCorpusSweep({
          db,
          dataDir: DATA_DIR,
          transcriptRoot: SOURCE_ROOT,
          wave2DeadlineMs: Number.MAX_SAFE_INTEGER,
        });
        // Wave 2's tail drains too; clear it so the first drain below is timed alone.
        sweep.wave1();
        sweep.wave2();
        sweep.close();
        db.exec('DELETE FROM spill_fts');
        const before = readHealthCounts(db).db_bytes;

        const env = createSpillIndexEnv(db, createArchiveReader(), [
          resolveArchiveRoot(DATA_DIR),
          SOURCE_ROOT,
        ]);
        const spillRows = (
          db.prepare(`SELECT count(*) AS n FROM events WHERE output_storage = 'spill'`).get() as {
            n: number;
          }
        ).n;

        let started = performance.now();
        const first = indexSpills(db, env);
        const firstMs = performance.now() - started;

        const decompressed = (
          db
            .prepare(`SELECT coalesce(sum(length(CAST(text AS BLOB))), 0) AS n FROM spill_fts`)
            .get() as { n: number }
        ).n;

        started = performance.now();
        const warm = indexSpills(db, env);
        const warmMs = performance.now() - started;
        const after = readHealthCounts(db).db_bytes;

        console.log(`[diagnostic] data dir: ${DATA_DIR}`);
        console.log(`[diagnostic] spill rows in events: ${spillRows}`);
        console.log(
          `[diagnostic] first drain: ${first.indexed} indexed, ${first.skipped.length} skipped, ${firstMs.toFixed(1)} ms`,
        );
        if (first.skipped.length > 0) {
          console.log(`[diagnostic] skipped: ${first.skipped.join(', ')}`);
        }
        console.log(`[diagnostic] decompressed bytes indexed: ${decompressed}`);
        console.log(
          `[diagnostic] warm pass (reconcile only): ${warm.indexed} indexed, ${warm.removed} removed, ${warmMs.toFixed(2)} ms`,
        );
        console.log(`[diagnostic] db_bytes delta: ${after - before}`);

        expect(warm.indexed).toBe(0);
        expect(warm.removed).toBe(0);
        expect(() =>
          db.exec(`INSERT INTO spill_fts(spill_fts, rank) VALUES('integrity-check', 1)`),
        ).not.toThrow();
        expect(() => ftsIntegrityCheck(db)).not.toThrow();
      } finally {
        db.close();
      }
    },
    600_000,
  );
});
