import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Span, SpanStatus, SpanType, Trace, TraceTrigger } from '@shared/entities.ts';

import {
  buildTreeModel,
  flatten,
  type Row,
  type SpanRow,
  type TraceRow,
} from '../../../lib/span-tree';
import {
  atSecond,
  expandedRows,
  makeDegradedPage,
  makeLargeTree,
  makeSession,
  makeSpan,
  makeStatusPage,
  makeSyntheticTraces,
  makeTrace,
  rowsForSpans,
} from '../../../lib/__tests__/fixtures';
import { hrefFor } from '../../../lib/route-match';
import { SpanTree } from '../SpanTree';
import { TreeSpanRow } from '../SpanRow';
import { TraceGroup } from '../TraceGroup';
import { TruncationNotice } from '../TruncationNotice';
import { SessionHeader } from '../SessionHeader';
import { DEGRADED_TAGS, SPAN_VISUALS } from '../span-visuals';

/*
 * Task 5.3b's rendering half.
 *
 * `renderToStaticMarkup` only — the `ui` project has no DOM, effects never run,
 * and every component below is props-in / JSX-out precisely so one static
 * render can assert everything it does.
 *
 * ===========================================================================
 * EVERY ASSERTION BELOW IS AGAINST A PROPS-IN COMPONENT. NEVER THE CONTAINER.
 * ===========================================================================
 * `pages/SessionView.tsx` fetches inside an effect, and an effect does not fire
 * here — so a static render of it emits its pending branch and ZERO rows. A row
 * count taken from it would go red against a perfectly correct implementation,
 * which is exactly why `initialRect` is an explicit prop on `SpanTree` rather
 * than something the page module arranges.
 *
 * This file never calls `builtCss()`. `build-ui.ts` memoizes its Vite run in
 * module scope and vitest hands each file a fresh module registry, so a second
 * suite asking for the built CSS pays for a whole second build. The "does this
 * class emit a rule?" claims live in `retokenized.test.ts`, which owns it.
 */

const NOW = Date.parse('2026-07-29T09:10:00.000Z');

/** Every `treeitem` in a markup string — turn headers and span rows alike. */
function treeItemCount(markup: string): number {
  return (markup.match(/role="treeitem"/g) ?? []).length;
}

function treeMarkup(rows: readonly Row[], height: number | null): string {
  return renderToStaticMarkup(
    <SpanTree
      rows={rows}
      focusedIndex={0}
      now={NOW}
      {...(height === null ? {} : { initialRect: { width: 1280, height } })}
    />,
  );
}

/** The span rows of a one-turn page, already narrowed. */
function spanRowsOf(spans: readonly Span[], trace?: Trace): SpanRow[] {
  const rows = trace === undefined ? rowsForSpans(spans) : rowsForSpans(spans, trace);
  return rows.filter((row): row is SpanRow => row.kind === 'span');
}

function spanRowMarkup(overrides: Partial<Span>, selected = false): string {
  const row = spanRowsOf([makeSpan({ id: 'sp-under-test', ...overrides })])[0];
  expect(row, 'the fixture produced no span row').toBeDefined();
  if (row === undefined) throw new Error('unreachable');
  return renderToStaticMarkup(
    <TreeSpanRow row={row} selected={selected} focused={false} now={NOW} />,
  );
}

function traceRowMarkup(trace: Trace): string {
  const rows = flatten(
    buildTreeModel([trace], new Map([[trace.id, [makeSpan({ trace_id: trace.id })]]])),
    new Set([trace.id]),
  );
  const row = rows.find((r): r is TraceRow => r.kind === 'trace');
  if (row === undefined) throw new Error('the fixture produced no turn row');
  return renderToStaticMarkup(<TraceGroup row={row} selected={false} focused={false} />);
}

/* ------------------------------------ Test 4 — virtualization, by SCALING -- */

