import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  COLUMN_LABELS,
  SORT_COLUMNS,
  emptyStateCopy,
  formatRowCount,
  LIST_LIMIT,
  rowLabel,
  type EmptyStateShown,
  type SortColumn,
} from '../../../lib/session-list';
import { hrefFor } from '../../../lib/route-match';
import { createRouter } from '../../../lib/router';
import { fakeHistoryPort } from '../../../lib/__tests__/helpers';
import { makePage, makeSessionRow, stubApiClient } from '../../../lib/__tests__/fixtures';
import type { SessionListRow } from '../../../lib/api';
import { designSystemLines, userFlowPath, userFlowText } from '../../../__tests__/spec-doc';
import { SessionListView } from '../SessionListView';
import { EmptyState } from '../EmptyState';
import { VolumeHistogram } from '../VolumeHistogram';
import { RangeControl } from '../RangeControl';
import { Sessions } from '../../../pages/Sessions';

/*
 * Task 5.2b's rendering half.
 *
 * `renderToStaticMarkup` only — the `ui` project has no DOM, effects never run,
 * and every component below is props-in / JSX-out precisely so that one static
 * render can assert everything it does.
 *
 * This file never calls `builtCss()`. `build-ui.ts` memoizes its Vite run in
 * module scope and vitest hands each test file a fresh module registry, so a
 * second suite asking for the built CSS pays for a whole second build. The
 * "does this class emit a rule?" claims live in `retokenized.test.ts`, which
 * already owns that build.
 */

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function markupOf(
  rows: SessionListRow[],
  sort: SortColumn = 'last_activity_at',
  cursor = -1,
): string {
  return renderToStaticMarkup(
    <SessionListView
      rows={rows}
      sort={sort}
      direction="desc"
      onSortChange={() => undefined}
      cursor={cursor}
      now={NOW}
    />,
  );
}

/** The text of the unpriced strip alone — never the row hrefs beside it. */
function unpricedStrip(markup: string): string {
  return /data-slot="unpriced-notice".*?<span[^>]*>([^<]*)</s.exec(markup)?.[1] ?? '';
}

/* ------------------------------------------------------- AC1 — 300 rows --- */

