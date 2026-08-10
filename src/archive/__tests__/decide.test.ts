// Test 6 — the pure copy rule, pinned independently of any I/O. Test 3 — the
// pure seal rule, likewise: `shouldSeal` takes three named fields and none of
// them is a clock, so there is no argument an elapsed time could arrive through.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideCopyEnd, shouldSeal } from '../mirror.js';

describe('decideCopyEnd (AC2) — the one copy rule, per state and not per kind', () => {
  const cases: {
    name: string;
    input: Parameters<typeof decideCopyEnd>[0];
    expected: number;
  }[] = [
    {
      name: 'empty delta, settled, newline present -> copies nothing',
      input: { archiveSize: 100, sourceSize: 100, lastNewlineOffset: 99, settled: true },
      expected: 100,
    },
    {
      name: 'empty delta, unsettled, newline present -> copies nothing',
      input: { archiveSize: 100, sourceSize: 100, lastNewlineOffset: 99, settled: false },
      expected: 100,
    },
    {
      name: 'empty delta, settled, no newline -> copies nothing',
      input: { archiveSize: 100, sourceSize: 100, lastNewlineOffset: undefined, settled: true },
      expected: 100,
    },
    {
      name: 'empty delta, unsettled, no newline -> copies nothing',
      input: { archiveSize: 100, sourceSize: 100, lastNewlineOffset: undefined, settled: false },
      expected: 100,
    },
    {
      name: 'non-empty delta, settled, newline present -> the WHOLE delta, partial included',
      input: { archiveSize: 100, sourceSize: 180, lastNewlineOffset: 150, settled: true },
      expected: 180,
    },
    {
      name: 'non-empty delta, settled, no newline (meta.json) -> the whole file, first pass',
      input: { archiveSize: 0, sourceSize: 42, lastNewlineOffset: undefined, settled: true },
      expected: 42,
    },
    {
      name: 'non-empty delta, unsettled, newline present -> stops at the record boundary',
      input: { archiveSize: 100, sourceSize: 180, lastNewlineOffset: 150, settled: false },
      expected: 151,
    },
    {
      name: 'non-empty delta, unsettled, no newline -> copies nothing at all',
      input: { archiveSize: 0, sourceSize: 42, lastNewlineOffset: undefined, settled: false },
      expected: 0,
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(decideCopyEnd(input)).toBe(expected);
    });
  }

  it('never returns an end before the archive it is extending', () => {
    // A shrunk source is the divergence path's business, but the rule must
    // still refuse to return a truncating offset.
    expect(
      decideCopyEnd({ archiveSize: 500, sourceSize: 10, lastNewlineOffset: 5, settled: true }),
    ).toBe(500);
  });

  it('an unsettled newline at the very start of the delta still copies that one byte', () => {
    expect(
      decideCopyEnd({ archiveSize: 100, sourceSize: 200, lastNewlineOffset: 100, settled: false }),
    ).toBe(101);
  });
});

