// The idempotency property, re-expressed for the v2 projector. Plan 001's
// `capture/__tests__/idempotency.property.test.ts` asked "replay-twice,
// resume-from-any-point, spool-then-live-mix all converge" over a hook funnel
// that no longer exists. The two claims that survive it are the two the live
// tail is built on:
//
//   (a) REPROJECT N TIMES == REPROJECT ONCE, over `runPipeline` — the pure half.
//   (b) WHOLE-FILE REPROJECTION == COLD PROJECTION, through `projectSession` —
//       the half that writes, where delta arithmetic, a desynchronised FTS index
//       or a rollup that accumulated instead of recomputing would show up.
//
// ★ (b) IS THE SAFETY NET TASK 6.1 BETS ON. A live tail is affordable only
// because a growing file is reprojected WHOLE, and that is correct only while a
// whole reprojection lands on exactly what a cold start would have produced.
// Without this property that bet is an assumption.
//
// Fixed seed and run count, both carried over from plan 001 and both named on
// purpose: a property that fails on Tuesday and passes on Wednesday is worse than
// no property. At 100 runs the original cost 5.5 s in isolation and was the
// slowest file in the suite; at 50 it cost ~2.8 s and still drove ~300 generated
// sessions. The seed is fixed, so 50 runs is exactly the first half of the
// 100-run sequence — raising it explores strictly more, never different.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DriftCounter } from '../../transcript/drift.js';
import { foldArchive } from '../../db/freshness.js';
import { projectSession } from '../../db/write.js';
import {
  fileEnv,
  ftsIntegrityCheck,
  humanLine,
  jsonl,
  machineryLine,
  openCache,
  parseJsonl,
  seedIndexRow,
  spillMarker,
  toolCallLine,
  toolResultLine,
  writeFile,
} from '../../db/__tests__/fixtures/index.js';
import { runPipeline } from '../pipeline.js';
import { projectionSnapshot } from './fixtures.js';

const SEED = 20260726;
const NUM_RUNS = 50;

/** How many passes the "reproject" arm makes before comparing against one. */
const REPROJECTIONS = 3;

const SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

// --- Generators ------------------------------------------------------------

interface Tool {
  fails: boolean;
  denied: boolean;
  spills: boolean;
  /** False means the call is never answered — a legitimately `running` row. */
  answered: boolean;
  name: string;
  gapSec: number;
}

const arbTool: fc.Arbitrary<Tool> = fc.record({
  fails: fc.boolean(),
  denied: fc.boolean(),
  spills: fc.boolean(),
  answered: fc.boolean(),
  name: fc.constantFrom('Bash', 'Read', 'Agent'),
  gapSec: fc.integer({ min: 0, max: 5 }),
});

interface Turn {
  tools: Tool[];
  /** A harness-written user line: it segments a turn without being a prompt. */
  machinery: boolean;
}

const arbTurn: fc.Arbitrary<Turn> = fc.record({
  tools: fc.array(arbTool, { maxLength: 4 }),
  machinery: fc.boolean(),
});

const arbScript = fc.array(arbTurn, { minLength: 1, maxLength: 4 });

type Script = readonly Turn[];

/** `2026-08-14T09:00:00Z` plus `n` seconds — monotonic across the whole script. */
function at(n: number): string {
  return new Date(Date.UTC(2026, 7, 14, 9, 0, 0) + n * 1000).toISOString();
}

/** Render a script to real harness-shaped JSONL text. */
function render(script: Script): string {
  const records: unknown[] = [];
  let tick = 0;

  script.forEach((turn, ti) => {
    records.push(humanLine(`turn ${ti + 1}`, at(tick++)));
    if (turn.machinery) records.push(machineryLine(`<system-reminder>${ti}`, at(tick++)));

    turn.tools.forEach((tool, tj) => {
      const callId = `toolu_${ti + 1}_${tj + 1}`;
      records.push(toolCallLine(callId, tool.name, at(tick++)));
      tick += tool.gapSec;
      if (!tool.answered) return;

      const content = tool.spills
        ? spillMarker(`/home/USER/.claude/projects/p/${SESSION}/tool-results/${callId}.txt`)
        : `output of ${callId}`;
      const extra: Record<string, unknown> = {};
      if (tool.denied) extra.toolDenialKind = 'permission-rule';
      if (tool.fails || tool.denied) {
        // `is_error === true` exactly, on the block, which is where the ladder
        // reads it — `toolResultLine`'s default block carries no flag at all.
        extra.message = {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: callId, content, is_error: true }],
        };
      }
      records.push(toolResultLine(callId, content, at(tick++), extra));
    });
  });

  return jsonl(records);
}

