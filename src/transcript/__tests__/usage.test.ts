// AC1 and AC3 for `../usage.js`. Builders are module-local on purpose: a shared
// `__tests__/fixtures.ts` is touched by every concurrent Phase 2 branch and
// conflicts on every merge.
//
// The fold is pinned two ways, and both are needed. The EXACT INTEGER RATIOS
// below come from a hand-built fixture, so they are permanent arithmetic rather
// than a measurement that decays: for a 3-line group the copy count IS the
// ratio. The CORPUS INVARIANTS at the bottom are the durable half — they stay
// true as the archive grows, where absolute counts do not.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { foldRequestGroup, groupByRequestId } from '../usage.js';

/** One assistant line carrying `message.usage`, shaped as the harness sends it. */
function assistantLine(
  usage: Record<string, unknown> | undefined,
  requestId = 'req_01',
): Record<string, unknown> {
  return {
    type: 'assistant',
    requestId,
    message: { role: 'assistant', model: 'claude-opus-5', ...(usage && { usage }) },
  };
}

/**
 * The golden group: input and cache COPIED on all three lines, `output_tokens`
 * growing to its final value on the last. Both wrong answers are wrong here in
 * opposite directions, which is what makes one fixture pin both.
 */
const GOLDEN = [
  assistantLine({
    input_tokens: 4,
    output_tokens: 100,
    cache_creation_input_tokens: 1234,
    cache_read_input_tokens: 17702,
  }),
  assistantLine({
    input_tokens: 4,
    output_tokens: 400,
    cache_creation_input_tokens: 1234,
    cache_read_input_tokens: 17702,
  }),
  assistantLine({
    input_tokens: 4,
    output_tokens: 900,
    cache_creation_input_tokens: 1234,
    cache_read_input_tokens: 17702,
  }),
];

/** What summing every copy would answer — the naive bug, for the ratio. */
function naiveSum(lines: readonly Record<string, unknown>[], field: string): number {
  return lines.reduce((total, line) => {
    const usage = (line['message'] as Record<string, unknown>)['usage'] as Record<string, number>;
    return total + (usage[field] ?? 0);
  }, 0);
}

/** What reading only line one would answer — the opposite bug. */
function firstOnly(lines: readonly Record<string, unknown>[], field: string): number {
  const usage = (lines[0]!['message'] as Record<string, unknown>)['usage'] as Record<
    string,
    number
  >;
  return usage[field] ?? 0;
}

