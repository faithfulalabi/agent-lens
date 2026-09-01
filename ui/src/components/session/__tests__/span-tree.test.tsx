import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EventRow, SessionListRow, TurnRow } from '../../../lib/api';
import {
  EVENT_KINDS,
  EVENT_STATUSES,
  buildTurnGroups,
  flatten,
  type EventRowModel,
  type Row,
  type TurnRowModel,
} from '../../../lib/turn-tree';
import {
  expandedRows,
  makeAgentEvent,
  makeLargeTree,
  makeSessionRow,
  makeSidecarDetail,
  makeTurnTree,
  rowsForEvents,
} from '../../../lib/__tests__/fixtures';
import {
  initialSubagentState,
  subagentReducer,
  subtreesOf,
  turnIdsToOpen,
} from '../../../lib/subagent';
import { expandMany, initialNavState } from '../../../lib/tree-nav';
import { hrefFor } from '../../../lib/route-match';
import { SpanTree } from '../SpanTree';
import { DURATION_LABELS, INDENT_PX, TreeSpanRow } from '../SpanRow';
import { TraceGroup } from '../TraceGroup';
import { TruncationNotice } from '../TruncationNotice';
import { SessionHeader } from '../SessionHeader';
import { SPAN_VISUALS, VISUAL_OF_KIND, type SpanTypeKey } from '../span-visuals';

/*
 * Task 5.2's rendering half.
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

/** Every `treeitem` in a markup string — turn headers and event rows alike. */
function treeItemCount(markup: string): number {
  return (markup.match(/role="treeitem"/g) ?? []).length;
}

function treeMarkup(rows: readonly Row[], height: number | null): string {
  return renderToStaticMarkup(
    <SpanTree
      rows={rows}
      focusedIndex={0}
      {...(height === null ? {} : { initialRect: { width: 1280, height } })}
    />,
  );
}

/** The event rows of a one-turn page, already narrowed. */
function eventRowsOf(events: Partial<EventRow>[], turn: Partial<TurnRow> = {}): EventRowModel[] {
  return rowsForEvents(events, turn).filter((row): row is EventRowModel => row.kind === 'event');
}

function eventRowMarkup(overrides: Partial<EventRow>, selected = false): string {
  const row = eventRowsOf([overrides])[0];
  expect(row, 'the fixture produced no event row').toBeDefined();
  if (row === undefined) throw new Error('unreachable');
  return renderToStaticMarkup(<TreeSpanRow row={row} selected={selected} focused={false} />);
}

function turnRowMarkup(turn: Partial<TurnRow>): string {
  const row = rowsForEvents([{ name: 'Read' }], turn).find(
    (r): r is TurnRowModel => r.kind === 'turn',
  );
  if (row === undefined) throw new Error('the fixture produced no turn row');
  return renderToStaticMarkup(<TraceGroup row={row} selected={false} focused={false} />);
}

/* ------------------------------------ Test 4 — virtualization, by SCALING -- */

