import { describe, it, expect } from 'vitest';

import {
  agentStatusOf,
  childIdsToFetch,
  initialSubagentState,
  mergedRowIds,
  subagentReducer,
  subtreesOf,
  turnIdsToOpen,
  type SubagentState,
} from '../subagent';
import { buildTurnGroups, flatten, type Row, type TreeModel } from '../turn-tree';
import { expandMany, initialNavState, navReducer } from '../tree-nav';
import { rowsChangedAction } from '../session-data';
import { makeAgentEvent, makeSidecarDetail, makeTurnTree, type TurnTreeSpec } from './fixtures';

/*
 * Task 5.5's pure half — the splice, and the reducer that decides what to
 * splice.
 *
 * ===========================================================================
 * NOTHING HERE DRIVES AN EFFECT, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
 * ===========================================================================
 * `ui/vitest.config.ts` runs `environment: 'node'`, so the lazy fetch itself is
 * unobservable to any test in this repo. Every decision around it is therefore a
 * pure function, and every one of them is called directly below. The request the
 * page actually issues is proved by the live render gate and by nothing here.
 */

const PARENT = 'seed-s0';
const CHILD = 'child-0';
const GRANDCHILD = 'grand-0';

function modelOf(specs: TurnTreeSpec[]): TreeModel {
  const tree = makeTurnTree(specs);
  return buildTurnGroups(tree.turns, tree.eventsByTurn);
}

/** A sidecar's loaded detail, built from the same nested literal a session uses. */
function sidecar(sessionId: string, specs: TurnTreeSpec[]) {
  return makeSidecarDetail(sessionId, makeTurnTree(specs));
}

/** Every child in `children` loaded, in order. Uses the real reducer, not a literal. */
function loadedState(...children: { id: string; specs: TurnTreeSpec[] }[]): SubagentState {
  return children.reduce<SubagentState>(
    (state, { id, specs }) =>
      subagentReducer(state, { type: 'loaded', childId: id, child: sidecar(id, specs) }),
    initialSubagentState,
  );
}

/**
 * The rows the screen would draw: the parent model, everything the reader
 * opened, plus every turn each loaded child needs open to show its events.
 *
 * ★ THE EXPANSION SET IS NEVER HAND-BUILT. `flatten` puts a turn's events on
 * screen only when its id is in that set, so a test that seeded the set itself
 * would be asserting on its own arithmetic rather than on the seed the page
 * actually applies — and the seed is precisely the thing that goes missing.
 */
function splicedRows(
  model: TreeModel,
  state: SubagentState,
  children: { id: string; specs: TurnTreeSpec[] }[],
  clicked: readonly string[] = [],
): Row[] {
  const seeded = children.reduce(
    (nav, child) => expandMany(nav, turnIdsToOpen(sidecar(child.id, child.specs))),
    initialNavState(model.rowIds),
  );
  // A nested Agent row is opened by the reader, exactly as a top-level one is —
  // the seed opens TURNS so a child shows its events, and nothing more.
  const opened = expandMany(seeded, clicked);
  return flatten(model, opened.expandedIds, undefined, {
    rootSessionId: PARENT,
    subtrees: subtreesOf(state),
  });
}

/* ------------------------------------------------ Test 1 — the splice ------ */