describe('SessionListView renders a large page correctly (Test 5)', () => {
  /*
   * 300 rows carrying all THREE cost states, because there are three.
   *
   * The zero-cost row is not decoration. `MetricChip` takes a pre-spelled
   * string, so a row written as `String(session.est_cost)` type checks and
   * renders `0` — and an anchor-count-and-href assertion would sail straight
   * past it. The em-dash mapping is what `design-system.md` mandates and what
   * AC1a names, so it is asserted on the same fixture rather than only on
   * `formatCost` in isolation (which is where Task 5.2a proved it, and which
   * proves nothing about this component's wiring).
   *
   * Task 0.8 seeded the third state: row 11 is UNPRICED — no rate was found for
   * its model — where row 7 measured a real zero. Both spell the em dash, and
   * that stays true; what separates them is the markup, asserted below.
   */
  const rows = Array.from({ length: 300 }, (_, i) =>
    makeSessionRow({
      id: `s-${i}`,
      project_path: `/tmp/p-${i % 4}`,
      started_at: new Date(NOW - i * 60_000).toISOString(),
      last_activity_at: new Date(NOW - i * 60_000 + 5_000).toISOString(),
      model: i === 11 ? 'claude-opus-5' : 'claude-sonnet-5',
      est_cost: i === 7 ? 0 : i === 11 ? null : 1.5,
    }),
  );
  const markup = markupOf(rows);

  /** The spelled text of every cost chip, in row order. */
  const costs = [...markup.matchAll(/data-slot="metric-cost"[^>]*>([^<]*)</g)].map((m) => m[1]);

  it('renders exactly one anchor per row', () => {
    expect(markup.match(/<a\s/g) ?? []).toHaveLength(300);
  });

  it('gives every row the href the router itself would build, in order', () => {
    const hrefs = [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(rows.map((s) => hrefFor({ name: 'session', sessionId: s.id })));
  });

  it('spells a zero cost as the em dash and never as a currency amount (AC1a)', () => {
    expect(costs, 'one cost chip per row').toHaveLength(300);
    expect(
      costs.filter((c) => c === '—'),
      'the two absences in the fixture — row 7 measured zero, row 11 unpriced',
    ).toHaveLength(2);
    expect(
      costs,
      'a row rendering est_cost directly type checks — MetricChip takes a ' +
        'string — and passes an href-only assertion, so this is the one thing ' +
        'standing between a zero-cost session and a screen that says $0.',
    ).not.toContain('0');
    expect(costs).not.toContain('$0');
    expect(
      new Set(costs),
      'ONE spelling for both absences — design-system.md:153 allows no other',
    ).toEqual(new Set(['—', '$1.50']));
  });

  it('★ marks the unpriced row and leaves the zero-cost row alone (Test 3, AC3)', () => {
    /*
     * ★ THE WHOLE OF AC3, ON THE SAME PAGE. Both rows read `—`, so the screen
     * keeps one spelling of an absent number — and the markup still says which
     * absence each one is. `design-system.md:141`'s unknown treatment, reused
     * rather than reinvented: faint, plus the word in `title` AND `aria-label`.
     */
    const chips = [...markup.matchAll(/<span data-slot="metric-cost"[^>]*>/g)].map((m) => m[0]);
    expect(chips, 'one cost chip per row').toHaveLength(300);

    const marked = chips.filter((chip) => chip.includes('title='));
    expect(marked, 'row 11 and no other').toHaveLength(1);
    expect(marked[0]).toContain('cost unknown — no rate for claude-opus-5');
    expect(marked[0], 'never colour alone').toContain('aria-label="cost unknown');
    expect(marked[0]).toContain('text-faint');

    // Row 7 costs a real zero: nothing is unknown about it, so nothing is said.
    expect(chips[7]).not.toContain('title=');
    expect(chips[7]).toContain('text-muted');
    // And 298 priced rows are untouched by any of this.
    expect(chips.filter((chip) => chip.includes('text-muted'))).toHaveLength(299);
  });

  it('states the pricing gap once above the rows, over the rows below it', () => {
    /*
     * ★ THE DENOMINATOR IS THE SCREEN'S, NOT THE CORPUS'S. 283 of 293 sessions
     * are unpriced corpus-wide, counted over sidecars the list never draws
     * (`src/db/read.ts:291` selects top-level only). This page shows 300 rows
     * and 1 of them is unpriced, so 1 of 300 is what it says.
     */
    expect(markup).toContain('data-slot="unpriced-notice"');

    const strip = unpricedStrip(markup);
    expect(strip).toContain('Cost unknown on 1 of 300 sessions shown');
    expect(strip).toContain('no rate for claude-opus-5');
    expect(strip, 'the tokens are exact; only the multiplication is missing').toContain(
      'Token counts are exact',
    );
    expect(strip, 'a denominator the rows on screen contradict').not.toContain('293');
    expect(strip).not.toContain('283');
  });

  it('the strip counts exactly the chips it sits above, on the same page', () => {
    /*
     * The invariant the split between the two would otherwise let drift: the
     * strip states a number and the chips below it are the evidence. Both read
     * `costUnknownLabel`, so they agree by construction — this asserts the
     * construction actually held.
     */
    const stated = Number(/on (\d+) of/.exec(unpricedStrip(markup))?.[1]);
    const marked = (markup.match(/data-slot="metric-cost" title=/g) ?? []).length;

    expect(stated).toBe(marked);
    expect(marked, 'row 11, and the fixture says so').toBe(1);
  });

  it('marks the cursor row and only the cursor row', () => {
    const highlighted = (m: string) => (m.match(/bg-surface-raised/g) ?? []).length;
    const none = highlighted(markupOf(rows.slice(0, 5)));
    const one = highlighted(markupOf(rows.slice(0, 5), 'last_activity_at', 2));
    expect(one).toBe(none + 1);
  });

  it('offers every sortable column as a real button, and no others (AC3)', () => {
    /*
     * ★ CUT FROM FOUR TO TWO BY TASK 5.1, which is an AC and not a weakening:
     * the founder's reading of the four-control strip is that it looks like a
     * tab bar, and AC3 reduces it to project + time. The list is no longer
     * hard-coded either — it iterates the constants the component itself reads,
     * so the next change to `SORT_COLUMNS` adjusts this test instead of reding
     * it for a reason a reader has to go and look up.
     */
    const markup = markupOf(rows.slice(0, 1));
    expect(SORT_COLUMNS.length, 'project and time, per AC3').toBe(2);
    for (const column of SORT_COLUMNS) expect(markup).toContain(COLUMN_LABELS[column]);
    expect(markup.match(/<button/g) ?? []).toHaveLength(SORT_COLUMNS.length);

    // And the two that went are really gone, not merely unlabelled.
    for (const gone of ['Started', 'Tokens', 'Cost']) expect(markup).not.toContain(`>${gone}`);
  });

  it('renders a sort chevron on the sorted column only', () => {
    const svgs = markupOf(rows.slice(0, 2)).match(/<svg/g) ?? [];
    expect(svgs).toHaveLength(1);
  });
});

/* --------------------------- Task 0.8 — the strip above the list, AC3 ----- */

describe('the unpriced strip raises and clears with the rows themselves', () => {
  it('draws nothing at all when every row on screen has a price', () => {
    /*
     * ★ NO STORED STATE AND NO DISMISSAL — plan 001 built a banner around
     * stored state twice and twice the raise could not be falsified by the
     * clear. Here the raise IS the data: price the model and the next response
     * carries numbers, so this strip goes on its own with nothing to clear.
     */
    const markup = markupOf([makeSessionRow({ est_cost: 1.5 })]);
    expect(markup).not.toContain('unpriced-notice');
    expect(markup).not.toContain('Cost unknown');
  });

  it('draws nothing for a session that measured a real zero', () => {
    // Zero is a priced answer. Only a missing rate is a gap in what agent-lens
    // can tell the reader.
    expect(markupOf([makeSessionRow({ est_cost: 0 })])).not.toContain('unpriced-notice');
  });

  it('is announced as a status, and carries no control to dismiss it', () => {
    const markup = markupOf([makeSessionRow({ est_cost: null })]);
    expect(markup).toContain('role="status"');
    expect(markup.match(/<button/g) ?? [], 'the two sort controls, and nothing new').toHaveLength(
      SORT_COLUMNS.length,
    );
  });
});

/* ------------------------------------------ AC1 — honest counts + labels --- */

describe('every row states its stored turn count (Test 3)', () => {
  it('renders the column verbatim, never a recount off the other counters', () => {
    // The stored value deliberately contradicts every number beside it: a row
    // that summed anything client-side would show something other than 3.
    const markup = markupOf([
      makeSessionRow({ turn_count: 3, tool_call_count: 412, error_count: 0, agent_count: 0 }),
    ]);

    expect(markup).toContain('data-slot="session-turns"');
    expect(markup).toContain('3 turns');
    expect(markup).not.toContain('412 turns');
  });

  it('renders a zero turn count as zero, because zero is the honest answer', () => {
    // Measured: 2 of 21 top-level sessions read 0, both driven entirely through
    // slash commands. `turn_count` counts HUMAN prompts, so 0 is true.
    const markup = markupOf([makeSessionRow({ turn_count: 0 })]);
    expect(markup).toContain('0 turns');
  });

  it('states it on every row of a large page', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      makeSessionRow({ id: `s-${i}`, turn_count: i }),
    );
    const markup = markupOf(many);
    expect(markup.match(/data-slot="session-turns"/g) ?? []).toHaveLength(40);
  });
});

