// Task 2.3 AC9 — the golden scorer. `origin.kind` is the oracle; the FALLBACK is
// what gets scored.
//
// ★ Scoring the composite `isHumanPrompt` here would be a TAUTOLOGY. `origin`
// occurs only on `type:"user"` lines, so on this population the composite
// returns `origin.kind === 'human'` verbatim: FP = FN = 0 by construction,
// forever, which is precisely the "heuristic scored by eyeball" this task exists
// to prevent. `fallbackIsHuman` is exported so it can be scored WITHOUT the fast
// path in front of it, and it carries `kind === 'user'` as its own first clause
// so the standalone call cannot resurrect the 12.8x assistant defect.
//
// Gated on `AGENT_LENS_REAL_CORPUS=1`, exactly like `./archive-invariants.test.ts`.
// An unset variable SKIPS; a set variable over a missing, empty or oracle-less
// archive goes RED — every non-vacuity guard runs INSIDE the gated body.
//
// `MIN_FILES` / `MIN_LINES` are declared here rather than imported: they are
// private to each suite on purpose, so one suite's bound never silently governs
// another's.

import { describe, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { obj, str } from '../accessors.js';
import { classifyLine, type ParsedLine } from '../line.js';
import { fallbackIsHuman, isHumanPrompt } from '../human.js';
import { ARCHIVE_ROOT, archiveJsonlFiles, ctx, offsetLines, runIt } from './fixtures.js';

/** Lower bounds, well under 2026-08-13's measurement of 262 files / 43,108 lines. */
const MIN_FILES = 100;
const MIN_LINES = 20000;

/** One archived line whose `origin.kind` is readable, with what the oracle says. */
interface Scored {
  file: string;
  byteOffset: number;
  originKind: string;
  oracleHuman: boolean;
  line: ParsedLine;
}

interface Population {
  files: number;
  lines: number;
  scored: Scored[];
}

let loaded: Population | undefined;

function originPopulation(): Population {
  if (loaded !== undefined) return loaded;

  const population: Population = { files: 0, lines: 0, scored: [] };

  for (const file of archiveJsonlFiles(ARCHIVE_ROOT)) {
    population.files += 1;
    for (const entry of offsetLines(readFileSync(file).toString('utf8'))) {
      population.lines += 1;
      let json: unknown;
      try {
        json = JSON.parse(entry.text);
      } catch {
        continue;
      }

      const line = classifyLine(json, ctx(entry.byteOffset));
      // Read through the 2.1 accessors, never through `human.ts` — an oracle
      // built out of the module under test would check it against itself.
      const originKind = str(obj(line.raw.origin, undefined)?.kind, undefined);
      if (originKind === undefined) continue;

      population.scored.push({
        file,
        byteOffset: entry.byteOffset,
        originKind,
        oracleHuman: originKind === 'human',
        line,
      });
    }
  }

  loaded = population;
  return population;
}

/** Every guard that stops a green run from meaning nothing. */
function assertNonVacuous(population: Population): void {
  expect(population.files).toBeGreaterThanOrEqual(MIN_FILES);
  expect(population.lines).toBeGreaterThanOrEqual(MIN_LINES);
  expect(population.scored.length).toBeGreaterThan(0);
  // Both halves of the oracle must be populated, or one of FP / FN is free.
  expect(population.scored.filter((row) => row.oracleHuman).length).toBeGreaterThan(0);
  expect(population.scored.filter((row) => !row.oracleHuman).length).toBeGreaterThan(0);
}

describe('AC9 — the golden scorer (opt-in via AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt(
    'scores the FALLBACK in isolation against origin.kind: FP = 0 and FN = 0',
    () => {
      const population = originPopulation();
      assertNonVacuous(population);

      const falsePositives = population.scored.filter(
        (row) => !row.oracleHuman && fallbackIsHuman(row.line),
      );
      const falseNegatives = population.scored.filter(
        (row) => row.oracleHuman && !fallbackIsHuman(row.line),
      );

      const kinds = new Map<string, number>();
      for (const row of population.scored) {
        kinds.set(row.originKind, (kinds.get(row.originKind) ?? 0) + 1);
      }
      console.log('oracle population', population.scored.length, Object.fromEntries(kinds));

      // A RATIO, not a count, so the launchd cron cannot red this on a Tuesday.
      expect(falsePositives.map((row) => `${row.file}@${row.byteOffset}`)).toEqual([]);
      expect(falseNegatives.map((row) => `${row.file}@${row.byteOffset}`)).toEqual([]);
    },
    600000,
  );

  runIt(
    'WIRING ONLY — isHumanPrompt connects the guard, the fast path and the fallback',
    () => {
      // This case CANNOT fail on this population and is not evidence of
      // discrimination: after the `kind === 'user'` guard the composite is
      // `origin.kind === 'human'` verbatim. It proves the three parts are wired
      // together, nothing more, and the name says so.
      const population = originPopulation();
      assertNonVacuous(population);

      const wrong = population.scored.filter(
        (row) => isHumanPrompt(row.line).human !== row.oracleHuman,
      );
      expect(wrong.map((row) => `${row.file}@${row.byteOffset}`)).toEqual([]);
      expect(population.scored.every((row) => isHumanPrompt(row.line).path === 'origin')).toBe(
        true,
      );
    },
    600000,
  );
});