describe('a loaded sidecar splices in beneath its Agent row (Test 1, AC1)', () => {
  const PARENT_SHAPE: TurnTreeSpec[] = [
    { id: 't0', seq: 0, events: [{ name: 'before' }, makeAgentEvent(), { name: 'after' }] },
  ];
  const CHILD_SHAPE: TurnTreeSpec[] = [
    { id: 'c0', seq: 0, events: [{ name: 'x' }, { name: 'y' }] },
  ];
  const model = modelOf(PARENT_SHAPE);
  const state = loadedState({ id: CHILD, specs: CHILD_SHAPE });
  const rows = splicedRows(model, state, [{ id: CHILD, specs: CHILD_SHAPE }]);

  it('puts the child’s turn row and its EVENT rows in place, then resumes the parent', () => {
    /*
     * The event rows are the clause that matters. `flatten` descends into a turn
     * only when its id is in the expansion set, and a fresh child's ids cannot be
     * in one seeded from the parent's turns — so without the seed this list would
     * read `… 't0-ev-1', 'c0', 't0-ev-2'` and the sidecar would show a header and
     * no work at all. MEASURED: 183 of 272 sidecars hold exactly one turn, and so
     * do all five children of the session the render gate drives.
     */
    expect(rows.map((row) => row.id)).toEqual([
      't0',
      't0-ev-0',
      't0-ev-1',
      'c0',
      'c0-ev-0',
      'c0-ev-1',
      't0-ev-2',
    ]);
  });

  it('leaves the parent’s own rows at exactly the depths they had', () => {
    const depths = new Map(rows.map((row) => [row.id, row.depth]));
    expect(depths.get('t0')).toBe(0);
    expect(depths.get('t0-ev-0')).toBe(1);
    expect(depths.get('t0-ev-2')).toBe(1);
  });

  it('nests the child one level under the Agent row, and its events one below that', () => {
    const depths = new Map(rows.map((row) => [row.id, row.depth]));
    expect(depths.get('c0')).toBe(2);
    expect(depths.get('c0-ev-0')).toBe(3);
  });

  it('draws a chevron on the Agent row before anything is loaded (Test 9, AC1)', () => {
    const cold = flatten(model, model.rowIds, undefined, { rootSessionId: PARENT });
    const agent = cold.find((row) => row.id === 't0-ev-1');
    const plain = cold.find((row) => row.id === 't0-ev-0');

    expect(
      agent?.hasChildren,
      'without this the toggle never renders and the row cannot be clicked at all',
    ).toBe(true);
    expect(plain?.hasChildren, 'a tool_call naming no child session has nothing to open').toBe(
      false,
    );
  });

  it('mints no duplicate row id across the splice (Test 10, AC1)', () => {
    // MEASURED: 647 turn ids and 30,286 event ids in the archive, all distinct,
    // and zero turn ids collide with an event id. `child_session_id` is 1:1 with
    // its Agent event, so one sidecar can never splice in twice.
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  /* -------------------------------------- Test 3 — whose transcript is this - */

  it('stamps the spliced rows with the CHILD’s session id and the rest with the parent’s', () => {
    const stamps = new Map(rows.map((row) => [row.id, row.sessionId]));

    expect(stamps.get('t0')).toBe(PARENT);
    expect(stamps.get('t0-ev-1')).toBe(PARENT);
    expect(stamps.get('c0')).toBe(CHILD);
    expect(
      stamps.get('c0-ev-0'),
      'the nested EVENT row is the one a splice carrying only a depth offset ' +
        'would leave stamped with the parent — it is what AC-R1(c) reads.',
    ).toBe(CHILD);
  });

  it('carries the child’s header on its ROOT turn row and on no other row', () => {
    const withHeader = rows.filter((row) => row.subagent !== undefined);
    expect(withHeader.map((row) => row.id)).toEqual(['c0']);
    expect(withHeader[0]?.subagent?.header.id).toBe(CHILD);
  });
});

/* --------------------------- Test 6 — depth 2 takes the identical path ----- */

describe('a sub-agent inside a sub-agent nests with no depth-specific branch (Test 6, AC2)', () => {
  // MEASURED: 17 events inside sidecars carry a `child_session_id`, and 17
  // sessions sit at `spawn_depth = 2`. This is a real shape, not a hypothetical.
  const PARENT_SHAPE: TurnTreeSpec[] = [
    { id: 't0', seq: 0, events: [{ name: 'before' }, makeAgentEvent({ child_session_id: CHILD })] },
  ];
  const CHILD_SHAPE: TurnTreeSpec[] = [
    { id: 'c0', seq: 0, events: [makeAgentEvent({ child_session_id: GRANDCHILD })] },
  ];
  const GRAND_SHAPE: TurnTreeSpec[] = [{ id: 'g0', seq: 0, events: [{ name: 'deep' }] }];

  const children = [
    { id: CHILD, specs: CHILD_SHAPE },
    { id: GRANDCHILD, specs: GRAND_SHAPE },
  ];
  const model = modelOf(PARENT_SHAPE);
  const state = loadedState(...children);
  const rows = splicedRows(model, state, children, ['c0-ev-0']);

  it('reaches the grandchild through the SAME childIdsToFetch call, at depth 2', () => {
    // The recursion has no second code path: the nested Agent row is an event row
    // in the one row list, so the same function that found `child-0` finds
    // `grand-0`. MEASURED: 17 events inside sidecars name a child session.
    const onlyChild = loadedState({ id: CHILD, specs: CHILD_SHAPE });
    const before = splicedRows(model, onlyChild, [{ id: CHILD, specs: CHILD_SHAPE }], ['c0-ev-0']);
    const openIds = new Set(before.map((row) => row.id));
    expect(childIdsToFetch(before, openIds, onlyChild)).toEqual([GRANDCHILD]);
  });

  it('reports ABSOLUTE depths at all three levels, never the child’s local ones', () => {
    /*
     * The silent failure this guards: if the offset is dropped when the walk
     * descends from a spliced turn into that turn's own events, every grandchild
     * row still renders — at the wrong indent, with correct `aria-level`
     * arithmetic computed on the wrong base.
     */
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ['t0', 0],
      ['t0-ev-0', 1],
      ['t0-ev-1', 1],
      ['c0', 2],
      ['c0-ev-0', 3],
      ['g0', 4],
      ['g0-ev-0', 5],
    ]);
  });

  it('stamps each level with its own session', () => {
    const stamps = new Map(rows.map((row) => [row.id, row.sessionId]));
    expect(stamps.get('t0-ev-1')).toBe(PARENT);
    expect(stamps.get('c0-ev-0')).toBe(CHILD);
    expect(stamps.get('g0-ev-0')).toBe(GRANDCHILD);
  });
});

