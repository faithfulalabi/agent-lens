// AC2. The forward pass over a single prompt-group variable replaces a 128-hop
// `parentUuid` ancestor walk, and this file is the proof that let the walker be
// DELETED rather than ported as a fallback: it was proved EQUIVALENT, not
// approximately equivalent. A fallback that never fires is dead code that
// outlives its own proof.
//
// ★ This test names a harness field outside `src/transcript/` BY DESIGN, and
// that is exactly why `one-door.test.ts` puts test files out of scope — its
// header names this task's AC2 as the forcing case. The exemption is asserted
// there in both directions.
//
// The walker is DB-backed in `capture/merge.ts` (a primary-key lookup per hop),
// so it cannot be imported. It is reimplemented here over the same
// `ParsedLine[]`, which is the honest way to run a differential anyway: two
// independent implementations, one corpus.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DriftCounter } from '../../transcript/drift.js';
import { classifyLine, type ParsedLine } from '../../transcript/line.js';
import { archiveJsonlFiles, offsetLines } from '../../transcript/__tests__/fixtures.js';
import { runPipeline } from '../pipeline.js';

const ENABLED = process.env.AGENT_LENS_REAL_CORPUS === '1';
const runIt = ENABLED ? it : it.skip;

const ARCHIVE_ROOT = join(homedir(), '.agent-lens', 'archive');

/** Lower bounds, well under what was measured on 2026-08-14 (276 files, 45,219 lines). */
const MIN_FILES = 100;
const MIN_LINES = 20000;
/** Re-measured 2026-08-14: 40,214 agreements. Bounded, never pinned. */
const MIN_AGREEMENTS = 20000;

/** `capture/merge.ts:57`. Reproduced so the port is faithful, hop limit included. */
const MAX_ANCESTOR_HOPS = 128;

function parsedLines(file: string): ParsedLine[] {
  const drift = new DriftCounter();
  return offsetLines(readFileSync(file).toString('utf8')).map((entry) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.text);
    } catch {
      parsed = undefined;
    }
    return classifyLine(parsed, {
      byteOffset: entry.byteOffset,
      byteLength: entry.byteLength,
      drift,
    });
  });
}

function rawString(line: ParsedLine, field: string): string | undefined {
  const value: unknown = line.raw[field];
  return typeof value === 'string' ? value : undefined;
}

/** The algorithm under proof: one variable, moving forward. No tree, no lookup. */
function forwardPass(lines: readonly ParsedLine[]): {
  id: (string | undefined)[];
  segment: number[];
} {
  const id: (string | undefined)[] = [];
  const segment: number[] = [];
  let current: string | undefined;
  let index = 0;

  for (const line of lines) {
    const group = rawString(line, 'promptId');
    if (group !== undefined && group !== current) {
      current = group;
      index += 1;
    }
    id.push(current);
    segment.push(index);
  }
  return { id, segment };
}

/** `capture/merge.ts:223-243`, in memory: own id first, then up the parent chain. */
function ancestorPass(lines: readonly ParsedLine[]): (string | undefined)[] {
  const byUuid = new Map<string, ParsedLine>();
  for (const line of lines) if (line.uuid !== undefined) byUuid.set(line.uuid, line);

  return lines.map((line) => {
    let uuid: string | undefined = line.uuid;
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS && uuid !== undefined; hop += 1) {
      const at = byUuid.get(uuid);
      if (at === undefined) return undefined;
      const group = rawString(at, 'promptId');
      if (group !== undefined) return group;
      uuid = rawString(at, 'parentUuid');
    }
    return undefined;
  });
}

describe('AC2 — the forward pass agrees with the ancestor walk (opt-in via AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt(
    'reproduces 0 disagreements, and resolves strictly more often than the walk',
    () => {
      const files = archiveJsonlFiles(ARCHIVE_ROOT);
      expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);

      let lineCount = 0;
      let agreements = 0;
      const disagreements: string[] = [];
      const walkOnly: string[] = [];

      for (const file of files) {
        const lines = parsedLines(file);
        lineCount += lines.length;
        const forward = forwardPass(lines);
        const walked = ancestorPass(lines);

        for (const [index, line] of lines.entries()) {
          if (line.uuid === undefined) continue;
          const byWalk = walked[index];
          if (byWalk === undefined) continue;

          const byForward = forward.id[index];
          if (byForward === undefined) walkOnly.push(`${file}#${index}`);
          else if (byForward === byWalk) agreements += 1;
          else disagreements.push(`${file}#${index}: ${byForward} vs ${byWalk}`);
        }
      }

      expect(lineCount).toBeGreaterThanOrEqual(MIN_LINES);
      expect(disagreements.slice(0, 10)).toEqual([]);

      // The honest limit: where the walk answers, the forward pass answers the
      // same thing — and it also answers in places the walk cannot.
      expect(walkOnly.slice(0, 10)).toEqual([]);
      expect(agreements).toBeGreaterThanOrEqual(MIN_AGREEMENTS);
    },
    600000,
  );

  runIt(
    'and runPipeline partitions its turns exactly the way that forward pass does',
    () => {
      // Binds the algorithm proof above to the SHIPPED code: without this, the
      // differential would only prove that two test-local functions agree.
      const files = archiveJsonlFiles(ARCHIVE_ROOT);
      expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);

      let checked = 0;
      const split: string[] = [];

      for (const file of files) {
        const lines = parsedLines(file);
        const forward = forwardPass(lines);
        const offsetToSegment = new Map(
          lines.map((line, index) => [line.byte_offset, forward.segment[index]!]),
        );

        const { events } = runPipeline(lines, { session_id: file, drift: new DriftCounter() });
        const turnOfSegment = new Map<number, string>();
        const segmentOfTurn = new Map<string, number>();

        for (const event of events) {
          const segment = offsetToSegment.get(event.src_offset)!;
          const turn = turnOfSegment.get(segment);
          if (turn === undefined) turnOfSegment.set(segment, event.turn_id);
          else if (turn !== event.turn_id)
            split.push(`${file}: segment ${segment} spans two turns`);

          const owner = segmentOfTurn.get(event.turn_id);
          if (owner === undefined) segmentOfTurn.set(event.turn_id, segment);
          else if (owner !== segment)
            split.push(`${file}: turn ${event.turn_id} spans two segments`);
          checked += 1;
        }
      }

      expect(split.slice(0, 10)).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(MIN_AGREEMENTS);
    },
    600000,
  );
});
