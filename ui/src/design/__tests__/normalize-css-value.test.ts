import { describe, it, expect } from 'vitest';
import { normalizeCssValue } from '../normalize-css-value';

/*
 * `@tailwindcss/vite` runs its own lightningcss `optimize()` pass, which rewrites
 * four of our token values on the way out. This normalizer exists solely so a
 * *correct* build doesn't red the parity test.
 *
 * The unequal cases below are the important half. A normalizer that collapses
 * everything to '' would make AC3 green and vacuous.
 */
describe('normalizeCssValue', () => {
  describe('the four values lightningcss actually rewrites normalize equal', () => {
    it.each([
      ['--shadow-float', '0 8px 24px rgb(0 0 0 / 0.5)', '0 8px 24px #00000080'],
      ['--default-transition-duration', '150ms', '.15s'],
      [
        '--default-transition-timing-function',
        'cubic-bezier(0.4, 0, 0.2, 1)',
        'cubic-bezier(.4, 0, .2, 1)',
      ],
      ['--animate-row-arrive', 'row-arrive 300ms ease-out 1', 'row-arrive .3s ease-out 1'],
    ])('%s', (_token, specSpelling, builtSpelling) => {
      expect(normalizeCssValue(specSpelling)).toBe(normalizeCssValue(builtSpelling));
    });
  });

  describe('genuine drift still normalizes UNEQUAL', () => {
    it.each([
      ['a different shadow alpha', '0 8px 24px rgb(0 0 0 / 0.5)', '0 8px 24px rgb(0 0 0 / 0.4)'],
      ['a different duration', '150ms', '140ms'],
      ['a different duration written in seconds', '150ms', '.14s'],
      ['a different easing curve', 'cubic-bezier(0.4, 0, 0.2, 1)', 'cubic-bezier(.4, 0, .3, 1)'],
      ['a different shadow offset', '0 8px 24px rgb(0 0 0 / 0.5)', '0 9px 24px rgb(0 0 0 / 0.5)'],
      ['a different animation name', 'row-arrive 300ms ease-out 1', 'row-arrived 300ms ease-out 1'],
      ['a different keyframe count', 'row-arrive 300ms ease-out 1', 'row-arrive 300ms ease-out 2'],
    ])('%s', (_label, a, b) => {
      expect(normalizeCssValue(a)).not.toBe(normalizeCssValue(b));
    });
  });

  describe('rule 1 — seconds become milliseconds, ms is left alone', () => {
    it.each([
      ['.15s', '150ms'],
      ['.3s', '300ms'],
      ['1.5s', '1500ms'],
      ['2s', '2000ms'],
      ['150ms', '150ms'],
      // 0.15 * 1000 is 150.00000000000003 in IEEE 754 — the rounding is real.
      ['.15s .3s', '150ms 300ms'],
    ])('%s -> %s', (input, expected) => {
      expect(normalizeCssValue(input)).toBe(expected);
    });

    it('does not eat the s in an easing keyword', () => {
      expect(normalizeCssValue('row-arrive 300ms ease-out 1')).toBe('row-arrive 300ms ease-out 1');
      expect(normalizeCssValue('live-pulse 1.5s ease-in-out infinite')).toBe(
        'live-pulse 1500ms ease-in-out infinite',
      );
    });
  });

  describe('rule 2 — colours canonicalize to lowercase 8-digit hex', () => {
    it.each([
      ['rgb(0 0 0 / 0.5)', '#00000080'],
      ['rgba(0, 0, 0, 0.5)', '#00000080'],
      ['rgb(124 140 248 / 0.15)', '#7c8cf826'],
      ['#7c8cf826', '#7c8cf826'],
      ['#7C8CF826', '#7c8cf826'],
      ['#0b0b0e', '#0b0b0eff'],
      ['#fff', '#ffffffff'],
      ['#0009', '#00000099'],
    ])('%s -> %s', (input, expected) => {
      expect(normalizeCssValue(input)).toBe(expected);
    });

    it('rounds alpha up at the .5 boundary, matching lightningcss', () => {
      // 0.5 * 255 = 127.5. Math.floor would give #0000007f and red a correct build.
      expect(normalizeCssValue('rgb(0 0 0 / 0.5)')).toBe('#00000080');
    });

    it('leaves non-colour functions alone', () => {
      expect(normalizeCssValue('cubic-bezier(0.4, 0, 0.2, 1)')).toBe(
        'cubic-bezier(0.4, 0, 0.2, 1)',
      );
    });
  });

  describe('rule 3 — decimal spellings canonicalize', () => {
    it.each([
      ['.4', '0.4'],
      ['0.50', '0.5'],
      ['1.45', '1.45'],
      ['1.30', '1.3'],
      ['cubic-bezier(.4, 0, .2, 1)', 'cubic-bezier(0.4, 0, 0.2, 1)'],
    ])('%s -> %s', (input, expected) => {
      expect(normalizeCssValue(input)).toBe(expected);
    });

    it('does not touch integers or hex digits', () => {
      expect(normalizeCssValue('0 8px 24px #00000080')).toBe('0 8px 24px #00000080');
      expect(normalizeCssValue('20px')).toBe('20px');
    });
  });

  describe('rule 4 — quote style canonicalizes without hiding a real difference', () => {
    it('single and double quoted family lists compare equal', () => {
      expect(normalizeCssValue("'Inter', ui-sans-serif, system-ui, sans-serif")).toBe(
        normalizeCssValue('"Inter", ui-sans-serif, system-ui, sans-serif'),
      );
      expect(normalizeCssValue("'JetBrains Mono', ui-monospace, 'SF Mono', monospace")).toBe(
        normalizeCssValue('"JetBrains Mono", ui-monospace, "SF Mono", monospace'),
      );
    });

    it('a different family still normalizes unequal', () => {
      expect(normalizeCssValue("'Inter', sans-serif")).not.toBe(
        normalizeCssValue('"Arial", sans-serif'),
      );
    });
  });

  describe('rule 5 — whitespace and commas collapse', () => {
    it.each([
      ['0  8px   24px', '0 8px 24px'],
      ['  150ms  ', '150ms'],
      ["'Inter' ,ui-sans-serif,  system-ui", '"Inter", ui-sans-serif, system-ui'],
      ['cubic-bezier(0.4,0,0.2,1)', 'cubic-bezier(0.4, 0, 0.2, 1)'],
    ])('%s -> %s', (input, expected) => {
      expect(normalizeCssValue(input)).toBe(expected);
    });
  });

  it('is idempotent', () => {
    for (const v of [
      '0 8px 24px rgb(0 0 0 / 0.5)',
      '.15s',
      'cubic-bezier(.4, 0, .2, 1)',
      'row-arrive .3s ease-out 1',
      "'Inter', ui-sans-serif, system-ui, sans-serif",
    ]) {
      const once = normalizeCssValue(v);
      expect(normalizeCssValue(once)).toBe(once);
    }
  });

  it('does not collapse distinct values to a single string', () => {
    // The guard against the degenerate normalizer that returns '' for everything.
    const distinct = ['150ms', '300ms', '6px', '8px', '#00000080', 'cubic-bezier(0.4, 0, 0.2, 1)'];
    expect(new Set(distinct.map(normalizeCssValue)).size).toBe(distinct.length);
  });
});
