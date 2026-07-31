import { describe, it, expect } from 'vitest';

import type { Span, Trace } from '@shared/entities.ts';

import {
  buildTreeModel,
  flatten,
  subtreeChips,
  subtreeDuration,
  traceChips,
  type SpanNode,
  type TreeModel,
} from '../span-tree';
import {
  atSecond,
  makeCyclePage,
  makeOrphanPage,
  makeSpan,
  makeSpanTree,
  makeTrace,
  type SpanTreeSpec,
} from './fixtures';

/*
 * Tests 1, 2, 3, 14 and 15 of Task 5.3a.
 *
 * Everything here is pure, so nothing is stubbed, nothing is mocked and no
 * clock is read: the one `now` in the file is a parameter.
 */

const TRACE = makeTrace({ id: 'seed-s0:1' });

function modelOf(spans: Span[], trace: Trace = TRACE): TreeModel {
  return buildTreeModel([trace], new Map([[trace.id, spans]]));
}

function rootsOf(model: TreeModel): readonly SpanNode[] {
  return model.traces[0]?.children ?? [];
}

function idsOf(model: TreeModel, expandedIds: ReadonlySet<string> = model.rowIds): string[] {
  return flatten(model, expandedIds).map((row) => row.id);
}

/*
 * Pinned timestamps, so the page the fixture emits is genuinely time-ordered
 * and NOT tree-ordered — which is the shape `readSessionSpans` actually
 * serves, and the reason this module re-orders at all.
 */
const SHAPE: SpanTreeSpec[] = [
  {
    id: 'a',
    started_at: atSecond(0),
    ended_at: atSecond(9),
    children: [
      { id: 'a2', started_at: atSecond(5), ended_at: atSecond(6) },
      { id: 'a1', started_at: atSecond(3), ended_at: atSecond(4) },
    ],
  },
  {
    id: 'b',
    started_at: atSecond(1),
    ended_at: atSecond(8),
    children: [
      {
        id: 'b1',
        started_at: atSecond(2),
        ended_at: atSecond(7),
        children: [{ id: 'b1a', started_at: atSecond(4), ended_at: atSecond(5) }],
      },
    ],
  },
];

/* --------------------------------------------------------------- Test 1 --- */

