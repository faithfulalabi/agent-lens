// AC2 — the five accessors are TOTAL: no value of any shape can make one throw.
// This is the property the whole "a bad projection is a cache miss, not
// corruption" claim rests on (RFC §1), so it is asserted over generated breadth
// AND over a hand-built hostile table.
//
// The hostile table is load-bearing rather than decorative: `fc.anything()`
// cannot produce a revoked Proxy, and a revoked Proxy is the ONE input that
// breaks the obvious one-line implementations of `arr` and `obj` —
// `Array.isArray(revoked)` throws `TypeError`. The last describe in this file
// proves that by running the same table through a deliberately naive accessor
// and asserting it does throw. Without it, "zero exceptions" would be a claim
// about a generator that never produced anything dangerous.
//
// The contract is checked on the RESULT, never on the input: classifying a
// revoked Proxy requires calling something that throws, so an input-side oracle
// would be exactly as fragile as the code it is meant to check.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { arr, isoTs, num, obj, str } from '../accessors.js';

/** Fixed seed: a failing counterexample must be reproducible on any machine. */
const SEED = 20260812;

const NUM_RUNS = 500;

/** Unique, and of no type any accessor accepts — so a match can never alias it. */
const S = Symbol('fallback');

type Accessor = (value: unknown, fallback: symbol) => unknown;

const ACCESSORS: readonly (readonly [string, Accessor])[] = [
  ['str', str],
  ['num', num],
  ['arr', arr],
  ['obj', obj],
  ['isoTs', isoTs],
];

/** The narrowing each accessor promises, applied to what it returned. */
const NARROWED: Readonly<Record<string, (result: unknown) => boolean>> = {
  str: (r) => typeof r === 'string',
  num: (r) => typeof r === 'number' && Number.isFinite(r),
  arr: (r) => Array.isArray(r),
  obj: (r) => r !== null && typeof r === 'object' && !Array.isArray(r),
  isoTs: (r) => typeof r === 'string',
};

/**
 * The whole contract as one statement about one call: it does not throw, and its
 * answer is either the fallback by identity, or the input itself — the same
 * reference, correctly narrowed. That single shape covers totality, "no
 * coercion" and "no copy" at once, because any coerced or copied answer fails
 * the `Object.is` limb.
 */
function assertContract(name: string, fn: Accessor, value: unknown, label: string): void {
  let result: unknown;
  expect(() => {
    result = fn(value, S);
  }, `${name} threw on ${label}`).not.toThrow();

  if (Object.is(result, S)) return;

  expect(Object.is(result, value), `${name} answered a copy, not the input, on ${label}`).toBe(
    true,
  );
  expect(NARROWED[name]!(result), `${name} answered the wrong type on ${label}`).toBe(true);
}