describe('SpanTree renders O(viewport) rows, not O(n) (Test 4, AC1a)', () => {
  const { traces, spansByTrace } = makeLargeTree();
  const { rows } = expandedRows(traces, spansByTrace);

  /*
   * The measured numbers, on @tanstack/react-virtual@3.14.9 and this repo's
   * react@18.3.1, with estimateSize 28 and overscan 8:
   *
   *   1280x720 -> 34 rows   ceil(720/28) = 26 on screen, plus 8 overscan
   *   1280x360 -> 21 rows   ceil(360/28) = 13 on screen, plus 8 overscan
   *   no rect  ->  0 rows
   *
   * The mechanism, so the numbers are not folklore: virtual-core resolves its
   * viewport as `scrollRect ?? options.initialRect`, defaults that rect to 0x0,
   * and abandons the window entirely (`range = null`) once the outer size is
   * zero. `getScrollElement()` answers null under a server render, so the prop
   * is the only viewport there is.
   */
  const tall = treeMarkup(rows, 720);
  const short = treeMarkup(rows, 360);

  it('holds 5,000 spans, so an unvirtualized render would be visibly different', () => {
    expect(rows.length).toBe(5010);
  });

  it('emits a viewport-sized window at 720px and at 360px', () => {
    expect(treeItemCount(tall)).toBe(34);
    expect(treeItemCount(short)).toBe(21);
  });

  it('emits STRICTLY MORE rows into the taller viewport', () => {
    /*
     * The assertion a constant slice cannot satisfy, and the reason a
     * single-viewport band was not enough: "> 8 and < 80 rows at 1280x720" is
     * equally satisfied by "rows scale with the viewport" and by "rows are a
     * hardcoded 50-row slice", and only this comparison tells them apart.
     *
     * Three mutation checks: bypass the virtualizer and both counts become
     * 5,010; drop `initialRect` and both become 0; return a fixed-size slice
     * and the two counts become equal.
     */
    expect(treeItemCount(tall)).toBeGreaterThan(treeItemCount(short));
    expect(treeItemCount(tall)).toBeLessThan(rows.length / 10);
  });

  it('emits nothing at all without a viewport, which is why the prop exists', () => {
    expect(
      treeItemCount(treeMarkup(rows, null)),
      'this is the shape an effect-fed page module renders, and asserting a row ' +
        'count against one would red a correct implementation.',
    ).toBe(0);
  });

  it('sizes the scroll canvas for the whole list, not for the window', () => {
    // The scrollbar has to describe 5,010 rows even though 34 exist in the
    // document, or the session would appear to be 34 rows long.
    expect(tall).toContain(`height:${rows.length * 28}px`);
  });

  it('places rows with an offset from the top and never with a translation', () => {
    // React drops the unit on a zero, so the first row's offset is a bare `0`.
    expect(tall).toContain('style="top:0"');
    expect(tall).toContain('style="top:28px"');
    expect(
      tall,
      'the library example repositions rows with a CSS translation, and the ' +
        'bare word naming that property is a Tailwind utility candidate — ' +
        'writing it anywhere in this directory emits a dead rule.',
    ).not.toContain('translate');
  });
});

/* ------------------------------------- Test 5 — the model's own complexity -- */

/*
 * MEASURED AS A RATIO, NOT AGAINST A WALL-CLOCK CEILING.
 *
 * The first version of this test asserted "5,000 spans in under 250 ms" and it
 * FLAKED — this suite runs 68 files in parallel, three of which shell out to a
 * real `vite build`, so a step that takes 15 ms unloaded can take an order of
 * magnitude longer while sharing a machine. A ceiling that survives that is too
 * loose to catch anything; the honest fix is to stop measuring speed.
 *
 * So the same work is timed at two sizes in the same process, under the same
 * load, and only the RATIO is asserted. Five times the input costs about five
 * times the work when the implementation is linear and about twenty-five times
 * when it is not — and a busy machine slows both measurements together, which
 * is exactly what makes the ratio stable where the ceiling was not.
 *
 * The minimum of several runs is used rather than the mean: noise can only ever
 * ADD time, so the fastest observation is the closest one to the real cost.
 */
