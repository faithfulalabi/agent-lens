// The five TOTAL readers every harness-supplied field is read through. "Total"
// is the literal, load-bearing property: no value of any shape can make one of
// these throw, so a malformed transcript can only ever produce a fallback —
// never an exception that aborts a projection. That is what lets a bad
// projection be a cache miss rather than corruption (RFC §1).
//
// Zero imports, zero I/O, zero clock, zero randomness. `isoTs` validates by
// anchored regex and never reaches the platform's date parser, which throws
// outright on a Symbol; `src/transcript/__tests__/module-shape.test.ts` holds
// that guarantee mechanically rather than on trust.
//
// **No coercion, ever.** `num('5')` answers the fallback, not `5`. A harness
// field that silently changed type must surface as drift (Task 2.2), not be
// quietly papered over here.
//
// **The fallback is required and generic in `F`** so "absent" and "present but
// empty" cannot collapse: `message.content` is a bare string on real human
// prompts, and a defaulted `''` would erase the difference at the one place it
// matters. The cost is verbosity at every call site, accepted deliberately.
//
// **A match answers the SAME reference, never a copy.** Copying a nested
// megabyte per read would be a perf disaster, and copying is behaviour — which
// this module must not have. `readonly` is the compile-time-only way of saying
// the projector downstream is pure.

/** The string as sent, or `fallback`. `''` is a value, not an absence. */
export function str<F>(value: unknown, fallback: F): string | F {
  return typeof value === 'string' ? value : fallback;
}

/** A finite number as sent, or `fallback`. `NaN` and `±Infinity` are not numbers here. */
export function num<F>(value: unknown, fallback: F): number | F {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The array as sent, or `fallback`. Elements stay `unknown` — reading one needs
 * another accessor. A generic `arr<T>(): T[]` would be an unchecked cast and
 * would punch a hole straight through the one door.
 *
 * The `try` is not defensive padding: `Array.isArray` THROWS a `TypeError` on a
 * revoked Proxy, which is the single input that breaks the one-line version of
 * this function. A revoked Proxy cannot be detected without calling something
 * that throws, so catching is the only total implementation.
 */
export function arr<F>(value: unknown, fallback: F): readonly unknown[] | F {
  try {
    return Array.isArray(value) ? (value as readonly unknown[]) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The object as sent — arrays and `null` excluded — or `fallback`. Same revoked
 * Proxy hazard as `arr`, reached through the same `Array.isArray` call, so the
 * same `try` is required here and for the same reason.
 *
 * A `Date` answers itself rather than the fallback: it is a non-null, non-array
 * object and `JSON.parse` can never produce one, so special-casing it would be
 * behaviour this module is not allowed to have.
 */
export function obj<F>(value: unknown, fallback: F): Readonly<Record<string, unknown>> | F {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback;
    return value as Readonly<Record<string, unknown>>;
  } catch {
    return fallback;
  }
}

/**
 * Anchored ISO-8601, deliberately shaped two ways.
 *
 * **No nested quantifier anywhere.** Every repetition is a fixed count over a
 * character class, so matching is linear: a 1 MB input resolves in ~2 ms instead
 * of backtracking for seconds. A future rewrite that nests one reintroduces
 * ReDoS on a field an untrusted file controls.
 *
 * **Grammar breadth over strictness.** Optional fractional seconds, and `Z` OR
 * `±HH:MM`. Every timestamp in the committed fixtures is `…sssZ`, but that is 4
 * scrubbed sessions rather than the corpus, and narrowing to what was measured
 * would turn an unmeasured harness version into a silent fallback — precisely
 * the failure mode this architecture exists to prevent.
 *
 * Ranges are checked (`2026-13-45` is refused) but the calendar is not
 * (`2026-02-30` passes). Shape is this module's job; a nonsense date is drift
 * for Task 2.2 to report, not damage for this module to repair.
 */
const ISO_8601 =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * The timestamp VERBATIM as the harness wrote it, or `fallback`. Never a parsed
 * date object, and never normalized: `+02:00` stays `+02:00`.
 *
 * Note the private `isoTs` in `src/capture/transcript-line.ts` does the opposite
 * — it re-emits through `toISOString()`. Same name, inverted semantics, one
 * directory away. They are not interchangeable and must not be merged.
 */
export function isoTs<F>(value: unknown, fallback: F): string | F {
  return typeof value === 'string' && ISO_8601.test(value) ? value : fallback;
}
