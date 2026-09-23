import { describe, it, expect } from 'vitest';
import {
  PRICING_TABLE,
  PRICING_TABLE_DATE,
  PRICING_VERSION,
  estimateCost,
  normalizeModelKey,
} from '../pricing.js';

describe('normalizeModelKey — AC2: versioned ids fold to a family key', () => {
  it.each([
    ['claude-opus-4-8', 'claude-opus-4-8'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['us.anthropic.claude-opus-4-8', 'claude-opus-4-8'],
    ['anthropic.claude-sonnet-5', 'claude-sonnet-5'],
    ['us.anthropic.claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    // `-4-5` is part of the family key, not a `-YYYYMMDD` build stamp.
    ['claude-sonnet-4-5', 'claude-sonnet-4-5'],
    // Task 0.8b: the undated first-party id, and its dated / vendor-prefixed forms.
    ['claude-opus-5', 'claude-opus-5'],
    ['claude-opus-5-20260901', 'claude-opus-5'],
    ['us.anthropic.claude-opus-5', 'claude-opus-5'],
    // 2026-09-22 table: newer ids, the `[1m]` context tag, and dated retired ids.
    ['claude-fable-5-1', 'claude-fable-5-1'],
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['claude-opus-4-1-20250805', 'claude-opus-4-1'],
    ['claude-opus-4-20250514', 'claude-opus-4'],
    ['claude-sonnet-4-20250514', 'claude-sonnet-4'],
    ['claude-3-5-haiku-20241022', 'claude-3-5-haiku'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeModelKey(input)).toBe(expected);
  });

  it.each([
    ['totally-unknown-9'],
    ['claude-opus-9-9'],
    ['claude-opus-9-9-20991231'],
    [''],
    // Task 0.8b ruling: no family fallback, so the bare alias stays unpriced...
    ['opus'],
    // ...and the harness's zero-token placeholder is excluded, not priced.
    ['<synthetic>'],
    // The context tag is stripped, but an unknown family behind it stays unknown.
    ['claude-opus-9-9[1m]'],
  ])('returns undefined for the unknown family %s', (input) => {
    expect(normalizeModelKey(input)).toBeUndefined();
  });
});

describe('estimateCost — AC2: unknown model is null, never zero', () => {
  it('prices a known model at USD per 1M tokens', () => {
    // claude-opus-4-8: $5 in / $25 out per 1M.
    const cost = estimateCost('claude-opus-4-8', {
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    expect(cost).toBeCloseTo(30, 10);
  });

  it('carries claude-opus-5 at the four published rates (Task 0.8b)', () => {
    // Anthropic public pricing page, read 2026-09-22: $5 / $25 / $0.50 / $6.25
    // (5-minute cache write) per MTok.
    expect(PRICING_TABLE['claude-opus-5']).toEqual({
      input: 5,
      output: 25,
      cache_read: 0.5,
      cache_write: 6.25,
    });
    const cost = estimateCost('claude-opus-5', { tokens_in: 1_000_000, tokens_out: 1_000_000 });
    expect(cost).toBeCloseTo(30, 10);
  });

  it('prices cache reads and writes separately from fresh input', () => {
    const rate = PRICING_TABLE['claude-opus-4-8']!;
    const cost = estimateCost('claude-opus-4-8', {
      tokens_in: 1000,
      tokens_out: 2000,
      cache_read: 4000,
      cache_write: 8000,
    });
    const expected =
      (1000 * rate.input + 2000 * rate.output + 4000 * rate.cache_read + 8000 * rate.cache_write) /
      1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('prices a dated build id at the family rate', () => {
    const dated = estimateCost('claude-sonnet-4-5-20250929', { tokens_in: 1_000_000 });
    const family = estimateCost('claude-sonnet-4-5', { tokens_in: 1_000_000 });
    expect(dated).not.toBeNull();
    expect(dated).toBe(family);
  });

  it.each([['totally-unknown-9'], ['gpt-4'], [''], [undefined]])(
    'returns null (not 0) for the unpriceable model %s',
    (model) => {
      // toBeNull, deliberately: `toBeFalsy` would pass on a 0 regression, and
      // "$0.00" is a lie the UI must not tell (data-model.md:269).
      expect(estimateCost(model, { tokens_in: 5000, tokens_out: 5000 })).toBeNull();
    },
  );

  it('returns 0 — not null — for zero tokens on a known model', () => {
    // "priced at zero" and "unpriceable" are different facts.
    expect(estimateCost('claude-opus-4-8', {})).toBe(0);
    expect(estimateCost('claude-opus-4-8', { tokens_in: 0, tokens_out: 0 })).toBe(0);
  });
});

describe('PRICING_TABLE — quoted rows from the 2026-09-22 public table', () => {
  it.each([
    ['claude-fable-5-1', { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 }],
    ['claude-opus-5-5', { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }],
    // Was 3/15/0.3/3.75 until 2026-09-22; the public table says 2/10.
    ['claude-sonnet-5', { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }],
  ])('%s', (key, rates) => {
    expect(PRICING_TABLE[key]).toEqual(rates);
  });
});

describe('PRICING_VERSION — derived from the table, not declared', () => {
  it('matches the documented format', () => {
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\+[0-9a-f]{8}$/);
    expect(PRICING_VERSION.startsWith(`${PRICING_TABLE_DATE}+`)).toBe(true);
  });

  it('quotes every rate in USD per 1M tokens as a finite non-negative number', () => {
    const entries = Object.entries(PRICING_TABLE);
    expect(entries.length).toBeGreaterThan(0);
    for (const [model, price] of entries) {
      for (const field of ['input', 'output', 'cache_read', 'cache_write'] as const) {
        expect(Number.isFinite(price[field]), `${model}.${field}`).toBe(true);
        expect(price[field]).toBeGreaterThanOrEqual(0);
      }
      // Output always costs at least as much as input for these models; a
      // transposed row is the likeliest hand-entry error.
      expect(price.output).toBeGreaterThanOrEqual(price.input);
    }
  });
});
