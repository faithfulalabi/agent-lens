import { describe, it, expect } from 'vitest';

import type { Page } from '@shared/api.ts';
import type { SessionListRow, SessionsQuery } from '../api.js';
import { createRouter } from '../router.js';
import {
  LIST_LIMIT,
  SORT_COLUMNS,
  applyIntent,
  cursorIntent,
  emptyStateOf,
  foldsUnderAgent,
  loadSessionList,
  projectsIn,
  rangeBounds,
  rowLabel,
  selectRows,
  volumeBuckets,
  withinRange,
  TIME_RANGES,
  type SessionListData,
} from '../session-list.js';
import { fakeHistoryPort } from './helpers.js';
import { makePage, makeSessionRow, makeTurnRow, stubApiClient } from './fixtures.js';

/*
 * Task 5.2b, the domain half — every branch AC1/AC2/AC3 care about, driven as a
 * plain function. The components render this module's output and decide nothing,
 * which is what keeps them assertable under `environment: 'node'`.
 */

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

/**
 * `n` wire rows, newest first, one hour apart, the newest active at `NOW`.
 *
 * Activity is the LATER of the two stamps, as it always is on a real row, and
 * the ladder is pinned by activity rather than by start: every selector under
 * test now reads `last_activity_at`, so a ladder whose newest row is active a
 * minute in the future would sit outside its own window.
 */
function ladder(
  n: number,
  overrides: (i: number) => Partial<SessionListRow> = () => ({}),
): SessionListRow[] {
  return Array.from({ length: n }, (_, i) =>
    makeSessionRow({
      id: `s${i}`,
      started_at: new Date(NOW - i * 3_600_000 - 60_000).toISOString(),
      last_activity_at: new Date(NOW - i * 3_600_000).toISOString(),
      ...overrides(i),
    }),
  );
}

/*
 * Task 4.5's second ladder is gone with the adapter that needed it. `selectRows`,
 * `emptyStateOf` and `volumeBuckets` all read `SessionListRow` now, so one type
 * serves both sides and a fixture can no longer describe a shape the wire cannot
 * send.
 */

/** A recorder around `listSessions`, so a test can read back every query sent. */
function recordingApi(pages: Page<SessionListRow>[]) {
  const queries: SessionsQuery[] = [];
  let call = 0;
  const api = stubApiClient({
    listSessions: (query = {}) => {
      queries.push(query);
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return Promise.resolve(page ?? makePage<SessionListRow>([]));
    },
  });
  return { api, queries, calls: () => call };
}

