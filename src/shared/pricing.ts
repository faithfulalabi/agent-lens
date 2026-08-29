// The bundled pricing table: model -> USD per 1M tokens, plus the cost
// estimator every usage write goes through (Task 2.4).
//
// **Bundled, versioned in-repo, zero egress** (plans/001:59). Rates are never
// fetched at runtime — a local-first tracer must not phone home to price a span.
// Shipping as a frozen `.ts` data module rather than `.json` is the same
// reasoning already recorded for TS-wrapped migrations (`db/migrations/index.ts`
// :1-3): the artifact is identical, but a TS module needs no `resolveJsonModule`,
// no `with { type: 'json' }` import attributes, and no `package.json#files` entry
// to reach `dist/`. Minor wording deviation from `spec/data-model.md:268`
// ("static JSON"); the guarantee it describes is preserved exactly.
//
// `PRICING_VERSION` is DERIVED from a hash of the table, not declared, so any
// rate edit changes the version automatically and a stale estimate can never
// masquerade as a current one. It is stamped into `spans.attrs` per
// `data-model.md:269`, which survives a mid-database pricing bump.

import { createHash } from 'node:crypto';

/**
 * Canonical JSON: recursively key-sorted, whitespace-free. `PRICING_VERSION`
 * below is a hash of it, so determinism depends entirely on this — object key
 * insertion order must not change the output.
 *
 * Lives here rather than in a shared module because this is its only caller.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}

/** Rates for one model family, all in USD per 1,000,000 tokens. */
export interface ModelPrice {
  /** Fresh (uncached) input tokens. */
  input: number;
  /** Generated output tokens. */
  output: number;
  /** Input tokens served from the prompt cache. */
  cache_read: number;
  /** Input tokens written to the prompt cache. */
  cache_write: number;
}

/** Token counts for one span. Absent fields count as zero. */
export interface TokenUsage {
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_write?: number;
}

/**
 * USD per 1M tokens, keyed by model FAMILY (no build-date suffix, no vendor
 * prefix — see {@link normalizeModelKey}).
 *
 * TODO(founder): rates unverified. These are best-guess list prices captured on
 * PRICING_TABLE_DATE and have not been reconciled against a billing statement.
 * `cache_read` is derived as 0.1x input and `cache_write` as 1.25x input (the
 * documented 5-minute-TTL ephemeral multipliers), not quoted independently.
 * Nothing consumes `est_cost` until Task 3.2, and PRICING_VERSION makes any
 * staleness auditable, so a correction is a one-line edit with no migration.
 */
export const PRICING_TABLE: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-fable-5': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  'claude-mythos-5': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-sonnet-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
});

/** Human half of the version stamp — hand-bumped when rates are re-checked. */
export const PRICING_TABLE_DATE = '2026-07-26';

/**
 * `{date}+{first 8 hex of sha256(canonical table)}`. Derived rather than
 * declared: editing a rate without touching this constant is impossible, so a
 * `pricing_version` stamped on a span always identifies the exact rates used.
 */
export const PRICING_VERSION = `${PRICING_TABLE_DATE}+${createHash('sha256')
  .update(canonicalJson(PRICING_TABLE), 'utf8')
  .digest('hex')
  .slice(0, 8)}`;

/** A trailing Claude build stamp: `-20250929`. Anchored, so `-4-5` is safe. */
const BUILD_SUFFIX = /-\d{8}$/;

/** Bedrock/Vertex-style vendor prefixes: `us.anthropic.`, `anthropic.`. */
const VENDOR_PREFIX = /^(?:[a-z]{2,4}\.)?anthropic\./;

/**
 * Fold a harness-reported model id onto a family key present in
 * {@link PRICING_TABLE}, or `undefined` if the family is genuinely unknown.
 *
 * The chain is exact match -> strip a trailing `-YYYYMMDD` build suffix -> strip
 * a vendor prefix -> both. Folding (rather than exact-match-only) is deliberate:
 * every new Claude build id carries a fresh date stamp, and exact matching would
 * render "—" for the whole fleet the day a build ships. Unknown *families* still
 * return `undefined`, so real drift stays loud.
 */
export function normalizeModelKey(model: string): string | undefined {
  const withoutVendor = model.replace(VENDOR_PREFIX, '');
  const candidates = [
    model,
    model.replace(BUILD_SUFFIX, ''),
    withoutVendor,
    withoutVendor.replace(BUILD_SUFFIX, ''),
  ];
  return candidates.find((key) => key !== '' && key in PRICING_TABLE);
}

/**
 * Estimated USD cost of one span's token usage, or **`null` when the model is
 * absent or unpriceable**. Never `0` for an unknown model: `data-model.md:269`
 * requires the UI show "—" rather than "$0.00", and a zero would silently
 * under-report every trace total. Zero tokens on a *known* model does return
 * `0` — that is a real price, not a missing one.
 */
export function estimateCost(
  model: string | undefined,
  usage: TokenUsage,
): number | null {
  if (model === undefined || model === '') return null;
  const key = normalizeModelKey(model);
  if (key === undefined) return null;
  const price = PRICING_TABLE[key]!;
  const millionths =
    (usage.tokens_in ?? 0) * price.input +
    (usage.tokens_out ?? 0) * price.output +
    (usage.cache_read ?? 0) * price.cache_read +
    (usage.cache_write ?? 0) * price.cache_write;
  return millionths / 1_000_000;
}
