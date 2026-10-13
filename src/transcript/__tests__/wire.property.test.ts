// `sameValue` and `wireInputOf` are TOTAL, on `accessors.property.test.ts`'s
// terms and with its hostile table: no pair of values makes either throw.
//
// Totality matters more here than for a plain accessor, because `sameValue`
// RECURSES. The obvious implementation walks two values to an unbounded depth,
// so a self-referential pair is an infinite descent rather than a wrong answer —
// and a projector that throws is the "corruption instead of a cache miss"
// failure RFC §1 exists to prevent.
//
// The hostile table is load-bearing, not decorative: `fc.anything()` produces
// neither a revoked Proxy nor a cyclic value, and those are precisely the two
// shapes that break the naive recursion. The last describe proves the table can
// fire by running it through a deliberately naive comparison and asserting that
// one DOES throw.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sameValue, wireInputOf } from '../wire.js';

/** Fixed seed: a failing counterexample must be reproducible on any machine. */
const SEED = 20261007;

const NUM_RUNS = 500;

/** A Proxy whose target is gone. `Array.isArray` on one throws; `typeof` does not. */
function revoked(target: object): unknown {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

/** A Proxy that is alive but detonates the moment anything reads THROUGH it. */
function booby(target: object): unknown {
  const bomb = (): never => {
    throw new Error('trap');
  };
  return new Proxy(target, {
    get: bomb,
    getOwnPropertyDescriptor: bomb,
    has: bomb,
    ownKeys: bomb,
    getPrototypeOf: bomb,
  });
}

/** Two DISTINCT cyclic values: `a === b` cannot short-circuit the descent. */
function cyclic(): unknown {
  const node: Record<string, unknown> = {};
  node.self = node;
  return node;
}

function deeplyNested(depth: number): unknown {
  let node: unknown = [];
  for (let i = 0; i < depth; i += 1) node = [node];
  return node;
}

function hostileToPrimitive(): unknown {
  return {
    toString(): never {
      throw new Error('toString');
    },
    valueOf(): never {
      throw new Error('valueOf');
    },
  };
}

/** Built rather than written as `[, , 3]`, which `no-sparse-arrays` refuses. */
function sparse(): unknown {
  const holes = new Array<unknown>(3);
  holes[2] = 3;
  return holes;
}

const HOSTILE: readonly (readonly [string, () => unknown])[] = [
  ['a revoked Proxy over an object', () => revoked({})],
  ['a revoked Proxy over an array', () => revoked([])],
  ['a booby-trapped Proxy over an object', () => booby({})],
  ['a booby-trapped Proxy over an array', () => booby([])],
  ['a cyclic object', cyclic],
  ['a cyclic object nested one level down', () => ({ outer: cyclic() })],
  ['200 nested arrays', () => deeplyNested(200)],
  ['100,000 nested arrays', () => deeplyNested(100_000)],
  ['an object hostile to primitive coercion', hostileToPrimitive],
  ['a sparse array', sparse],
  ['a 1 MB string', () => 'x'.repeat(1024 * 1024)],
  ['NaN', () => NaN],
  ['negative zero', () => -0],
  ['a bigint', () => 10n],
  ['a symbol', () => Symbol('s')],
  ['a function', () => () => undefined],
  ['null', () => null],
  ['undefined', () => undefined],
];

describe('sameValue is total', () => {
  it('answers a boolean for any generated pair, and never throws', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (a, b) => {
        expect(typeof sameValue(a, b)).toBe('boolean');
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('is reflexive on anything a transcript could hold', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(sameValue(value, structuredClone(value))).toBe(true);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('is symmetric on any generated pair', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        expect(sameValue(a, b)).toBe(sameValue(b, a));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it.each(HOSTILE)('survives %s on both sides and against a plain object', (_label, make) => {
    expect(() => sameValue(make(), make())).not.toThrow();
    expect(() => sameValue(make(), { command: 'ls' })).not.toThrow();
    expect(() => sameValue({ command: 'ls' }, make())).not.toThrow();
  });
});

describe('wireInputOf is total', () => {
  it('answers an object or undefined for any generated line and id', () => {
    fc.assert(
      fc.property(fc.anything(), fc.string(), (raw, id) => {
        const answer = wireInputOf(raw, id);
        expect(answer === undefined || typeof answer === 'object').toBe(true);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it.each(HOSTILE)('survives %s as the line and as the field', (_label, make) => {
    expect(() => wireInputOf(make(), 'toolu_a')).not.toThrow();
    expect(() => wireInputOf({ wireToolInputs: make() }, 'toolu_a')).not.toThrow();
    expect(() => wireInputOf({ wireToolInputs: { toolu_a: make() } }, 'toolu_a')).not.toThrow();
  });
});

describe('the hostile table is not vacuous', () => {
  /** What someone writes when they believe the inputs are always plain JSON. */
  function naive(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((key) =>
      naive((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }

  it('breaks the naive comparison on at least one row', () => {
    const broken = HOSTILE.filter(([, make]) => {
      try {
        naive(make(), make());
        return false;
      } catch {
        return true;
      }
    });

    // Without this the "never throws" limb above could be a claim about a table
    // of inputs that were never dangerous.
    expect(broken.length).toBeGreaterThan(0);
  });

  it('names the two shapes no generator reaches', () => {
    const labels = HOSTILE.map(([label]) => label);
    expect(labels).toContain('a revoked Proxy over an object');
    expect(labels).toContain('a cyclic object');
  });
});
