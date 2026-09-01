import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SessionDetailBody } from '../api';

import {
  EVENT_LIMIT,
  driftNotice,
  initialExpanded,
  loadSessionDetail,
  needsReseed,
  rowsChangedAction,
  truncationNotes,
  type SessionData,
} from '../session-data';
import { buildTurnGroups, flatten } from '../turn-tree';
import { initialSubagentState } from '../subagent';
import { initialNavState, navReducer } from '../tree-nav';
import { makeDetail, makeEventRow, makeSessionRow, makeTurnRow, stubApiClient } from './fixtures';

/*
 * Task 5.2's loading half — every decision the session page module would
 * otherwise make inside an effect, asserted as a plain function call.
 *
 * The two mutation checks worth stating up front, because they are what make
 * this file more than a description of the code:
 *
 *   - Drop the explicit `limit` and the read API's own default silently serves
 *     1,000 events, so a 5,000-event session renders as a plausible-looking lie.
 *   - Pass the ON-SCREEN row ids as `modelIds` instead of the model's own and
 *     every collapsed-away selection is cleared, which is precisely what the
 *     selection/focus split was built to prevent.
 */

/** A detail body carrying `turnCount` turns and one page of `count` events. */
function detailOf(
  turnCount: number,
  { events = 0, hasMore = false, turnId = 'seed-s0:0' } = {},
): SessionDetailBody {
  return makeDetail({
    turns: Array.from({ length: turnCount }, (_, i) =>
      makeTurnRow({ id: `seed-s0:${i}`, seq: i, title: `turn ${i}` }),
    ),
    events: Array.from({ length: events }, (_, i) =>
      makeEventRow({ id: `ev-${i}`, turn_id: turnId, seq: i }),
    ),
    next_seq: events,
    has_more: hasMore,
  });
}

/* ------------------------------------ Test 4 — one request fills the screen --- */

describe('exactly one request fills the whole screen (Test 4, AC1)', () => {
  it('asks once, at the server’s own ceiling, for a 9,000-event session', async () => {
    const queries: unknown[] = [];
    let calls = 0;
    const api = stubApiClient({
      getSession: (_id, query) => {
        calls += 1;
        queries.push(query);
        return Promise.resolve(detailOf(1, { events: 9_000 }));
      },
    });

    const data = await loadSessionDetail(api, 'seed-s0');

    expect(calls, 'a second request means the paging loop came back').toBe(1);
    expect(
      queries,
      'an omitted limit is not a loud failure — the server clamps rather than ' +
        'rejecting, so a 9,000-event session would load its first 1,000 and the ' +
        'tree would render a truncated session that looks whole.',
    ).toEqual([{ limit: EVENT_LIMIT }]);
    expect(data.shown).toBe(9_000);
  });

  it('states has_more in the notice strip rather than making a second call', async () => {
    let calls = 0;
    const api = stubApiClient({
      getSession: () => {
        calls += 1;
        return Promise.resolve(detailOf(1, { events: 4, hasMore: true }));
      },
    });

    const data = await loadSessionDetail(api, 'seed-s0');

    // Mutation check, verified by hand: restore the `while (hasMore)` loop and
    // `calls` becomes 2 — which is the request this AC exists to delete.
    expect(calls).toBe(1);
    expect(data.hasMore).toBe(true);
    expect(
      truncationNotes({ shown: data.shown, hasMore: data.hasMore, unmatchedEventCount: 0 }),
    ).toHaveLength(1);
  });

  it('passes the abort signal through to the one request it makes', async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const api = stubApiClient({
      getSession: (_id, _query, options) => {
        seen.push(options?.signal);
        return Promise.resolve(detailOf(1, { events: 1, hasMore: true }));
      },
    });

    await loadSessionDetail(api, 'seed-s0', { signal: controller.signal });
    expect(seen).toEqual([controller.signal]);
  });

  it('carries the flat array beside the buckets, so both views read one fetch', async () => {
    /*
     * Task 5.4. The bucketing above DISCARDS the ordered array, and the thread
     * needs exactly that array — rebuilding it from the buckets would put the
     * event order back in the hands of map iteration, and asking for it again
     * would cost the second request AC1 exists to delete.
     */
    const api = stubApiClient({ getSession: () => Promise.resolve(detailOf(1, { events: 6 })) });
    const data = await loadSessionDetail(api, 'seed-s0');

    expect(data.events).toHaveLength(6);
    expect(data.events.map((event) => event.id)).toEqual([
      'ev-0',
      'ev-1',
      'ev-2',
      'ev-3',
      'ev-4',
      'ev-5',
    ]);
    const bucketed = [...data.eventsByTurn.values()].flat();
    expect(data.events.length, 'the two shapes must describe the same page').toBe(bucketed.length);
  });

  it('takes every turn the response carries, with no client turn page', async () => {
    // The detail route returns EVERY turn in one array — measured n=647 across
    // 293 sessions, maximum 28 per session — so there is nothing to cap.
    const api = stubApiClient({ getSession: () => Promise.resolve(detailOf(1_500)) });
    const data = await loadSessionDetail(api, 'seed-s0');
    expect(data.turns).toHaveLength(1_500);
  });
});

