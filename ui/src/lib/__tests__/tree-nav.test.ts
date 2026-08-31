import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { buildTurnGroups, flatten, type Row, type TreeModel } from '../turn-tree';
import { expandMany, initialNavState, navReducer, type NavState } from '../tree-nav';
import { makeTurnRow, makeTurnTree, type TurnTreeSpec } from './fixtures';

/*
 * Tests 6 and 7 of Task 5.3a — the keyboard matrix, and the property that
 * makes AC2 true rather than merely asserted.
 *
 * ★ THE REDUCER ITSELF IS UNTOUCHED BY TASK 5.2. Only its fixtures moved: the
 * span forest became a turn tree, so the shape below is now one turn owning two
 * events, with two `task_notification` turns folded under the second of them.
 * It flattens to the same nine rows at the same five depths the span fixture
 * did, which is the point — the reducer indexes rows and knows nothing else.
 *
 * `fast-check` resolves from the root devDependencies by node walk-up; the
 * same import already works in route-match.test.ts.
 */

const SHAPE: TurnTreeSpec[] = [
  {
    id: 'seed-s0:1',
    seq: 1,
    events: [{ name: 'a' }, { name: 'b' }],
    folded: [
      { id: 'f1', seq: 2, events: [{ name: 'c' }, { name: 'd' }] },
      { id: 'f2', seq: 3, events: [{ name: 'e' }, { name: 'f' }] },
    ],
  },
];

function modelOf(specs: TurnTreeSpec[] = SHAPE): TreeModel {
  const tree = makeTurnTree(specs);
  return buildTurnGroups(tree.turns, tree.eventsByTurn);
}

const MODEL = modelOf();

/** Every row list in this file is derived from state, never held beside it. */
function rowsFor(state: NavState, model: TreeModel = MODEL): Row[] {
  return flatten(model, state.expandedIds);
}

function press(state: NavState, key: string, model: TreeModel = MODEL): NavState {
  return navReducer(state, { type: 'key', key, rows: rowsFor(state, model) });
}

function pressAll(state: NavState, keys: string[], model: TreeModel = MODEL): NavState {
  return keys.reduce((current, key) => press(current, key, model), state);
}

function focusedId(state: NavState, model: TreeModel = MODEL): string | undefined {
  return rowsFor(state, model)[state.focusedIndex]?.id;
}

/** Everything open, which is the row list most of the matrix walks. */
function openState(model: TreeModel = MODEL): NavState {
  return initialNavState(model.rowIds);
}

/* --------------------------------------------------------------- Test 6 --- */

