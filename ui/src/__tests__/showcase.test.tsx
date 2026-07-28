import { describe, it, expect, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { builtCss, cleanupBuilds, ruleBody } from './build-ui';
import { Showcase } from '../pages/Showcase';
import { SPEC_TOKENS } from '../design/spec-tokens';
import { normalizeCssValue } from '../design/normalize-css-value';

afterAll(cleanupBuilds);

/*
 * AC1 — type scale, colours, radii and fonts render per the design system.
 *
 * What is asserted here: every spec token reaches the page through a real
 * utility class, and every one of those classes actually compiles to CSS that
 * references its token. What is NOT asserted, and cannot be: whether the result
 * looks right. That is the manual eyeball pass on `npm run dev` -> /showcase.
 */

/** Class names as whole tokens. Substring matching would let `bg-accent-hover`
 *  satisfy an assertion about `bg-accent`. */
function renderedClasses(): Set<string> {
  const markup = renderToStaticMarkup(<Showcase />);
  const classes = new Set<string>();
  for (const attr of markup.matchAll(/class="([^"]*)"/g)) {
    for (const name of (attr[1] ?? '').split(/\s+/)) if (name) classes.add(name);
  }
  return classes;
}

describe('the showcase page is the visual surface for every spec token', () => {
  it('renders one literal utility class per spec token', () => {
    const classes = renderedClasses();
    for (const token of SPEC_TOKENS) {
      if (token.utilityClass === null) continue;
      expect(
        classes,
        `${token.cssVar} has no specimen on the showcase page (expected class ` +
          `"${token.utilityClass}"). A token nothing renders is a token nobody can check.`,
      ).toContain(token.utilityClass);
    }
  });

  it('every showcase utility class emits its expected shape in the built CSS', async () => {
    const css = await builtCss();

    for (const token of SPEC_TOKENS) {
      if (token.utilityClass === null) continue;
      const body = ruleBody(css, token.utilityClass);
      expect(
        body,
        `no .${token.utilityClass} rule in the built CSS for ${token.cssVar}. ` +
          'Tailwind scans raw source text, so a class name built at runtime silently ' +
          'produces nothing — check it is a full literal string.',
      ).not.toBeNull();
      const rule = body ?? '';

      switch (token.emits) {
        case 'var':
          // Closing paren included on purpose: `var(--text-2xs` is a prefix of
          // `var(--text-2xs--line-height`, so a paren-less check would let the
          // font-size declaration satisfy the line-height assertion.
          expect(rule, `.${token.utilityClass} should reference ${token.cssVar}`).toContain(
            `var(${token.cssVar})`,
          );
          break;

        case 'var-fallback':
          // Tailwind wraps these in a --tw-* override slot, so the token name is
          // present but never as the whole value.
          expect(
            rule,
            `.${token.utilityClass} should wrap ${token.cssVar} in a --tw-* fallback`,
          ).toMatch(
            new RegExp(`var\\(--tw-[a-z-]+,\\s*var\\(${token.cssVar.replace(/-/g, '\\-')}\\)\\)`),
          );
          break;

        case 'inline': {
          // Tailwind inlines the literal and never references the variable. The
          // `var(--tw-shadow-color,` wrapper sits between the lengths and the
          // colour, so the body does not contain the value contiguously — unwrap
          // before comparing or a correct build goes red.
          const decl = /--tw-shadow:\s*([^;]+)/.exec(rule)?.[1];
          expect(decl, `.${token.utilityClass} has no --tw-shadow declaration`).toBeDefined();
          const unwrapped = (decl ?? '')
            .replace(/var\(--tw-shadow-color,\s*/, '')
            .replace(/\)\s*$/, '');
          expect(normalizeCssValue(unwrapped), `.${token.utilityClass} value`).toBe(
            normalizeCssValue(token.specValue),
          );
          break;
        }
      }
    }
  });

  it('the inlined shadow really is inlined — nothing references var(--shadow-float)', async () => {
    // Pins the 'inline' classification itself. If a future Tailwind starts
    // emitting var(--shadow-float), this reds and the manifest needs updating
    // rather than the assertion above quietly testing the wrong thing.
    const css = await builtCss();
    expect(css).not.toContain('var(--shadow-float)');
    expect(css).toContain('--shadow-float:');
  });
});
