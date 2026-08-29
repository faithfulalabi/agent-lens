import { describe, it, expect } from 'vitest';

import type { Session } from '@shared/entities.ts';
import type { Page } from '@shared/api.ts';
import type { SessionListRow, SessionsQuery } from '../api.js';
import { createRouter } from '../router.js';
import {
  LIST_LIMIT,
  applyIntent,
  cursorIntent,
  emptyStateOf,
  loadSessionList,
  projectsIn,
  rangeBounds,
  selectRows,
  volumeBuckets,
  TIME_RANGES,
  type SessionListData,
} from '../session-list.js';
import { fakeHistoryPort } from './helpers.js';
import { makePage, makeSession, makeSessionRow, stubApiClient } from './fixtures.js';

/*
 * Task 5.2b, the domain half — every branch AC1/AC2/AC3 care about, driven as a
 * plain function. The components render this module's output and decide nothing,
 * which is what keeps them assertable under `environment: 'node'`.
 */

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

/** `n` wire rows, newest first, one hour apart, ending at `NOW`. */
function ladder(
  n: number,
  overrides: (i: number) => Partial<SessionListRow> = () => ({}),
): SessionListRow[] {
  return Array.from({ length: n }, (_, i) =>
    makeSessionRow({
      id: `s${i}`,
      started_at: new Date(NOW - i * 3_600_000).toISOString(),
      last_activity_at: new Date(NOW - i * 3_600_000 + 60_000).toISOString(),
      ...overrides(i),
    }),
  );
}

/**
 * The same ladder in the shape the pure functions take.
 *
 * Task 4.5 moved the WIRE to `SessionListRow` while `selectRows`, `emptyStateOf`
 * and `volumeBuckets` still operate on `SessionListData.sessions`, which the
 * loader adapts. Two ladders is the honest way to say that: one per side of the
 * adapter, rather than one type pretending to be both.
 */
function sessionLadder(n: number, overrides: (i: number) => Partial<Session> = () => ({})): Session[] {
  return Array.from({ length: n }, (_, i) =>
    makeSession({
      id: `s${i}`,
      started_at: new Date(NOW - i * 3_600_000).toISOString(),
      ended_at: new Date(NOW - i * 3_600_000 + 60_000).toISOString(),
      ...overrides(i),
    }),
  );
}

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
    outsideRangeCount: null,
    outsideRangeTruncated: false,
    projectSessions: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ AC1 --- */

describe('rangeBounds turns a range into the server bound', () => {
  it.each([
    ['3d', 3],
    ['7d', 7],
    ['30d', 30],
  ] as const)('%s asks for the last %i days and sets no upper bound', (range, days) => {
    const bounds = rangeBounds(range, NOW);
    expect(bounds.from).toBe(new Date(NOW - days * 86_400_000).toISOString());
    expect(
      'to' in bounds,
      'an upper bound of "now" is what the absence of `to` already means, and ' +
        'omitting it keeps the server on idx_sessions_started_at.',
    ).toBe(false);
  });

  it('all asks for no lower bound either', () => {
    expect(rangeBounds('all', NOW)).toEqual({});
  });

  it('every declared range is handled', () => {
    for (const range of TIME_RANGES) expect(() => rangeBounds(range, NOW)).not.toThrow();
  });
});

describe('loadSessionList sends an explicit limit and no range (Test 1)', () => {
  it('sends the limit, and NOT a range the server would ignore', async () => {
    const { api, queries, calls } = recordingApi([makePage(ladder(4))]);

    const data = await loadSessionList(api, { range: '3d', now: NOW });

    expect(calls(), 'the probe must not fire when the in-range page has rows').toBe(1);
    // ★ NO `from`. `src/server/api.ts` reads only limit/offset/sort/project/q and
    // ignores an unknown param rather than 400-ing, so a range sent here would be
    // a filter the user set and the server silently never applied. Ruled at the
    // phase-4 gate: removed, so the gap is visible to whoever restores it.
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
    expect(data.outsideRangeCount).toBeNull();
  });

  it('passes the abort signal through to every request it makes', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const api = stubApiClient({
      listSessions: (_query, options) => {
        seen.push(options?.signal);
        return Promise.resolve(makePage<SessionListRow>([]));
      },
    });
    const controller = new AbortController();

    await loadSessionList(api, { range: '7d', now: NOW, signal: controller.signal });

    expect(seen.length).toBe(2);
    for (const signal of seen) expect(signal).toBe(controller.signal);
  });
});