/* ------------- Test 7 — a fold and a splice under the same Agent event ----- */

describe('a folded turn and a spliced child are ONE sibling set (Test 7, AC1, AC2)', () => {
  /*
   * ★ THE OVERLAP IS TOTAL, NOT RARE. MEASURED: all 20 folded
   * `task_notification` turns in the archive hang under events that ALSO name a
   * `child_session_id` — 20 of 20. So two separate pushes would emit two lying
   * `setSize` values on EVERY real fold, and a screen reader would announce
   * "1 of 1" twice for a set of two.
   */
  const PARENT_SHAPE: TurnTreeSpec[] = [
    {
      id: 't0',
      seq: 0,
      events: [makeAgentEvent()],
      folded: [{ id: 'f0', seq: 1, events: [{ name: 'q' }] }],
    },
  ];
  const CHILD_SHAPE: TurnTreeSpec[] = [{ id: 'c0', seq: 0, events: [{ name: 'x' }] }];
  const children = [{ id: CHILD, specs: CHILD_SHAPE }];
  const rows = splicedRows(modelOf(PARENT_SHAPE), loadedState(...children), children);
  const turns = rows.filter((row) => row.kind === 'turn' && row.id !== 't0');

  it('reports one total setSize across both halves, and consecutive places in it', () => {
    expect(turns.map((row) => [row.id, row.posInSet, row.setSize])).toEqual([
      ['f0', 1, 2],
      ['c0', 2, 2],
    ]);
  });

  it('gives the folded turn the CURRENT entry’s offset and the child root row.depth + 1', () => {
    // Hard-coding 0 for the folded half is the depth-2 bug wearing a different
    // hat: it would re-base a fold sitting inside an already-spliced sidecar.
    expect(turns.map((row) => [row.id, row.depth])).toEqual([
      ['f0', 2],
      ['c0', 2],
    ]);
  });

  it('keeps each half stamped with the session it came from', () => {
    const stamps = new Map(turns.map((row) => [row.id, row.sessionId]));
    expect(stamps.get('f0')).toBe(PARENT);
    expect(stamps.get('c0')).toBe(CHILD);
  });
});

/* ------------------------- Tests 4 and 5 — what gets fetched, and when ----- */

describe('childIdsToFetch asks once, in a stable order (Tests 4 and 5, AC1, AC-R1b)', () => {
  const SHAPE: TurnTreeSpec[] = [
    {
      id: 't0',
      seq: 0,
      events: [
        { name: 'plain' },
        makeAgentEvent({ child_session_id: 'child-a' }),
        makeAgentEvent({ child_session_id: 'child-b' }),
      ],
    },
  ];
  const model = modelOf(SHAPE);
  const allOpen = model.rowIds;
  const rows = flatten(model, allOpen, undefined, { rootSessionId: PARENT });

  it('names exactly the open Agent rows, and nothing else on the page', () => {
    expect(childIdsToFetch(rows, allOpen, initialSubagentState)).toEqual(['child-a', 'child-b']);
  });

  it('returns the same join key twice over the same rows, so the effect key is stable', () => {
    /*
     * The page joins this list into ONE string and keys its fetch effect on it.
     * An order that varied between renders would churn the key and re-issue
     * requests already in flight, which AC-R1(b) counts as a failure.
     */
    const first = childIdsToFetch(rows, allOpen, initialSubagentState).join(',');
    const second = childIdsToFetch(rows, allOpen, initialSubagentState).join(',');
    expect(first).toBe(second);
    expect(first).toBe('child-a,child-b');
  });

  it('asks for nothing it has already requested', () => {
    const requested = subagentReducer(initialSubagentState, {
      type: 'requested',
      childId: 'child-a',
    });
    expect(childIdsToFetch(rows, allOpen, requested)).toEqual(['child-b']);
  });

  it('asks for nothing once every child is in flight', () => {
    const both = ['child-a', 'child-b'].reduce<SubagentState>(
      (state, childId) => subagentReducer(state, { type: 'requested', childId }),
      initialSubagentState,
    );
    expect(childIdsToFetch(rows, allOpen, both)).toEqual([]);
  });

  it('asks for nothing already loaded, and nothing that already failed', () => {
    const loaded = loadedState({ id: 'child-a', specs: [{ id: 'c0', seq: 0 }] });
    const failed = subagentReducer(loaded, { type: 'failed', childId: 'child-b' });
    expect(childIdsToFetch(rows, allOpen, failed)).toEqual([]);
    expect(failed.failed.has('child-b')).toBe(true);
  });

  it('asks for nothing when the Agent row is closed', () => {
    const closed = new Set(allOpen);
    closed.delete('t0-ev-1');
    closed.delete('t0-ev-2');
    const closedRows = flatten(model, closed, undefined, { rootSessionId: PARENT });
    expect(childIdsToFetch(closedRows, closed, initialSubagentState)).toEqual([]);
  });

  it('keeps a closed sub-agent’s model rather than re-fetching it', () => {
    // Ruled: a finished sidecar is immutable, so re-opening one buys a second
    // fetch of bytes that cannot have changed.
    const loaded = loadedState({ id: 'child-a', specs: [{ id: 'c0', seq: 0 }] });
    const closed = new Set(allOpen);
    closed.delete('t0-ev-1');
    const closedRows = flatten(model, closed, undefined, { rootSessionId: PARENT });

    expect(childIdsToFetch(closedRows, closed, loaded)).not.toContain('child-a');
    expect(subtreesOf(loaded).has('child-a')).toBe(true);
  });
});