describe('the keyboard matrix moves focus over the flattened rows', () => {
  const ROWS = [
    'seed-s0:1',
    'seed-s0:1-ev-0',
    'seed-s0:1-ev-1',
    'f1',
    'f1-ev-0',
    'f1-ev-1',
    'f2',
    'f2-ev-0',
    'f2-ev-1',
  ];

  it('flattens the fixture to the row list the rest of this file assumes', () => {
    expect(rowsFor(openState()).map((row) => row.id)).toEqual(ROWS);
  });

  it('nests the two folded turns under the event that spawned them', () => {
    // Not decoration: the reducer's parent walk is "the nearest row above at a
    // shallower depth", so a flat fixture would make Escape and ArrowLeft pass
    // for the wrong reason.
    const depths = new Map(rowsFor(openState()).map((row) => [row.id, row.depth]));
    expect([...depths.values()]).toEqual([0, 1, 1, 2, 3, 3, 2, 3, 3]);
  });

  it('starts with focus at the top and nothing selected', () => {
    const state = openState();
    expect(state.focusedIndex).toBe(0);
    expect(state.selectedId).toBeUndefined();
  });

  it.each([
    ['j', 1],
    ['ArrowDown', 1],
  ])('%s moves down one row', (key, expected) => {
    expect(press(openState(), key).focusedIndex).toBe(expected);
  });

  it.each([
    ['k', 2],
    ['ArrowUp', 2],
  ])('%s moves up one row', (key, expected) => {
    const at3 = pressAll(openState(), ['j', 'j', 'j']);
    expect(press(at3, key).focusedIndex).toBe(expected);
  });

  it('stops at the top rather than running off it', () => {
    expect(pressAll(openState(), ['k', 'k', 'k']).focusedIndex).toBe(0);
  });

  it('stops at the bottom rather than running off it', () => {
    const keys = Array.from({ length: ROWS.length + 5 }, () => 'j');
    expect(pressAll(openState(), keys).focusedIndex).toBe(ROWS.length - 1);
  });

  it('jumps to the first and last row with Home and End', () => {
    const atEnd = press(openState(), 'End');
    expect(focusedId(atEnd)).toBe('f2-ev-1');
    expect(focusedId(press(atEnd, 'Home'))).toBe('seed-s0:1');
  });

  it('opens a closed row with ArrowRight, then steps onto its first child', () => {
    // Nothing open: the turn is the only row there is.
    const shut = initialNavState();
    expect(rowsFor(shut)).toHaveLength(1);

    const opened = press(shut, 'ArrowRight');
    expect(opened.expandedIds.has('seed-s0:1')).toBe(true);
    expect(opened.focusedIndex, 'opening a row must not also move focus').toBe(0);

    const descended = press(opened, 'ArrowRight');
    expect(focusedId(descended)).toBe('seed-s0:1-ev-0');
  });

  it('does nothing on ArrowRight at a leaf', () => {
    const atLeaf = pressAll(openState(), ['j', 'j', 'j', 'j']);
    expect(focusedId(atLeaf)).toBe('f1-ev-0');
    expect(press(atLeaf, 'ArrowRight')).toBe(atLeaf);
  });

  it('closes an open row with ArrowLeft, then ascends from the closed one', () => {
    const atF1 = pressAll(openState(), ['j', 'j', 'j']);
    expect(focusedId(atF1)).toBe('f1');

    const closed = press(atF1, 'ArrowLeft');
    expect(closed.expandedIds.has('f1')).toBe(false);
    expect(focusedId(closed), 'closing a row must leave focus on it').toBe('f1');
    expect(rowsFor(closed).map((row) => row.id)).toEqual([
      'seed-s0:1',
      'seed-s0:1-ev-0',
      'seed-s0:1-ev-1',
      'f1',
      'f2',
      'f2-ev-0',
      'f2-ev-1',
    ]);

    expect(focusedId(press(closed, 'ArrowLeft'))).toBe('seed-s0:1-ev-1');
  });

  it('sets the selection from focus on Enter, never from anywhere else', () => {
    const atLeaf = pressAll(openState(), ['j', 'j', 'j', 'j']);
    const selected = press(atLeaf, 'Enter');
    expect(selected.selectedId).toBe('f1-ev-0');
    expect(selected.focusedIndex).toBe(atLeaf.focusedIndex);
  });

  it('moves focus to the parent on Escape and leaves the selection alone', () => {
    const selected = pressAll(openState(), ['j', 'j', 'j', 'j', 'Enter']);
    const up = press(selected, 'Escape');
    expect(focusedId(up)).toBe('f1');
    expect(up.selectedId, 'Escape must not close Task 5.3 s detail pane').toBe('f1-ev-0');

    // …and keeps walking up, one level per press.
    expect(focusedId(press(up, 'Escape'))).toBe('seed-s0:1-ev-1');
    expect(focusedId(pressAll(up, ['Escape', 'Escape']))).toBe('seed-s0:1');
  });

  it('ignores a key it does not handle', () => {
    const state = pressAll(openState(), ['j', 'Enter']);
    expect(press(state, 'q')).toBe(state);
  });

  it('survives an empty row list', () => {
    const empty = buildTurnGroups([], new Map());
    const state = initialNavState();
    for (const key of ['j', 'k', 'Home', 'End', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight']) {
      expect(press(state, key, empty)).toEqual(state);
    }
  });
});

/* --------------------------------------------------------------- Test 7 --- */

describe('selection and focus are independent, and both stay legal', () => {
  it('keeps the selection on a row a collapse closed away, and restores it', () => {
    const before = rowsFor(openState()).map((row) => row.id);

    // Select a deep descendant, then walk up and close its ancestor.
    const selected = pressAll(openState(), ['j', 'j', 'j', 'j', 'Enter']);
    expect(selected.selectedId).toBe('f1-ev-0');

    const closed = pressAll(selected, ['Escape', 'ArrowLeft']);
    expect(closed.selectedId, 'a collapse must never clear the selection').toBe('f1-ev-0');
    expect(rowsFor(closed).map((row) => row.id)).not.toContain('f1-ev-0');
    expect(focusedId(closed), 'focus belongs on the nearest ancestor still on screen').toBe('f1');

    const reopened = press(closed, 'ArrowRight');
    expect(rowsFor(reopened).map((row) => row.id)).toEqual(before);
    expect(reopened.selectedId, 'the round trip must restore the selection too').toBe('f1-ev-0');
  });

  it('leaves focus alone when the model only grows', () => {
    // Task 6.2's live append: new events arrive below, the reader stays put.
    const state = pressAll(openState(), ['j', 'j', 'Enter']);
    const grown = modelOf([...SHAPE, { id: 'later', seq: 4, events: [{ name: 'g' }] }]);
    const next = navReducer(state, {
      type: 'rows-changed',
      rows: flatten(grown, state.expandedIds),
      modelIds: grown.rowIds,
    });
    expect(next.focusedIndex).toBe(state.focusedIndex);
    expect(next.selectedId).toBe('seed-s0:1-ev-1');
  });

  it('pulls focus back into range when the model shrinks', () => {
    const state = pressAll(openState(), ['End']);
    const shrunk = modelOf([{ id: 'seed-s0:1', seq: 1, events: [{ name: 'a' }] }]);
    const next = navReducer(state, {
      type: 'rows-changed',
      rows: flatten(shrunk, state.expandedIds),
      modelIds: shrunk.rowIds,
    });
    expect(next.focusedIndex).toBe(1);
  });

  it('resets a selection the new model no longer holds', () => {
    const state = pressAll(openState(), ['j', 'j', 'j', 'j', 'Enter']);
    expect(state.selectedId).toBe('f1-ev-0');
    const swapped = modelOf([{ id: 'z', seq: 9, events: [{ name: 'z' }] }]);
    const next = navReducer(state, {
      type: 'rows-changed',
      rows: flatten(swapped, state.expandedIds),
      modelIds: swapped.rowIds,
    });
    // Mutation check, verified by hand: keeping the id here leaves a dangling
    // selection that Task 5.3 would open a detail pane for.
    expect(next.selectedId).toBeUndefined();
  });

  it('holds both invariants under random navigation, collapse and model swaps', () => {
    const KEYS = [
      'j',
      'k',
      'ArrowDown',
      'ArrowUp',
      'ArrowLeft',
      'ArrowRight',
      'Enter',
      'Escape',
      'Home',
      'End',
    ];
    const SWAPS: TurnTreeSpec[][] = [
      SHAPE,
      [...SHAPE, { id: 'later', seq: 4, events: [{ name: 'g' }] }],
      [
        {
          id: 'seed-s0:1',
          seq: 1,
          events: [{ name: 'a' }],
          folded: [{ id: 'f1', seq: 2, events: [{ name: 'c' }] }],
        },
      ],
      [{ id: 'z', seq: 9, events: [{ name: 'z' }] }],
    ];

    const step = fc.oneof(
      fc.constantFrom(...KEYS).map((key) => ({ kind: 'key', key }) as const),
      fc.nat({ max: SWAPS.length - 1 }).map((which) => ({ kind: 'swap', which }) as const),
    );

    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 60 }), (steps) => {
        let model = MODEL;
        let state = openState(model);

        for (const move of steps) {
          if (move.kind === 'key') {
            state = navReducer(state, {
              type: 'key',
              key: move.key,
              rows: flatten(model, state.expandedIds),
            });
          } else {
            model = modelOf(SWAPS[move.which] ?? SHAPE);
            state = navReducer(state, {
              type: 'rows-changed',
              rows: flatten(model, state.expandedIds),
              modelIds: model.rowIds,
            });
          }

          const rows = flatten(model, state.expandedIds);
          // (1) The focused row is one the reader can actually reach.
          expect(rows.length === 0 || rows[state.focusedIndex] !== undefined).toBe(true);
          // (2) selectedId is undefined, or names a node in the CURRENT model.
          expect(state.selectedId === undefined || model.rowIds.has(state.selectedId)).toBe(true);
        }
      }),
      // A pinned seed, so a failure is reproducible from the message alone.
      // (And not the other adjective for that: Tailwind scans comments, and
      // the obvious word for "unchanging" is also a layout utility.)
      { seed: 20260730, numRuns: 300 },
    );
  });

  it('never re-anchors the selection onto a nearby row', () => {
    // The mutation this rules out is subtle: re-anchoring on collapse looks
    // right on screen and quietly breaks the round trip above, because the
    // selection that comes back is not the one that went away.
    const selected = pressAll(openState(), ['j', 'j', 'j', 'j', 'Enter']);
    const closedTurn = pressAll(selected, ['Home', 'ArrowLeft']);
    expect(rowsFor(closedTurn)).toHaveLength(1);
    expect(closedTurn.selectedId).toBe('f1-ev-0');
  });

  it('selects a turn row itself, before any event beneath it is opened', () => {
    const turn = makeTurnRow({ id: 'seed-s0:1' });
    const tree = makeTurnTree([{ id: turn.id, seq: turn.seq, events: [{ name: 'a' }] }]);
    const model = buildTurnGroups(tree.turns, tree.eventsByTurn);
    const state = press(initialNavState(), 'Enter', model);
    expect(state.selectedId).toBe(turn.id);
    expect(model.rowIds.has(turn.id)).toBe(true);
  });
});