describe('the unfiltered probe fires only on an empty in-range page (Test 10)', () => {
  it('does not fire when the in-range page has rows', async () => {
    const { api, calls } = recordingApi([makePage(ladder(2))]);
    await loadSessionList(api, { range: '7d', now: NOW });
    expect(calls()).toBe(1);
  });

  it('fires, unfiltered, when the in-range page is empty', async () => {
    const { api, queries, calls } = recordingApi([
      makePage<SessionListRow>([]),
      makePage(ladder(7), { has_more: true }),
    ]);

    const data = await loadSessionList(api, { range: '7d', now: NOW });

    expect(calls()).toBe(2);
    expect(queries[1], 'the probe must drop the range, or it counts the same nothing').toEqual({
      limit: LIST_LIMIT,
    });
    expect(data.outsideRangeCount).toBe(7);
    expect(
      data.outsideRangeTruncated,
      'the N+ degradation reads the PROBE’s has_more. `truncated` is derived ' +
        'from a LIMIT n+1 row on a page that is empty by construction, so ' +
        'binding it there makes the N+ branch unreachable.',
    ).toBe(true);
    expect(data.truncated, 'an empty page can never report more').toBe(false);
  });

  it('short-circuits the probe for `all`, where both requests would be identical', async () => {
    const { api, calls } = recordingApi([makePage<SessionListRow>([])]);

    const data = await loadSessionList(api, { range: 'all', now: NOW });

    expect(calls(), 'rangeBounds("all") sets no `from`, so the probe is the same request').toBe(1);
    expect(data.outsideRangeCount).toBe(0);
    expect(data.outsideRangeTruncated).toBe(false);
  });
});