describe('shouldSeal (AC1) — one trigger, and no clock anywhere near it (Test 3)', () => {
  const cases: {
    name: string;
    input: Parameters<typeof shouldSeal>[0];
    expected: boolean;
  }[] = [
    {
      name: 'the ONLY firing row: source gone, not yet sealed, archived bytes exist',
      input: { sourceState: 'expired', alreadySealed: false, archiveSize: 4096 },
      expected: true,
    },
    {
      name: 'THE ROW THAT HOLDS TESTS 12 AND 17(b): already sealed -> never re-sealed. Every source-less entry reaches here, and the mirror’s "never append to a sealed archive" guard is unreachable with no source, so this term is the only thing protecting a planted .zst and the crash window',
      input: { sourceState: 'expired', alreadySealed: true, archiveSize: 4096 },
      expected: false,
    },
    {
      name: 'source gone but nothing archived -> nothing to seal',
      input: { sourceState: 'expired', alreadySealed: false, archiveSize: 0 },
      expected: false,
    },
    {
      name: 'source gone, already sealed, no hot bytes -> the settled steady state',
      input: { sourceState: 'expired', alreadySealed: true, archiveSize: 0 },
      expected: false,
    },
    {
      name: 'source still present -> never sealed, however large the archive',
      input: { sourceState: 'present', alreadySealed: false, archiveSize: 4096 },
      expected: false,
    },
    {
      name: 'source present and already sealed -> still never sealed',
      input: { sourceState: 'present', alreadySealed: true, archiveSize: 4096 },
      expected: false,
    },
    {
      name: 'source present, empty archive -> nothing to do',
      input: { sourceState: 'present', alreadySealed: false, archiveSize: 0 },
      expected: false,
    },
    {
      name: 'source present, sealed, empty archive -> nothing to do',
      input: { sourceState: 'present', alreadySealed: true, archiveSize: 0 },
      expected: false,
    },
    {
      name: 'diverged -> never sealed: the divergent bytes are the record and the source may yet return',
      input: { sourceState: 'diverged', alreadySealed: false, archiveSize: 4096 },
      expected: false,
    },
    {
      name: 'diverged and already sealed -> never sealed',
      input: { sourceState: 'diverged', alreadySealed: true, archiveSize: 4096 },
      expected: false,
    },
    {
      name: 'diverged with an empty archive -> never sealed',
      input: { sourceState: 'diverged', alreadySealed: false, archiveSize: 0 },
      expected: false,
    },
    {
      name: 'diverged, sealed, empty archive -> never sealed',
      input: { sourceState: 'diverged', alreadySealed: true, archiveSize: 0 },
      expected: false,
    },
  ];

  it('covers the whole 3 x 2 x 2 grid, so no combination is merely unasserted', () => {
    expect(cases).toHaveLength(12);
    expect(new Set(cases.map((c) => JSON.stringify(c.input))).size).toBe(12);
    expect(cases.filter((c) => c.expected)).toHaveLength(1);
  });

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(shouldSeal(input)).toBe(expected);
    });
  }
});

// --- Test 4: the AC's grep, scoped to the decision and paired with a control ---

const ARCHIVE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Anything that could smuggle elapsed time into a seal decision. */
const CLOCK_INPUT = /\bDate\b|Date\.now|setTimeout|setInterval|\bmtime|\bage\b|_MS\b|threshold/i;

/** `shouldSeal`'s doc comment and body, from `export function` to its closing brace. */
function shouldSealRegion(): string {
  const source = readFileSync(join(ARCHIVE_SRC, 'mirror.ts'), 'utf8');
  const start = source.indexOf('export function shouldSeal');
  expect(start, 'shouldSeal moved out of mirror.ts').toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}

/**
 * `seal.ts` minus the one `sealed_at` stamp. That stamp is an OUTPUT of the
 * seal, which is exactly why it lives here and not in the decision.
 */
function sealSourceWithoutTheStamp(): string[] {
  return readFileSync(join(ARCHIVE_SRC, 'seal.ts'), 'utf8')
    .split('\n')
    .filter((line) => !/sealed_?at/i.test(line));
}

describe('AC1 — no age or timer input reaches the seal decision (Test 4)', () => {
  it('neither shouldSeal nor seal.ts names a clock, once the output stamp is set aside', () => {
    expect(CLOCK_INPUT.test(shouldSealRegion())).toBe(false);

    const offenders = sealSourceWithoutTheStamp().filter((line) => CLOCK_INPUT.test(line));
    expect(offenders).toEqual([]);
  });

  it('the same regex DOES match lock.ts — otherwise it proves only that it is broken', () => {
    // Positive control. `lock.ts` legitimately reasons about elapsed time, so a
    // regex that had stopped matching anything would red here first.
    expect(CLOCK_INPUT.test(readFileSync(join(ARCHIVE_SRC, 'lock.ts'), 'utf8'))).toBe(true);
  });

  it('the stamp really is present, so the exemption is not hiding an empty file', () => {
    const whole = readFileSync(join(ARCHIVE_SRC, 'seal.ts'), 'utf8');
    expect(CLOCK_INPUT.test(whole)).toBe(true);
    expect(whole).toMatch(/sealedAt = new Date\(\)\.toISOString\(\)/);
  });
});