/** The shape `loadSessionList` returns, for the pure selectors' own tests. */
function dataOf(overrides: Partial<SessionListData> = {}): SessionListData {
  return {
    sessions: [],
    truncated: false,
    outsideRangeCount: 0,
    outsideRangeTruncated: false,
    projectSessions: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ AC1 --- */

describe('rangeBounds turns a range into its lower bound', () => {
  it.each([
    ['3d', 3],
    ['7d', 7],
    ['30d', 30],
  ] as const)('%s asks for the last %i days and sets no upper bound', (range, days) => {
    const bounds = rangeBounds(range, NOW);
    expect(bounds.from).toBe(new Date(NOW - days * 86_400_000).toISOString());
    expect(
      'to' in bounds,
      'an upper bound of "now" is what the absence of `to` already means.',
    ).toBe(false);
  });

  it('all asks for no lower bound either', () => {
    expect(rangeBounds('all', NOW)).toEqual({});
  });

  it('every declared range is handled', () => {
    for (const range of TIME_RANGES) expect(() => rangeBounds(range, NOW)).not.toThrow();
  });
});

/* ---------------------------------------------- AC2 — the straddle rule --- */

describe('withinRange narrows on last_activity_at, never on started_at (Test 5)', () => {
  /** Started seven days ago, typed into three minutes ago. */
  const longRunning = makeSessionRow({
    id: 'straddler',
    started_at: new Date(NOW - 7 * 86_400_000).toISOString(),
    last_activity_at: new Date(NOW - 3 * 60_000).toISOString(),
  });

  /** Old on both readings. The row the narrowing must actually drop. */
  const stale = makeSessionRow({
    id: 'stale',
    started_at: new Date(NOW - 9 * 86_400_000).toISOString(),
    last_activity_at: new Date(NOW - 7 * 86_400_000).toISOString(),
  });

  const inside = makeSessionRow({
    id: 'inside',
    started_at: new Date(NOW - 2 * 3_600_000).toISOString(),
    last_activity_at: new Date(NOW - 3_600_000).toISOString(),
  });

  const page = [longRunning, stale, inside];

  it('keeps a session started 7 days ago and active 3 minutes ago in the 3d range', () => {
    expect(
      withinRange(page, '3d', NOW).map((row) => row.id),
      'the range answers "what have I been working on", not "what did I start".',
    ).toEqual(['straddler', 'inside']);
  });

  it('selects a DIFFERENT set than a started_at reading would, on this same page', () => {
    /*
     * The mutation proof, and the only shape that can be one. `last_activity_at`
     * is never before `started_at`, so the activity reading always selects a
     * superset — a page where the two agree proves nothing about which column
     * is read. This page is one where they differ, and the extra row is exactly
     * the long-running session the founder wanted back.
     */
    const bound = NOW - 3 * 86_400_000;
    const byStart = page.filter((row) => Date.parse(row.started_at) >= bound).map((row) => row.id);

    expect(byStart).toEqual(['inside']);
    expect(withinRange(page, '3d', NOW).map((row) => row.id)).not.toEqual(byStart);
  });

  it('drops a session that is old on both readings', () => {
    expect(withinRange([stale], '3d', NOW)).toEqual([]);
  });

  it('keeps a session wholly inside the range', () => {
    expect(withinRange([inside], '3d', NOW).map((row) => row.id)).toEqual(['inside']);
  });

  it('keeps everything for `all`, and copies rather than aliasing', () => {
    const kept = withinRange(page, 'all', NOW);
    expect(kept).toHaveLength(3);
    expect(kept).not.toBe(page);
  });

  it('keeps a row whose stamp will not parse rather than hiding it', () => {
    const broken = makeSessionRow({ id: 'broken', last_activity_at: 'not a date' });
    expect(withinRange([broken], '3d', NOW).map((row) => row.id)).toEqual(['broken']);
  });
});

describe('loadSessionList makes one unfiltered request and splits it (Test 1)', () => {
  it('sends the limit, and NOT a range the server would ignore', async () => {
    const { api, queries, calls } = recordingApi([makePage(ladder(4))]);

    const data = await loadSessionList(api, { range: '3d', now: NOW });

    expect(calls(), 'one page answers both the in-range and outside-range question').toBe(1);
    // ★ NO `from`. `src/server/api.ts` reads only limit/offset/sort/project/q and
    // ignores an unknown param rather than 400-ing, so a range sent here would be
    // a filter the reader set and the server silently never applied. Task 5.1 was
    // ruled to narrow on the client instead of widening the route.
    expect(queries[0]).toEqual({ limit: LIST_LIMIT });
    expect(queries[0], 'a silently-ignored filter is worse than a removed one').not.toHaveProperty(
      'from',
    );
    expect(
      LIST_LIMIT,
      'the server defaults `?limit` to 100, so an implicit limit silently ' +
        'truncates the page and the histogram and empty-state maths go wrong.',
    ).toBeGreaterThan(100);
    expect(data.sessions).toHaveLength(4);
    expect(data.outsideRangeCount).toBe(0);
  });

  it('narrows the page it fetched, and counts what fell out', async () => {
    const stale = makeSessionRow({
      id: 'stale',
      last_activity_at: new Date(NOW - 20 * 86_400_000).toISOString(),
    });
    const { api, calls } = recordingApi([makePage([...ladder(2), stale])]);

    const data = await loadSessionList(api, { range: '7d', now: NOW });

    expect(calls()).toBe(1);
    expect(data.sessions.map((row) => row.id)).toEqual(['s0', 's1']);
    expect(data.outsideRangeCount).toBe(1);
  });

  it('passes the abort signal through to every request it makes', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    // A truncated page holding no row of the wanted project: the one shape that
    // makes a second request, so "every request" is more than one.
    const pages = [makePage(ladder(3), { has_more: true }), makePage<SessionListRow>([])];
    let call = 0;
    const api = stubApiClient({
      listSessions: (_query, options) => {
        seen.push(options?.signal);
        const page = pages[Math.min(call, pages.length - 1)]!;
        call += 1;
        return Promise.resolve(page);
      },
    });
    const controller = new AbortController();

    await loadSessionList(api, {
      range: '7d',
      now: NOW,
      project: '/p/rare',
      signal: controller.signal,
    });

    expect(seen.length).toBe(2);
    for (const signal of seen) expect(signal).toBe(controller.signal);
  });
});

describe('the byte-identical probe is gone, not merely unused (Test 10)', () => {
  it('asks nothing more when the in-range set is empty', async () => {
    const { api, calls } = recordingApi([makePage<SessionListRow>([])]);

    const data = await loadSessionList(api, { range: '7d', now: NOW });

    expect(
      calls(),
      'the old probe re-sent the request it was meant to widen, which is why ' +
        'outside_range could never be reached.',
    ).toBe(1);
    expect(data.outsideRangeCount).toBe(0);
    expect(data.outsideRangeTruncated).toBe(false);
  });

  it('reports the outside-range count off the page it already has', async () => {
    const old = Array.from({ length: 7 }, (_, i) =>
      makeSessionRow({
        id: `old${i}`,
        last_activity_at: new Date(NOW - (30 + i) * 86_400_000).toISOString(),
      }),
    );
    const { api, calls } = recordingApi([makePage(old, { has_more: true })]);

    const data = await loadSessionList(api, { range: '7d', now: NOW });

    expect(calls()).toBe(1);
    expect(data.sessions).toEqual([]);
    expect(data.outsideRangeCount).toBe(7);
    expect(
      data.outsideRangeTruncated,
      'the N+ degradation says the COUNT is a floor; `truncated` says the ' +
        'in-range SET may be short. Same evidence today, different sentences.',
    ).toBe(true);
    expect(data.truncated).toBe(true);
  });

  it('makes no request for `all` beyond the one', async () => {
    const { api, calls } = recordingApi([makePage<SessionListRow>([])]);

    const data = await loadSessionList(api, { range: 'all', now: NOW });

    expect(calls()).toBe(1);
    expect(data.outsideRangeCount).toBe(0);
    expect(data.outsideRangeTruncated).toBe(false);
  });
});

describe('selectRows narrows and sorts totally (Test 2)', () => {
  const rows = [
    makeSessionRow({
      id: 'b',
      project_path: '/p/one',
      last_activity_at: '2026-07-29T10:00:00.000Z',
    }),
    makeSessionRow({
      id: 'a',
      project_path: '/p/two',
      last_activity_at: '2026-07-29T10:00:00.000Z',
    }),
    makeSessionRow({
      id: 'c',
      project_path: '/p/one',
      last_activity_at: '2026-07-29T09:00:00.000Z',
    }),
  ];
  const data = dataOf({ sessions: rows });

  it('narrows to one project and leaves the others out', () => {
    const narrowed = selectRows(data, {
      project: '/p/one',
      sort: 'last_activity_at',
      direction: 'desc',
    });
    expect(narrowed.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('returns everything when no project is chosen', () => {
    expect(selectRows(data, { sort: 'last_activity_at', direction: 'desc' })).toHaveLength(3);
  });

  it.each([
    ['last_activity_at', 'desc', ['a', 'b', 'c']],
    ['last_activity_at', 'asc', ['c', 'a', 'b']],
    ['project_path', 'asc', ['b', 'c', 'a']],
    ['project_path', 'desc', ['a', 'b', 'c']],
  ] as const)('sorts by %s %s with an id tiebreaker', (sort, direction, expected) => {
    expect(selectRows(data, { sort, direction }).map((s) => s.id)).toEqual(expected);
  });

  it('offers exactly the two columns the strip draws', () => {
    // The strip iterates this constant, so a column added here without a label
    // renders an empty button rather than failing to compile.
    expect([...SORT_COLUMNS]).toEqual(['project_path', 'last_activity_at']);
  });

  it('never mutates the array it was handed', () => {
    const before = data.sessions.map((s) => s.id);
    selectRows(data, { sort: 'project_path', direction: 'asc' });
    expect(data.sessions.map((s) => s.id)).toEqual(before);
  });

  it('reads the server-narrowed pool when one was fetched', () => {
    const server = [makeSessionRow({ id: 'z', project_path: '/p/deep' })];
    const narrowed = selectRows(dataOf({ sessions: rows, projectSessions: server }), {
      project: '/p/deep',
      sort: 'last_activity_at',
      direction: 'desc',
    });
    expect(narrowed.map((s) => s.id)).toEqual(['z']);
  });
});

/* ------------------------------------------------- AC1 — honest labels --- */

describe('rowLabel refuses a stored label that is harness markup (Test 4)', () => {
  it('prefers the title', () => {
    expect(rowLabel(makeSessionRow({ title: 'ship the projector' }))).toBe('ship the projector');
  });

  it('falls back to the preview, then to the project', () => {
    expect(rowLabel(makeSessionRow({ title: null, preview: 'a human prompt' }))).toBe(
      'a human prompt',
    );
    expect(
      rowLabel(makeSessionRow({ title: null, preview: null, project_path: '/tmp/p' })),
    ).toBe('/tmp/p');
  });

  it.each([
    ['<task-notification>\n<task-id>ab203519d2e64bacf</task-id>'],
    ['<command-message>review is running…</command-message>'],
    ['  <system-reminder>mind the door</system-reminder>'],
  ])('rejects %s and falls through', (machinery) => {
    const label = rowLabel(
      makeSessionRow({ title: machinery, preview: machinery, project_path: '/tmp/p' }),
    );
    expect(label).toBe('/tmp/p');
    expect(label).not.toContain('<');
  });

  it('treats an empty or blank stored label as absent', () => {
    expect(rowLabel(makeSessionRow({ title: '', preview: '   ', project_path: '/tmp/p' }))).toBe(
      '/tmp/p',
    );
  });

  it('names no harness tag, so it stays true when the tags change', () => {
    // The rule is the SHAPE of the value, not a vocabulary. A tag nobody has
    // seen yet is rejected by the same line.
    expect(rowLabel(makeSessionRow({ title: '<a-tag-invented-tomorrow>x', preview: null }))).toBe(
      makeSessionRow().project_path,
    );
  });
});

describe('foldsUnderAgent is total and false by default (Test 2)', () => {
  it('is true only for a notification that named an Agent call', () => {
    expect(
      foldsUnderAgent(makeTurnRow({ kind: 'task_notification', parent_event_id: 'toolu_x' })),
    ).toBe(true);
  });

  it.each(['human', 'slash_command', 'compaction', 'system', 'unknown'])(
    'is false for a %s turn even when a parent is somehow set',
    (kind) => {
      expect(foldsUnderAgent(makeTurnRow({ kind, parent_event_id: 'toolu_x' }))).toBe(false);
    },
  );

  it('is false for a notification that named no call', () => {
    expect(
      foldsUnderAgent(makeTurnRow({ kind: 'task_notification', parent_event_id: null })),
    ).toBe(false);
  });
});

describe('projectsIn feeds the narrowing control', () => {
  it('lists each project once, sorted, however often it appears', () => {
    const sessions = [
      makeSessionRow({ id: 'a', project_path: '/p/two' }),
      makeSessionRow({ id: 'b', project_path: '/p/one' }),
      makeSessionRow({ id: 'c', project_path: '/p/two' }),
    ];
    expect(projectsIn(sessions)).toEqual(['/p/one', '/p/two']);
  });

  it('is empty for no sessions rather than undefined', () => {
    expect(projectsIn([])).toEqual([]);
  });
});

describe('volumeBuckets (Test 7)', () => {
  it('returns a constant number of buckets whatever the input', () => {
    for (const sessions of [[], ladder(1), ladder(40)]) {
      expect(volumeBuckets(sessions, { range: '7d', now: NOW, bucketCount: 24 })).toHaveLength(24);
    }
  });

  it('yields all-zero bars for no sessions rather than an empty pane', () => {
    const buckets = volumeBuckets([], { range: '3d', now: NOW, bucketCount: 12 });
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });

  it('counts every in-range session exactly once, boundaries included', () => {
    const buckets = volumeBuckets(ladder(48), { range: '3d', now: NOW, bucketCount: 12 });
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total, '48 hourly sessions all sit inside a 3-day window').toBe(48);
  });

  it('places a session sitting exactly on an internal boundary in one bucket only', () => {
    // 12 buckets across 3 days = 6h each; 6h before `now` is the boundary
    // between the last two buckets.
    const onBoundary = makeSessionRow({
      last_activity_at: new Date(NOW - 6 * 3_600_000).toISOString(),
    });
    const buckets = volumeBuckets([onBoundary], { range: '3d', now: NOW, bucketCount: 12 });
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });

  it('excludes sessions outside the window', () => {
    const old = makeSessionRow({
      last_activity_at: new Date(NOW - 40 * 86_400_000).toISOString(),
    });
    const buckets = volumeBuckets([old, ...ladder(3)], { range: '3d', now: NOW, bucketCount: 12 });
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(3);
  });

  it('spans oldest-to-now for `all`, so the bars are not all in the last bucket', () => {
    const spread = ladder(3, (i) => ({
      last_activity_at: new Date(NOW - i * 30 * 86_400_000).toISOString(),
    }));
    const buckets = volumeBuckets(spread, { range: 'all', now: NOW, bucketCount: 3 });
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(3);
    expect(buckets.filter((b) => b.count > 0).length).toBeGreaterThan(1);
  });

  it('gives every bucket a start before its end, contiguously', () => {
    const buckets = volumeBuckets(ladder(5), { range: '7d', now: NOW, bucketCount: 8 });
    for (const [i, bucket] of buckets.entries()) {
      expect(bucket.end).toBeGreaterThan(bucket.start);
      if (i > 0) expect(bucket.start).toBe(buckets[i - 1]?.end);
    }
  });
});

/* ------------------------------------------------------------------ AC2 --- */

describe('emptyStateOf classifies all four states (Test 9)', () => {
  it('in-range rows present -> none', () => {
    const data = dataOf({ sessions: ladder(3) });
    expect(emptyStateOf(data, ladder(3), {})).toEqual({ kind: 'none' });
  });

  it('in-range empty and the probe empty -> never_captured', () => {
    const data = dataOf({ outsideRangeCount: 0 });
    expect(emptyStateOf(data, [], {})).toEqual({ kind: 'never_captured' });
  });

  it('in-range empty and the probe non-empty -> outside_range with the probe count', () => {
    const data = dataOf({ outsideRangeCount: 7, outsideRangeTruncated: true });
    expect(emptyStateOf(data, [], {})).toEqual({
      kind: 'outside_range',
      count: 7,
      truncated: true,
    });
  });

  it('a non-empty page narrowed to zero by the project control -> no_match_for_project', () => {
    const data = dataOf({ sessions: ladder(40), truncated: true });
    expect(
      emptyStateOf(data, [], { project: '/p/other' }),
      'the three-state design rendered this as a blank pane, which ' +
        'design-system.md forbids outright.',
    ).toEqual({
      kind: 'no_match_for_project',
      project: '/p/other',
      count: 40,
      truncated: true,
    });
  });

  it('prefers outside_range over no_match_for_project when nothing is in range at all', () => {
    const data = dataOf({ outsideRangeCount: 5 });
    expect(emptyStateOf(data, [], { project: '/p/one' }).kind).toBe('outside_range');
  });
});

describe('no_match_for_project may not state a falsehood (Ruling 3)', () => {
  const deep = makeSessionRow({ id: 'deep', project_path: '/p/rare' });

  it('re-queries the server with `project` when a TRUNCATED page narrows to zero', async () => {
    // The whole point of the ruling: the client-side pass sees one page, so a
    // project whose in-range sessions sit past LIST_LIMIT is invisible to it.
    // This fixture is the >LIST_LIMIT case — a full page, `has_more`, and not
    // one row of the wanted project anywhere in it.
    // Every row stamped recent, so the range narrowing leaves the page whole and
    // the assertion is about the project proof rather than about the clock.
    const fullPage = ladder(LIST_LIMIT, () => ({
      project_path: '/p/busy',
      last_activity_at: new Date(NOW - 60_000).toISOString(),
    }));
    const { api, queries, calls } = recordingApi([
      makePage(fullPage, { has_more: true, limit: LIST_LIMIT }),
      makePage([deep]),
    ]);

    const data = await loadSessionList(api, { range: '7d', now: NOW, project: '/p/rare' });

    expect(calls(), 'exactly one extra request, in an already-empty state').toBe(2);
    expect(queries[1]).toEqual({ project: '/p/rare', limit: LIST_LIMIT });
    expect(data.projectSessions?.map((s) => s.id)).toEqual(['deep']);

    const rows = selectRows(data, {
      project: '/p/rare',
      sort: 'last_activity_at',
      direction: 'desc',
    });
    expect(rows.map((s) => s.id)).toEqual(['deep']);
    expect(
      emptyStateOf(data, rows, { project: '/p/rare' }),
      'the server found the session the client page could not see, so there is ' +
        'no empty state to render at all.',
    ).toEqual({ kind: 'none' });
  });

  it('still renders no_match_for_project when the server confirms there are none', async () => {
    // Every row stamped recent, so the range narrowing leaves the page whole and
    // the assertion is about the project proof rather than about the clock.
    const fullPage = ladder(LIST_LIMIT, () => ({
      project_path: '/p/busy',
      last_activity_at: new Date(NOW - 60_000).toISOString(),
    }));
    const { api, calls } = recordingApi([
      makePage(fullPage, { has_more: true, limit: LIST_LIMIT }),
      makePage<SessionListRow>([]),
    ]);

    const data = await loadSessionList(api, { range: '7d', now: NOW, project: '/p/gone' });
    const rows = selectRows(data, {
      project: '/p/gone',
      sort: 'last_activity_at',
      direction: 'desc',
    });

    expect(calls()).toBe(2);
    expect(emptyStateOf(data, rows, { project: '/p/gone' })).toEqual({
      kind: 'no_match_for_project',
      project: '/p/gone',
      count: LIST_LIMIT,
      truncated: true,
    });
  });

  it('does NOT re-query when the page is complete — the client-side pass is then authoritative', async () => {
    const { api, calls } = recordingApi([makePage(ladder(40))]);
    const data = await loadSessionList(api, { range: '7d', now: NOW, project: '/p/absent' });
    expect(
      calls(),
      'an untruncated page IS the whole in-range set, so zero matches in it is ' +
        'already the true answer and a second request would buy nothing.',
    ).toBe(1);
    expect(data.projectSessions).toBeNull();
  });

  it('does NOT re-query when the truncated page already carries the project', async () => {
    const page = [...ladder(3, () => ({ project_path: '/p/busy' })), deep];
    const { api, calls } = recordingApi([makePage(page, { has_more: true })]);
    await loadSessionList(api, { range: '7d', now: NOW, project: '/p/rare' });
    expect(calls()).toBe(1);
  });
});

/* ------------------------------------------------------------------ AC3 --- */

describe('cursorIntent (Test 16)', () => {
  const at = (index: number, rowCount = 5, inEditable = false) =>
    ({ index, rowCount, inEditable }) as const;

  it.each([
    ['j', at(0), { kind: 'move', index: 1 }],
    ['k', at(3), { kind: 'move', index: 2 }],
    ['j', at(4), { kind: 'move', index: 4 }],
    ['k', at(0), { kind: 'move', index: 0 }],
    ['Enter', at(2), { kind: 'open', index: 2 }],
    ['x', at(2), { kind: 'ignore' }],
    ['ArrowDown', at(2), { kind: 'ignore' }],
  ] as const)('%s at %o -> %o', (key, cursor, expected) => {
    expect(cursorIntent(key, cursor)).toEqual(expected);
  });

  it.each(['j', 'k', 'Enter', 'x'])('ignores %s when there are no rows', (key) => {
    expect(cursorIntent(key, at(0, 0))).toEqual({ kind: 'ignore' });
  });

  it.each(['j', 'k', 'Enter'])('ignores %s while an editable control has focus', (key) => {
    expect(
      cursorIntent(key, at(1, 5, true)),
      'j and k are ordinary letters — stealing them from the project control ' +
        'would make it untypeable.',
    ).toEqual({ kind: 'ignore' });
  });

  it('clamps a cursor that is somehow past the end', () => {
    expect(cursorIntent('j', at(99, 5))).toEqual({ kind: 'move', index: 4 });
  });
});

describe('applyIntent actually navigates (Test 17)', () => {
  const rows = ladder(4);

  it('open pushes the session href onto the history port', () => {
    const port = fakeHistoryPort('/');
    const router = createRouter(port);

    const next = applyIntent({ kind: 'open', index: 2 }, rows, router);

    expect(port.entries[port.entries.length - 1]).toBe(`/session/${rows[2]?.id ?? ''}`);
    expect(next, 'opening a row leaves the cursor where it was').toBe(2);
  });

  it('percent-encodes an id that would otherwise split into extra segments', () => {
    const port = fakeHistoryPort('/');
    const odd = [makeSessionRow({ id: 'a/b c' })];
    applyIntent({ kind: 'open', index: 0 }, odd, createRouter(port));
    expect(port.entries[port.entries.length - 1]).toBe('/session/a%2Fb%20c');
  });

  it('move returns the new index and navigates nowhere', () => {
    const port = fakeHistoryPort('/');
    expect(applyIntent({ kind: 'move', index: 3 }, rows, createRouter(port))).toBe(3);
    expect(port.entries).toEqual(['/']);
  });

  it('ignore returns null and navigates nowhere', () => {
    const port = fakeHistoryPort('/');
    expect(applyIntent({ kind: 'ignore' }, rows, createRouter(port))).toBeNull();
    expect(port.entries).toEqual(['/']);
  });

  it('is total against an index no row answers to', () => {
    const port = fakeHistoryPort('/');
    expect(applyIntent({ kind: 'open', index: 99 }, rows, createRouter(port))).toBeNull();
    expect(port.entries).toEqual(['/']);
  });
});