describe('no row label renders a harness tag (Test 4)', () => {
  /*
   * ★ THIS IS THE GUARD THAT WORKS. Measured over the dev archive, 0 of 293
   * stored `sessions.title`/`preview` values carry a harness tag — the projector
   * gates the preview on a human prompt, so it structurally cannot emit one. The
   * render gate therefore has nothing to catch and would pass vacuously. This
   * test INJECTS the string, so the rejection rule is red-provable.
   */
  const machinery = '<task-notification>\n<task-id>ab203519d2e64bacf</task-id>';

  it('falls through to the project when both stored labels are markup', () => {
    const markup = markupOf([
      makeSessionRow({ title: machinery, preview: machinery, project_path: '/tmp/real-project' }),
    ]);

    expect(markup).not.toContain('&lt;task-notification');
    expect(markup).not.toContain('&lt;task-id');
    expect(markup).not.toContain('<task-notification');
    expect(markup).toContain('/tmp/real-project');
  });

  it('keeps the tag out of the accessible name too, not only the visible text', () => {
    const markup = markupOf([makeSessionRow({ title: machinery, preview: machinery })]);
    const label = /aria-label="([^"]*)"/.exec(markup)?.[1] ?? '';

    expect(label, 'a screen reader announces this string').not.toContain('task-notification');
    expect(label).not.toContain('task-id');
  });

  it('still renders an ordinary prompt as the label', () => {
    expect(markupOf([makeSessionRow({ title: 'ship the projector' })])).toContain(
      'ship the projector',
    );
    expect(rowLabel(makeSessionRow({ title: 'ship the projector' }))).toBe('ship the projector');
  });
});

