import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MetricChip } from '../MetricChip';
import { formatCost, formatDuration, formatTokens } from '../../../lib/format';

/*
 * AC2 (chip half) — Test 7 of the task plan.
 *
 * Two things this file deliberately does NOT do:
 *
 *   - It never calls `builtCss()`. `build-ui.ts` memoizes its Vite run in
 *     module scope and vitest hands every test file a fresh module registry, so
 *     a second suite asking for the built CSS pays for a whole second build.
 *     Task 5.2b brings this component under the EXISTING scan by appending it
 *     to `retokenized.test.ts`'s own source array.
 *   - It never imports from `retokenized.test.ts`. Importing a test module
 *     re-registers its suites here, which would drag that same Vite build in
 *     through the back door. The one extractor property that matters is
 *     re-checked locally below, in five lines.
 */

const CHIP_PATH = fileURLToPath(new URL('../MetricChip.tsx', import.meta.url));
const CHIP_SOURCE = readFileSync(CHIP_PATH, 'utf8');

function classesIn(markup: string): Set<string> {
  const names = new Set<string>();
  for (const attr of markup.matchAll(/class="([^"]*)"/g)) {
    for (const name of (attr[1] ?? '').split(/\s+/)) if (name) names.add(name);
  }
  return names;
}

const FULL_CHIP = <MetricChip duration="1.02s" tokens="185 tok" cost="<$0.001" />;

describe('MetricChip renders its three slots', () => {
  it('emits one chip per supplied value, in the order the design system writes them', () => {
    const markup = renderToStaticMarkup(FULL_CHIP);
    expect(markup).toContain('1.02s');
    expect(markup).toContain('185 tok');
    // `<` is escaped on the way out — the correct rendering of the spec's own
    // sub-milli-dollar example.
    expect(markup).toContain('&lt;$0.001');

    const slots = [...markup.matchAll(/data-slot="(metric-[a-z]+)"/g)].map((hit) => hit[1]);
    expect(slots).toEqual(['metric-chips', 'metric-duration', 'metric-tokens', 'metric-cost']);
  });

  it('emits nothing at all for an omitted slot', () => {
    const markup = renderToStaticMarkup(<MetricChip duration="1.02s" />);
    expect(markup).toContain('metric-duration');
    expect(markup).not.toContain('metric-tokens');
    expect(markup).not.toContain('metric-cost');
  });

  it('still emits the group wrapper when every slot is omitted', () => {
    const markup = renderToStaticMarkup(<MetricChip />);
    expect(markup).toContain('data-slot="metric-chips"');
    expect(markup).not.toContain('data-slot="metric-duration"');
  });

  it('lets a caller add classes without losing the group defaults', () => {
    /*
     * A sentinel rather than a real utility on purpose. Tailwind v4 scans this
     * file too, so naming a live utility here would emit a rule into the
     * shipped stylesheet that no component asks for. A sentinel matches nothing
     * and so compiles to nothing, while still proving `cn` passes it through.
     */
    const classes = classesIn(
      renderToStaticMarkup(<MetricChip duration="1.02s" className="caller-supplied" />),
    );
    expect(classes).toContain('caller-supplied');
    expect(classes).toContain('inline-flex');
  });

  it('composes with the formatters into the atom the design system writes', () => {
    /*
     * The two halves of this task's spine, joined: `design-system.md:141` gives
     * the atom as `1.02s · 185 tok · <$0.001`, and this reproduces it from the
     * real formatters rather than from literals. Task 5.2b wires the same pair
     * to a session row, so a drift between them surfaces here first.
     */
    const markup = renderToStaticMarkup(
      <MetricChip
        duration={formatDuration('2026-07-29T09:00:00.000Z', '2026-07-29T09:00:01.020Z')}
        tokens={`${formatTokens(185)} tok`}
        cost={formatCost(0.0004)}
      />,
    );
    expect(markup).toContain('1.02s');
    expect(markup).toContain('185 tok');
    expect(markup).toContain('&lt;$0.001');
  });
});

describe('MetricChip stays inside the agent-lens vocabulary', () => {
  it('carries the treatment design-system.md:141 specifies', () => {
    const classes = classesIn(renderToStaticMarkup(FULL_CHIP));
    // 11px mono (`text-2xs` IS the 11px step — design-system.md:107), the muted
    // foreground, the raised surface, the small radius.
    for (const token of [
      'font-mono',
      'text-2xs',
      'text-muted',
      'bg-surface-raised',
      'rounded-md',
    ]) {
      expect(classes, `the chip lost its "${token}" treatment`).toContain(token);
    }
  });

  it('never reaches for the one-word neutral background', () => {
    /*
     * Task 5.2b appends this file to retokenized.test.ts's source array, and
     * that array also feeds SHADCN_CLASS_DENYLIST — which lists `bg-muted`,
     * even though it is a real agent-lens token. Catching it here keeps 5.2b's
     * append a one-line change instead of a red suite whose message blames
     * shadcn for a class this task chose on purpose.
     */
    expect(classesIn(renderToStaticMarkup(FULL_CHIP))).not.toContain('bg-muted');
    expect(CHIP_SOURCE).not.toMatch(/(?<![\w-])bg-muted(?![\w-])/);
  });

  it('writes its classes where the built-CSS scan Task 5.2b turns on can see them', () => {
    /*
     * retokenized.test.ts's extractor reads `className="…"` literals and the
     * strings inside `cn( … )`, and nothing else — a class list hoisted into a
     * `const` and referenced as `className={NAME}` extracts as ZERO tokens.
     * That file then fails its own per-source richness bar (`> 4`) with a
     * message about the extractor rather than about this component.
     */
    const literals = [...CHIP_SOURCE.matchAll(/className="([^"]*)"/g)].flatMap((hit) =>
      (hit[1] ?? '').split(/\s+/).filter(Boolean),
    );
    expect(literals.length, 'the chip classes are not in an extractable position').toBeGreaterThan(
      4,
    );
    expect(literals).toContain('bg-surface-raised');
  });
});