describe('AC1 — foldRequestGroup takes input once and output from the last line', () => {
  it('folds the golden 3-line group', () => {
    expect(foldRequestGroup(GOLDEN)).toEqual({
      input_tokens: 4,
      output_tokens: 900,
      cache_creation_input_tokens: 1234,
      cache_read_input_tokens: 17702,
    });
  });

  it('pins both wrong answers by exact integer ratio', () => {
    const folded = foldRequestGroup(GOLDEN);

    // Naive summing counts each copy: for a 3-line group the copy count IS the
    // ratio, on every field taken once per group. Exact and permanent.
    for (const field of [
      'input_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ] as const) {
      expect(naiveSum(GOLDEN, field) / folded[field], field).toBe(3.0);
    }

    // First-line-only understates output by the growth factor built in above.
    expect(folded.output_tokens / firstOnly(GOLDEN, 'output_tokens')).toBe(9.0);

    // …and the naive sum is wrong on output too, in the other direction.
    expect(naiveSum(GOLDEN, 'output_tokens')).toBeGreaterThan(folded.output_tokens);
  });

  it('is a fixed point on a single-line group', () => {
    const one = [GOLDEN[0]!];
    expect(foldRequestGroup(one)).toEqual({
      input_tokens: 4,
      output_tokens: 100,
      cache_creation_input_tokens: 1234,
      cache_read_input_tokens: 17702,
    });
  });

  it('takes the LAST output even when the group is not monotonic', () => {
    // The corpus is monotonic in all 7,575 measured groups, but the rule is
    // "last", not "max" — a fold that quietly took the maximum would agree with
    // every real group and disagree here, hiding the difference forever.
    const shrinking = [
      assistantLine({ output_tokens: 900 }),
      assistantLine({ output_tokens: 400 }),
    ];
    expect(foldRequestGroup(shrinking).output_tokens).toBe(400);
  });

  it('takes input and cache from the FIRST line that supplies each', () => {
    const partial = [
      assistantLine({ output_tokens: 1 }),
      assistantLine({ input_tokens: 7, output_tokens: 2 }),
      assistantLine({ input_tokens: 99, output_tokens: 3 }),
    ];
    const folded = foldRequestGroup(partial);
    expect(folded.input_tokens).toBe(7);
    expect(folded.output_tokens).toBe(3);
  });
});

describe('AC1 — the fold is total: zeros, never a throw, never a coercion', () => {
  const HOSTILE: readonly [string, unknown][] = [
    ['empty group', []],
    ['no usage key at all', [assistantLine(undefined)]],
    ['usage is null', [{ message: { usage: null } }]],
    ['usage is a string', [{ message: { usage: 'lots' } }]],
    ['usage is an array', [{ message: { usage: [1, 2] } }]],
    ['message is a bare string', [{ message: 'hello' }]],
    ['line is null', [null]],
    ['line is a bare string', ['not a line']],
    ['line is a number', [42]],
    ['fields are numeric strings', [assistantLine({ input_tokens: '5', output_tokens: '9' })]],
    ['fields are null', [assistantLine({ input_tokens: null, output_tokens: null })]],
    ['fields are NaN', [assistantLine({ input_tokens: NaN, output_tokens: NaN })]],
    ['fields are Infinity', [assistantLine({ input_tokens: Infinity, output_tokens: -Infinity })]],
    ['fields are booleans', [assistantLine({ input_tokens: true, output_tokens: false })]],
    ['fields are objects', [assistantLine({ input_tokens: { n: 1 } })]],
  ];

  it.each(HOSTILE)('%s folds to zeros without throwing', (_label, lines) => {
    expect(() => foldRequestGroup(lines as readonly unknown[])).not.toThrow();
    expect(foldRequestGroup(lines as readonly unknown[])).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('a revoked Proxy is a zero, not an exception', () => {
    const { proxy, revoke } = Proxy.revocable({ message: {} }, {});
    revoke();
    expect(() => foldRequestGroup([proxy])).not.toThrow();
    expect(foldRequestGroup([proxy]).output_tokens).toBe(0);
  });

  it('one corrupt field cannot poison the others', () => {
    // The reason `num` must refuse non-finite values rather than pass them
    // through: a single Infinity would otherwise make a whole session total
    // Infinity, and no downstream sum could recover from it.
    const folded = foldRequestGroup([
      assistantLine({ input_tokens: 5, output_tokens: Infinity, cache_read_input_tokens: 60 }),
    ]);
    expect(folded).toEqual({
      input_tokens: 5,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 60,
    });
    expect(Number.isFinite(folded.output_tokens)).toBe(true);
  });
});

describe('AC3 — groupByRequestId drops nothing and merges nothing it should not', () => {
  it('preserves every line, in order', () => {
    const lines = [
      assistantLine({ output_tokens: 1 }, 'req_a'),
      assistantLine({ output_tokens: 2 }, 'req_a'),
      assistantLine({ output_tokens: 3 }, 'req_b'),
    ];
    const groups = groupByRequestId(lines);

    expect(groups).toHaveLength(2);
    expect(groups.flat()).toEqual(lines);
    expect(groups.flat()).toHaveLength(lines.length);
  });

  it('a line with no requestId becomes its own singleton, never merged', () => {
    // Measured: 9 such lines in the archive. Bucketing them under a shared
    // "undefined" key would fuse unrelated turns into one group.
    const orphanA = { type: 'assistant', message: { usage: { output_tokens: 1 } } };
    const orphanB = { type: 'assistant', message: { usage: { output_tokens: 2 } } };
    const groups = groupByRequestId([orphanA, orphanB]);

    expect(groups).toEqual([[orphanA], [orphanB]]);
  });

  it('a non-string requestId is no requestId', () => {
    const lines = [assistantLine({}, 'req_a'), { requestId: 42 }, { requestId: null }];
    expect(groupByRequestId(lines)).toHaveLength(3);
  });

  it('an id that stops and reappears does NOT merge across the gap', () => {
    // The bug a `Map` keyed on requestId would have: these are two separate
    // turns that happen to share an id, and folding them together would take
    // `output_tokens` from the wrong one.
    const lines = [
      assistantLine({ output_tokens: 1 }, 'req_a'),
      assistantLine({ output_tokens: 2 }, 'req_b'),
      assistantLine({ output_tokens: 3 }, 'req_a'),
    ];
    const groups = groupByRequestId(lines);

    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.length)).toEqual([1, 1, 1]);
  });

  it('every line survives an adversarial mixed sequence', () => {
    const lines: unknown[] = [
      assistantLine({ output_tokens: 1 }, 'req_a'),
      assistantLine({ output_tokens: 2 }, 'req_a'),
      null,
      'a bare string',
      { requestId: 'req_a' },
      assistantLine({ output_tokens: 3 }, 'req_c'),
      42,
    ];
    const groups = groupByRequestId(lines);

    expect(groups.flat()).toEqual(lines);
    expect(groups.flat()).toHaveLength(lines.length);
    // `null`, the string and the number each break the run, so nothing fuses.
    expect(groups).toHaveLength(6);
  });

  it('never throws on hostile input', () => {
    const { proxy, revoke } = Proxy.revocable({ requestId: 'x' }, {});
    revoke();
    expect(() => groupByRequestId([proxy, null, undefined, 0, ''])).not.toThrow();
    expect(groupByRequestId([proxy, null, undefined, 0, '']).flat()).toHaveLength(5);
  });

  it('composes with the fold: grouped then folded is per-turn truth', () => {
    const lines = [...GOLDEN, assistantLine({ input_tokens: 8, output_tokens: 50 }, 'req_02')];
    const folded = groupByRequestId(lines).map((group) => foldRequestGroup(group));

    expect(folded).toEqual([
      {
        input_tokens: 4,
        output_tokens: 900,
        cache_creation_input_tokens: 1234,
        cache_read_input_tokens: 17702,
      },
      {
        input_tokens: 8,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    ]);
  });
});

// --- AC2: the corpus invariants, opt-in ------------------------------------

const REAL_CORPUS = process.env['AGENT_LENS_REAL_CORPUS'] === '1';
const corpusIt = REAL_CORPUS ? it : it.skip;

/** Every archived transcript. The archive is frozen; `~/.claude/projects` is not. */
function archivedTranscripts(root: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) archivedTranscripts(path, out);
    else if (entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

describe('AC2 — the fold rule holds over the real archive (AGENT_LENS_REAL_CORPUS=1)', () => {
  corpusIt(
    'every multi-line group copies input and grows output to its last line',
    () => {
      const root = join(homedir(), '.agent-lens', 'archive');
      const groups: unknown[][] = [];
      let usageLines = 0;

      for (const file of archivedTranscripts(root)) {
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const lines: unknown[] = [];
        for (const raw of text.split('\n')) {
          if (raw.trim() === '') continue;
          try {
            lines.push(JSON.parse(raw));
          } catch {
            continue;
          }
        }
        // Grouped per FILE: a requestId is unique to a session, and grouping
        // across files would fuse turns from unrelated sessions.
        for (const group of groupByRequestId(lines)) {
          const withUsage = group.filter(
            (line) => (line as { message?: { usage?: unknown } })?.message?.usage !== undefined,
          );
          usageLines += withUsage.length;
          if (withUsage.length > 1) groups.push(withUsage);
        }
      }

      // Non-vacuity: without this, an empty archive passes every assertion below.
      expect(groups.length).toBeGreaterThan(0);

      const constant: string[] = [];
      const nonMonotonic: string[] = [];
      const lastNotMax: string[] = [];

      for (const [index, group] of groups.entries()) {
        const usages = group.map(
          (line) => (line as { message: { usage: Record<string, number> } }).message.usage,
        );

        for (const field of [
          'input_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens',
        ]) {
          const values = new Set(usages.map((u) => u[field] ?? 0));
          if (values.size > 1) constant.push(`group ${index}: ${field} varies`);
        }

        const outputs = usages.map((u) => u['output_tokens'] ?? 0);
        for (let i = 1; i < outputs.length; i++) {
          if (outputs[i]! < outputs[i - 1]!) nonMonotonic.push(`group ${index}`);
        }
        if (outputs[outputs.length - 1] !== Math.max(...outputs)) lastNotMax.push(`group ${index}`);

        // The fold answers exactly what the invariants say it should.
        const folded = foldRequestGroup(group);
        expect(folded.output_tokens, `group ${index}`).toBe(outputs[outputs.length - 1]);
        expect(folded.input_tokens, `group ${index}`).toBe(usages[0]!['input_tokens'] ?? 0);
      }

      // Counts are DIAGNOSTICS. Asserting one would red every time the archive grows.
      console.log(
        `[usage] ${usageLines} usage lines, ${groups.length} multi-line requestId groups`,
      );

      // 0 exceptions is the assertion, and it stays true as the corpus grows.
      expect(constant).toEqual([]);
      expect(nonMonotonic).toEqual([]);
      expect(lastNotMax).toEqual([]);
    },
    120000,
  );
});