describe('the tree is rebuilt from a flat, time-ordered page', () => {
  const page = makeSpanTree(SHAPE);
  const model = modelOf(page);

  it('starts from a page whose array order is not its tree order', () => {
    // If this ever equals the pre-order below, the fixture stopped testing the
    // thing the whole module exists for and every assertion under it weakens.
    expect(page.map((span) => span.id)).toEqual(['a', 'b', 'b1', 'a1', 'b1a', 'a2']);
  });

  it('wires parents, children and depth', () => {
    expect(rootsOf(model).map((node) => node.span.id)).toEqual(['a', 'b']);
    expect(rootsOf(model).map((node) => node.depth)).toEqual([1, 1]);

    const [a, b] = rootsOf(model);
    expect(a?.children.map((node) => node.span.id)).toEqual(['a1', 'a2']);
    expect(a?.children.map((node) => node.depth)).toEqual([2, 2]);
    expect(b?.children[0]?.children.map((node) => node.span.id)).toEqual(['b1a']);
    expect(b?.children[0]?.children[0]?.depth).toBe(3);
  });

  it('emits pre-order rows, one per span plus one per turn', () => {
    expect(idsOf(model)).toEqual(['seed-s0:1', 'a', 'a1', 'a2', 'b', 'b1', 'b1a']);
  });

  it('orders siblings by started_at, and breaks a millisecond tie by id', () => {
    // The server orders `started_at ASC` with no tiebreaker, so a tie leaves
    // sibling order up to SQLite. Declaration order here is z-then-a; the
    // answer must be a-then-z either way.
    const tied = modelOf([
      makeSpan({ id: 'sp-z', started_at: atSecond(1), ended_at: atSecond(2) }),
      makeSpan({ id: 'sp-a', started_at: atSecond(1), ended_at: atSecond(2) }),
    ]);
    expect(rootsOf(tied).map((node) => node.span.id)).toEqual(['sp-a', 'sp-z']);

    const reversed = modelOf([
      makeSpan({ id: 'sp-a', started_at: atSecond(1), ended_at: atSecond(2) }),
      makeSpan({ id: 'sp-z', started_at: atSecond(1), ended_at: atSecond(2) }),
    ]);
    expect(rootsOf(reversed).map((node) => node.span.id)).toEqual(['sp-a', 'sp-z']);
  });

  it('counts setSize and posInSet within the parent, never within the window', () => {
    const places = new Map(
      flatten(model, model.rowIds).map((row) => [row.id, `${row.posInSet}/${row.setSize}`]),
    );
    expect(Object.fromEntries(places)).toEqual({
      'seed-s0:1': '1/1',
      a: '1/2',
      a1: '1/2',
      a2: '2/2',
      b: '2/2',
      b1: '1/1',
      b1a: '1/1',
    });
  });

  it('counts spans belonging to no turn on the page rather than dropping them', () => {
    // `SessionDetail.traces` is a capped page while the span query filters on
    // session_id alone, so span 101's turn can simply not be here.
    const partial = buildTreeModel(
      [TRACE],
      new Map([
        [TRACE.id, [makeSpan({ id: 'sp-here' })]],
        ['seed-s0:404', [makeSpan({ id: 'sp-elsewhere', trace_id: 'seed-s0:404' })]],
      ]),
    );
    expect(partial.unmatchedSpanCount).toBe(1);
    expect(idsOf(partial)).toEqual(['seed-s0:1', 'sp-here']);
  });
});

/* --------------------------------------------------------------- Test 2 --- */

describe('the model is total against parents the page does not contain', () => {
  it('attaches an out-of-page parent to the turn instead of dropping the span', () => {
    const model = modelOf(makeOrphanPage());
    expect(rootsOf(model).map((node) => node.span.id)).toEqual(['sp-kept', 'sp-orphan']);
    expect(idsOf(model)).toEqual(['seed-s0:1', 'sp-kept', 'sp-orphan']);
  });

  it('attaches a span that names itself as its own parent to the turn', () => {
    const model = modelOf([makeSpan({ id: 'sp-self', parent_span_id: 'sp-self' })]);
    expect(idsOf(model)).toEqual(['seed-s0:1', 'sp-self']);
  });

  it('cuts a cycle: both spans survive, exactly once each, and the walk ends', () => {
    // Reaching the expectation at all is half the assertion — `parent_span_id`
    // is a self-FK with no cycle constraint, so an uncut edge is an infinite
    // walk here rather than a wrong answer.
    const rows = idsOf(modelOf(makeCyclePage()));
    expect(rows).toEqual(['seed-s0:1', 'sp-a', 'sp-b']);
    expect(new Set(rows).size).toBe(rows.length);
  });

  it('cuts a three-span cycle the same way', () => {
    const rows = idsOf(
      modelOf([
        makeSpan({ id: 'sp-1', parent_span_id: 'sp-3' }),
        makeSpan({ id: 'sp-2', parent_span_id: 'sp-1', started_at: atSecond(1) }),
        makeSpan({ id: 'sp-3', parent_span_id: 'sp-2', started_at: atSecond(2) }),
      ]),
    );
    expect(new Set(rows)).toEqual(new Set(['seed-s0:1', 'sp-1', 'sp-2', 'sp-3']));
    expect(rows).toHaveLength(4);
  });
});

/* --------------------------------------------------------------- Test 3 --- */