/* --------------------------------- Test 5 — the cap and the loop are gone --- */

describe('the cap and the paging loop are deleted, not renamed (Test 5, AC1)', () => {
  const LIB = fileURLToPath(new URL('..', import.meta.url));

  function libSources(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) found.push(full);
      }
    };
    walk(LIB);
    return found;
  }

  it('exports none of the three page constants from ui/src/lib', () => {
    const files = libSources();
    expect(files.length, 'the scan is not vacuous').toBeGreaterThan(5);
    for (const term of ['SPAN_CAP', 'SPAN_PAGE', 'TRACE_PAGE']) {
      const hits = files.filter((file) => readFileSync(file, 'utf8').includes(term));
      expect(hits, `${term} is still in ui/src/lib`).toEqual([]);
    }
  });
});

/* ------------------------------------------------ the truncation wording --- */

describe('the view says what it is not showing', () => {
  it('says nothing at all when the tree is complete', () => {
    expect(truncationNotes({ shown: 42, hasMore: false, unmatchedEventCount: 0 })).toEqual([]);
  });

  it('names the count it is showing, spelled rather than bare', () => {
    const [note] = truncationNotes({ shown: 20_000, hasMore: true, unmatchedEventCount: 0 });
    expect(note).toContain('20,000');
    expect(note, 'Flow 3 forbids presenting a partial trace as a whole one').toContain('first');
  });

  it('reports events whose turn is not on the page as its own sentence', () => {
    const notes = truncationNotes({ shown: 5, hasMore: false, unmatchedEventCount: 12 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('12 more events');
  });

  it('says both when a session managed both', () => {
    expect(truncationNotes({ shown: 20_000, hasMore: true, unmatchedEventCount: 3 })).toHaveLength(
      2,
    );
  });
});

/* ----------------------------------------------------- the drift wording --- */

describe('the alarm speaks only when the row says it should (AC2, AC3)', () => {
  it('names the release that wrote the shape this build does not know', () => {
    const notice = driftNotice({ hasDrift: true, harnessVersion: '2.2.0' });
    expect(notice).toContain('2.2.0');
    expect(notice, 'the alarm is about records, not about a page').toContain('Unrecognized');
  });

  it('still speaks when the transcript named no version', () => {
    const notice = driftNotice({ hasDrift: true, harnessVersion: null });
    expect(notice).not.toBeNull();
    expect(notice, 'there is no version to name, so it must not invent one').not.toContain('null');
  });

  it('says nothing at all on a clean session — no false alarm on a clean corpus', () => {
    expect(driftNotice({ hasDrift: false, harnessVersion: '2.1.212' })).toBeNull();
    // The version is irrelevant to the raise. Only the flag decides.
    expect(driftNotice({ hasDrift: false, harnessVersion: null })).toBeNull();
  });
});

/* --------------------------------------------- reseeding across sessions --- */

describe('the navigation state restarts on the session that ARRIVED (needsReseed)', () => {
  /** A `SessionData` for one session id, with one turn. */
  function dataFor(id: string): SessionData {
    return {
      session: { ...makeSessionRow({ id }), projection: { state: 'ready' } },
      turns: [makeTurnRow({ id: `${id}:0`, seq: 0 })],
      eventsByTurn: new Map(),
      events: [],
      hasMore: false,
      shown: 0,
      fingerprint: '900:500:2',
    };
  }

  it('does not reseed before any data has arrived', () => {
    expect(needsReseed(null, null)).toBe(false);
  });

  it('reseeds once when the first session lands, then leaves it alone', () => {
    const a = dataFor('A');
    expect(needsReseed(a, null)).toBe(true);
    expect(needsReseed(a, 'A'), 'a re-render must not throw away the expansion state').toBe(false);
  });

  it('does NOT reseed on the render where the id has moved but the data has not', () => {
    /*
     * The whole reason this is a function and not an inline comparison.
     *
     * `useAsync` resets its slot inside an EFFECT, so on the first render after
     * a move from session A to session B the id prop already reads `B` while
     * the data in hand is still all of A. A guard written against the requested
     * id fires there, seeds the expansion set from A's turns, records itself as
     * done for B — and then never fires again when B's data actually lands,
     * because the guard is already satisfied. B renders with an expansion set
     * naming turns it does not contain, so every turn is closed and "a session
     * opens on its latest turn" quietly stops being true on a browser Back.
     *
     * Mutation check: compare the REQUESTED id instead of `data.session.id` and
     * this case flips to true, which is the bug.
     */
    expect(
      needsReseed(dataFor('A'), 'A'),
      'the data in hand is still A’s, so there is nothing new to seed from yet',
    ).toBe(false);
  });

  it('reseeds as soon as the new session’s own data is in hand', () => {
    expect(needsReseed(dataFor('B'), 'A')).toBe(true);
  });

  it('seeds from the arrived session’s turns, not the previous one’s', () => {
    const expanded = initialExpanded(dataFor('B').turns);
    expect([...expanded]).toEqual(['B:0']);
    expect(expanded.has('A:0')).toBe(false);
  });
});

/* ------------------------------------------------- the opening expansion --- */

describe('a session opens on its latest turn', () => {
  it('opens the last turn and leaves the older ones closed', () => {
    expect([...initialExpanded(detailOf(3).turns)]).toEqual(['seed-s0:2']);
  });

  it('opens nothing at all when the session has no turns', () => {
    expect(initialExpanded([]).size).toBe(0);
  });

  it('puts real event rows on screen, which an empty expansion set would not', () => {
    const turns = detailOf(2).turns;
    const eventsByTurn = new Map([
      ['seed-s0:0', [makeEventRow({ id: 'old', turn_id: 'seed-s0:0' })]],
      ['seed-s0:1', [makeEventRow({ id: 'new', turn_id: 'seed-s0:1' })]],
    ]);
    const model = buildTurnGroups(turns, eventsByTurn);
    const rows = flatten(model, initialExpanded(turns));

    expect(rows.map((r) => r.id)).toEqual(['seed-s0:0', 'seed-s0:1', 'new']);
  });
});

/* --------------------------------- the rows-changed action's own contract --- */

describe('rowsChangedAction carries the model’s ids, not the on-screen ones', () => {
  const turns = detailOf(2).turns;
  const eventsByTurn = new Map([
    ['seed-s0:0', [makeEventRow({ id: 'old', turn_id: 'seed-s0:0' })]],
    ['seed-s0:1', [makeEventRow({ id: 'new', turn_id: 'seed-s0:1' })]],
  ]);
  const model = buildTurnGroups(turns, eventsByTurn);

  it('names every id that can be a row, including the closed-away ones', () => {
    const rows = flatten(model, initialExpanded(turns));
    const action = rowsChangedAction(model, rows, initialSubagentState);

    expect(action.type).toBe('rows-changed');
    const modelIds = action.type === 'rows-changed' ? action.modelIds : new Set<string>();
    expect([...modelIds].sort()).toEqual(['new', 'old', 'seed-s0:0', 'seed-s0:1']);
    expect(
      modelIds.has('old'),
      'the event under the closed turn is off screen but still in the model, and ' +
        'that is exactly the difference this field exists to carry.',
    ).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain('old');
  });

  it('keeps a selection sitting under a closed turn', () => {
    const rows = flatten(model, initialExpanded(turns));
    const selected = { ...initialNavState(initialExpanded(turns)), selectedId: 'old' };

    const next = navReducer(selected, rowsChangedAction(model, rows, initialSubagentState));

    expect(
      next.selectedId,
      'the on-screen rows do not contain "old" — passing THEIR ids as modelIds ' +
        'would clear the selection on every collapse, which is the one failure ' +
        'the selection/focus split exists to prevent.',
    ).toBe('old');
  });

  it('drops a selection the new model no longer holds', () => {
    const smaller = buildTurnGroups(turns.slice(0, 1), new Map());
    const stale = { ...initialNavState(), selectedId: 'new' };

    const next = navReducer(
      stale,
      rowsChangedAction(smaller, flatten(smaller, new Set()), initialSubagentState),
    );
    expect(next.selectedId).toBeUndefined();
  });
});