describe('SpanTree renders O(viewport) rows, not O(n) (Test 4, AC1a)', () => {
  const { rows } = expandedRows(makeLargeTree());

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

  it('holds 5,000 events, so an unvirtualized render would be visibly different', () => {
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
 * The first version of this test asserted "5,000 events in under 250 ms" and it
 * FLAKED — this suite runs many files in parallel, three of which shell out to a
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
function bestBuildMs(eventCount: number): number {
  const tree = makeLargeTree({ turns: 10, eventsPerTurn: eventCount / 10 });
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const model = buildTurnGroups(tree.turns, tree.eventsByTurn);
    flatten(model, model.rowIds);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('the row model builds within a complexity budget (Test 5, AC1a)', () => {
  it('builds and flattens 5,000 events into the row list', () => {
    const tree = makeLargeTree();
    const model = buildTurnGroups(tree.turns, tree.eventsByTurn);
    expect(flatten(model, model.rowIds).length).toBe(5010);
  });

  it('costs about five times as much for five times the events, not twenty-five', () => {
    // Floored so the ratio cannot be manufactured by a baseline that rounded to
    // zero — on a fast machine 1,000 events genuinely can measure under 1 ms.
    const small = Math.max(bestBuildMs(1000), 0.05);
    const large = bestBuildMs(5000);
    const ratio = large / small;

    expect(
      ratio,
      `5,000 events cost ${ratio.toFixed(1)}x what 1,000 cost. Linear is ~5x and ` +
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
    ).toContain('rowsChangedAction(model, rows, sub)');
  });

  it('the child-fetch effect names NEITHER sub NOR rows in its deps (Test 24)', () => {
    /*
     * ★ THIS IS THE ONLY AUTOMATED WITNESS OF THE SELF-CANCELLING FETCH EFFECT.
     *
     * With `sub` in the dependency array, the `requested` dispatch re-renders,
     * React runs the previous cleanup, `controller.abort()` kills the request it
     * has just issued, and the re-run asks for nothing because the id is now
     * pending. The sub-agent never loads. Nothing else in this repo can see it:
     * `environment: 'node'` means no effect ever fires, and the only other
     * witness is the live gate counting zero additional responses at AC-R1(b).
     *
     * `rows` has the same defect by a longer route — it changes whenever any
     * child lands, so the second sub-agent dies the way the first would have.
     */
    const source = sourceOf('../../../pages/SessionView.tsx');
    expect(source).toContain('}, [wantedKey, client]);');
    expect(
      source,
      'the abort belongs to the SESSION-keyed effect, following use-async.ts — ' +
        'so a re-render cannot abort its own in-flight request.',
    ).toMatch(/abortRef\.current = controller;[\s\S]{0,200}\}, \[sessionId\]\);/);

    const fetchEffect = source.slice(
      source.indexOf('const wantedKey'),
      source.indexOf('}, [wantedKey, client]);'),
    );
    expect(fetchEffect, 'the fetch effect must exist to be checked').not.toBe('');
    for (const forbidden of ['[wantedKey, client, sub]', '[wantedKey, client, rows]']) {
      expect(source, `${forbidden} reinstates the self-cancelling effect`).not.toContain(forbidden);
    }
  });

  it('the scroller reports its own numbers, and the follow index reaches the virtualizer', () => {
    /*
     * Source text, and NOT a render pin — the reason is the same one this block
     * opens with, twice over. `renderToStaticMarkup` runs no effect, so
     * `scrollToIndex` never fires; and React's server renderer emits no
     * event-handler attributes, so an `onScroll` never reaches the markup. A
     * render assertion over either would be a test that cannot fail.
     *
     * What IS behavioural is every decision behind them: `atBottom` and
     * `followReducer` are driven as a table in `lib/__tests__/follow.test.ts`.
     */
    const source = sourceOf('../SpanTree.tsx');

    expect(source, 'the handler belongs on the element that actually scrolls').toMatch(
      /ref=\{scrollRef\}[\s\S]{0,400}onScroll=\{onScroll\}/,
    );
    for (const metric of ['scrollTop: element.scrollTop', 'scrollHeight: element.scrollHeight']) {
      expect(source, `${metric} is not read off the scroller`).toContain(metric);
    }
    expect(source, 'the tree reads numbers; live.ts decides what they mean').not.toContain(
      'FOLLOW_EPSILON_PX',
    );
    expect(source).toContain("virtualizer.scrollToIndex(followIndex, { align: 'end' })");
  });

  it('swallows the one scroll event its own scrollToIndex causes', () => {
    /*
     * ★ THE DEFECT THIS CLOSES IS INVISIBLE TO EVERY OTHER TEST HERE.
     *
     * Rows are MEASURED, not assumed — `measureElement` corrects each rendered
     * row against the real DOM — so `scrollToIndex(last, { align: 'end' })` can
     * land short of the true end while the rows below it are still estimates.
     * That fires an `onScroll` whose numbers say "not at the end", the reducer
     * reads it as a reader who moved, and follow mode pauses on the very frame
     * the pill resumed it.
     */
    const source = sourceOf('../SpanTree.tsx');

    expect(source).toMatch(/programmaticScroll\.current = true;\s*virtualizer\.scrollToIndex\(/);
    expect(source, 'the flag must be cleared by the event it swallows').toMatch(
      /if \(programmaticScroll\.current\) \{\s*programmaticScroll\.current = false;\s*return;/,
    );
  });

  it('the page wires each surface to the state it is meant to show', () => {
    /*
     * The same source-pin technique as the two above, extended to the props no
     * render test can reach. Every one of these is a swap that would ship
     * green: `hasMore={data.shown > 0}` says the wrong thing about the wrong
     * fact, and a `focusedIndex`/`selectedId` crossover would put the cursor on
     * the selection and the selection on the cursor.
     */
    const source = sourceOf('../../../pages/SessionView.tsx');
    for (const wire of [
      'shown={data.shown}',
      'hasMore={data.hasMore}',
      'unmatchedEventCount={model.unmatchedEventCount}',
      'selectedId={nav.selectedId}',
      'focusedIndex={nav.focusedIndex}',
      // Task 7.3. The banner is a pure function of the row on screen, so a
      // `hasDrift={true}` or a crossover onto another boolean would ship a
      // permanent alarm — green everywhere else, and AC3 broken.
      'hasDrift={data.session.has_drift}',
      'harnessVersion={data.session.harness_version}',
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
     * The fixture therefore has to nest — a folded turn under an Agent event —
     * so that three separate expand toggles exist to be counted.
     */
    const rows = NESTED_ROWS;
    const markup = renderToStaticMarkup(
      <SpanTree rows={rows} focusedIndex={2} initialRect={{ width: 1280, height: 720 }} />,
    );

    expect(markup.match(/<button/g) ?? [], 'the fixture must actually have toggles').toHaveLength(
      3,
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
    expect(markup.match(/tabindex="-1"/g) ?? []).toHaveLength(rows.length - 1 + 3);
  });
});

/* ------------- Test 3 — every kind and every status renders (the blank guard) */

const WIRE_STATUSES = [null, 'ok', 'error', 'denied', 'running', 'wat'] as const;

describe('every event kind and every status renders, including a null one (Test 3, AC2)', () => {
  /*
   * ⚠️ THE BLANK-SCREEN GUARD. `status IS NULL` on 14,211 of 30,286 archived
   * events — every `text`, `thinking`, `prompt`, `compaction` and `unknown`
   * row. Before Task 5.2 the coalesce lived in an adapter this task deleted;
   * moving it into `turn-tree.ts` rather than dropping it is the whole reason
   * screen 2 still draws.
   *
   * Mutation check, verified by hand: drop the `?? 'unknown'` in
   * `eventStatusOf` and `SPAN_VISUALS.status[…]` answers undefined, so
   * `status.Icon` throws on the first non-tool row of every real session.
   */
  const cases = EVENT_KINDS.flatMap((kind) =>
    WIRE_STATUSES.map((status) => [kind, String(status)] as const),
  );

  it.each(cases)('a %s event with status %s renders a named row', (kind, status) => {
    const markup = eventRowMarkup({
      kind,
      status: status === 'null' ? null : status,
      name: null,
    });
    expect(markup).toContain('data-slot="span-row"');
    expect(markup).toContain('data-slot="span-status"');
    expect(markup).toContain(`data-event-kind="${kind}"`);
    // A non-empty accessible name on the status glyph, which is the half that
    // survives a reader who cannot tell the two reds apart.
    expect(markup).toMatch(/data-slot="span-status" role="img" title="[^"]+" aria-label="[^"]+"/);
  });

  it.each([null, 'wat'])('resolves status %s to the unknown visual', (status) => {
    const markup = eventRowMarkup({ status });
    expect(markup).toContain('data-span-status="unknown"');
    expect(markup).toContain(`aria-label="${SPAN_VISUALS.status.unknown.label}"`);
  });

  it('resolves an unrecognised kind to the generic visual rather than throwing', () => {
    const markup = eventRowMarkup({ kind: 'wat', name: null });
    expect(markup).toContain('data-event-kind="unknown"');
    expect(markup).toContain(VISUAL_OF_KIND.unknown.tint);
  });

  it('names the kind of work as well as the event, in the accessible name', () => {
    const markup = eventRowMarkup({ kind: 'tool_call', name: 'Bash', status: 'ok' });
    expect(markup).toContain('aria-label="tool call Bash, ok, elapsed, approval wait included"');
  });

  it('falls back to the raw kind when the projector named nothing', () => {
    expect(eventRowMarkup({ kind: 'thinking', name: null })).toContain('>thinking<');
  });
});

/* --------------------------- Test 9 — error and denied rows, AC3 ------------ */

describe('error and denied rows are tinted, glyphed AND named (Test 9, AC3)', () => {
  it.each(['error', 'denied'] as const)('a %s event washes the whole row', (status) => {
    const markup = eventRowMarkup({ status });
    expect(markup).toContain(SPAN_VISUALS.status[status].row);
    expect(SPAN_VISUALS.status[status].row, 'the specced 8% error wash').toBe('bg-error/8');
  });

  it.each([...EVENT_STATUSES])(
    'a %s event carries a glyph and its word, never colour alone',
    (status) => {
      const markup = eventRowMarkup({ status });
      const { label } = SPAN_VISUALS.status[status];
      expect(markup, 'design-system.md: error rows get an icon + row tint').toContain('<svg');
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain(`title="${label}"`);
      expect(markup).toContain(`data-span-status="${status}"`);
    },
  );

  it('leaves an ordinary row unwashed, so the washed ones stand out', () => {
    expect(eventRowMarkup({ status: 'ok' })).not.toContain('bg-error/8');
  });

  it('gives a live event the pulse the design system asks for', () => {
    expect(eventRowMarkup({ status: 'running' })).toContain('animate-live-pulse');
    expect(eventRowMarkup({ status: 'ok' })).not.toContain('animate-live-pulse');
  });

  it('gives the status glyph a role, so its label is not dropped', () => {
    // A name on a plain span is discarded by the accessible-name computation:
    // the element's role is generic and it carries no text of its own.
    expect(eventRowMarkup({ status: 'error' })).toMatch(/data-slot="span-status" role="img"/);
  });

  it('draws no error chip on the event, and the turn above still draws its own', () => {
    /*
     * `showErrors` is false on an event row, decided by Task 5.2. An event's
     * only possible child is a folded turn, and that turn's header renders its
     * STORED `error_count` one row down — so the rollup reading is not lost, it
     * renders where the number lives. On the event itself the chip could only
     * read `1 err`, beside a status glyph that already carries the word and an
     * 8% row wash: a fourth signal for one fact.
     *
     * Mutation check, verified by hand: pass `showErrors={row.hasChildren}` and
     * a nested-turn event grows a phantom `1 err`.
     */
    expect(eventRowMarkup({ status: 'error' })).not.toContain('data-slot="row-errors"');
    expect(turnRowMarkup({ error_count: 3 })).toContain('3 err');
  });
});

/* ------------------- Test 7 and 8 — the tool_call row, AC3 ----------------- */

describe('a tool_call row shows what was called and what came back (Test 7, AC3)', () => {
  it('renders the tool name, its status, its input and its output', () => {
    const markup = eventRowMarkup({
      kind: 'tool_call',
      name: 'Bash',
      status: 'ok',
      input: '{"cmd":"ls"}',
      text: 'a.txt',
    });

    expect(markup).toContain('>Bash<');
    expect(markup).toContain('data-span-status="ok"');
    // Mutation check, verified by hand: drop the payload line and both of these
    // go red, which is the whole of AC3's "and both its input and its output".
    expect(markup).toContain('data-slot="span-input"');
    expect(markup).toContain('{&quot;cmd&quot;:&quot;ls&quot;}');
    expect(markup).toContain('data-slot="span-output"');
    expect(markup).toContain('a.txt');
  });

  it('clamps a long payload to one line rather than pasting 64 KB into a row', () => {
    const markup = eventRowMarkup({ input: 'x'.repeat(4_000), text: null });
    const shown = /data-slot="span-input"[^>]*>([^<]*)</.exec(markup)?.[1] ?? '';
    expect(shown.length).toBeLessThan(120);
    expect(shown.startsWith('x'.repeat(50)), 'the preview is a PREFIX of the value').toBe(true);
    expect(markup).not.toContain('data-slot="span-output"');
  });

  it('draws no payload line at all when the event carries neither', () => {
    expect(eventRowMarkup({ input: null, text: null })).not.toContain('data-slot="span-payload"');
  });
});

describe('the duration is labelled by where it came from (Test 8, AC3)', () => {
  it.each([...Object.keys(DURATION_LABELS)] as (keyof typeof DURATION_LABELS)[])(
    'a %s duration names its source and never says execution',
    (source) => {
      const markup = eventRowMarkup({
        duration_source: source === 'none' ? null : source,
        duration_ms: source === 'none' ? null : 1_020,
      });
      expect(markup).toContain(`data-duration-source="${source}"`);
      expect(markup).toContain(DURATION_LABELS[source]);
      // ★ A 61 ms Bash reads as 8,063 ms elapsed when a human sits on the
      // approval dialog. A labelled approximation beats a precise-looking lie.
      expect(markup.toLowerCase()).not.toContain('execution');
    },
  );

  it('gives the four arms four distinct labels', () => {
    const labels = Object.values(DURATION_LABELS);
    expect(labels).toHaveLength(4);
    expect(new Set(labels).size).toBe(4);
  });

  it('defaults an absent source to none, never to elapsed', () => {
    // Mutation check, verified by hand: defaulting the null arm to `elapsed`
    // claims a measurement on 14,211 of 30,286 rows that nobody took.
    const markup = eventRowMarkup({ duration_source: null, duration_ms: null });
    expect(markup).toContain('data-duration-source="none"');
    expect(markup).toContain(DURATION_LABELS.none);
    // …and the number itself is the em dash, not `0ms`.
    expect(markup).not.toContain('0ms');
  });

  it('never lets the TURN vocabulary reach the event map', () => {
    /*
     * `turns.duration_source` is `derived` | `turn_duration` — a different
     * field on a different table. The separation is structural: `TurnRow` does
     * not declare the field at all, and a turn header renders no source.
     */
    for (const turnSource of ['derived', 'turn_duration']) {
      expect(Object.keys(DURATION_LABELS)).not.toContain(turnSource);
    }
    expect(turnRowMarkup({})).not.toContain('data-duration-source');
  });
});

/* ------------------------- the turn header badge, AC2 --------------------- */

describe('a turn that no human started says so (AC2)', () => {
  it.each(['task_notification', 'slash_command', 'compaction', 'system', 'unknown'])(
    'a %s turn carries the badge and names its kind',
    (kind) => {
      const markup = turnRowMarkup({ kind });
      expect(markup).toContain('data-slot="trace-trigger"');
      expect(markup).toContain(`>${kind}<`);
      expect(markup, 'the badge is informational, so it takes the neutral atom').toContain(
        SPAN_VISUALS.triggerBadge,
      );
      expect(markup).toContain(`title="started by ${kind}"`);
      expect(markup).toContain(`data-turn-kind="${kind}"`);
    },
  );

  it('a human turn is the ordinary case and carries no badge at all', () => {
    expect(
      turnRowMarkup({ kind: 'human' }),
      'a badge on every turn would say nothing about any of them.',
    ).not.toContain('data-slot="trace-trigger"');
  });

  it('shows the title the server already sends, with no payload fetch', () => {
    const markup = turnRowMarkup({ title: 'rename the widget' });
    expect(markup).toContain('rename the widget');
    expect(markup).toContain('data-slot="trace-preview"');
  });
});

/* --------------------- Test 13 — the manifest is exhaustive ---------------- */

const SPAN_TYPES: readonly SpanTypeKey[] = [
  'llm_call',
  'tool_call',
  'thinking',
  'subagent',
  'generic',
];

describe('the span-visuals manifest covers everything the wire can carry (Test 13)', () => {
  it('has an entry for every palette key and every event status', () => {
    /*
     * `satisfies` catches a MISSING key at compile time; this catches the other
     * direction — a status added to `turn-tree.ts` that nobody taught this
     * manifest about would render an untinted, unglyphed row, and widening the
     * union is exactly the change that would not touch the manifest.
     */
    expect(Object.keys(SPAN_VISUALS.type).sort()).toEqual([...SPAN_TYPES].sort());
    expect(Object.keys(SPAN_VISUALS.status).sort()).toEqual([...EVENT_STATUSES].sort());
  });

  it('maps every event kind onto a palette entry', () => {
    // Seven kinds onto five keys, by reuse. A kind missing here indexes the map
    // with undefined and the row throws before it draws.
    expect(Object.keys(VISUAL_OF_KIND).sort()).toEqual([...EVENT_KINDS].sort());
    for (const kind of EVENT_KINDS) {
      expect(Object.values(SPAN_VISUALS.type)).toContain(VISUAL_OF_KIND[kind]);
    }
  });

  it('gives every status a word, so status is never colour alone', () => {
    for (const status of EVENT_STATUSES) {
      expect(SPAN_VISUALS.status[status].label, `${status} has no word`).not.toBe('');
    }
  });

  it('renders every event kind with its own tint and glyph', () => {
    for (const kind of EVENT_KINDS) {
      const markup = eventRowMarkup({ kind });
      expect(markup, `${kind} renders untinted`).toContain(VISUAL_OF_KIND[kind].tint);
      expect(markup).toContain('data-slot="span-type"');
    }
  });

  it('washes exactly the two statuses that are failures', () => {
    const washed = EVENT_STATUSES.filter((s) => SPAN_VISUALS.status[s].row !== '');
    expect([...washed].sort()).toEqual(['denied', 'error']);
  });
});

/* ------------------- Test 18b — the truncation strip renders --------------- */

describe('truncation is stated out loud (Test 18b)', () => {
  it('says how many events it is showing once the server withheld some', () => {
    const markup = renderToStaticMarkup(
      <TruncationNotice shown={20_000} hasMore unmatchedEventCount={0} />,
    );
    expect(markup).toContain('data-slot="truncation-notice"');
    expect(markup, 'a bare 20000 reads as a total rather than as a limit').toContain('20,000');
    expect(markup).toContain('role="status"');
  });

  it('reports events whose turn is not on the page, which nothing else does', () => {
    const markup = renderToStaticMarkup(
      <TruncationNotice shown={12} hasMore={false} unmatchedEventCount={7} />,
    );
    expect(
      markup,
      'the model counts these so this component can say so — the alternative ' +
        'is events that arrived, were counted, and appear nowhere.',
    ).toContain('7 more events');
  });

  it('renders nothing at all when the tree is complete', () => {
    expect(
      renderToStaticMarkup(<TruncationNotice shown={12} hasMore={false} unmatchedEventCount={0} />),
      'a permanent "showing everything" strip trains the reader to stop ' +
        'reading the one that matters.',
    ).toBe('');
  });
});

/* --------------------- Test 19 — the ARIA tree contract -------------------- */

/** One turn, two events, and a `task_notification` turn folded under the second. */
const NESTED_ROWS = expandedRows(
  makeTurnTree([
    {
      id: 'seed-s0:0',
      seq: 0,
      events: [{ name: 'Read' }, { name: 'Agent' }],
      folded: [{ id: 'seed-s0:1', seq: 1, events: [{ name: 'Bash' }] }],
    },
  ]),
).rows;

describe('the emitted markup is a real ARIA tree (Test 19)', () => {
  const rows = NESTED_ROWS;
  const markup = renderToStaticMarkup(
    <SpanTree
      rows={rows}
      selectedId="seed-s0:1-ev-0"
      focusedIndex={1}
      initialRect={{ width: 1280, height: 720 }}
    />,
  );

  it('puts one tree around every treeitem', () => {
    expect(markup.match(/role="tree"/g) ?? []).toHaveLength(1);
    expect(treeItemCount(markup)).toBe(rows.length);
    expect(rows).toHaveLength(5);
  });

  it('gives a turn header the same treeitem role as an event row', () => {
    // A turn is a row the arrow keys land on, so a section-heading role would
    // be a lie about what focus can reach.
    expect(markup).toContain('data-slot="trace-group"');
    expect(markup.match(/data-slot="trace-group"/g) ?? []).toHaveLength(2);
  });

  it('levels every row as depth plus one, and a folded turn is not at level 1', () => {
    const levels = [...markup.matchAll(/aria-level="(\d+)"/g)].map((m) => Number(m[1]));
    expect(levels).toEqual(rows.map((row) => row.depth + 1));
    expect(levels).toEqual([1, 2, 2, 3, 4]);
  });

  it('states set size and position from the SIBLINGS, not from the window', () => {
    /*
     * The load-bearing one. With ~34 of 5,000 rows in the document, a
     * window-relative number would have a screen reader announce "1 of 34" for
     * a whole session. `Row` carries `setSize`/`posInSet` for this alone, and a
     * sibling set never mixes an event with a turn.
     */
    const sizes = [...markup.matchAll(/aria-setsize="(\d+)"/g)].map((m) => Number(m[1]));
    const positions = [...markup.matchAll(/aria-posinset="(\d+)"/g)].map((m) => Number(m[1]));
    expect(sizes).toEqual(rows.map((row) => row.setSize));
    expect(positions).toEqual(rows.map((row) => row.posInSet));
    expect(sizes, 'the two events are a set of two, whatever the window shows').toContain(2);
  });

  it('marks expansion only on rows that can expand', () => {
    const expandable = rows.filter((row) => row.hasChildren).length;
    expect(markup.match(/aria-expanded=/g) ?? []).toHaveLength(expandable);
    expect(expandable).toBe(3);
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

  it('indents a folded turn header the same way it indents an event', () => {
    // A turn header is no longer always at depth 0, and a class name assembled
    // from a depth is invisible to Tailwind's scanner.
    expect(markup).toContain('padding-left:28px');
  });
});

/* -------------- Test 6 — the header derives its four missing fields -------- */

describe('chips are read off the server’s rollups, never resummed (Test 6, AC1)', () => {
  it('a turn header shows the turn’s stored totals, not the sum of its events', () => {
    /*
     * The fixture deliberately DISAGREES with its own events. That disagreement
     * is the whole test: a component that recomputed would render the sum and
     * go red, and one that reads renders the stored number.
     */
    const markup = turnRowMarkup({
      tokens_in: 9_000,
      tokens_out: 999,
      est_cost: 1.25,
      duration_ms: 60_000,
      error_count: 3,
    });

    expect(markup).toContain('9,999 tok');
    expect(markup).toContain('$1.25');
    expect(markup).toContain('1m 0s');
    expect(markup).toContain('3 err');
  });

  it('derives status, tokens, end and turn count from the wire row', () => {
    /*
     * `GET /api/sessions/:id` sends no `status`, no `ended_at` and no
     * `total_tokens`. Task 5.2 deleted the adapter that invented them, so the
     * component derives them and this pins all four.
     *
     * Mutation check, verified by hand: read `session.total_tokens` and the
     * token chip spells `undefined`.
     */
    const live = renderToStaticMarkup(
      <SessionHeader
        session={makeSessionRow({ live: true, tokens_in: 10, tokens_out: 5, turn_count: 3 })}
        now={NOW}
      />,
    );
    expect(live).toContain('live');
    expect(live).toContain('15 tok');
    expect(live).toContain('3 turns');

    const done = renderToStaticMarkup(
      <SessionHeader
        session={makeSessionRow({
          live: false,
          started_at: '2026-07-29T09:00:00.000Z',
          last_activity_at: '2026-07-29T09:05:00.000Z',
        })}
        now={NOW}
      />,
    );
    expect(done).toContain('complete');
    // Closed at `last_activity_at`, not at the injected clock ten minutes on.
    expect(done).toContain('5m 0s');
  });

  it('a session header shows the session’s stored totals (AC4-render)', () => {
    const session = makeSessionRow({
      tokens_in: 120_000,
      tokens_out: 3_456,
      est_cost: 4.5,
      error_count: 2,
      turn_count: 7,
      started_at: '2026-07-29T09:00:00.000Z',
      last_activity_at: '2026-07-29T09:05:00.000Z',
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
    const markup = renderToStaticMarkup(<SessionHeader session={makeSessionRow()} now={NOW} />);

    expect(markup).toContain('data-slot="back-to-sessions"');
    expect(markup).toContain(`href="${hrefFor({ name: 'sessions' })}"`);
    expect(hrefFor({ name: 'sessions' }), 'the list lives at the root').toBe('/');
    // Icon-only would be unannounceable; the accessibility baseline asks for a
    // label on every control that is not its own text.
    expect(markup).toContain('aria-label="Back to sessions"');
  });

  it('a session with no errors renders no error chip', () => {
    const markup = renderToStaticMarkup(
      <SessionHeader session={makeSessionRow({ error_count: 0 })} now={NOW} />,
    );
    expect(markup).not.toContain('data-slot="session-errors"');
  });

  it('spells an unpriced session as the em dash, never as $0', () => {
    const markup = renderToStaticMarkup(
      <SessionHeader session={makeSessionRow({ est_cost: null })} now={NOW} />,
    );
    expect(markup).toContain('—');
    expect(markup).not.toContain('$0');
  });

  it('omits a chip an event has no number for rather than rendering a zero', () => {
    const markup = eventRowMarkup({ tokens_in: null, tokens_out: null, est_cost: null });
    expect(markup).not.toContain('0 tok');
    expect(markup).not.toContain('data-slot="metric-cost"');
  });
});

/* -------------------------- the selection affordance ---------------------- */

describe('the selected row is washed and edged, per the flagship-row spec', () => {
  it('takes the accent wash and the accent left edge when selected', () => {
    const markup = eventRowMarkup({ status: 'ok' }, true);
    expect(markup).toContain('bg-accent-muted');
    expect(markup).toContain('border-l-accent');
  });

  it('holds the edge’s width when unselected, so nothing shifts sideways', () => {
    const markup = eventRowMarkup({ status: 'ok' }, false);
    expect(markup).toContain('border-l-2');
    expect(markup).toContain('border-l-background');
    expect(markup).not.toContain('bg-accent-muted');
  });

  it('indents by depth with an inline offset, never with a built class name', () => {
    const row = NESTED_ROWS.find((r): r is EventRowModel => r.id === 'seed-s0:1-ev-0');
    if (row === undefined) throw new Error('no nested event row');
    const markup = renderToStaticMarkup(<TreeSpanRow row={row} selected={false} focused={false} />);
    expect(markup).toContain('padding-left:42px');
    expect(
      markup,
      "a class name assembled at runtime is invisible to Tailwind's scanner " +
        'and compiles to nothing — silently.',
    ).not.toMatch(/class="[^"]*pl-\[/);
  });
});

/* ------------------- Task 5.5 — the sub-agent an Agent row opens ----------- */

/**
 * The rows a spliced sidecar produces, built the way the page builds them: the
 * real reducer, the real seed, and `flatten` with the real subtree map.
 *
 * Nothing here hand-writes a `Row`. Every `Row` in this repo comes out of
 * `flatten`, and a literal would be free to carry a `sessionId` the walk never
 * assigns.
 */
function subagentRows(event: Partial<EventRow> = {}, header: Partial<SessionListRow> = {}): Row[] {
  // Both TURNS are unpriced on purpose, so the only currency anywhere in the
  // rendered tree is the sub-agent header's own. Without that, a turn rollup of
  // `$0.01` would satisfy — or spoil — every assertion about the child's cost.
  const parent = makeTurnTree([
    { id: 'seed-s0:0', seq: 0, est_cost: null, events: [{ name: 'Read' }, makeAgentEvent(event)] },
  ]);
  const model = buildTurnGroups(parent.turns, parent.eventsByTurn);
  const child = makeSidecarDetail(
    'child-0',
    makeTurnTree([{ id: 'c0', seq: 0, est_cost: null, events: [{ name: 'Grep' }] }]),
    header,
  );
  const sub = subagentReducer(initialSubagentState, {
    type: 'loaded',
    childId: 'child-0',
    child,
  });
  const nav = expandMany(initialNavState(model.rowIds), turnIdsToOpen(child));
  return flatten(model, nav.expandedIds, undefined, {
    rootSessionId: 'seed-s0',
    subtrees: subtreesOf(sub),
  });
}

/** The whole tree, rendered through an UNMODIFIED `SpanTree`. */
function subagentMarkup(event: Partial<EventRow> = {}, header: Partial<SessionListRow> = {}) {
  return renderToStaticMarkup(
    <SpanTree
      rows={subagentRows(event, header)}
      focusedIndex={0}
      initialRect={{ width: 1280, height: 720 }}
    />,
  );
}

describe('an Agent row names its sub-agent and says how it ended (Test 13, AC3)', () => {
  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    // MEASURED 0 rows, and NOT dead: `src/project/tools.ts:203` assigns the
    // notification's status verbatim and the parser is proven to return this
    // word. Reachable-but-unobserved keeps its arm.
    ['killed', 'killed'],
    ['running', 'running'],
    // 39 of 260 child-bearing events carry no status at all — 15.0%.
    [null, 'unknown'],
  ])('renders agent_status %s as %s', (wire, shown) => {
    const markup = subagentMarkup({ agent_status: wire });
    expect(markup).toContain('data-slot="span-subagent"');
    expect(markup).toContain(shown);
  });

  it('renders agent_type, which is populated on 260 of 260 rows', () => {
    expect(subagentMarkup({ agent_type: 'approach-critic' })).toContain('approach-critic');
  });

  it('draws with the palette token that had no consumer until now', () => {
    // `--span-subagent` has been in the locked palette since the design system
    // landed; `VISUAL_OF_KIND` maps no event kind onto it, so this row is its
    // first real use. No new token is invented.
    expect(subagentMarkup()).toContain(SPAN_VISUALS.type.subagent.tint);
  });

  it('names the sub-agent in the row’s accessible name, not by colour alone', () => {
    const markup = subagentMarkup({ agent_type: 'task-shipper', agent_status: 'failed' });
    expect(markup).toMatch(/aria-label="[^"]*sub-agent task-shipper, failed/);
  });

  it('leaves an ordinary tool call untouched', () => {
    expect(eventRowMarkup({ name: 'Read' })).not.toContain('data-slot="span-subagent"');
  });
});

describe('the spliced rows say whose transcript they are (AC1, AC-R1c)', () => {
  const markup = subagentMarkup();

  it('stamps the Agent row with the parent’s id and its own child id', () => {
    expect(markup).toContain('data-session-id="seed-s0"');
    expect(markup).toContain('data-child-session-id="child-0"');
  });

  it('stamps the nested rows with the CHILD’s id', () => {
    expect(markup).toContain('data-session-id="child-0"');
    // The event row, not just the turn row: a splice carrying only a depth
    // offset would still stamp the turn row correctly.
    const nestedEventRows = subagentRows().filter(
      (row) => row.kind === 'event' && row.sessionId === 'child-0',
    );
    expect(nestedEventRows.map((row) => row.id)).toEqual(['c0-ev-0']);
  });
});

describe('the child’s root row carries the sub-agent’s own numbers (Test 14, AC3)', () => {
  it('renders the description and the rollup through an UNMODIFIED SpanTree', () => {
    /*
     * `SpanTree` forwards `row` and nothing else, so proving this through the
     * real component — rather than by rendering `TraceGroup` directly — is what
     * makes the pass-through claim a fact instead of an assertion.
     */
    const markup = subagentMarkup({}, { tokens_in: 900, tokens_out: 100 });
    expect(markup).toContain('data-slot="trace-subagent"');
    expect(markup).toContain('find every caller of buildTurnGroups');
    expect(markup).toContain('1,000 tok');
  });

  it('puts the header block on the child’s root row and on no parent row', () => {
    const markup = subagentMarkup();
    expect(markup.match(/data-slot="trace-subagent"/g) ?? []).toHaveLength(1);
  });

  it('spells an unpriced sub-agent as the em dash, never as $0 (Test 15, AC3)', () => {
    /*
     * ★ MEASURED 262 of 272 SIDECARS ARE UNPRICED, so this is the common path,
     * not the corner. 283 of 293 sessions run `claude-opus-5`, which task 0.8
     * records as absent from `PRICING_TABLE`. The cost is therefore routed
     * around `RowChips`, which OMITS its chip when the number is not above zero
     * — a vanished chip rather than a dash, and that omission is deliberately
     * pinned elsewhere in this file.
     */
    const markup = subagentMarkup({}, { est_cost: null });
    expect(markup).toContain('data-slot="metric-cost"');
    expect(markup).toContain('—');
    expect(
      markup,
      'no turn in this tree is priced, so any currency here is the child’s',
    ).not.toContain('$');
  });

  it('spells a zero cost as the em dash too', () => {
    const markup = subagentMarkup({}, { est_cost: 0 });
    expect(markup).toContain('data-slot="metric-cost"');
    expect(markup).toContain('—');
    expect(markup).not.toContain('$');
  });

  it('prints a real cost when the sidecar has one — 10 of 272 do', () => {
    // Under a cent, so it takes the three-decimal spelling and cannot be
    // confused with any rounded number elsewhere in the tree.
    expect(subagentMarkup({}, { est_cost: 0.0077 })).toContain('$0.008');
  });

  it('omits the TURN’s own cost chip while showing the sub-agent’s dash', () => {
    /*
     * The two spellings side by side, which is why the cost is routed around
     * `RowChips` at all: the turn's unpriced chip VANISHES — deliberate, and
     * pinned elsewhere in this file — while the sub-agent's renders the dash the
     * data-model rule requires.
     */
    const markup = subagentMarkup({}, { est_cost: null });
    expect(markup.match(/data-slot="metric-cost"/g) ?? []).toHaveLength(1);
  });
});

describe('nested depth is an inline offset, never a built class (Test 16, AC2)', () => {
  it('indents each spliced level by INDENT_PX and varies no class with depth', () => {
    const markup = subagentMarkup();
    // Agent row at depth 1, the child's root turn at 2, its event at 3.
    expect(markup).toContain(`padding-left:${1 * INDENT_PX}px`);
    expect(markup).toContain(`padding-left:${2 * INDENT_PX}px`);
    expect(markup).toContain(`padding-left:${3 * INDENT_PX}px`);
    expect(
      markup,
      "a class name assembled at runtime is invisible to Tailwind's scanner and " +
        'compiles to nothing — silently, at every depth at once.',
    ).not.toMatch(/class="[^"]*pl-\[/);
  });
});

/* ---------------- every status the wire can carry actually renders --------- */

describe('every status on one page renders its own treatment', () => {
  const rows = rowsForEvents(
    EVENT_STATUSES.map((status) => ({ id: `ev-${status}`, name: status, status })),
  );
  const markup = renderToStaticMarkup(
    <SpanTree rows={rows} focusedIndex={0} initialRect={{ width: 1280, height: 720 }} />,
  );

  it.each([...EVENT_STATUSES])('%s appears exactly once', (status) => {
    expect(markup.match(new RegExp(`data-span-status="${status}"`, 'g')) ?? []).toHaveLength(1);
  });

  it('washes exactly the two failing rows', () => {
    expect(markup.match(/bg-error\/8/g) ?? []).toHaveLength(2);
  });
});
