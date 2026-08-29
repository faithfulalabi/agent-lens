import { describe, it, expect } from 'vitest';

import type { SessionDetailBody } from '../api';

import {
  SPAN_CAP,
  SPAN_PAGE,
  TRACE_PAGE,
  initialExpanded,
  loadSessionSpans,
  needsReseed,
  rowsChangedAction,
  truncationNotes,
  type SessionData,
} from '../session-data';
import { buildTreeModel, flatten } from '../span-tree';
import { initialNavState, navReducer } from '../tree-nav';
import {
  atSecond,
  makeDetail,
  makeEventRow,
  makeSession,
  makeSpan,
  makeTrace,
  makeTurnRow,
  stubApiClient,
} from './fixtures';

/*
 * Task 5.3b's loading half — every decision the session page module would
 * otherwise make inside an effect, asserted as a plain function call.
 *
 * The two mutation checks worth stating up front, because they are what make
 * this file more than a description of the code:
 *
 *   - Drop the explicit `limit` and the read API's own default silently serves
 *     100 spans, so a 5,000-span session renders as a plausible-looking lie.
 *   - Pass the ON-SCREEN row ids as `modelIds` instead of the model's own and
 *     every collapsed-away selection is cleared, which is precisely what the
 *     selection/focus split was built to prevent.
 */

/** A detail body carrying `turnCount` turns and one page of `count` events. */
function detailOf(
  turnCount: number,
  { events = 0, from = 0, hasMore = false, turnId = 'seed-s0:0' } = {},
): SessionDetailBody {
  return makeDetail({
    turns: Array.from({ length: turnCount }, (_, i) =>
      makeTurnRow({ id: `seed-s0:${i}`, seq: i, title: `turn ${i}` }),
    ),
    events: Array.from({ length: events }, (_, i) =>
      makeEventRow({
        id: `sp-${from + i}`,
        turn_id: turnId,
        seq: from + i,
        ts: atSecond(from + i),
      }),
    ),
    next_seq: from + events,
    has_more: hasMore,
  });
}

/* ------------------------------------------- Test 17 — the page is real --- */

describe('the span page is fetched at the session’s real size', () => {
  it('states a limit far above the read API’s default', async () => {
    const queries: unknown[] = [];
    const api = stubApiClient({
      getSession: (_id, query) => {
        queries.push(query);
        return Promise.resolve(detailOf(1, { events: 3 }));
      },
    });

    await loadSessionSpans(api, 'seed-s0');

    expect(
      queries,
      'an omitted limit is not a loud failure — the server clamps rather than ' +
        'rejecting, so a 5,000-event session would load its first page and the ' +
        'tree would render a truncated session that looks whole.',
    ).toEqual([{ limit: SPAN_PAGE }]);
    expect(SPAN_PAGE).toBeGreaterThan(1000);
  });

  it('follows has_more onto the next page using next_seq as the cursor', async () => {
    const queries: { limit?: number; from_seq?: number }[] = [];
    const api = stubApiClient({
      getSession: (_id, query) => {
        queries.push(query ?? {});
        const first = queries.length === 1;
        return Promise.resolve(
          first
            ? detailOf(1, { events: 4, from: 0, hasMore: true })
            : detailOf(1, { events: 2, from: 4, hasMore: false }),
        );
      },
    });

    const data = await loadSessionSpans(api, 'seed-s0');

    // ★ A CURSOR, NOT AN OFFSET. The second request names the seq the first one
    // stopped at; an offset scheme renumbers its whole page when the file grows
    // mid-scroll, which is the state a live tail is in by definition.
    expect(queries).toEqual([{ limit: SPAN_PAGE }, { limit: SPAN_PAGE, from_seq: 4 }]);
    expect(queries[1], 'offset paging was replaced by the cursor').not.toHaveProperty('offset');
    expect(data.shown).toBe(6);
    expect(data.truncated).toBe(false);
  });

  it('stops rather than spinning when a page claims more but serves nothing', async () => {
    let calls = 0;
    const api = stubApiClient({
      getSession: () => {
        calls += 1;
        // A server bug, not a client one — and an unbounded loop here is a
        // frozen tab rather than an error anybody can read.
        return Promise.resolve(detailOf(1, { events: 0, hasMore: true }));
      },
    });

    const data = await loadSessionSpans(api, 'seed-s0');
    expect(calls).toBe(2);
    expect(data.shown).toBe(0);
  });

  it('stops rather than spinning when next_seq fails to advance', async () => {
    // The other non-termination a cursor can hit, and the one an offset loop
    // could not: a server that answers `has_more` while repeating its cursor.
    let calls = 0;
    const api = stubApiClient({
      getSession: () => {
        calls += 1;
        return Promise.resolve(detailOf(1, { events: 2, from: 0, hasMore: true }));
      },
    });

    const data = await loadSessionSpans(api, 'seed-s0');
    expect(calls).toBe(2);
    expect(data.shown).toBe(2);
  });

  it('passes the abort signal through to every request it makes', async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const api = stubApiClient({
      getSession: (_id, _query, options) => {
        seen.push(options?.signal);
        return Promise.resolve(detailOf(1, { events: 1, hasMore: true }));
      },
    });

    await loadSessionSpans(api, 'seed-s0', { signal: controller.signal });
    expect(seen).toEqual([controller.signal, controller.signal]);
  });
});