function bestBuildMs(spanCount: number): number {
  const { traces, spansByTrace } = makeLargeTree({ traces: 10, spansPerTrace: spanCount / 10 });
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const model = buildTreeModel(traces, spansByTrace);
    flatten(model, model.rowIds);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('the row model builds within a complexity budget (Test 5, AC1a)', () => {
  it('builds and flattens 5,000 spans into the row list', () => {
    const { traces, spansByTrace } = makeLargeTree();
    const model = buildTreeModel(traces, spansByTrace);
    expect(flatten(model, model.rowIds).length).toBe(5010);
  });

  it('costs about five times as much for five times the spans, not twenty-five', () => {
    // Floored so the ratio cannot be manufactured by a baseline that rounded to
    // zero — on a fast machine 1,000 spans genuinely can measure under 1 ms.
    const small = Math.max(bestBuildMs(1000), 0.05);
    const large = bestBuildMs(5000);
    const ratio = large / small;

    expect(
      ratio,
      `5,000 spans cost ${ratio.toFixed(1)}x what 1,000 cost. Linear is ~5x and ` +
        'quadratic is ~25x, so this guards COMPLEXITY — an accidental ' +
        'quadratic, say a parent lookup by scan rather than by map. It is NOT ' +
        'a proxy for the 2-second open: that bar needs a real browser and is ' +
        'measured by hand until the Phase 8 harness lands.',
    ).toBeLessThan(12);
  });
});

/* ---------------------------- Test 8 — the keyboard really is bound --------- */

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('the keyboard handler is bound and the tabindex roves (Test 8)', () => {
  /*
   * Source text, and the reason is worth stating: there is no document here, so
   * a keystroke cannot be delivered and the behavioural proof belongs to Phase
   * 8's harness. `router.test.ts` treats its own window binding exactly this
   * way. What IS proven behaviourally is the reducer itself, in
   * `lib/__tests__/tree-nav.test.ts` — this only asserts the wire between them.
   */
  it('the tree passes its onKeyDown down to the real scroll element', () => {
    const source = sourceOf('../SpanTree.tsx');
    expect(source).toMatch(/onKeyDown=\{onKeyDown\}/);
    expect(source, 'the handler belongs on the element that actually scrolls').toMatch(
      /ref=\{scrollRef\}[\s\S]{0,400}onKeyDown=\{onKeyDown\}/,
    );
  });

  it('the page turns keystrokes into reducer actions', () => {
    const source = sourceOf('../../../pages/SessionView.tsx');
    expect(source).toMatch(/dispatch\(\{\s*type:\s*'key',\s*key:\s*event\.key,\s*rows\s*\}\)/);
    expect(
      source,
      'the rows-changed action is the one contract Task 6.2 turns on, and it ' +
        'has to carry the model — not the on-screen rows.',
    ).toContain('rowsChangedAction(model, rows)');
  });

  it('the page wires each surface to the state it is meant to show', () => {
    /*
     * The same source-pin technique as the two above, extended to the props no
     * render test can reach. Every one of these is a swap that would ship
     * green: `truncated={data.tracesTruncated}` says the wrong thing about the
     * wrong cap, and a `focusedIndex`/`selectedId` crossover would put the
     * cursor on the selection and the selection on the cursor.
     */
    const source = sourceOf('../../../pages/SessionView.tsx');
    for (const wire of [
      'shown={data.shown}',
      'truncated={data.truncated}',
      'tracesTruncated={data.tracesTruncated}',
      'unmatchedSpanCount={model.unmatchedSpanCount}',
      'selectedId={nav.selectedId}',
      'focusedIndex={nav.focusedIndex}',
    ]) {
      expect(source, `${wire} is not wired through`).toContain(wire);
    }
  });

  it('exactly one element in the whole tree is reachable by tab', () => {
    /*
     * Counted over EVERY focusable element, not over the elements that happen
     * to carry a `tabindex` attribute — which is what an earlier version of
     * this test did, and why it could not have caught the bug it was named
     * after. A `<button>` is focusable by default and renders NO `tabindex`
     * attribute at all, so an expand toggle without an explicit `tabIndex={-1}`
     * is invisible to an attribute count while adding a real tab stop per
     * expandable row. Putting `tabIndex={-1}` on the ROW does not help: a
     * focusable child is not removed from the tab order by its parent.
     *
     * The fixture therefore has to nest — two children under one parent span,
     * inside a turn — so that three separate expand toggles exist to be
     * counted.
     */
    const rows = rowsForSpans([
      makeSpan({ id: 'parent', started_at: atSecond(0), ended_at: atSecond(9) }),
      makeSpan({ id: 'child-a', parent_span_id: 'parent', started_at: atSecond(1) }),
      makeSpan({ id: 'child-b', parent_span_id: 'parent', started_at: atSecond(2) }),
    ]);
    const markup = renderToStaticMarkup(
      <SpanTree
        rows={rows}
        focusedIndex={2}
        now={NOW}
        initialRect={{ width: 1280, height: 720 }}
      />,
    );

    expect(markup.match(/<button/g) ?? [], 'the fixture must actually have toggles').toHaveLength(
      2,
    );

    // Everything the browser would put in the tab sequence: an explicit
    // tabindex="0", plus every natively-focusable element that names no
    // tabindex of its own.
    const explicitStops = (markup.match(/tabindex="0"/g) ?? []).length;
    const untamedButtons = [...markup.matchAll(/<button(?![^>]*tabindex=)[^>]*>/g)].length;

    expect(
      explicitStops + untamedButtons,
      'the tree promises exactly one tab stop and the arrows do the rest; an ' +
        'expand toggle left in the sequence adds one stop per expandable row.',
    ).toBe(1);
    expect(markup.match(/tabindex="-1"/g) ?? []).toHaveLength(rows.length - 1 + 2);
  });
});

/* --------------------------- Test 9 — error and denied rows, AC3 ------------ */

describe('error and denied rows are tinted, glyphed AND named (Test 9, AC3)', () => {
  it.each(['error', 'denied'] as const)('a %s span washes the whole row', (status) => {
    const markup = spanRowMarkup({ status });
    expect(markup).toContain(SPAN_VISUALS.status[status].row);
    expect(SPAN_VISUALS.status[status].row, 'the specced 8% error wash').toBe('bg-error/8');
  });

  it.each(['error', 'denied', 'running', 'unknown', 'ok'] as const)(
    'a %s span carries a glyph and its word, never colour alone',
    (status) => {
      const markup = spanRowMarkup({ status });
      const { label } = SPAN_VISUALS.status[status];
      expect(markup, 'design-system.md: error rows get an icon + row tint').toContain('<svg');
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain(`title="${label}"`);
      expect(markup).toContain(`data-span-status="${status}"`);
    },
  );

  it('leaves an ordinary row unwashed, so the washed ones stand out', () => {
    const markup = spanRowMarkup({ status: 'ok' });
    expect(markup).not.toContain('bg-error/8');
  });

  it('gives a live span the pulse the design system asks for', () => {
    expect(spanRowMarkup({ status: 'running', ended_at: undefined })).toContain(
      'animate-live-pulse',
    );
    expect(spanRowMarkup({ status: 'ok' })).not.toContain('animate-live-pulse');
  });

  it('names the kind of work as well as the span, in the accessible name', () => {
    const markup = spanRowMarkup({ span_type: 'subagent', name: 'reviewer', status: 'ok' });
    expect(markup).toContain('aria-label="sub-agent reviewer, ok"');
  });

  it('folds degradation into the row name, since naming it hides its chips', () => {
    /*
     * `aria-label` on a treeitem REPLACES the name computed from its children,
     * so a tag that lived only in a chip would stop being announced entirely —
     * which is the same colour-alone failure in a different disguise.
     */
    const markup = spanRowMarkup({ name: 'Bash', status: 'ok', tags: ['degraded'] });
    expect(markup).toContain('aria-label="tool call Bash, ok, degraded"');
  });

  it('gives the status glyph a role, so its label is not dropped', () => {
    // A name on a plain span is discarded by the accessible-name computation:
    // the element's role is generic and it carries no text of its own.
    const markup = spanRowMarkup({ status: 'error' });
    expect(markup).toMatch(/data-slot="span-status" role="img"/);
  });
});

/* ------------------------- Test 10 — synthetic traces, AC3 ----------------- */

describe('a turn that no prompt started says so (Test 10, AC3)', () => {
  const traces = makeSyntheticTraces();

  it.each(['system_resume', 'compaction', 'unknown'] as const)(
    'a %s turn carries the trigger badge and names it',
    (trigger) => {
      const trace = traces.find((t) => t.trigger === trigger);
      if (trace === undefined) throw new Error(`no ${trigger} turn in the fixture`);
      const markup = traceRowMarkup(trace);

      expect(markup).toContain('data-slot="trace-trigger"');
      expect(markup).toContain(`>${trigger}<`);
      expect(markup, 'the badge is informational, so it takes the neutral atom').toContain(
        SPAN_VISUALS.triggerBadge,
      );
      expect(markup).toContain(`title="started by ${trigger}"`);
    },
  );

  it('a user prompt is the ordinary case and carries no badge at all', () => {
    const trace = traces.find((t) => t.trigger === 'user_prompt');
    if (trace === undefined) throw new Error('no user_prompt turn in the fixture');
    expect(
      traceRowMarkup(trace),
      'a badge on every turn would say nothing about any of them.',
    ).not.toContain('data-slot="trace-trigger"');
  });

  it('shows the prompt preview the server already sends, with no payload fetch', () => {
    const markup = traceRowMarkup(makeTrace({ prompt_preview: 'rename the widget' }));
    expect(markup).toContain('rename the widget');
    expect(markup).toContain('data-slot="trace-preview"');
  });
});

/* -------------------------- Test 11 — degraded spans, AC3 ------------------ */

describe('a degraded span names its degradation (Test 11, AC3)', () => {
  const page = makeDegradedPage();

  it.each(DEGRADED_TAGS)('a %s span carries a labelled warning chip', (tag) => {
    const span = page.find((s) => s.tags.includes(tag));
    if (span === undefined) throw new Error(`no ${tag} span in the fixture`);
    const markup = spanRowMarkup({ tags: span.tags });

    expect(markup).toContain('data-slot="degraded-tag"');
    expect(markup).toContain(`>${tag}<`);
    expect(markup).toContain(`title="degraded capture: ${tag}"`);
    expect(markup, 'warning is the spec’s own degraded-capture semantic').toContain(
      SPAN_VISUALS.degradedChip,
    );
  });

  it('a clean span carries none', () => {
    expect(spanRowMarkup({ tags: [] })).not.toContain('data-slot="degraded-tag"');
  });

  it('ignores tags that are not degradations', () => {
    expect(spanRowMarkup({ tags: ['seeded'] })).not.toContain('data-slot="degraded-tag"');
  });

  it('draws two chips for a span degraded two ways, in the manifest’s order', () => {
    const markup = spanRowMarkup({ tags: ['unattributed', 'degraded'] });
    const shown = [...markup.matchAll(/data-slot="degraded-tag"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(shown).toEqual(['degraded', 'unattributed']);
  });
});

/* --------------------- Test 13 — the manifest is exhaustive ---------------- */

const SPAN_TYPES: readonly SpanType[] = [
  'llm_call',
  'tool_call',
  'thinking',
  'subagent',
  'generic',
];
const SPAN_STATUSES: readonly SpanStatus[] = ['running', 'ok', 'error', 'denied', 'unknown'];
const TRIGGERS: readonly TraceTrigger[] = ['user_prompt', 'system_resume', 'compaction', 'unknown'];

describe('the span-visuals manifest covers everything the wire can carry (Test 13)', () => {
  it('has an entry for every span type and every span status', () => {
    /*
     * `satisfies` catches a MISSING key at compile time; this catches the other
     * direction — a type added to `@shared/entities.ts` that nobody taught this
     * manifest about would render an untinted, unglyphed row, and widening the
     * union is exactly the change that would not touch the manifest.
     */
    expect(Object.keys(SPAN_VISUALS.type).sort()).toEqual([...SPAN_TYPES].sort());
    expect(Object.keys(SPAN_VISUALS.status).sort()).toEqual([...SPAN_STATUSES].sort());
  });

  it('gives every status a word, so status is never colour alone', () => {
    for (const status of SPAN_STATUSES) {
      expect(SPAN_VISUALS.status[status].label, `${status} has no word`).not.toBe('');
    }
  });

  it('renders every span type with its own tint and glyph', () => {
    for (const spanType of SPAN_TYPES) {
      const markup = spanRowMarkup({ span_type: spanType });
      expect(markup, `${spanType} renders untinted`).toContain(SPAN_VISUALS.type[spanType].tint);
      expect(markup).toContain('data-slot="span-type"');
    }
  });

  it('renders every trigger the wire can carry', () => {
    for (const trigger of TRIGGERS) {
      expect(() => traceRowMarkup(makeTrace({ trigger }))).not.toThrow();
    }
  });

  it('washes exactly the two statuses that are failures', () => {
    const washed = SPAN_STATUSES.filter((s) => SPAN_VISUALS.status[s].row !== '');
    expect(washed.sort()).toEqual(['denied', 'error']);
  });
});

/* ------------------- Test 18b — the truncation strip renders --------------- */

describe('truncation is stated out loud (Test 18b)', () => {
  it('says how many spans it is showing once the cap bit', () => {
    const markup = renderToStaticMarkup(
      <TruncationNotice shown={20_000} truncated tracesTruncated={false} unmatchedSpanCount={0} />,
    );
    expect(markup).toContain('data-slot="truncation-notice"');
    expect(markup, 'a bare 20000 reads as a total rather than as a limit').toContain('20,000');
    expect(markup).toContain('role="status"');
  });

  it('reports spans whose turn fell off the page, which nothing else does', () => {
    const markup = renderToStaticMarkup(
      <TruncationNotice
        shown={12}
        truncated={false}
        tracesTruncated={false}
        unmatchedSpanCount={7}
      />,
    );
    expect(
      markup,
      'the model counts these so this component can say so — the alternative ' +
        'is spans that arrived, were counted, and appear nowhere.',
    ).toContain('7 more spans');
  });

  it('renders nothing at all when the tree is complete', () => {
    expect(
      renderToStaticMarkup(
        <TruncationNotice
          shown={12}
          truncated={false}
          tracesTruncated={false}
          unmatchedSpanCount={0}
        />,
      ),
      'a permanent "showing everything" strip trains the reader to stop ' +
        'reading the one that matters.',
    ).toBe('');
  });
});

/* --------------------- Test 19 — the ARIA tree contract -------------------- */

describe('the emitted markup is a real ARIA tree (Test 19)', () => {
  const spans = [
    makeSpan({ id: 'parent', started_at: atSecond(0), ended_at: atSecond(9) }),
    makeSpan({ id: 'child-a', parent_span_id: 'parent', started_at: atSecond(1) }),
    makeSpan({ id: 'child-b', parent_span_id: 'parent', started_at: atSecond(2) }),
  ];
  const rows = rowsForSpans(spans);
  const markup = renderToStaticMarkup(
    <SpanTree
      rows={rows}
      selectedId="child-b"
      focusedIndex={1}
      now={NOW}
      initialRect={{ width: 1280, height: 720 }}
    />,
  );

  it('puts one tree around every treeitem', () => {
    expect(markup.match(/role="tree"/g) ?? []).toHaveLength(1);
    expect(treeItemCount(markup)).toBe(rows.length);
  });

  it('gives a turn header the same treeitem role as a span row', () => {
    // A turn is a row the arrow keys land on, so a section-heading role would
    // be a lie about what focus can reach.
    expect(markup).toContain('data-slot="trace-group"');
    expect(
      markup.match(/role="treeitem"[^>]*data-slot="trace-group"|data-slot="trace-group"/g),
    ).not.toBeNull();
  });

  it('levels every row as depth plus one, turns at 1 and their children at 2', () => {
    const levels = [...markup.matchAll(/aria-level="(\d+)"/g)].map((m) => Number(m[1]));
    expect(levels).toEqual(rows.map((row) => row.depth + 1));
    expect(levels[0]).toBe(1);
    expect(levels[1]).toBe(2);
    expect(levels).toContain(3);
  });

  it('states set size and position from the SIBLINGS, not from the window', () => {
    /*
     * The load-bearing one. With ~34 of 5,000 rows in the document, a
     * window-relative number would have a screen reader announce "1 of 34" for
     * a whole session. `Row` carries `setSize`/`posInSet` for this alone.
     */
    const sizes = [...markup.matchAll(/aria-setsize="(\d+)"/g)].map((m) => Number(m[1]));
    const positions = [...markup.matchAll(/aria-posinset="(\d+)"/g)].map((m) => Number(m[1]));
    expect(sizes).toEqual(rows.map((row) => row.setSize));
    expect(positions).toEqual(rows.map((row) => row.posInSet));
    expect(sizes, 'the two children are a set of two, whatever the window shows').toContain(2);
  });

  it('marks expansion only on rows that can expand', () => {
    const expandable = rows.filter((row) => row.hasChildren).length;
    expect(markup.match(/aria-expanded=/g) ?? []).toHaveLength(expandable);
    expect(expandable).toBe(2);
  });

  it('marks the selected row, and only it', () => {
    expect(markup.match(/aria-selected="true"/g) ?? []).toHaveLength(1);
    expect(markup.match(/aria-selected="false"/g) ?? []).toHaveLength(rows.length - 1);
  });

  it('keeps the positioning wrapper out of the accessibility tree', () => {
    // A `tree` may only own `treeitem` and `group`; the absolutely-positioned
    // wrapper is neither, so it declares itself presentational.
    expect(markup.match(/role="presentation"/g) ?? []).toHaveLength(rows.length);
  });
});

/* -------------- AC4-render — chips are read at turn and session level ------ */

describe('chips are read off the server’s rollups, never resummed (AC4-render)', () => {
  /*
   * Every fixture below deliberately DISAGREES with its own children. That
   * disagreement is the whole test: a component that recomputed would render
   * the sum and go red, and one that reads renders the stored number.
   */
  it('a turn header shows the turn’s stored totals, not the sum of its spans', () => {
    const trace = makeTrace({
      total_tokens: 9999,
      est_cost: 1.25,
      duration_ms: 60_000,
      error_count: 3,
    });
    const model = buildTreeModel(
      [trace],
      new Map([
        [trace.id, [makeSpan({ trace_id: trace.id, tokens_in: 1, tokens_out: 1, est_cost: 0.01 })]],
      ]),
    );
    const row = flatten(model, new Set([trace.id])).find((r): r is TraceRow => r.kind === 'trace');
    if (row === undefined) throw new Error('no turn row');
    const markup = renderToStaticMarkup(<TraceGroup row={row} selected={false} focused={false} />);

    expect(markup).toContain('9,999 tok');
    expect(markup).toContain('$1.25');
    expect(markup).toContain('1m 0s');
    expect(markup).toContain('3 err');
    expect(markup, 'the summed answer would have been 2 tokens').not.toContain('2 tok');
  });

  it('a sub-agent subtree IS summed, because nothing else sums it', () => {
    // The server's rollups stop at the turn, so a subtree inside one has no
    // stored total to read — this is the one level the client owns.
    const rows = spanRowsOf([
      makeSpan({
        id: 'group',
        span_type: 'subagent',
        started_at: atSecond(0),
        ended_at: atSecond(4),
      }),
      makeSpan({
        id: 'kid-a',
        parent_span_id: 'group',
        tokens_in: 100,
        tokens_out: 5,
        est_cost: 0.5,
      }),
      makeSpan({
        id: 'kid-b',
        parent_span_id: 'group',
        tokens_in: 20,
        tokens_out: 0,
        est_cost: 0.25,
        status: 'error',
        started_at: atSecond(2),
      }),
    ]);
    const group = rows.find((row) => row.id === 'group');
    if (group === undefined) throw new Error('no subagent row');
    const markup = renderToStaticMarkup(
      <TreeSpanRow row={group} selected={false} focused={false} now={NOW} />,
    );

    expect(markup).toContain('125 tok');
    expect(markup).toContain('$0.75');
    expect(markup).toContain('1 err');
  });

  it('a session header shows the session’s stored totals (AC4-render)', () => {
    const session = makeSession({
      total_tokens: 123_456,
      est_cost: 4.5,
      error_count: 2,
      trace_count: 7,
      started_at: '2026-07-29T09:00:00.000Z',
      ended_at: '2026-07-29T09:05:00.000Z',
    });
    const markup = renderToStaticMarkup(<SessionHeader session={session} now={NOW} />);

    expect(markup).toContain('data-slot="session-header"');
    expect(markup).toContain('123,456 tok');
    expect(markup).toContain('$4.50');
    expect(markup).toContain('2 err');
    expect(markup).toContain('7 turns');
    expect(markup).toContain('5m 0s');
    expect(markup).toContain(session.project_path);
  });

  it('a session header offers a way back to the list (AC3, Test 9)', () => {
    /*
     * ★ Task 5.1. Before it there was no return control on this screen at all —
     * a reader who opened a session by deep link had the browser's back button
     * and nothing else. A real anchor rather than a history call: `history.back()`
     * on a fresh tab leaves agent-lens entirely.
     */
    const markup = renderToStaticMarkup(<SessionHeader session={makeSession()} now={NOW} />);

    expect(markup).toContain('data-slot="back-to-sessions"');
    expect(markup).toContain(`href="${hrefFor({ name: 'sessions' })}"`);
    expect(hrefFor({ name: 'sessions' }), 'the list lives at the root').toBe('/');
    // Icon-only would be unannounceable; the accessibility baseline asks for a
    // label on every control that is not its own text.
    expect(markup).toContain('aria-label="Back to sessions"');
  });

  it('a session with no errors renders no error chip', () => {
    const markup = renderToStaticMarkup(
      <SessionHeader session={makeSession({ error_count: 0 })} now={NOW} />,
    );
    expect(markup).not.toContain('data-slot="session-errors"');
  });

  it('spells an unpriced session as the em dash, never as $0', () => {
    const markup = renderToStaticMarkup(
      <SessionHeader session={makeSession({ est_cost: 0 })} now={NOW} />,
    );
    expect(markup).toContain('—');
    expect(markup).not.toContain('$0');
  });

  it('spells a running span’s elapsed time against the injected clock', () => {
    const markup = spanRowMarkup({
      status: 'running',
      started_at: new Date(NOW - 2_000).toISOString(),
      ended_at: undefined,
    });
    expect(markup, 'never NaN, and never an em dash while a clock was offered').toContain('2.00s');
  });

  it('omits a chip a leaf has no number for rather than rendering a zero', () => {
    const markup = spanRowMarkup({
      tokens_in: undefined,
      tokens_out: undefined,
      est_cost: undefined,
    });
    expect(markup).not.toContain('0 tok');
    expect(markup).not.toContain('data-slot="metric-cost"');
  });
});

/* -------------------------- the selection affordance ---------------------- */

describe('the selected row is washed and edged, per the flagship-row spec', () => {
  it('takes the accent wash and the accent left edge when selected', () => {
    const markup = spanRowMarkup({ status: 'ok' }, true);
    expect(markup).toContain('bg-accent-muted');
    expect(markup).toContain('border-l-accent');
  });

  it('holds the edge’s width when unselected, so nothing shifts sideways', () => {
    const markup = spanRowMarkup({ status: 'ok' }, false);
    expect(markup).toContain('border-l-2');
    expect(markup).toContain('border-l-background');
    expect(markup).not.toContain('bg-accent-muted');
  });

  it('indents by depth with an inline offset, never with a built class name', () => {
    const rows = spanRowsOf([
      makeSpan({ id: 'p', started_at: atSecond(0), ended_at: atSecond(5) }),
      makeSpan({ id: 'c', parent_span_id: 'p', started_at: atSecond(1) }),
    ]);
    const child = rows.find((row) => row.id === 'c');
    if (child === undefined) throw new Error('no child row');
    const markup = renderToStaticMarkup(
      <TreeSpanRow row={child} selected={false} focused={false} now={NOW} />,
    );
    expect(markup).toContain('padding-left:28px');
    expect(
      markup,
      "a class name assembled at runtime is invisible to Tailwind's scanner " +
        'and compiles to nothing — silently.',
    ).not.toMatch(/class="[^"]*pl-\[/);
  });
});

/* ---------------- every status the wire can carry actually renders --------- */

describe('every status on one page renders its own treatment', () => {
  const rows = rowsForSpans(makeStatusPage());
  const markup = renderToStaticMarkup(
    <SpanTree rows={rows} focusedIndex={0} now={NOW} initialRect={{ width: 1280, height: 720 }} />,
  );

  it.each(SPAN_STATUSES)('%s appears exactly once', (status) => {
    expect(markup.match(new RegExp(`data-span-status="${status}"`, 'g')) ?? []).toHaveLength(1);
  });

  it('washes exactly the two failing rows', () => {
    expect(markup.match(/bg-error\/8/g) ?? []).toHaveLength(2);
  });
});
