import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Session } from '@shared/entities.ts';
import {
  emptyStateCopy,
  formatRowCount,
  LIST_LIMIT,
  type EmptyStateShown,
  type SortColumn,
} from '../../../lib/session-list';
import { hrefFor } from '../../../lib/route-match';
import { createRouter } from '../../../lib/router';
import { fakeHistoryPort } from '../../../lib/__tests__/helpers';
import { makePage, makeSession, stubApiClient } from '../../../lib/__tests__/fixtures';
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

function markupOf(rows: Session[], sort: SortColumn = 'started_at', cursor = -1): string {
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

/* ------------------------------------------------------- AC1 — 300 rows --- */

describe('SessionListView renders a large page correctly (Test 5)', () => {
  /*
   * 300 rows, one of which cost nothing.
   *
   * The zero-cost row is not decoration. `MetricChip` takes a pre-spelled
   * string, so a row written as `String(session.est_cost)` type checks and
   * renders `0` — and an anchor-count-and-href assertion would sail straight
   * past it. The em-dash mapping is what `design-system.md` mandates and what
   * AC1a names, so it is asserted on the same fixture rather than only on
   * `formatCost` in isolation (which is where Task 5.2a proved it, and which
   * proves nothing about this component's wiring).
   */
  const rows = Array.from({ length: 300 }, (_, i) =>
    makeSession({
      id: `s-${i}`,
      project_path: `/tmp/p-${i % 4}`,
      started_at: new Date(NOW - i * 60_000).toISOString(),
      ended_at: new Date(NOW - i * 60_000 + 5_000).toISOString(),
      est_cost: i === 7 ? 0 : 1.5,
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
      'exactly the one zero-cost session in the fixture renders the em dash',
    ).toHaveLength(1);
    expect(
      costs,
      'a row rendering est_cost directly type checks — MetricChip takes a ' +
        'string — and passes an href-only assertion, so this is the one thing ' +
        'standing between a zero-cost session and a screen that says $0.',
    ).not.toContain('0');
    expect(costs).not.toContain('$0');
    expect(new Set(costs)).toEqual(new Set(['—', '$1.50']));
  });

  it('marks the cursor row and only the cursor row', () => {
    const highlighted = (m: string) => (m.match(/bg-surface-raised/g) ?? []).length;
    const none = highlighted(markupOf(rows.slice(0, 5)));
    const one = highlighted(markupOf(rows.slice(0, 5), 'started_at', 2));
    expect(one).toBe(none + 1);
  });

  it('offers every sortable column as a real button', () => {
    const markup = markupOf(rows.slice(0, 1));
    for (const label of ['Started', 'Project', 'Tokens', 'Cost']) expect(markup).toContain(label);
    expect(markup.match(/<button/g) ?? []).toHaveLength(4);
  });

  it('renders a sort chevron on the sorted column only', () => {
    const svgs = markupOf(rows.slice(0, 2)).match(/<svg/g) ?? [];
    expect(svgs).toHaveLength(1);
  });
});

/* --------------------------------------------- AC3 — badges and chips ----- */

describe('status, degradation and errors are visible, not just coloured', () => {
  it('a live row carries the pulse AND the literal word (Test 13)', () => {
    const markup = markupOf([makeSession({ status: 'live', ended_at: undefined })]);
    expect(markup).toContain('animate-live-pulse');
    expect(
      markup,
      'design-system.md: "status never conveyed by color alone; live gets ' +
        "pulse + 'live' text\". The word is the half that survives a rename.",
    ).toContain('live');
  });

  it.each([
    ['complete', 'complete'],
    ['interrupted', 'interrupted'],
  ] as const)('a %s row carries its own word and no pulse', (status, label) => {
    const markup = markupOf([makeSession({ status })]);
    expect(markup).toContain(label);
    expect(markup).not.toContain('animate-live-pulse');
  });

  it('a transcript_only row carries the degraded chip (Test 14)', () => {
    const markup = markupOf([makeSession({ capture_mode: 'transcript_only' })]);
    expect(markup).toContain('data-slot="degraded-chip"');
    expect(markup).toContain('transcript only');
  });

  it('a full-capture row carries no degraded chip', () => {
    expect(markupOf([makeSession({ capture_mode: 'full' })])).not.toContain(
      'data-slot="degraded-chip"',
    );
  });

  it('error_count > 0 renders the count; 0 renders nothing (Test 15)', () => {
    const failing = markupOf([makeSession({ error_count: 3 })]);
    expect(failing).toContain('data-slot="session-errors"');
    expect(failing).toContain('3 err');

    expect(markupOf([makeSession({ error_count: 0 })])).not.toContain('data-slot="session-errors"');
  });

  it('never puts an ARIA row role on an anchor', () => {
    expect(
      markupOf([makeSession()]),
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
    const rows = Array.from({ length: 3 }, (_, i) => makeSession({ id: `s${i}` }));
    const markup = renderToStaticMarkup(
      <SessionListView
        rows={rows}
        sort={'started_at' as SortColumn}
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
    const rows = Array.from({ length: 2 }, (_, i) => makeSession({ id: `s${i}` }));
    const render = (pageTruncated: boolean) =>
      renderToStaticMarkup(
        <SessionListView
          rows={rows}
          sort={'started_at' as SortColumn}
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
        rows={[makeSession({ id: 's0' })]}
        sort={'started_at' as SortColumn}
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
    const api = stubApiClient({ listSessions: () => Promise.resolve(makePage<Session>([])) });
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
    const api = stubApiClient({ listSessions: () => Promise.resolve(makePage<Session>([])) });
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