/* --------------------------------------- the caller buckets by trace_id --- */

describe('every event lands under the turn it names', () => {
  it('buckets a mixed page by turn_id', async () => {
    const api = stubApiClient({
      getSession: () =>
        Promise.resolve(
          makeDetail({
            turns: [makeTurnRow({ id: 'seed-s0:0', seq: 0 }), makeTurnRow({ id: 'seed-s0:1', seq: 1 })],
            events: [
              makeEventRow({ id: 'a1', turn_id: 'seed-s0:0', seq: 0 }),
              makeEventRow({ id: 'b1', turn_id: 'seed-s0:1', seq: 1 }),
              makeEventRow({ id: 'a2', turn_id: 'seed-s0:0', seq: 2 }),
            ],
          }),
        ),
    });

    const { spansByTrace } = await loadSessionSpans(api, 'seed-s0');

    expect([...spansByTrace.keys()].sort()).toEqual(['seed-s0:0', 'seed-s0:1']);
    expect(spansByTrace.get('seed-s0:0')?.map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(spansByTrace.get('seed-s0:1')?.map((s) => s.id)).toEqual(['b1']);
  });

  it('hands buildTreeModel a map it can use without any further sorting', async () => {
    const api = stubApiClient({
      getSession: () =>
        Promise.resolve(
          makeDetail({
            turns: [makeTurnRow({ id: 'seed-s0:0', seq: 0 }), makeTurnRow({ id: 'seed-s0:1', seq: 1 })],
            events: [
              makeEventRow({ id: 'a1', turn_id: 'seed-s0:0', seq: 0 }),
              makeEventRow({ id: 'b1', turn_id: 'seed-s0:1', seq: 1 }),
            ],
          }),
        ),
    });

    const data = await loadSessionSpans(api, 'seed-s0');
    const model = buildTreeModel(data.traces, data.spansByTrace);

    expect(model.traces.map((t) => t.children.map((c) => c.span.id))).toEqual([['a1'], ['b1']]);
    expect(model.unmatchedSpanCount).toBe(0);
  });

  it('counts events whose turn fell off the turn page rather than dropping them', async () => {
    const api = stubApiClient({
      getSession: () =>
        Promise.resolve(
          makeDetail({
            turns: [makeTurnRow({ id: 'seed-s0:0', seq: 0 })],
            events: [
              makeEventRow({ id: 'a1', turn_id: 'seed-s0:0', seq: 0 }),
              makeEventRow({ id: 'z1', turn_id: 'seed-s0:99', seq: 1 }),
            ],
          }),
        ),
    });

    const data = await loadSessionSpans(api, 'seed-s0');
    expect(buildTreeModel(data.traces, data.spansByTrace).unmatchedSpanCount).toBe(1);
  });

  it('reports tracesTruncated once the turn array passes TRACE_PAGE', async () => {
    // The detail route returns EVERY turn in one array — there is no turn
    // cursor — so the cap is the client's and the notice strip is how it says so.
    const api = stubApiClient({
      getSession: () =>
        Promise.resolve(
          makeDetail({
            turns: Array.from({ length: TRACE_PAGE + 1 }, (_, i) =>
              makeTurnRow({ id: `seed-s0:${i}`, seq: i }),
            ),
          }),
        ),
    });

    const data = await loadSessionSpans(api, 'seed-s0');
    expect(data.traces).toHaveLength(TRACE_PAGE);
    expect(data.tracesTruncated).toBe(true);
  });
});

/* ------------------------------------------ Test 18a — truncation report --- */

describe('the client cap is reported, never silently applied (Test 18a)', () => {
  it('reports truncated with the count it actually holds once the cap is passed', async () => {
    let calls = 0;
    const api = stubApiClient({
      getSession: () => {
        calls += 1;
        return Promise.resolve(detailOf(1, { events: 4, from: (calls - 1) * 4, hasMore: true }));
      },
    });

    const data = await loadSessionSpans(api, 'seed-s0', { cap: 8, limit: 4 });

    expect(data.truncated, 'more events exist and the reader has to be told').toBe(true);
    expect(data.shown).toBe(8);
    expect(calls, 'the cap stops the loop rather than merely labelling it').toBe(2);
  });

  it('reports untruncated when the session ended before the cap', async () => {
    const api = stubApiClient({
      getSession: () => Promise.resolve(detailOf(1, { events: 3 })),
    });

    const data = await loadSessionSpans(api, 'seed-s0', { cap: 8, limit: 4 });
    expect(data.truncated).toBe(false);
    expect(data.shown).toBe(3);
  });

  it('sets the cap above the server’s own ceiling, so it is the rare case', () => {
    expect(SPAN_CAP).toBeGreaterThan(SPAN_PAGE);
    expect(SPAN_CAP).toBe(20_000);
  });
});

/* ------------------------------------------------ the truncation wording --- */

describe('the view says what it is not showing (Test 18a, copy half)', () => {
  it('says nothing at all when the tree is complete', () => {
    expect(
      truncationNotes({
        shown: 42,
        truncated: false,
        tracesTruncated: false,
        unmatchedSpanCount: 0,
      }),
    ).toEqual([]);
  });

  it('names the count it is showing, spelled rather than bare', () => {
    const [note] = truncationNotes({
      shown: 20_000,
      truncated: true,
      tracesTruncated: false,
      unmatchedSpanCount: 0,
    });
    expect(note).toContain('20,000');
    expect(note, 'Flow 3 forbids presenting a partial trace as a whole one').toContain('first');
  });

  it('reports spans whose turn fell off the page as its own sentence', () => {
    const notes = truncationNotes({
      shown: 5,
      truncated: false,
      tracesTruncated: false,
      unmatchedSpanCount: 12,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('12 more spans');
  });

  it('reports turns beyond the turn page as its own sentence', () => {
    /*
     * Not covered by the unmatched count: a turn past the page whose spans are
     * ALSO past the span cap contributes nothing to that count, so without this
     * sentence a 1,500-turn session would show 1,000 turns and claim to be
     * whole. Both caps are this module's own choice, which is exactly why it
     * owes the reader an account of them.
     */
    const notes = truncationNotes({
      shown: 5,
      truncated: false,
      tracesTruncated: true,
      unmatchedSpanCount: 0,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('1,000 turns');
  });

  it('says all three when a session managed all three', () => {
    expect(
      truncationNotes({
        shown: 20_000,
        truncated: true,
        tracesTruncated: true,
        unmatchedSpanCount: 3,
      }),
    ).toHaveLength(3);
  });
});

/* --------------------------------------------- reseeding across sessions --- */

describe('the navigation state restarts on the session that ARRIVED (needsReseed)', () => {
  /** A `SessionData` for one session id, with one turn. */
  function dataFor(id: string): SessionData {
    return {
      session: makeSession({ id }),
      traces: [makeTrace({ id: `${id}:0`, session_id: id })],
      tracesTruncated: false,
      spansByTrace: new Map(),
      truncated: false,
      shown: 0,
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
    const stillA = dataFor('A');
    expect(
      needsReseed(stillA, 'A'),
      'the data in hand is still A’s, so there is nothing new to seed from yet',
    ).toBe(false);
  });

  it('reseeds as soon as the new session’s own data is in hand', () => {
    expect(needsReseed(dataFor('B'), 'A')).toBe(true);
  });

  it('seeds from the arrived session’s turns, not the previous one’s', () => {
    // The observable consequence of the case above: expansion must name a turn
    // that exists in the model actually being flattened.
    const b = dataFor('B');
    const expanded = initialExpanded(b.traces);
    expect([...expanded]).toEqual(['B:0']);
    expect(expanded.has('A:0')).toBe(false);
  });
});

/* ------------------------------------------------- the opening expansion --- */

describe('a session opens on its latest turn', () => {
  it('opens the last turn and leaves the older ones closed', () => {
    const traces = detailOf(3).turns.map((turn) => makeTrace({ id: turn.id }));
    expect([...initialExpanded(traces)]).toEqual(['seed-s0:2']);
  });

  it('opens nothing at all when the session has no turns', () => {
    expect(initialExpanded([]).size).toBe(0);
  });

  it('puts real span rows on screen, which an empty expansion set would not', () => {
    const traces = detailOf(2).turns.map((turn) => makeTrace({ id: turn.id }));
    const spansByTrace = new Map([
      ['seed-s0:0', [makeSpan({ id: 'old', trace_id: 'seed-s0:0' })]],
      ['seed-s0:1', [makeSpan({ id: 'new', trace_id: 'seed-s0:1' })]],
    ]);
    const model = buildTreeModel(traces, spansByTrace);
    const rows = flatten(model, initialExpanded(traces));

    expect(rows.map((r) => r.id)).toEqual(['seed-s0:0', 'seed-s0:1', 'new']);
  });
});

/* ---------------------------------- the rows-changed action's own contract --- */

describe('rowsChangedAction carries the model’s ids, not the on-screen ones', () => {
  const traces = detailOf(2).turns.map((turn) => makeTrace({ id: turn.id }));
  const spansByTrace = new Map([
    ['seed-s0:0', [makeSpan({ id: 'old', trace_id: 'seed-s0:0' })]],
    ['seed-s0:1', [makeSpan({ id: 'new', trace_id: 'seed-s0:1' })]],
  ]);
  const model = buildTreeModel(traces, spansByTrace);

  it('names every id that can be a row, including the closed-away ones', () => {
    const rows = flatten(model, initialExpanded(traces));
    const action = rowsChangedAction(model, rows);

    expect(action.type).toBe('rows-changed');
    const modelIds = action.type === 'rows-changed' ? action.modelIds : new Set<string>();
    expect([...modelIds].sort()).toEqual(['new', 'old', 'seed-s0:0', 'seed-s0:1']);
    expect(
      modelIds.has('old'),
      'the span under the closed turn is off screen but still in the model, and ' +
        'that is exactly the difference this field exists to carry.',
    ).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain('old');
  });

  it('keeps a selection sitting under a closed turn', () => {
    const rows = flatten(model, initialExpanded(traces));
    const selected = { ...initialNavState(initialExpanded(traces)), selectedId: 'old' };

    const next = navReducer(selected, rowsChangedAction(model, rows));

    expect(
      next.selectedId,
      'the on-screen rows do not contain "old" — passing THEIR ids as modelIds ' +
        'would clear the selection on every collapse, which is the one failure ' +
        'the selection/focus split exists to prevent.',
    ).toBe('old');
  });

  it('drops a selection the new model no longer holds', () => {
    const smaller = buildTreeModel(traces.slice(0, 1), new Map());
    const stale = { ...initialNavState(), selectedId: 'new' };

    const next = navReducer(stale, rowsChangedAction(smaller, flatten(smaller, new Set())));
    expect(next.selectedId).toBeUndefined();
  });
});