describe('selectRows narrows and sorts totally (Test 2)', () => {
  const rows = [
    makeSession({
      id: 'b',
      project_path: '/p/one',
      started_at: '2026-07-29T10:00:00.000Z',
      total_tokens: 50,
      est_cost: 3,
    }),
    makeSession({
      id: 'a',
      project_path: '/p/two',
      started_at: '2026-07-29T10:00:00.000Z',
      total_tokens: 50,
      est_cost: 1,
    }),
    makeSession({
      id: 'c',
      project_path: '/p/one',
      started_at: '2026-07-29T09:00:00.000Z',
      total_tokens: 90,
      est_cost: 2,
    }),
  ];
  const data = dataOf({ sessions: rows });

  it('narrows to one project and leaves the others out', () => {
    const narrowed = selectRows(data, { project: '/p/one', sort: 'started_at', direction: 'desc' });
    expect(narrowed.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('returns everything when no project is chosen', () => {
    expect(selectRows(data, { sort: 'started_at', direction: 'desc' })).toHaveLength(3);
  });

  it.each([
    ['started_at', 'desc', ['a', 'b', 'c']],
    ['started_at', 'asc', ['c', 'a', 'b']],
    ['project_path', 'asc', ['b', 'c', 'a']],
    ['project_path', 'desc', ['a', 'b', 'c']],
    ['total_tokens', 'desc', ['c', 'a', 'b']],
    ['total_tokens', 'asc', ['a', 'b', 'c']],
    ['est_cost', 'desc', ['b', 'c', 'a']],
    ['est_cost', 'asc', ['a', 'c', 'b']],
  ] as const)('sorts by %s %s with an id tiebreaker', (sort, direction, expected) => {
    expect(selectRows(data, { sort, direction }).map((s) => s.id)).toEqual(expected);
  });

  it('never mutates the array it was handed', () => {
    const before = data.sessions.map((s) => s.id);
    selectRows(data, { sort: 'total_tokens', direction: 'asc' });
    expect(data.sessions.map((s) => s.id)).toEqual(before);
  });

  it('reads the server-narrowed pool when one was fetched', () => {
    const server = [makeSession({ id: 'z', project_path: '/p/deep' })];
    const narrowed = selectRows(dataOf({ sessions: rows, projectSessions: server }), {
      project: '/p/deep',
      sort: 'started_at',
      direction: 'desc',
    });
    expect(narrowed.map((s) => s.id)).toEqual(['z']);
  });
});

describe('projectsIn feeds the narrowing control', () => {
  it('lists each project once, sorted, however often it appears', () => {
    const sessions = [
      makeSession({ id: 'a', project_path: '/p/two' }),
      makeSession({ id: 'b', project_path: '/p/one' }),
      makeSession({ id: 'c', project_path: '/p/two' }),
    ];
    expect(projectsIn(sessions)).toEqual(['/p/one', '/p/two']);
  });

  it('is empty for no sessions rather than undefined', () => {
    expect(projectsIn([])).toEqual([]);
  });
});

describe('volumeBuckets (Test 7)', () => {
  it('returns a constant number of buckets whatever the input', () => {
    for (const sessions of [[], sessionLadder(1), sessionLadder(40)]) {
      expect(volumeBuckets(sessions, { range: '7d', now: NOW, bucketCount: 24 })).toHaveLength(24);
    }
  });

  it('yields all-zero bars for no sessions rather than an empty pane', () => {
    const buckets = volumeBuckets([], { range: '3d', now: NOW, bucketCount: 12 });
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });

  it('counts every in-range session exactly once, boundaries included', () => {
    const buckets = volumeBuckets(sessionLadder(48), { range: '3d', now: NOW, bucketCount: 12 });
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total, '48 hourly sessions all sit inside a 3-day window').toBe(48);
  });

  it('places a session sitting exactly on an internal boundary in one bucket only', () => {
    // 12 buckets across 3 days = 6h each; 6h before `now` is the boundary
    // between the last two buckets.
    const onBoundary = makeSession({ started_at: new Date(NOW - 6 * 3_600_000).toISOString() });
    const buckets = volumeBuckets([onBoundary], { range: '3d', now: NOW, bucketCount: 12 });
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });

  it('excludes sessions outside the window', () => {
    const old = makeSession({ started_at: new Date(NOW - 40 * 86_400_000).toISOString() });
    const buckets = volumeBuckets([old, ...sessionLadder(3)], { range: '3d', now: NOW, bucketCount: 12 });
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(3);
  });

  it('spans oldest-to-now for `all`, so the bars are not all in the last bucket', () => {
    const spread = sessionLadder(3, (i) => ({
      started_at: new Date(NOW - i * 30 * 86_400_000).toISOString(),
    }));
    const buckets = volumeBuckets(spread, { range: 'all', now: NOW, bucketCount: 3 });
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(3);
    expect(buckets.filter((b) => b.count > 0).length).toBeGreaterThan(1);
  });

  it('gives every bucket a start before its end, contiguously', () => {
    const buckets = volumeBuckets(sessionLadder(5), { range: '7d', now: NOW, bucketCount: 8 });
    for (const [i, bucket] of buckets.entries()) {
      expect(bucket.end).toBeGreaterThan(bucket.start);
      if (i > 0) expect(bucket.start).toBe(buckets[i - 1]?.end);
    }
  });
});

/* ------------------------------------------------------------------ AC2 --- */

describe('emptyStateOf classifies all four states (Test 9)', () => {
  it('in-range rows present -> none', () => {
    const data = dataOf({ sessions: sessionLadder(3) });
    expect(emptyStateOf(data, sessionLadder(3), {})).toEqual({ kind: 'none' });
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
    const data = dataOf({ sessions: sessionLadder(40), truncated: true });
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
    const fullPage = ladder(LIST_LIMIT, () => ({ project_path: '/p/busy' }));
    const { api, queries, calls } = recordingApi([
      makePage(fullPage, { has_more: true, limit: LIST_LIMIT }),
      makePage([deep]),
    ]);

    const data = await loadSessionList(api, { range: '7d', now: NOW, project: '/p/rare' });

    expect(calls(), 'exactly one extra request, in an already-empty state').toBe(2);
    expect(queries[1]).toEqual({ project: '/p/rare', limit: LIST_LIMIT });
    expect(data.projectSessions?.map((s) => s.id)).toEqual(['deep']);

    const rows = selectRows(data, { project: '/p/rare', sort: 'started_at', direction: 'desc' });
    expect(rows.map((s) => s.id)).toEqual(['deep']);
    expect(
      emptyStateOf(data, rows, { project: '/p/rare' }),
      'the server found the session the client page could not see, so there is ' +
        'no empty state to render at all.',
    ).toEqual({ kind: 'none' });
  });

  it('still renders no_match_for_project when the server confirms there are none', async () => {
    const fullPage = ladder(LIST_LIMIT, () => ({ project_path: '/p/busy' }));
    const { api, calls } = recordingApi([
      makePage(fullPage, { has_more: true, limit: LIST_LIMIT }),
      makePage<SessionListRow>([]),
    ]);

    const data = await loadSessionList(api, { range: '7d', now: NOW, project: '/p/gone' });
    const rows = selectRows(data, { project: '/p/gone', sort: 'started_at', direction: 'desc' });

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
  const rows = sessionLadder(4);

  it('open pushes the session href onto the history port', () => {
    const port = fakeHistoryPort('/');
    const router = createRouter(port);

    const next = applyIntent({ kind: 'open', index: 2 }, rows, router);

    expect(port.entries[port.entries.length - 1]).toBe(`/session/${rows[2]?.id ?? ''}`);
    expect(next, 'opening a row leaves the cursor where it was').toBe(2);
  });

  it('percent-encodes an id that would otherwise split into extra segments', () => {
    const port = fakeHistoryPort('/');
    const odd = [makeSession({ id: 'a/b c' })];
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