/* --------------------------------------------- AC3 — badges and chips ----- */

describe('status, degradation and errors are visible, not just coloured', () => {
  it('a live row carries the pulse AND the literal word (Test 13)', () => {
    const markup = markupOf([makeSessionRow({ live: true })]);
    expect(markup).toContain('animate-live-pulse');
    expect(
      markup,
      'design-system.md: "status never conveyed by color alone; live gets ' +
        "pulse + 'live' text\". The word is the half that survives a rename.",
    ).toContain('live');
  });

  it('a settled row carries its own word and no pulse', () => {
    const markup = markupOf([makeSessionRow({ live: false })]);
    expect(markup).toContain('complete');
    expect(markup).not.toContain('animate-live-pulse');
  });

  it('claims no capture mode, because the v2 wire carries none (Test 14)', () => {
    /*
     * ★ REPOINTED BY TASK 5.1, not deleted. Task 4.5's adapter stamped
     * `capture_mode: 'transcript_only'` on EVERY row — a fabricated value, so
     * the chip it drove appeared on all of them and distinguished nothing. The
     * adapter is gone and the column does not exist on `GET /api/sessions`, so
     * the assertion that means something now is that nobody invents it again.
     */
    expect(markupOf([makeSessionRow()])).not.toContain('data-slot="degraded-chip"');
    expect(markupOf([makeSessionRow({ has_drift: true })])).not.toContain('transcript only');
  });

  it('error_count > 0 renders the count; 0 renders nothing (Test 15)', () => {
    const failing = markupOf([makeSessionRow({ error_count: 3 })]);
    expect(failing).toContain('data-slot="session-errors"');
    expect(failing).toContain('3 err');

    expect(markupOf([makeSessionRow({ error_count: 0 })])).not.toContain(
      'data-slot="session-errors"',
    );
  });

  it('shimmers the sub-agent totals while the sweep is still running (Test 11)', () => {
    /*
     * `rollup_state === 'own'` means the sidecars have not been folded in, and
     * omitting them costs 2–6x. A number that is wrong by that much is worse
     * than no number, so the cell is a skeleton until the sweep settles.
     */
    const pending = markupOf([
      makeSessionRow({ rollup_state: 'own', agent_count: 3, sub_tokens_in: 0, sub_tokens_out: 0 }),
    ]);

    expect(pending).toContain('data-slot="session-subs-pending"');
    expect(pending).not.toContain('data-slot="session-subs"');
    expect(pending, 'design-system.md, Loading states: pulsing --surface-raised').toContain(
      'animate-pulse',
    );
    expect(
      pending,
      'design-system.md: "Respect prefers-reduced-motion: pulse becomes a ' +
        'static badge." A bare animate-pulse satisfies the atom and breaks that.',
    ).toContain('motion-reduce:animate-none');
  });

  it('states the stored sub-agent figures once the sweep has settled', () => {
    const settled = markupOf([
      makeSessionRow({
        rollup_state: 'complete',
        agent_count: 3,
        sub_tokens_in: 12_000,
        sub_tokens_out: 3_400,
      }),
    ]);

    expect(settled).toContain('data-slot="session-subs"');
    expect(settled).not.toContain('data-slot="session-subs-pending"');
    expect(settled, 'the exact stored total, thousands-separated').toContain('15,400');
  });

  it('draws no sub-agent cell at all for a session that launched none', () => {
    // A `+0` on nineteen rows of twenty makes the one that matters harder to
    // find — the same rule the capture chip was written against.
    const markup = markupOf([makeSessionRow({ agent_count: 0 })]);
    expect(markup).not.toContain('data-slot="session-subs"');
    expect(markup).not.toContain('data-slot="session-subs-pending"');
  });

  it('never puts an ARIA row role on an anchor', () => {
    expect(
      markupOf([makeSessionRow()]),
      'role="row" overrides the anchor\'s implicit link role and is invalid ' +
        'without an owning grid — the row would stop being announced as a link.',
    ).not.toContain('role="row"');
  });
});