describe('flatten answers to the expansion state', () => {
  const model = modelOf(makeSpanTree(SHAPE));
  const everything = model.rowIds;

  it('contributes zero rows for a closed subtree, and round-trips exactly', () => {
    const open = idsOf(model, everything);

    const closedIds = new Set(everything);
    closedIds.delete('b1');
    expect(idsOf(model, closedIds)).toEqual(['seed-s0:1', 'a', 'a1', 'a2', 'b', 'b1']);

    // Re-opening restores the prior rows in the prior order — the round trip
    // AC2 is really about.
    expect(idsOf(model, everything)).toEqual(open);
  });

  it('drops a whole turn to one row when the turn itself is closed', () => {
    const closedIds = new Set(everything);
    closedIds.delete('seed-s0:1');
    expect(idsOf(model, closedIds)).toEqual(['seed-s0:1']);
  });

  it('removes exactly the row a predicate rejects', () => {
    // Task 7.2's seam. A parameter can type-check, satisfy no-unused-vars and
    // still do nothing, so this asserts it actually decides something.
    const rows = flatten(model, everything, (row) => row.id !== 'a2').map((row) => row.id);
    expect(rows).toEqual(['seed-s0:1', 'a', 'a1', 'b', 'b1', 'b1a']);
  });

  it('removes the rejected row and everything beneath it', () => {
    const rows = flatten(model, everything, (row) => row.id !== 'b1').map((row) => row.id);
    expect(rows).toEqual(['seed-s0:1', 'a', 'a1', 'a2', 'b']);
  });

  it('hands the predicate a fully built row, aria counts included', () => {
    const seen: string[] = [];
    flatten(model, everything, (row) => {
      seen.push(`${row.kind}:${row.id}:${row.depth}:${row.posInSet}/${row.setSize}`);
      return true;
    });
    expect(seen).toContain('trace:seed-s0:1:0:1/1');
    expect(seen).toContain('span:a2:2:2/2');
  });
});

/* -------------------------------------------------------------- Test 14 --- */

describe('turn chips are read off the server rollup, never recomputed', () => {
  it('answers the stored total even when it disagrees with the spans on the page', () => {
    // Deliberately inconsistent: the server rolled up every span in the turn,
    // this page carries one of them. Recomputing would make the number the
    // user sees depend on how far they had scrolled.
    const trace = makeTrace({
      total_tokens: 90_000,
      est_cost: 9.5,
      duration_ms: 123_456,
      error_count: 7,
    });
    const model = modelOf(
      [makeSpan({ id: 'sp-1', tokens_in: 1, tokens_out: 2, est_cost: 0.5, status: 'ok' })],
      trace,
    );
    const node = model.traces[0];
    if (node === undefined) throw new Error('the fixture built no turn');

    expect(traceChips(node)).toEqual({
      durationMs: 123_456,
      tokens: 90_000,
      cost: 9.5,
      errorCount: 7,
    });
    // Mutation check, verified by hand: rewriting traceChips to sum
    // `node.children` answers 3 tokens and 0.5 cost, and this goes red.
    expect(traceChips(node).tokens).not.toBe(3);
  });
});

/* -------------------------------------------------------------- Test 15 --- */