/** A Proxy whose target is gone. `Array.isArray` on one throws; `typeof` does not. */
function revoked(target: object): unknown {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

/**
 * A Proxy that is alive but detonates the moment anything reads THROUGH it.
 *
 * Inert against today's accessors, and deliberately kept anyway: `typeof` and
 * `Array.isArray` read internal slots (`[[ProxyTarget]]`, `[[Call]]`) and never
 * invoke a trap, so these rows currently exercise no path a plain object does
 * not. They are the regression test for the first accessor that reads a
 * PROPERTY — `value.length`, an `in` check, a spread — because that is the
 * change that would make them fire, and it will not look dangerous when someone
 * makes it.
 */
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

function circular(): unknown {
  const node: Record<string, unknown> = {};
  node.self = node;
  return node;
}

function deeplyNested(): unknown {
  let node: unknown[] = [];
  for (let i = 0; i < 200; i += 1) node = [node];
  return node;
}

/** Built rather than written as `[, , 3]`, which `no-sparse-arrays` refuses. */
function sparse(): unknown {
  const holes = new Array<unknown>(3);
  holes[2] = 3;
  return holes;
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

/** Every input a maintainer might reasonably believe is "not really possible". */
const HOSTILE: readonly (readonly [string, () => unknown])[] = [
  ['a revoked Proxy over an array', () => revoked([])],
  ['a revoked Proxy over an object', () => revoked({})],
  ['a revoked Proxy over a function', () => revoked(() => undefined)],
  ['a booby-trapped Proxy over an object', () => booby({})],
  ['a booby-trapped Proxy over an array', () => booby([])],
  ['a 1 MB string', () => 'x'.repeat(1024 * 1024)],
  ['a 1 MB digit string', () => '2026-08-11T12:00:00'.padEnd(1024 * 1024, '0')],
  ['NaN', () => NaN],
  ['Infinity', () => Infinity],
  ['-Infinity', () => -Infinity],
  ['negative zero', () => -0],
  ['a Symbol', () => Symbol('x')],
  ['a BigInt', () => 2n],
  ['a boxed String', () => new String('x')],
  ['a boxed Number', () => new Number(5)],
  ['a boxed Boolean', () => new Boolean(false)],
  ['a null-prototype object', () => Object.create(null)],
  ['a circular object', circular],
  ['a 200-deep nested array', deeplyNested],
  ['an object whose toString and valueOf throw', hostileToPrimitive],
  ['a function', () => (): undefined => undefined],
  ['a Date', () => new Date(0)],
  ['a Map', () => new Map([['a', 1]])],
  ['a Set', () => new Set([1])],
  ['a typed array', () => new Uint8Array([1, 2, 3])],
  ['a sparse array', sparse],
  ['null', () => null],
  ['undefined', () => undefined],
  ['a valid ISO timestamp', () => '2026-08-11T12:00:00.000Z'],
  ['a plain object', () => ({ a: 1 })],
  ['a plain array', () => [1, 2, 3]],
];

describe('AC2 — every accessor is total under generated input', () => {
  it.each(ACCESSORS)('%s never throws on anything fast-check can build', (name, fn) => {
    fc.assert(
      fc.property(
        fc.anything({
          maxDepth: 4,
          withBigInt: true,
          withBoxedValues: true,
          withDate: true,
          withMap: true,
          withNullPrototype: true,
          withObjectString: true,
          withSet: true,
          withSparseArray: true,
          withTypedArray: true,
        }),
        (value) => {
          assertContract(name, fn, value, 'a generated value');
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('AC2 — every accessor is total under the hostile table', () => {
  it.each(ACCESSORS)('%s never throws on any hand-built hostile input', (name, fn) => {
    for (const [label, make] of HOSTILE) {
      assertContract(name, fn, make(), label);
    }
  });

  it('covers the inputs no generator can reach', () => {
    // Guards the table against being quietly trimmed to what fast-check already
    // covers, which would take the revoked Proxy — the only input that breaks
    // the naive implementations — out of the suite.
    const labels = HOSTILE.map(([label]) => label);
    expect(labels.filter((l) => l.includes('revoked Proxy'))).toHaveLength(3);
    expect(labels.filter((l) => l.includes('booby-trapped'))).toHaveLength(2);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('AC2 — the accessors accept their own type by reference', () => {
  // Non-vacuity for the properties above: five functions that ignored their
  // input and always answered the fallback would satisfy every "never throws"
  // assertion in this file.

  it('str and isoTs answer the identical string', () => {
    const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
    const isoArb = fc
      .tuple(
        fc.integer({ min: 1000, max: 9999 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 59 }),
        fc.option(fc.integer({ min: 0, max: 999 }), { nil: undefined }),
        fc.constantFrom('Z', '+02:00', '-07:30', '+00:00', '+14:00'),
      )
      .map(([y, mo, d, h, mi, s, ms, zone]) => {
        const fraction = ms === undefined ? '' : `.${pad(ms, 3)}`;
        return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${fraction}${zone}`;
      });

    fc.assert(
      // The grammar breadth Open Question 3 settled on: optional fractional
      // seconds, and `Z` OR `±HH:MM`. Narrowing it would turn an unmeasured
      // harness version into a silent fallback.
      fc.property(isoArb, (stamp) => {
        expect(isoTs(stamp, S)).toBe(stamp);
        expect(str(stamp, S)).toBe(stamp);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('num, arr and obj answer the identical value', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.array(fc.anything({ maxDepth: 2 })),
        fc.object({ maxDepth: 2 }),
        (n, array, record) => {
          expect(Object.is(num(n, S), n)).toBe(true);
          expect(Object.is(arr(array, S), array)).toBe(true);
          expect(Object.is(obj(record, S), record)).toBe(true);
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('the property reds when the totality it protects is broken', () => {
  // The naive implementations, verbatim as someone would first write them.
  const arrNaive = (value: unknown, fallback: symbol): unknown =>
    Array.isArray(value) ? value : fallback;
  const objNaive = (value: unknown, fallback: symbol): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value : fallback;

  it('the naive arr throws on every revoked Proxy', () => {
    const revokedRows = HOSTILE.filter(([label]) => label.includes('revoked Proxy'));
    expect(revokedRows.length).toBeGreaterThan(0);

    for (const [label, make] of revokedRows) {
      expect(() => arrNaive(make(), S), `naive arr survived ${label}`).toThrow(TypeError);
      expect(Object.is(arr(make(), S), S), `shipped arr mishandled ${label}`).toBe(true);
    }
  });

  it('the naive obj throws on every revoked Proxy it actually reaches', () => {
    // `typeof` a revoked Proxy answers from the target's callability without
    // touching the target, so a revoked Proxy over a FUNCTION exits `objNaive`
    // at the `typeof` test and never reaches `Array.isArray`. That is not a
    // reason to drop the `try` from the shipped `obj`: every object-typed value
    // still reaches the throwing call, which is the common case and the one a
    // transcript produces.
    for (const [label, make] of HOSTILE.filter(([l]) => l.includes('revoked Proxy'))) {
      const value = make();
      if (typeof value === 'object') {
        expect(() => objNaive(value, S), `naive obj survived ${label}`).toThrow(TypeError);
      } else {
        expect(typeof value, `${label} is expected to be typeof 'function'`).toBe('function');
        expect(() => objNaive(value, S)).not.toThrow();
      }
      expect(Object.is(obj(make(), S), S), `shipped obj mishandled ${label}`).toBe(true);
    }
  });

  it('the shipped accessors survive the whole table where the naive ones do not', () => {
    const throwCount = (fn: Accessor): number => {
      let thrown = 0;
      for (const [, make] of HOSTILE) {
        try {
          fn(make(), S);
        } catch {
          thrown += 1;
        }
      }
      return thrown;
    };

    // A positive count on the left is what makes the zero on the right mean
    // something: it proves the table still contains something dangerous.
    expect(throwCount(arrNaive)).toBeGreaterThan(0);
    expect(throwCount(objNaive)).toBeGreaterThan(0);
    expect(throwCount(arr)).toBe(0);
    expect(throwCount(obj)).toBe(0);
  });
});