/* -------------------- Tests 2, 11 and 12 — the ids the selection lives in -- */

describe('turnIdsToOpen names every turn in the loaded child (Test 2, AC1)', () => {
  it('names them all, and expandMany adds them without dropping the reader’s own', () => {
    const child = sidecar(CHILD, [
      { id: 'c0', seq: 0, events: [{ name: 'x' }] },
      { id: 'c1', seq: 1, events: [{ name: 'y' }] },
    ]);
    expect(turnIdsToOpen(child)).toEqual(['c0', 'c1']);

    const before = initialNavState(new Set(['mine']));
    const after = expandMany(before, turnIdsToOpen(child));
    expect([...after.expandedIds].sort()).toEqual(['c0', 'c1', 'mine']);
  });
});

describe('mergedRowIds keeps a child-row selection alive (Tests 11 and 12, AC1)', () => {
  const PARENT_SHAPE: TurnTreeSpec[] = [{ id: 't0', seq: 0, events: [makeAgentEvent()] }];
  const CHILD_SHAPE: TurnTreeSpec[] = [{ id: 'c0', seq: 0, events: [{ name: 'x' }] }];
  const model = modelOf(PARENT_SHAPE);
  const state = loadedState({ id: CHILD, specs: CHILD_SHAPE });
  const rows = splicedRows(model, state, [{ id: CHILD, specs: CHILD_SHAPE }]);

  it('survives a rows-changed pass with a spliced row selected', () => {
    /*
     * `onRowsChanged` resets a `selectedId` the model does not hold. The parent
     * model has never heard of `c0-ev-0`, so without the union the very next
     * render would clear a selection the reader had just made — the exact failure
     * the selection/focus split exists to prevent, arriving through the one path
     * it cannot see.
     */
    const selected = { ...initialNavState(), selectedId: 'c0-ev-0' };
    const next = navReducer(selected, rowsChangedAction(model, rows, state));
    expect(next.selectedId).toBe('c0-ev-0');
  });

  it('drops the same selection when the sub-agent state has no such child', () => {
    const selected = { ...initialNavState(), selectedId: 'c0-ev-0' };
    const next = navReducer(selected, rowsChangedAction(model, rows, initialSubagentState));
    expect(next.selectedId).toBeUndefined();
  });

  it('drops a previous session’s child ids once the state is reset', () => {
    const other = modelOf([{ id: 'z0', seq: 0, events: [{ name: 'other' }] }]);
    const cleared = subagentReducer(state, { type: 'reset' });

    expect([...mergedRowIds(other, cleared)].sort()).toEqual(['z0', 'z0-ev-0']);
    const stale = { ...initialNavState(), selectedId: 'c0-ev-0' };
    const next = navReducer(stale, rowsChangedAction(other, flatten(other, other.rowIds), cleared));
    expect(next.selectedId).toBeUndefined();
  });

  it('returns the model’s own set unchanged when nothing is loaded', () => {
    expect(mergedRowIds(model, initialSubagentState)).toBe(model.rowIds);
  });
});

/* -------------------------------------------- the status vocabulary -------- */

describe('agentStatusOf is total over the schema’s four words', () => {
  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    // MEASURED: 0 rows in the archive carry `killed`. It is NOT unwritten —
    // `src/project/tools.ts:203` assigns the notification's status verbatim and
    // the parser is proven to return it. Reachable-but-unobserved is not dead,
    // and dropping the arm would make this map partial against the schema.
    ['killed', 'killed'],
    ['running', 'running'],
    [null, 'unknown'],
    ['something-new', 'unknown'],
  ])('narrows %s to %s', (wire, expected) => {
    expect(agentStatusOf(wire)).toBe(expected);
  });
});