/* ------------------------------------------------ AC2 — the empty states -- */

/** The design-system paragraph the empty-state copy is ruled against. */
function emptyStatesSpec(): string {
  const lines = designSystemLines();
  const heading = lines.findIndex((line) => line.trim() === '### Empty states');
  expect(heading, 'design-system.md no longer has an Empty states section').toBeGreaterThan(-1);
  const next = lines.findIndex((line, i) => i > heading && line.startsWith('### '));
  return lines.slice(heading, next === -1 ? undefined : next).join('\n');
}

/*
 * The same loud-not-skipped contract `tokens.test.ts` states for
 * design-system.md, now extended to the two flow documents Task 5.2b started
 * reading. `internal_docs/` is git-ignored by design, so this suite needs a
 * working copy that has it — and a missing document must say so rather than
 * surfacing as an ENOENT stack under an unrelated assertion.
 */
describe('spec file location', () => {
  it.each(['firstRun', 'inspectSession'] as const)('%s flow document is readable', (name) => {
    expect(
      () => userFlowText(name),
      `${userFlowPath(name)} not found. The empty-state copy is pinned to it, so ` +
        'this fails loudly rather than letting the pin quietly assert nothing.',
    ).not.toThrow();
  });
});

describe('the empty-state copy is pinned to the spec, not invented (Test 11)', () => {
  it('never-captured is spelled as Flow 1 spells it', () => {
    const { sentence } = emptyStateCopy({ kind: 'never_captured' });
    expect(
      userFlowText('firstRun'),
      'the 2026-07-30 ruling: design-system.md introduces its own version with ' +
        '"e.g." — a pattern, not a string — so the flow document wins the ' +
        'wording, including "it WILL appear".',
    ).toContain(sentence);
    expect(emptyStatesSpec(), 'and the design system now records that ruling').toContain(sentence);
  });

  it('the doctor hint comes from Flow 3, where it is specced', () => {
    const { hint } = emptyStateCopy({ kind: 'never_captured' });
    const doctor = 'agent-lens doctor';
    expect(hint).toContain(doctor);
    expect(userFlowText('inspectSession')).toContain(doctor);
  });

  it('out-of-range is "outside range", per the design system and Flow 3\'s diagram', () => {
    const { sentence } = emptyStateCopy({ kind: 'outside_range', count: 7, truncated: false });
    expect(sentence).toContain('outside range');
    expect(emptyStatesSpec()).toContain('outside range');
    expect(userFlowText('inspectSession')).toContain('outside range');
    expect(
      sentence,
      'Flow 3\'s prose spells it "outside THIS range" and LOST the ruling 2-1, ' +
        'so this copy must not be pinned against that line.',
    ).not.toContain('outside this range');
  });

  it("the fourth state's copy landed in the design system before being used", () => {
    const { sentence, hint } = emptyStateCopy({
      kind: 'no_match_for_project',
      project: '/p/one',
      count: 12,
      truncated: false,
    });
    const spec = emptyStatesSpec();
    expect(spec).toContain('in this range across all projects.');
    expect(spec).toContain('{project}');
    expect(spec).toContain(hint);
    expect(sentence).toContain('/p/one');
    expect(sentence).toContain('12 in this range across all projects.');
  });
});

