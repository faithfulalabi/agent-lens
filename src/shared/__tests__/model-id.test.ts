// Task 0.17 — the id-shape regexes moved out of pricing.ts so the browser can
// share them. pricing.test.ts still pins normalizeModelKey unchanged.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripModelId } from '../model-id.js';

describe('stripModelId', () => {
  it.each([
    ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['us.anthropic.claude-haiku-4-5', 'claude-haiku-4-5'],
    ['anthropic.claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['us.anthropic.claude-sonnet-4-5-20250929[1m]', 'claude-sonnet-4-5'],
    // Anchored: a short version tail is not a build stamp.
    ['claude-fable-5-1', 'claude-fable-5-1'],
    ['gpt-4o', 'gpt-4o'],
    ['', ''],
  ])('%j -> %j', (raw, bare) => {
    expect(stripModelId(raw)).toBe(bare);
  });
});

describe('model-id.ts stays importable by the browser', () => {
  it('imports nothing at all', () => {
    const source = readFileSync(new URL('../model-id.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
