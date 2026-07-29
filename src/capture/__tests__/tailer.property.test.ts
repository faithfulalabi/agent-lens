// Task 3.1 AC2 as a property: whatever sequence of appends, truncations,
// rotations, in-place rewrites and restarts a transcript goes through, the
// tailer converges — it never loses a line that is still in the file, never
// duplicates one, and never fabricates one.
//
// ## Why these three invariants and not "the archives are equal"
//
// Truncation removes lines that were already ingested, and those rows correctly
// stay in the archive: `raw_events` is the record of everything that ever
// arrived, not a mirror of the file. So the honest statement of convergence is a
// SUBSET relation against a cold read of the final file, plus no-duplication and
// no-fabrication bounds. Asserting equality would force the tailer to forget
// history, which is the opposite of what the archive is for.
//
// ## Determinism
//
// Fixed `SEED` and a measured `NUM_RUNS`, per the Task 2.4 flake postmortem
// (`idempotency.property.test.ts`): a property that fails on Tuesday and passes
// on Wednesday is worse than no property. fast-check prints the counterexample
// either way, and a reviewer chasing one can raise the run count locally.

import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, upsertSession } from '../../db/index.js';
import { Broadcaster } from '../../server/sse.js';
import { tailOnce } from '../tailer.js';
import { at, freshDb, TS } from './fixtures.js';
import { projectionSnapshot } from './golden.js';

/** Fixed seed: the failing counterexample must be reproducible on any machine. */
const SEED = 20260729;

/**
 * Measured, not guessed. At 60 runs this file costs ~1.1 s while driving a few
 * hundred file mutations through the real funnel — inside the repo's ~3 s
 * per-file budget, with the same fixed seed making the coverage stable.
 */
const NUM_RUNS = 60;

const SESSION = 'sess-prop';
const SLUG = 'proj';

const dirs: string[] = [];

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// --- The generated script --------------------------------------------------

type Op =
  | { kind: 'append'; count: number }
  | { kind: 'appendPartial' }
  | { kind: 'truncate'; keep: number }
  | { kind: 'rotate' }
  | { kind: 'rewriteHead' }
  | { kind: 'restart' }
  | { kind: 'tail' };

/** A weighted op, so appends and passes dominate and the resets still show up. */
function op<T extends Op>(arbitrary: fc.Arbitrary<T>, weight: number) {
  return { arbitrary: arbitrary as fc.Arbitrary<Op>, weight };
}

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  op(
    fc.record({
      kind: fc.constant('append' as const),
      count: fc.integer({ min: 1, max: 5 }),
    }),
    4,
  ),
  op(fc.record({ kind: fc.constant('tail' as const) }), 4),
  op(fc.record({ kind: fc.constant('appendPartial' as const) }), 2),
  op(fc.record({ kind: fc.constant('truncate' as const), keep: fc.nat({ max: 6 }) }), 1),
  op(fc.record({ kind: fc.constant('rotate' as const) }), 1),
  op(fc.record({ kind: fc.constant('rewriteHead' as const) }), 1),
  op(fc.record({ kind: fc.constant('restart' as const) }), 1),
);

const arbScript = fc.array(arbOp, { minLength: 1, maxLength: 10 });

/**
 * The generated line shapes mirror the measured corpus: roughly two thirds carry
 * a `uuid`, the rest are uuid-less control records, and some of those are exact
 * duplicates of an earlier line — the case that only the byte offset keeps
 * distinct.
 */
