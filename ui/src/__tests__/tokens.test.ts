import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { builtCss, builtRootVars, cleanupBuilds } from './build-ui';
import {
  DESIGN_SYSTEM_PATH,
  designSystemExists,
  designSystemLines,
  parseColourFence,
} from './spec-doc';
import {
  SPEC_TOKENS,
  PROSE_SHAPE_DIFFERS,
  SPEC_WRITES_MILLISECONDS,
  isColourToken,
} from '../design/spec-tokens';
import { normalizeCssValue } from '../design/normalize-css-value';

afterAll(cleanupBuilds);

const THEME_CSS_PATH = fileURLToPath(new URL('../styles/theme.css', import.meta.url));

/*
 * AC3 — the emitted CSS custom properties match design-system.md.
 *
 * Direction matters: design-system.md is authoritative. If the emitted CSS
 * disagrees, the CSS is wrong.
 *
 * Everything below reads the *built* artifact, never the source theme.css —
 * comparing theme.css to itself would be a tautology.
 */

// Test 18 first: if the spec file moved, every other assertion here would
// silently parse nothing and go green-and-vacuous.
describe('spec file location', () => {
  it('the spec file is where the parity test thinks it is', () => {
    expect(
      designSystemExists(),
      `design-system.md not found at ${DESIGN_SYSTEM_PATH}.\n` +
        'The token parity tests read it directly, so this fails loudly rather than\n' +
        'parsing an empty token set and passing vacuously. Note internal_docs/ is\n' +
        'git-ignored by design, so this suite requires a working copy that has it.',
    ).toBe(true);
  });
});

describe('type and radius scales have exactly the shape the spec allows', () => {
  it('the type scale has exactly six steps and none exceeds 20px', async () => {
    const vars = await builtRootVars();
    // --text-*--line-height is a sibling key, not a scale step; excluded here
    // and asserted separately by the parity test.
    const steps = new Map(
      [...vars].filter(([n]) => n.startsWith('--text-') && !n.endsWith('--line-height')),
    );

    expect(new Set(steps.keys())).toEqual(
      new Set(['--text-2xs', '--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-xl']),
    );
    expect([...steps.values()].sort()).toEqual(
      ['11px', '12px', '13px', '14px', '16px', '20px'].sort(),
    );

    // "Nothing larger exists" — text-3xl must not be constructible.
    for (const px of [...steps.values()]) {
      expect(Number.parseInt(px, 10)).toBeLessThanOrEqual(20);
    }
  });

  it('the radius scale has exactly md=6px and lg=8px', async () => {
    const vars = await builtRootVars();
    const radii = new Map([...vars].filter(([n]) => n.startsWith('--radius-')));
    expect(Object.fromEntries(radii)).toEqual({ '--radius-md': '6px', '--radius-lg': '8px' });
  });
});