describe('a populated list states its own size', () => {
  it.each([
    [0, false, '0 sessions'],
    [1, false, '1 session'],
    [2, false, '2 sessions'],
    [300, false, '300 sessions'],
    [1000, false, '1,000 sessions'],
    [300, true, '300+ sessions'],
    // Plural even at one, because "1+ session" would claim a precision the
    // trailing `+` is there to deny.
    [1, true, '1+ sessions'],
  ])('formatRowCount(%i, truncated=%s) -> %s', (showing, truncated, expected) => {
    expect(formatRowCount(showing, truncated)).toBe(expected);
  });

  it('counts the rows on screen, not the size of the page they came from', () => {
    // Ten loaded, narrowed to three: the count answers "how many am I looking
    // at", so it must follow `rows`, never the unnarrowed page.
    const rows = Array.from({ length: 3 }, (_, i) => makeSessionRow({ id: `s${i}` }));
    const markup = renderToStaticMarkup(
      <SessionListView
        rows={rows}
        sort={'last_activity_at' as SortColumn}
        direction="desc"
        onSortChange={() => {}}
        cursor={-1}
        now={Date.parse('2026-07-30T12:00:00.000Z')}
      />,
    );
    expect(markup).toContain('3 sessions');
    expect(markup).not.toContain('10 sessions');
  });

  it('degrades to N+ when the page stopped early, and omits the + when it did not', () => {
    const rows = Array.from({ length: 2 }, (_, i) => makeSessionRow({ id: `s${i}` }));
    const render = (pageTruncated: boolean) =>
      renderToStaticMarkup(
        <SessionListView
          rows={rows}
          sort={'last_activity_at' as SortColumn}
          direction="desc"
          onSortChange={() => {}}
          cursor={-1}
          now={0}
          pageTruncated={pageTruncated}
        />,
      );
    expect(render(true)).toContain('2+ sessions');
    expect(render(false)).toContain('2 sessions');
    expect(render(false)).not.toContain('2+');
  });

  it('spells the noun and the degrade marker the spec asks for, not an invented pair', () => {
    // Same discipline as the empty-state copy pin: the design system is the
    // source, so a reworded count here goes red rather than drifting quietly.
    const spec = designSystemLines().join('\n');
    expect(spec).toContain('**"N sessions"**');
    expect(spec).toContain('"1 session"');
    expect(spec).toContain('**"N+ sessions"**');
  });

  it('defaults to the honest reading when the flag is omitted', () => {
    // An absent flag must not overstate certainty in either direction: it means
    // "not known to have stopped early", which spells as a plain count.
    const markup = renderToStaticMarkup(
      <SessionListView
        rows={[makeSessionRow({ id: 's0' })]}
        sort={'last_activity_at' as SortColumn}
        direction="desc"
        onSortChange={() => {}}
        cursor={-1}
        now={0}
      />,
    );
    expect(markup).toContain('1 session');
    expect(markup).not.toContain('+');
  });
});

describe('counts pluralise and degrade honestly (Test 12)', () => {
  it.each([
    [1, false, '1 session outside range'],
    [7, false, '7 sessions outside range'],
    [2, true, '2+ sessions outside range'],
    [1, true, '1+ sessions outside range'],
  ])('outside_range: %i truncated=%s -> %s', (count, truncated, expected) => {
    expect(emptyStateCopy({ kind: 'outside_range', count, truncated }).sentence).toBe(expected);
  });

  it('degrades the outside-range count rather than stating a number it cannot stand behind', () => {
    const { sentence } = emptyStateCopy({
      kind: 'outside_range',
      count: LIST_LIMIT,
      truncated: true,
    });
    expect(sentence).toContain(`${LIST_LIMIT}+`);
  });

  it('no_match_for_project names the project and degrades the same way', () => {
    const truncated = emptyStateCopy({
      kind: 'no_match_for_project',
      project: '/tmp/api',
      count: LIST_LIMIT,
      truncated: true,
    });
    expect(truncated.sentence).toContain('No sessions in /tmp/api in this range');
    expect(truncated.sentence).toContain(`${LIST_LIMIT}+ in this range across all projects.`);
  });

  it.each([['never_captured'], ['outside_range'], ['no_match_for_project']])(
    '%s renders its sentence, its hint and a 24px icon',
    (kind) => {
      const state = {
        never_captured: { kind: 'never_captured' },
        outside_range: { kind: 'outside_range', count: 4, truncated: false },
        no_match_for_project: {
          kind: 'no_match_for_project',
          project: '/p/x',
          count: 9,
          truncated: false,
        },
      }[kind] as EmptyStateShown;

      const markup = renderToStaticMarkup(<EmptyState state={state} />);
      const { sentence, hint } = emptyStateCopy(state);

      expect(markup).toContain(escapeHtml(sentence));
      expect(markup).toContain(escapeHtml(hint));
      expect(markup, 'design-system.md: Lucide, 24px, --faint').toContain('width="24"');
      expect(markup).toContain('text-faint');
      expect(markup).toContain(`data-empty-kind="${state.kind}"`);
    },
  );
});

