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
// masquerade as a current one. It is NOT stamped onto stored rows in v2
// (`data-model.md:269` describes a `spans.attrs` stamp that `db/write.ts` never
// implemented); the only row-level key that says which rates priced a row is
// `projector_version`.
//
// REPROJECT POLICY: `est_cost` is stored at projection time and nothing
// re-derives it on read, while this file sits OUTSIDE the `PROJECTOR_VERSION`
// hashed trees (`projector-version.test.ts`), so a rate edit invalidates no
// cached row on its own. A rate edit that changes stored `est_cost` — any edit
// to a family a stored row uses — must bump `PROJECTOR_VERSION`
// (`transcript/version.ts`) in the same diff so every install reprojects
// through the freshness gate. Task 0.8b set the precedent (8 -> 9).

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
 * Source: Anthropic's public pricing table, supplied by the founder 2026-09-22.
 * Every row is quoted, not derived. `cache_write` is the 5-minute write rate:
 * the corpus's `cache_write` counter does not distinguish TTLs, so the 1-hour
 * rate (1.6x the 5-minute one) has no column. `cache_read` is "cache hits and
 * refreshes". Retired models are kept so old sessions still price.
 *
 * DELIBERATELY ABSENT (Task 0.8b ruling, 2026-09-22):
 * - `opus` — unpriced. No published rate exists under that string, and
 *   {@link normalizeModelKey} has no family fallback by design ("unknown
 *   families stay loud"). A session with an `opus` event carrying tokens rolls
 *   up NULL and the UI names it; that is the honest answer, not a gap.
 * - `<synthetic>` — excluded, not "unknown". It is the harness's zero-token
 *   placeholder (auth expiry, etc.); it did no billable work. The fold skips it
 *   for `sessions.model` (`transcript/line.ts`) and the roll-up ignores
 *   zero-token unpriced parts (`db/write.ts`, ROLLUP_TURN_COST_SQL), so no row
 *   or sum is ever blocked by it. Pricing it would over-promise that a rate
 *   could help.
 */
export const PRICING_TABLE: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  'claude-mythos-5-1': { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  'claude-mythos-5': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-1': { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  'claude-opus-4': { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
});

/** Human half of the version stamp — hand-bumped when rates are re-checked. */
export const PRICING_TABLE_DATE = '2026-09-22';

/**
 * `{date}+{first 8 hex of sha256(canonical table)}`. Derived rather than
 * declared: editing a rate without touching this constant is impossible, so the
 * value always identifies the exact rates in this build. It is not stamped on
 * stored rows (see the header); `projector_version` is the row-level key, which
 * is why a rate edit that changes stored `est_cost` bumps `PROJECTOR_VERSION`.
 */
export const PRICING_VERSION = `${PRICING_TABLE_DATE}+${createHash('sha256')
  .update(canonicalJson(PRICING_TABLE), 'utf8')
  .digest('hex')
  .slice(0, 8)}`;

/** A trailing Claude build stamp: `-20250929`. Anchored, so `-4-5` is safe. */
const BUILD_SUFFIX = /-\d{8}$/;

/** A context-window variant tag the harness appends: `claude-opus-5-5[1m]`. Same rate. */
const CONTEXT_TAG = /\[[^\]]*\]$/;

/** Bedrock/Vertex-style vendor prefixes: `us.anthropic.`, `anthropic.`. */
const VENDOR_PREFIX = /^(?:[a-z]{2,4}\.)?anthropic\./;

/**
 * Fold a harness-reported model id onto a family key present in
 * {@link PRICING_TABLE}, or `undefined` if the family is genuinely unknown.
 *
 * A trailing context tag (`[1m]`) is dropped first. The chain is then exact match
 * -> strip a trailing `-YYYYMMDD` build suffix -> strip a vendor prefix -> both. Folding (rather than exact-match-only) is deliberate:
 * every new Claude build id carries a fresh date stamp, and exact matching would
 * render "—" for the whole fleet the day a build ships. Unknown *families* still
 * return `undefined`, so real drift stays loud.
 */
export function normalizeModelKey(raw: string): string | undefined {
  const model = raw.replace(CONTEXT_TAG, '');
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
export function estimateCost(model: string | undefined, usage: TokenUsage): number | null {
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
