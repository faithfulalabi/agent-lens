// Task 2.2 AC1 and AC3 as a property: whatever JSON a transcript contains,
// `classifyLine` answers exactly one row per line, never throws, and never
// invents a kind. "Never drops a line" is the load-bearing half — a hole in a
// projection is invisible, whereas an `unknown` row is a thing a human can see.
//
// Fixed seed, so a counterexample reproduces on any machine. Same discipline as
// `src/archive/__tests__/mirror.property.test.ts`.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { classifyLine, type ParsedKind } from '../line.js';
import { DriftCounter } from '../drift.js';

const SEED = 20260813;
const NUM_RUNS = 300;

const KINDS: ReadonlySet<string> = new Set<ParsedKind>([
  'assistant',
  'user',
  'system',
  'attachment',
  'mode',
  'last-prompt',
  'permission-mode',
  'ai-title',
  'file-history-snapshot',
  'file-history-delta',
  'queue-operation',
  'pr-link',
  'started',
  'result',
  'unknown',
]);

const KNOWN_TYPES = [...KINDS].filter((kind) => kind !== 'unknown');

/**
 * Anything a JSONL line can be after `JSON.parse`: arbitrary JSON, an object
 * shaped like a real line, and an object shaped like a real line whose fields
 * have all been replaced by nonsense.
 */
const lineArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.jsonValue(),
  fc.record({
    type: fc.constantFrom(...KNOWN_TYPES),
    subtype: fc.string(),
    uuid: fc.jsonValue(),
    sessionId: fc.jsonValue(),
    timestamp: fc.jsonValue(),
  }),
  fc.dictionary(fc.string(), fc.jsonValue()),
);

describe('classifyLine is total over any JSON a transcript can hold', () => {
  it('answers exactly one row per line, always, with a declared kind', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 40 }), (values) => {
        const drift = new DriftCounter();
        const rows = values.map((value, index) =>
          classifyLine(value, { byteOffset: index * 100, byteLength: 0, drift }),
        );

        // N in, N out. The property the product depends on.
        expect(rows).toHaveLength(values.length);

        for (const [index, row] of rows.entries()) {
          expect(KINDS.has(row.kind)).toBe(true);
          expect(row.byte_offset).toBe(index * 100);
          // Identity is either a string the harness sent or absent — never
          // coerced, which is what makes drift able to see a type change.
          for (const field of [row.uuid, row.session_id, row.timestamp]) {
            expect(field === undefined || typeof field === 'string').toBe(true);
          }
          if (row.kind === 'unknown') expect(typeof row.raw_type).toBe('string');
        }

        // Drift is a report about a bad transcript, so it must not fail on one.
        expect(() => JSON.parse(drift.serialize())).not.toThrow();
        return true;
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('serialize() is deterministic whatever order the fields arrived in', () => {
    // AC6 asks for sorted keys so the `sessions.drift_json` column is
    // deterministic. Determinism is the property that matters, and it is
    // strictly stronger than "sorted": an INTEGER-LIKE field name jumps to the
    // front no matter how this module sorts, because JavaScript orders such keys
    // first on every object. So the run below asserts order-independence over any
    // names, and sortedness over the names that are not integers.
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue()), (fields) => {
        const forward = new DriftCounter();
        classifyLine({ ...fields, type: 'mode' }, { byteOffset: 0, byteLength: 0, drift: forward });

        const backward = new DriftCounter();
        const reversed = Object.fromEntries(Object.entries(fields).reverse());
        classifyLine(
          { ...reversed, type: 'mode' },
          { byteOffset: 0, byteLength: 0, drift: backward },
        );

        expect(backward.serialize()).toBe(forward.serialize());

        const keys = Object.keys(JSON.parse(forward.serialize()).unknown_top_level_fields ?? {});
        const notIntegers = keys.filter((key) => !/^(?:0|[1-9]\d*)$/.test(key));
        expect(notIntegers).toEqual([...notIntegers].sort());
        return true;
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('the inputs that break a naive implementation', () => {
  it('a revoked Proxy over a function is one unknown row, not a throw', () => {
    // Task 2.1's language finding: `typeof` on a revoked Proxy over a FUNCTION
    // answers 'function' without touching the revoked target, so a guard that
    // stops at `typeof` never reaches the throwing `Array.isArray`. `obj()`
    // carries the `try` for exactly this, which is why this module has none.
    const revocable = Proxy.revocable(function noop() {}, {});
    revocable.revoke();
    const drift = new DriftCounter();
    const row = classifyLine(revocable.proxy, { byteOffset: 5, byteLength: 0, drift });
    expect(row.kind).toBe('unknown');
    expect(row.byte_offset).toBe(5);
  });

  it('a revoked Proxy over an object is one unknown row, not a throw', () => {
    const revocable = Proxy.revocable({ type: 'assistant' }, {});
    revocable.revoke();
    const drift = new DriftCounter();
    expect(classifyLine(revocable.proxy, { byteOffset: 0, byteLength: 0, drift }).kind).toBe(
      'unknown',
    );
  });

  it('a line whose type collides with an Object prototype member is unknown', () => {
    // `LINE_TYPES` is a `Map` precisely for this: an object-literal table would
    // answer a function for `LINE_TYPES['toString']` and classify the line as
    // whatever that truthy hit implied.
    const drift = new DriftCounter();
    for (const type of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(classifyLine({ type }, { byteOffset: 0, byteLength: 0, drift }).kind).toBe('unknown');
    }
  });
});
