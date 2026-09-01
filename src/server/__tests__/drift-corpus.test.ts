// AC1's corpus clause: `/api/drift`'s aggregation over the REAL archive. Opt-in
// via `AGENT_LENS_REAL_CORPUS=1`, the same gate sixteen other files open-code.
//
// ★ ASSERT PROPERTIES, PRINT COUNTS, PIN NOTHING — `resolve-corpus.test.ts:4-7`.
// The AC as drafted named three harness versions by number. Measured, the
// corpus carries ONE `version` value, and `2.1.153` occurs zero times as a
// `version` field anywhere; the string only appears as prose inside
// conversations. A literal here would be false today and false again next week,
// so the arms below say what must be TRUE of any corpus and print what this one
// happens to hold.
//
// Reads `~/.agent-lens/archive` and `~/.claude/projects` the way the other
// corpus tests do — they hardcode the home-relative roots and do not honour
// `AGENT_LENS_DIR`. The database is in memory, so nothing here writes anywhere.

import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCorpusSweep } from '../../corpus/watch.js';
import { openCache } from '../../db/__tests__/fixtures/index.js';
import { readDriftRows } from '../../db/read.js';
import { aggregateDrift } from '../api.js';

const ENABLED = process.env['AGENT_LENS_REAL_CORPUS'] === '1';
const runIt = ENABLED ? it : it.skip;

const DATA_DIR = join(homedir(), '.agent-lens');
const SOURCE_ROOT = join(homedir(), '.claude', 'projects');

/** Drive the REAL sweep — wave 1 indexes, wave 2 projects. */
function corpus(): DatabaseSync {
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
  return db;
}

describe('the drift report over the real corpus (AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt(
    'names every projected release, and reports a clean corpus as clean',
    () => {
      const db = corpus();
      try {
        const rows = readDriftRows(db);
        const report = aggregateDrift(rows);

        /*
         * ★ `coalesce` IS NOT COSMETIC. `aggregateDrift` buckets
         * `harness_version ?? 'unknown'`, while a bare `SELECT DISTINCT`
         * answers `NULL`. There are zero NULL rows today — but a Claude Code
         * release that drops the `version` field creates them, which is exactly
         * the drift this report watches for. Without the `coalesce` the alarm
         * firing would red its own corpus test.
         */
        const distinct = db
          .prepare(
            `SELECT DISTINCT coalesce(harness_version, 'unknown') AS v FROM sessions
             WHERE projection_state = 'ready'`,
          )
          .all() as unknown as { v: string }[];

        const keys = Object.keys(report.harness_versions).sort();
        expect(keys).toEqual(distinct.map((r) => r.v).sort());
        expect(keys.length).toBeGreaterThanOrEqual(1);

        // The census sums to the population, which is the whole point of
        // hoisting it above the clean-row exit: `{}` is indistinguishable from
        // a broken endpoint, and "0 drifting of N projected" is not.
        const projected = Object.values(report.harness_versions).reduce((a, b) => a + b, 0);
        expect(projected).toBe(rows.length);

        // No parse failure anywhere: `corpus/env.ts:44-47` records a non-JSON
        // line as a failed projection, and that is what "0 parse failures"
        // means. The nine-key payload carries no field for it, so it is read
        // off the table instead.
        const failed = db
          .prepare(`SELECT count(*) AS n FROM sessions WHERE projection_state = 'failed'`)
          .get() as unknown as { n: number };
        expect(failed.n).toBe(0);

        expect(report.unjoined_tool_uses).toBe(0);

        // Diagnostics, never expectations.
        console.log(
          `drift corpus: ${projected} projected session(s), ` +
            `${keys.length} harness version(s) ${JSON.stringify(report.harness_versions)}, ` +
            `${report.sessions_with_drift.length} drifting`,
        );
      } finally {
        db.close();
      }
    },
    600_000,
  );
});
