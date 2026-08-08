// Test 6 — the pure copy rule, pinned independently of any I/O.

import { describe, it, expect } from 'vitest';
import { decideCopyEnd } from '../mirror.js';

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
