// One assistant API turn is split across N consecutive `assistant` lines, and
// EVERY one of them carries a COPY of `message.usage`. Summing them overstates;
// reading only the first understates. Measured over the frozen archive
// (2026-08-13): across 7,575 multi-line `requestId` groups, `input_tokens`,
// `cache_read_input_tokens` and `cache_creation_input_tokens` are IDENTICAL on
// every line of every group — 0 exceptions — while `output_tokens` is monotonic
// non-decreasing and its last value is the group maximum, also 0 exceptions.
//
// So the fold is: input and cache ONCE per group, output from the LAST line.
// Both halves are load-bearing in opposite directions, which is why neither
// "sum everything" nor "take line one" is a simplification available here.
//
// Total, like `./accessors.js`: takes `unknown`, never throws, no clock, no
// filesystem, no coercion. A malformed group yields zeros, never an exception.
// Input is `unknown` rather than a parsed line type on purpose — Task 2.2's
// `ParsedLine` covers neither `message.usage` nor `requestId`, so depending on
// it would buy nothing and couple two concurrently-shipping modules.

import { num, obj, str } from './accessors.js';

/** The four token counts, folded across one `requestId` group. */
export interface FoldedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Taken once per group — constant across every line of all 7,575 measured. */
const ONCE_PER_GROUP = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

const ZERO: FoldedUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** `message.usage` as sent, or `undefined` for any line that carries none. */
function usageOf(line: unknown): Readonly<Record<string, unknown>> | undefined {
  return obj(obj(obj(line, undefined)?.message, undefined)?.usage, undefined);
}

/** `requestId` as sent, or `undefined`. A non-string id is no id. */
function requestIdOf(line: unknown): string | undefined {
  return str(obj(line, undefined)?.requestId, undefined);
}

/**
 * The group's true token cost: input and cache from the first line that supplies
 * each, `output_tokens` from the last. Zeros for an empty or usage-free group.
 *
 * `num` refuses `NaN`, `±Infinity` and numeric strings, so one corrupt field
 * degrades to a zero for that field alone and cannot poison a session total.
 */
export function foldRequestGroup(lines: readonly unknown[]): FoldedUsage {
  const folded: FoldedUsage = { ...ZERO };
  const taken = new Set<string>();

  for (const line of lines) {
    const usage = usageOf(line);
    if (usage === undefined) continue;

    for (const field of ONCE_PER_GROUP) {
      if (taken.has(field)) continue;
      const value = num(usage[field], undefined);
      if (value === undefined) continue;
      folded[field] = value;
      taken.add(field);
    }

    // Last writer wins: the final line of the group holds the whole turn's
    // output, and every earlier copy is a prefix of it.
    const output = num(usage['output_tokens'], undefined);
    if (output !== undefined) folded.output_tokens = output;
  }

  return folded;
}

/**
 * Split lines into CONTIGUOUS runs sharing a `requestId`. Every input line comes
 * back in exactly one group, so the output line count always equals the input
 * line count.
 *
 * Contiguity is the whole design. A map keyed on `requestId` would merge an id
 * that stops and later reappears into one group spanning unrelated turns, and it
 * would have to drop or bucket the lines carrying no id at all — measured at 9
 * in the archive. Each of those becomes its own singleton instead: never
 * dropped, never merged into a neighbour.
 */
export function groupByRequestId(lines: readonly unknown[]): readonly unknown[][] {
  const groups: unknown[][] = [];
  let currentId: string | undefined;

  for (const line of lines) {
    const id = requestIdOf(line);
    const last = groups[groups.length - 1];
    if (id !== undefined && id === currentId && last !== undefined) {
      last.push(line);
      continue;
    }
    groups.push([line]);
    currentId = id;
  }

  return groups;
}