/* ------------------------- Task 5.5 — the load-event transformer ---------- */

describe('expandMany opens what a load event brings, and only that (Test 2, AC1)', () => {
  /*
   * A TRANSFORMER, not a third `NavAction`. `NavAction` is a closed two-arm
   * union and `navReducer` has no default arm, so a third variant would need a
   * reducer arm nobody wants — and this is not a keystroke. It is what happens
   * when a sub-agent's transcript arrives: `flatten` puts a turn's events on
   * screen only when its id is in this set, and a freshly fetched child's ids
   * cannot be in one seeded from the parent's turns.
   */
  it('adds the new ids and keeps every id the reader had already opened', () => {
    const state = expandMany(initialNavState(new Set(['t0', 't1'])), ['c0', 'c1']);
    expect([...state.expandedIds].sort()).toEqual(['c0', 'c1', 't0', 't1']);
  });

  it('touches neither the selection nor the focused index', () => {
    const before = { ...initialNavState(new Set(['t0'])), selectedId: 't0', focusedIndex: 3 };
    const after = expandMany(before, ['c0']);
    expect(after.selectedId).toBe('t0');
    expect(after.focusedIndex).toBe(3);
  });

  it('returns the SAME state when it would add nothing, so no render is caused', () => {
    const state = initialNavState(new Set(['t0']));
    expect(expandMany(state, [])).toBe(state);
    expect(expandMany(state, ['t0'])).toBe(state);
  });
});