describe('sub-agent subtree chips are computed bottom up', () => {
  /*
   * A sub-agent whose two tool calls overlap, inside a parent that outlives
   * both. Wall clock is 10s; the three durations sum to 21s. The fixture is
   * built so those two answers cannot coincide.
   */
  const group = makeSpanTree([
    {
      id: 'sub',
      span_type: 'subagent',
      started_at: atSecond(0),
      ended_at: atSecond(10),
      tokens_in: 100,
      tokens_out: 20,
      est_cost: 0.01,
      children: [
        {
          id: 'tool-1',
          started_at: atSecond(1),
          ended_at: atSecond(6),
          tokens_in: 10,
          tokens_out: 5,
          est_cost: 0.002,
          status: 'error',
        },
        {
          id: 'tool-2',
          started_at: atSecond(2),
          ended_at: atSecond(8),
          tokens_in: 7,
          est_cost: 0.003,
          status: 'denied',
        },
      ],
    },
  ]);

  function subtreeRoot(spans: Span[]): SpanNode {
    const node = modelOf(spans).traces[0]?.children[0];
    if (node === undefined) throw new Error('the fixture built no subtree root');
    return node;
  }

  it('sums tokens, cost and error count over every descendant', () => {
    const chips = subtreeChips(subtreeRoot(group));
    expect(chips.tokens).toBe(142);
    expect(chips.cost).toBeCloseTo(0.015, 10);
    // `denied` counts as an error, exactly as the server's error_count does.
    expect(chips.errorCount).toBe(2);
  });

  it('measures duration as wall clock, never as a sum of descendant durations', () => {
    const node = subtreeRoot(group);
    const summed = 10_000 + 5_000 + 6_000;
    expect(subtreeDuration(node)).toBe(10_000);
    // Mutation check, verified by hand: summing descendant durations answers
    // 21_000 here — more time than actually passed, because the parent already
    // contains both children and the two children overlap each other.
    expect(subtreeDuration(node)).toBeLessThan(summed);
  });

  it('still reports a duration while a descendant is running', () => {
    const live = makeSpanTree([
      {
        id: 'sub',
        span_type: 'subagent',
        started_at: atSecond(0),
        ended_at: undefined,
        children: [
          { id: 'done', started_at: atSecond(1), ended_at: atSecond(4) },
          { id: 'running', started_at: atSecond(2), ended_at: undefined, status: 'running' },
        ],
      },
    ]);
    const node = subtreeRoot(live);

    // No clock offered: close at the latest descendant that HAS ended, which
    // is what recomputeTraceRollup's COALESCE(…, MAX(ended_at)) does.
    expect(subtreeDuration(node)).toBe(4_000);
    // A clock offered: the live subtree advances with it.
    expect(subtreeDuration(node, Date.parse(atSecond(30)))).toBe(30_000);
    expect(subtreeDuration(node, new Date(Date.parse(atSecond(45))))).toBe(45_000);
    // Mutation check, verified by hand: returning undefined whenever the
    // subtree holds a running span reds all three, and would have put an em
    // dash on the entire ancestor chain above every live span.
    expect(subtreeDuration(node)).not.toBeUndefined();
  });

  it('answers unknown only when nothing in the subtree has ended', () => {
    const nothingClosed = subtreeRoot([
      makeSpan({ id: 'sp-open', status: 'running', ended_at: undefined }),
    ]);
    expect(subtreeDuration(nothingClosed)).toBeUndefined();
    expect(subtreeChips(nothingClosed).durationMs).toBeUndefined();
    // …and even then, a clock still closes it.
    expect(subtreeDuration(nothingClosed, Date.parse(atSecond(12)))).toBe(12_000);
  });

  it('ignores the clock once every span in the subtree has ended', () => {
    const node = subtreeRoot(group);
    expect(subtreeDuration(node, Date.parse(atSecond(9_000)))).toBe(10_000);
  });

  it('floors an out-of-order span at zero rather than reporting negative time', () => {
    // A LONE span, deliberately: with any normally-ordered sibling in the
    // subtree the un-floored max−min stays positive and a dropped floor would
    // pass green. Task 2.3 tolerates an out-of-order Stop, so this row is
    // producible, and `db/rollups.ts` clamps its own answer for the same
    // reason.
    const backwards = subtreeRoot([
      makeSpan({ id: 'sp-backwards', started_at: atSecond(10), ended_at: atSecond(4) }),
    ]);
    expect(subtreeDuration(backwards)).toBe(0);
    // Mutation check, verified by hand: dropping the Math.max answers -6000.
    expect(subtreeDuration(backwards)).not.toBeLessThan(0);
  });

  it('treats an absent token or cost field as nothing, never as NaN', () => {
    const bare = subtreeRoot([makeSpan({ id: 'sp-bare' })]);
    expect(subtreeChips(bare)).toEqual({
      durationMs: 1_000,
      tokens: 0,
      cost: 0,
      errorCount: 0,
    });
  });
});
