// AC3 (no accessor coerces across types) and AC4's behavioural half (`isoTs`
// returns the harness's string VERBATIM, never a normalized one, never a clock
// object). The breadth half — "total under any input at all" — is
// `accessors.property.test.ts`; this file pins the exact cases the ACs name.
//
// Every "returns the fallback" expectation compares against ONE sentinel by
// reference identity. `expect(arr('abc', [])).toEqual([])` would pass for an
// accessor that allocated a fresh array and never consulted the fallback at all,
// so `toEqual` against a structural fallback proves nothing here.

import { describe, expect, it } from 'vitest';
import { arr, isoTs, num, obj, str } from '../accessors.js';

/** Unique, and of no type any accessor accepts — so a match can never alias it. */
const S = Symbol('fallback');

const ONE_MB_STRING = 'x'.repeat(1024 * 1024);

describe('AC3 — no accessor coerces across types', () => {
  // Lazy thunks, not pre-computed values: a throw must fail the case that named
  // it rather than the whole table's construction.
  it.each([
    ['num of a numeric string', (): unknown => num('5', S)],
    ['num of a boolean', (): unknown => num(true, S)],
    ['num of a boxed Number', (): unknown => num(new Number(5), S)],
    ['num of NaN', (): unknown => num(NaN, S)],
    ['num of Infinity', (): unknown => num(Infinity, S)],
    ['num of -Infinity', (): unknown => num(-Infinity, S)],
    ['num of a numeric-looking bigint', (): unknown => num(5n, S)],
    ['str of a number', (): unknown => str(5, S)],
    ['str of a boxed String', (): unknown => str(new String('x'), S)],
    ['str of null', (): unknown => str(null, S)],
    ['str of undefined', (): unknown => str(undefined, S)],
    ['arr of a plain object', (): unknown => arr({}, S)],
    ['arr of a string', (): unknown => arr('abc', S)],
    ['arr of an arraylike', (): unknown => arr({ length: 1, 0: 'a' }, S)],
    ['obj of an array', (): unknown => obj([], S)],
    ['obj of null', (): unknown => obj(null, S)],
    ['obj of a string', (): unknown => obj('abc', S)],
  ])('%s returns the fallback', (_label, call) => {
    expect(Object.is(call(), S)).toBe(true);
  });

  it('accepts its own type and returns the very same reference', () => {
    // Without this the whole table above is satisfied by five functions that
    // ignore their input and return the fallback.
    const array: unknown[] = [1];
    const record = { a: 1 };
    const text = 'hello';

    expect(Object.is(str(text, S), text)).toBe(true);
    expect(num(0, S)).toBe(0);
    expect(num(-1.5, S)).toBe(-1.5);
    expect(Object.is(arr(array, S), array)).toBe(true);
    expect(Object.is(obj(record, S), record)).toBe(true);
  });

  it('treats the empty string as present, not as absent', () => {
    // The reason the fallback is a required parameter rather than a defaulted
    // `''` (Ruling 1): `message.content` is a bare string on real human prompts,
    // so "absent" and "present but empty" must not collapse into one value.
    // `src/capture/transcript-line.ts`'s private `nonEmpty()` collapses them;
    // this must not.
    expect(str('', S)).toBe('');
  });

  it('accepts the empty array and the empty object', () => {
    const array: unknown[] = [];
    const record = {};
    expect(Object.is(arr(array, S), array)).toBe(true);
    expect(Object.is(obj(record, S), record)).toBe(true);
  });

  it('reads a null-prototype object as an object', () => {
    // `JSON.parse` with a `__proto__` key produces one, so this is reachable
    // from a real transcript, not a synthetic curiosity.
    const bare: unknown = Object.create(null);
    expect(Object.is(obj(bare, S), bare)).toBe(true);
  });
});

describe('AC4 — isoTs returns the harness string verbatim', () => {
  it('returns the very same string reference for a valid timestamp', () => {
    const stamp = '2026-08-11T12:00:00.000Z';
    expect(Object.is(isoTs(stamp, S), stamp)).toBe(true);
  });

  it('does NOT normalize an offset to UTC', () => {
    // `src/capture/transcript-line.ts` has a private `isoTs` that returns
    // `new Date(parsed).toISOString()` — the same name with inverted semantics,
    // one directory away. This assertion is the thing that stops someone later
    // "consolidating" the two: the normalizing one would answer
    // '2026-08-11T10:00:00.000Z' here.
    expect(isoTs('2026-08-11T12:00:00+02:00', S)).toBe('2026-08-11T12:00:00+02:00');
  });

  it('returns a string, never a clock object', () => {
    const result = isoTs('2026-08-11T12:00:00Z', S);
    expect(typeof result).toBe('string');
    expect(result).not.toBeInstanceOf(Date);
  });

  it.each([
    ['no fractional seconds, Z', '2026-08-11T12:00:00Z'],
    ['millisecond precision, Z', '2026-08-11T12:00:00.000Z'],
    ['nanosecond precision, Z', '2026-08-11T12:00:00.123456789Z'],
    ['positive offset', '2026-08-11T12:00:00+02:00'],
    ['negative half-hour offset', '2026-08-11T12:00:00-07:30'],
    ['zero offset spelled numerically', '2026-08-11T12:00:00.000+00:00'],
    ['the calendar-invalid 30th of February', '2026-02-30T00:00:00Z'],
  ])('accepts %s', (_label, stamp) => {
    // The last row is deliberate (Open Question 4): this module validates SHAPE.
    // Calendar validity is Task 2.2's drift signal, not a repair job here.
    expect(isoTs(stamp, S)).toBe(stamp);
  });

  it.each([
    ['a human-readable date', (): unknown => isoTs('Aug 11 2026', S)],
    ['an out-of-range month and day', (): unknown => isoTs('2026-13-45T00:00:00Z', S)],
    ['hour 24', (): unknown => isoTs('2026-08-11T24:00:00Z', S)],
    ['a missing zone', (): unknown => isoTs('2026-08-11T12:00:00', S)],
    ['a space instead of T', (): unknown => isoTs('2026-08-11 12:00:00Z', S)],
    ['trailing whitespace', (): unknown => isoTs('2026-08-11T12:00:00Z ', S)],
    ['a valid stamp embedded in prose', (): unknown => isoTs('at 2026-08-11T12:00:00Z ok', S)],
    ['the empty string', (): unknown => isoTs('', S)],
    ['epoch milliseconds', (): unknown => isoTs(1786550400000, S)],
    ['a Symbol', (): unknown => isoTs(Symbol('x'), S)],
    ['a Date object', (): unknown => isoTs(new Date(0), S)],
    ['a 1 MB string', (): unknown => isoTs(ONE_MB_STRING, S)],
  ])('rejects %s without throwing', (_label, call) => {
    expect(Object.is(call(), S)).toBe(true);
  });

  it('validates a 1 MB string well inside a pinned budget', () => {
    // Not a perf test — a regex-shape test. An anchored regex with no nested
    // quantifier runs this in ~2 ms; one with a nested quantifier backtracks for
    // seconds. The budget is loose enough to survive a loaded CI box and tight
    // enough that catastrophic backtracking cannot hide under it.
    const started = performance.now();
    expect(Object.is(isoTs(ONE_MB_STRING, S), S)).toBe(true);
    expect(Object.is(isoTs('2026-08-11T12:00:00'.padEnd(1024 * 1024, '0'), S), S)).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