function assertProperty<T>(arb: fc.Arbitrary<T>, predicate: (value: T) => void): void {
  fc.assert(fc.property(arb, predicate), { numRuns: NUM_RUNS, seed: SEED });
}

// --- (a) the pure half ------------------------------------------------------

describe('reprojecting N times equals reprojecting once (AC2)', () => {
  it('runPipeline is stable under repetition, over generated sessions', () => {
    // Every call gets its OWN DriftCounter, the way `createProjectionEnv` gives
    // each read one. Sharing it would make pass N legitimately differ from pass 1
    // and turn a real property into an accident of the counter.
    let withContent = 0;

    assertProperty(arbScript, (script) => {
      const text = render(script);
      const project = (): ReturnType<typeof runPipeline> =>
        runPipeline(parseJsonl(text).lines, { session_id: SESSION, drift: new DriftCounter() });

      const once = project();
      if (once.turns.length > 0 && once.events.length > 0) withContent += 1;
      for (let pass = 1; pass < REPROJECTIONS; pass++) expect(project()).toEqual(once);
    });

    // Anti-vacuity: two empty projections are deeply equal, so without this the
    // property could quietly degrade to comparing nothing with nothing.
    expect(withContent, 'the generator produced no projectable session at all').toBeGreaterThan(
      NUM_RUNS / 4,
    );
  });
});

// --- (b) the half that writes ----------------------------------------------

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-lens-idem-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let serial = 0;

/** A transcript on disk, written once so every projection of it shares a fold. */
function writeArchive(text: string): string {
  return writeFile(join(root, `s${(serial += 1)}.jsonl`), text);
}

/**
 * Project one archive path `passes` times into a fresh cache, and serialize.
 *
 * The same file and the same fold on every pass, which is what makes this
 * "reproject the whole file" rather than "project a different file".
 */
function projectTimes(archivePath: string, passes: number): string {
  const db: DatabaseSync = openCache();
  try {
    seedIndexRow(db, archivePath, { id: SESSION });
    const fold = foldArchive(archivePath);
    if (fold === undefined) throw new Error(`no bytes to fold at ${archivePath}`);
    for (let pass = 0; pass < passes; pass++) projectSession(db, SESSION, fileEnv(), fold);
    // The sole detector of a desynchronised FTS index — a plain count reads equal
    // in the broken state. It throws rather than returning, so it belongs here,
    // inside the arm that just wrote.
    ftsIntegrityCheck(db);
    return projectionSnapshot(db);
  } finally {
    db.close();
  }
}

describe('whole-file reprojection equals cold projection (AC2)', () => {
  it('re-projecting an unchanged file changes nothing it wrote', () => {
    let withContent = 0;

    assertProperty(arbScript, (script) => {
      const archivePath = writeArchive(render(script));
      const cold = projectTimes(archivePath, 1);
      const reprojected = projectTimes(archivePath, REPROJECTIONS);

      if ((JSON.parse(cold) as { events: unknown[] }).events.length > 0) withContent += 1;
      expect(reprojected).toBe(cold);
    });

    expect(withContent, 'no generated session produced a single event').toBeGreaterThan(
      NUM_RUNS / 4,
    );
    // 50 runs x 4 projections + a file write each, measured at 3.75 s against
    // vitest's 5 s default. An explicit timeout rather than fewer runs: the
    // original file's own header records that a property which times out prints
    // "Test timed out" instead of the counterexample, which is the failure mode
    // worth spending 20 s of headroom to avoid.
  }, 20_000);

  it('and a second, independent cold projection lands on the same bytes', () => {
    // The other direction, and the one Task 6.1 actually bets on: a live tail
    // reprojects into a warm cache while a cold start projects into an empty one,
    // and the two must be indistinguishable.
    const archivePath = writeArchive(
      render([
        { tools: [tool(), tool({ fails: true })], machinery: true },
        { tools: [tool({ spills: true }), tool({ answered: false })], machinery: false },
      ]),
    );

    const first = projectTimes(archivePath, 1);
    const second = projectTimes(archivePath, 1);

    expect((JSON.parse(first) as { events: unknown[] }).events.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    fails: false,
    denied: false,
    spills: false,
    answered: true,
    name: 'Read',
    gapSec: 1,
    ...overrides,
  };
}