describe('emitted tokens match design-system.md', () => {
  it('colour tokens are set-equal to the design-system.md css fence, both directions', async () => {
    const spec = parseColourFence(designSystemLines());
    const vars = await builtRootVars();
    const emitted = new Map(
      [...vars].filter(([n]) => n.startsWith('--color-')).map(([n, v]) => [n, v.toLowerCase()]),
    );

    // Both directions: no missing token, no extra token.
    expect([...emitted.keys()].sort()).toEqual([...spec.keys()].sort());

    // Literal comparison — no colour-space maths. `#7c8cf826` stays `#7c8cf826`,
    // and the deleted mirror's `rgb(124 140 248 / 0.15)` spelling is not accepted.
    expect(Object.fromEntries(emitted)).toEqual(Object.fromEntries(spec));
  });

  it('non-colour tokens match the manifest, after canonical normalization', async () => {
    const vars = await builtRootVars();
    const nonColour = SPEC_TOKENS.filter((t) => !isColourToken(t));
    expect(nonColour.length).toBeGreaterThan(0);

    for (const token of nonColour) {
      const emitted = vars.get(token.cssVar);
      expect(emitted, `${token.cssVar} is absent from the built :root`).toBeDefined();
      // Both sides normalized: lightningcss respells four of these on the way
      // out, and a raw compare would red a correct implementation.
      expect(
        normalizeCssValue(emitted ?? ''),
        `${token.cssVar} (design-system.md:${token.specLine})`,
      ).toBe(normalizeCssValue(token.specValue));
    }
  });

  it('the design-system.md prose still states the manifest values', () => {
    const lines = designSystemLines();
    for (const token of SPEC_TOKENS) {
      const line = lines[token.specLine - 1];
      expect(
        line,
        `design-system.md has no line ${token.specLine} (for ${token.cssVar})`,
      ).toBeDefined();
      expect(
        line,
        `design-system.md:${token.specLine} no longer states ${token.cssVar}'s value.\n` +
          `  expected to find: ${token.prosePin}\n` +
          `  line reads:       ${line}\n` +
          'Either the spec changed (update theme.css and the manifest) or a line was\n' +
          'inserted above and every specLine below it shifted.',
      ).toContain(token.prosePin);
    }
  });

  it('the manifest carries the spec spelling, not the built spelling', () => {
    const nonColour = SPEC_TOKENS.filter((t) => !isColourToken(t));

    for (const token of nonColour) {
      // 1. The pin binds the manifest to the prose. Without this, an implementer
      //    facing a red parity test can paste the built value into specValue and
      //    go green — this is what makes that mistake red instead.
      if (!PROSE_SHAPE_DIFFERS.has(token.cssVar)) {
        expect(
          token.specValue,
          `${token.cssVar}: prosePin must be a substring of specValue, or the pin\n` +
            'stops binding the manifest to the spec. Add it to PROSE_SHAPE_DIFFERS\n' +
            'only if the spec genuinely writes the value in a different shape.',
        ).toContain(token.prosePin);
      }

      // 2. No specValue may carry a known lightningcss-optimized spelling.
      expect(
        token.specValue,
        `${token.cssVar}: specValue has a leading-dot decimal (.15s / cubic-bezier(.4), the\n` +
          "optimizer's spelling). Use the spec's spelling; fix normalize-css-value.ts instead.",
      ).not.toMatch(/(^|[\s(,])\.\d/);

      expect(
        token.specValue,
        `${token.cssVar}: specValue has an 8-digit hex, which is what lightningcss produces\n` +
          "from rgb(... / ...). Use the spec's spelling.",
      ).not.toMatch(/#[0-9a-f]{8}\b/);

      // 3. Seconds rule — scoped, never global. --animate-live-pulse's spec value
      //    is legitimately `1.5s`, so a global rule would contradict assertion 1.
      if (SPEC_WRITES_MILLISECONDS.includes(token.cssVar)) {
        expect(
          token.specValue,
          `${token.cssVar}: the spec writes this in ms; a seconds spelling means the\n` +
            'built value was pasted in.',
        ).not.toMatch(/\b\d+(\.\d+)?s\b/);
      }
    }
  });

  it('the manifest and the built :root agree on which tokens exist', async () => {
    // The five namespaces theme.css clears and redefines. Anything emitted into
    // them that the spec does not name is a leak — a shadcn-compat alias, or a
    // Tailwind default that survived the clear.
    const CLEARED = ['--color-', '--text-', '--radius-', '--shadow-', '--font-'];
    // Namespaces must be matched the way Tailwind DEFINES them, not by bare
    // string prefix. --font-weight-* is a separate namespace that survives
    // `--font-*: initial`, and :root really does carry --font-weight-semibold
    // (any font-semibold candidate is enough). Without this exclusion a correct
    // build reds. Tailwind's --default-font-family / --default-mono-font-family
    // plumbing needs no exclusion — it is out of scope of all five prefixes.
    const inScope = (name: string) =>
      CLEARED.some((ns) => name.startsWith(ns)) && !name.startsWith('--font-weight-');

    const vars = await builtRootVars();
    const emitted = [...vars.keys()].filter(inScope).sort();
    const expected = SPEC_TOKENS.map((t) => t.cssVar)
      .filter(inScope)
      .sort();

    expect(emitted).toEqual(expected);
  });

  it('theme.css declares `@theme static`, not a plain `@theme`', () => {
    // Pinned at the source, deliberately, because it cannot be pinned at the
    // output: the showcase currently renders a specimen for every token, so
    // every token is referenced and a plain `@theme` emits exactly the same
    // CSS. Mutation-tested — flipping `@theme static` to `@theme` today reds
    // nothing else in this suite.
    //
    // It still matters. `globals.css`'s base layer reads var(--color-background)
    // and var(--font-sans) directly, and a raw var() is not a utility candidate,
    // so it keeps nothing alive on its own. Drop `static` and the first task
    // that removes a specimen from the showcase silently removes the token from
    // :root along with it. This assertion is what stops it being tidied away as
    // redundant in the meantime.
    const source = readFileSync(THEME_CSS_PATH, 'utf8');
    expect(source, 'theme.css must use `@theme static` — see the comment in that file').toMatch(
      /@theme\s+static\s*\{/,
    );
  });

  it('keyframes live-pulse and row-arrive are emitted', async () => {
    // Direct regression test for the tree-shaking trap: with a plain `@theme`
    // instead of `@theme static`, both of these vanish and the parity tests
    // above pass vacuously.
    const css = await builtCss();
    const names = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    expect(names).toContain('live-pulse');
    expect(names).toContain('row-arrive');
  });
});