/** React escapes text nodes; the spec strings carry apostrophes and dashes. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ------------------------------------------------------- the other two ---- */

describe('VolumeHistogram', () => {
  const buckets = [
    { start: 0, end: 10, count: 0 },
    { start: 10, end: 20, count: 5 },
    { start: 20, end: 30, count: 10 },
  ];

  it('draws one element per bucket with its height inline, never as a class', () => {
    const markup = renderToStaticMarkup(<VolumeHistogram buckets={buckets} />);
    expect(markup.match(/data-slot="volume-bucket"/g) ?? []).toHaveLength(3);
    expect(markup).toContain('height:100%');
    expect(
      markup,
      "a class name assembled at runtime is invisible to Tailwind's scanner " +
        'and compiles to nothing — silently.',
    ).not.toMatch(/class="[^"]*h-\[/);
  });

  it('gives an all-zero range a baseline rather than nothing at all', () => {
    const flat = [
      { start: 0, end: 10, count: 0 },
      { start: 10, end: 20, count: 0 },
    ];
    const markup = renderToStaticMarkup(<VolumeHistogram buckets={flat} />);
    expect(markup.match(/data-slot="volume-bucket"/g) ?? []).toHaveLength(2);
    expect(markup).not.toContain('height:0%');
  });
});

describe('RangeControl', () => {
  const markup = renderToStaticMarkup(
    <RangeControl
      range="7d"
      onRangeChange={() => undefined}
      projects={['/tmp/a', '/tmp/b']}
      project="/tmp/b"
      onProjectChange={() => undefined}
    />,
  );

  it('offers every declared range and presses exactly the chosen one', () => {
    for (const option of ['3d', '7d', '30d', 'all']) expect(markup).toContain(`>${option}<`);
    expect(markup.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
  });

  it('lists every project plus an all-projects option', () => {
    expect(markup).toContain('All projects');
    expect(markup).toContain('/tmp/a');
    expect(markup).toContain('/tmp/b');
  });
});

/* ---------------------------------------------------- the page module ----- */

describe('Sessions renders under environment: node with both ports injected (Test 24)', () => {
  it('renders the pending branch without touching the address bar or the bootstrap', () => {
    const api = stubApiClient({
      listSessions: () => Promise.resolve(makePage<SessionListRow>([])),
    });
    const router = createRouter(fakeHistoryPort('/'));

    /*
     * The one-line assertion that keeps this page testable at all. Without
     * an injectable `api` the memo calls the client factory during render, whose
     * default reads the page bootstrap and throws outside a browser — and Task
     * 5.3's `<App />` render at `/session/x` reaches this exact line.
     */
    expect(() => renderToStaticMarkup(<Sessions router={router} api={api} />)).not.toThrow();

    const markup = renderToStaticMarkup(<Sessions router={router} api={api} />);
    expect(markup).toContain('<main');
    expect(
      markup,
      'effects never run here, so the first render is the pending one and the ' +
        'request has not been made, let alone answered.',
    ).not.toContain('data-slot="session-row"');
  });

  it('keeps the range control on screen while a load is pending', () => {
    const api = stubApiClient({
      listSessions: () => Promise.resolve(makePage<SessionListRow>([])),
    });
    const markup = renderToStaticMarkup(
      <Sessions router={createRouter(fakeHistoryPort('/'))} api={api} />,
    );

    expect(
      markup,
      'changing the range changes the load key, so an early return on the ' +
        'pending state would unmount the control that was just clicked and ' +
        "flash the page blank on this screen's primary gesture.",
    ).toContain('data-slot="range-control"');
    expect(markup).toContain('data-slot="volume-histogram"');
    expect(markup, 'and no empty state is claimed before the answer is in').not.toContain(
      'data-slot="empty-state"',
    );
  });
});