function makeLine(index: number, mutable: string): string {
  const bucket = index % 3;
  if (bucket === 2) {
    // A uuid-less duplicate: byte-identical to every other line in this bucket.
    return JSON.stringify({ type: 'mode', sessionId: SESSION, m: mutable });
  }
  if (bucket === 1) {
    return JSON.stringify({ type: 'ai-title', sessionId: SESSION, title: 'work', m: mutable });
  }
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${index}`,
    sessionId: SESSION,
    timestamp: at(index),
    m: mutable,
  });
}

/** Mutable transcript state the script drives. */
interface Fixture {
  path: string;
  /** Complete (newline-terminated) lines currently in the file. */
  lines: string[];
  /** A line written WITHOUT its newline — the torn tail of a live writer. */
  pending: string | undefined;
  /** Next line index, so generated uuids stay unique across the script. */
  next: number;
  /** How many lines have ever been completed — the upper bound on archive rows. */
  completed: number;
}

function byteLengthOf(lines: readonly string[]): number {
  return lines.reduce((total, l) => total + Buffer.byteLength(`${l}\n`), 0);
}

function rewriteFile(path: string, lines: readonly string[]): void {
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
}

/** Terminate a torn tail line, promoting it to a complete line. */
function completePending(fixture: Fixture): void {
  if (fixture.pending === undefined) return;
  appendFileSync(fixture.path, '\n');
  fixture.lines.push(fixture.pending);
  fixture.completed += 1;
  fixture.pending = undefined;
}

/** Drop a torn tail line: any whole-file rewrite discards it. */
function dropPending(fixture: Fixture): void {
  fixture.pending = undefined;
}

function applyOp(op: Op, fixture: Fixture): void {
  switch (op.kind) {
    case 'append': {
      completePending(fixture);
      const added: string[] = [];
      for (let i = 0; i < op.count; i++) {
        added.push(makeLine(fixture.next + i, 'a'));
      }
      fixture.next += op.count;
      fixture.completed += op.count;
      fixture.lines.push(...added);
      appendFileSync(fixture.path, added.map((l) => `${l}\n`).join(''));
      return;
    }
    case 'appendPartial': {
      // A live writer caught mid-line. The tailer must consume nothing of it and
      // must not advance its offset past the last complete newline.
      if (fixture.pending !== undefined) return;
      const text = makeLine(fixture.next, 'a');
      fixture.next += 1;
      fixture.pending = text;
      appendFileSync(fixture.path, text);
      return;
    }
    case 'truncate': {
      // Suffix removal — the only shrink real transcripts perform.
      const keep = Math.min(op.keep, fixture.lines.length);
      fixture.lines = fixture.lines.slice(0, keep);
      dropPending(fixture);
      truncateSync(fixture.path, byteLengthOf(fixture.lines));
      return;
    }
    case 'rotate': {
      // Same path, same bytes, NEW inode.
      const staging = `${fixture.path}.rotated`;
      rewriteFile(staging, fixture.lines);
      renameSync(staging, fixture.path);
      dropPending(fixture);
      return;
    }
    case 'rewriteHead': {
      // In-place, same byte length, mutated head — invisible to size and inode.
      if (fixture.lines.length === 0) return;
      fixture.lines[0] = fixture.lines[0]!.replace(/"m":"."/, '"m":"b"');
      rewriteFile(fixture.path, fixture.lines);
      dropPending(fixture);
      return;
    }
    default:
      return;
  }
}

// --- Observations ----------------------------------------------------------

function transcriptIds(db: DatabaseSync): string[] {
  return (
    db
      .prepare(`SELECT id FROM raw_events WHERE source = 'transcript' ORDER BY id`)
      .all() as { id: string }[]
  ).map((row) => row.id);
}

function register(db: DatabaseSync, path: string): void {
  upsertSession(db, {
    id: SESSION,
    harness: 'claude-code',
    project_path: '/proj',
    started_at: TS,
    status: 'live',
    capture_mode: 'full',
    transcript_path: path,
  });
}

function tail(db: DatabaseSync, root: string): void {
  tailOnce(db, new Broadcaster(), { transcriptRoot: root });
}

/** Ids a fresh database gets from ONE read of the file as it stands now. */
function coldRead(root: string, path: string): string[] {
  const db = freshDb();
  try {
    register(db, path);
    tail(db, root);
    return transcriptIds(db);
  } finally {
    db.close();
  }
}

describe('tailOnce — convergence under arbitrary file events (property)', () => {
  it('never loses, duplicates, or fabricates a line', () => {
    fc.assert(
      fc.property(arbScript, (script) => {
        const root = makeDir('agent-lens-prop-root-');
        const dataDir = makeDir('agent-lens-prop-data-');
        mkdirSync(join(root, SLUG), { recursive: true });
        const path = join(root, SLUG, `${SESSION}.jsonl`);
        writeFileSync(path, '');
        const fixture: Fixture = {
          path,
          lines: [],
          pending: undefined,
          next: 0,
          completed: 0,
        };

        let db = openDb(dataDir);
        try {
          register(db, path);
          for (const op of script) {
            if (op.kind === 'tail') {
              tail(db, root);
            } else if (op.kind === 'restart') {
              db.close();
              db = openDb(dataDir);
            } else {
              applyOp(op, fixture);
            }
          }
          // Always finish with a pass, so the assertions describe a settled tailer.
          tail(db, root);

          const ids = transcriptIds(db);

          // No duplication, and no fabrication: one row per identity, never more
          // rows than lines that have ever been completed in the file.
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBeLessThanOrEqual(fixture.completed);

          const cold = coldRead(root, path);
          // No collision: a cold read of the final file yields exactly one
          // identity per line it contains. This is what goes RED if two
          // byte-identical uuid-less lines share an id — the 16.6% case.
          expect(cold).toHaveLength(fixture.lines.length);
          // No loss: everything that cold read found is already here. (Not
          // equality — lines truncated away stay archived on purpose.)
          for (const id of cold) expect(ids).toContain(id);

          // Settled: another pass over an unchanged file changes nothing.
          const before = projectionSnapshot(db);
          tail(db, root);
          expect(projectionSnapshot(db)).toBe(before);
        } finally {
          db.close();
          rmSync(root, { recursive: true, force: true });
          rmSync(dataDir, { recursive: true, force: true });
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});
