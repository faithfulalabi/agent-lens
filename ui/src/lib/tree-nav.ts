/*
 * Keyboard navigation over the span tree (Task 5.3a). A pure reducer, so the
 * whole of AC2 is assertable with no document, no events and no rendering.
 *
 * ===========================================================================
 * SELECTION AND FOCUS ARE TWO DIFFERENT THINGS. THAT IS THE WHOLE DESIGN.
 * ===========================================================================
 * "Selection state survives collapse/expand" is only true if selection is not
 * an index. So:
 *
 *   - `focusedIndex` is an index into the CURRENT `Row[]`, which makes the
 *     focused row on-screen by construction. A collapse moves it; nothing else
 *     needs to.
 *   - `selectedId` is an id, and it PERSISTS on a row a collapse has closed
 *     away. It is never cleared by a collapse and never re-anchored to some
 *     nearby row, which is exactly what makes collapse-then-expand restore the
 *     prior view AND the prior selection.
 *   - `Enter` therefore acts on FOCUS, not on selection: it sets `selectedId`
 *     from the row the user can actually see. There is no path on which it
 *     opens Task 5.4's detail pane for a row that is not on screen.
 *   - `Escape` moves focus to the parent and leaves `selectedId` alone.
 *     Clearing it would shut the detail pane on every upward move, which is
 *     not what "go to parent" means.
 *
 * This is the ARIA treeview model — roving tabindex on focus, `aria-selected`
 * on selection — which Task 5.3b's `role="tree"` commits to anyway.
 *
 * ===========================================================================
 * `selectedId` IS ALLOWED TO GO STALE. THE INVARIANT ADMITS IT.
 * ===========================================================================
 * It is `undefined` at mount — nothing is selected until the user acts — so
 * "always names a node" would be false on the very first render. And two
 * designed paths swap the model underneath a persisted selection: Task 5.3b's
 * client row cap and the live append published to Task 6.2. The real invariant
 * is **`selectedId` is `undefined`, or names a node in the CURRENT model**,
 * and `rows-changed` is what restores it: a swap that drops the selected node
 * resets the field rather than leaving a dangling id behind.
 */

import type { Row } from './turn-tree.js';

export interface NavState {
  /** `undefined` at mount, and after a model swap that dropped the selection. */
  readonly selectedId: string | undefined;
  readonly expandedIds: ReadonlySet<string>;
  /** An index into the row list the caller most recently flattened. */
  readonly focusedIndex: number;
}

/**
 * Every action carries the rows it applies to, because the rows are derived
 * from `expandedIds` — the caller has them in hand already, and holding a copy
 * in reducer state would mean two sources of truth for one list.
 */
export type NavAction =
  | { type: 'key'; key: string; rows: readonly Row[] }
  | {
      type: 'rows-changed';
      rows: readonly Row[];
      /**
       * `TreeModel.rowIds` for the NEW model — every id that could be a row,
       * not just the ones currently on screen. Passing only the on-screen ids
       * would clear the selection on every collapse, which is the one thing
       * this design exists to prevent.
       */
      modelIds: ReadonlySet<string>;
    };

/** Nothing selected; focus at the top. Expansion is the caller's to seed. */
export function initialNavState(expandedIds: ReadonlySet<string> = new Set()): NavState {
  return { selectedId: undefined, expandedIds, focusedIndex: 0 };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.add(id);
  return next;
}

function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.delete(id);
  return next;
}

/** The nearest row above `index` that sits one level shallower or more. */
function indexOfParent(rows: readonly Row[], index: number): number {
  const from = rows[index];
  if (from === undefined) return index;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = rows[i];
    if (candidate !== undefined && candidate.depth < from.depth) return i;
  }
  return index;
}

function focusAt(state: NavState, index: number, rows: readonly Row[]): NavState {
  const focusedIndex = clampIndex(index, rows.length);
  return focusedIndex === state.focusedIndex ? state : { ...state, focusedIndex };
}

/**
 * `rows-changed` — the one action no keystroke produces.
 *
 * Its contract, which Task 6.2's live append turns on: an append must NOT move
 * focus (a clamp is a no-op when the list only grows); a shrink pulls
 * `focusedIndex` back into range; and a model that no longer holds the
 * selected node resets `selectedId` instead of keeping a dangling one.
 */
function onRowsChanged(
  state: NavState,
  rows: readonly Row[],
  modelIds: ReadonlySet<string>,
): NavState {
  const focusedIndex = clampIndex(state.focusedIndex, rows.length);
  const selectedId =
    state.selectedId !== undefined && modelIds.has(state.selectedId) ? state.selectedId : undefined;
  if (focusedIndex === state.focusedIndex && selectedId === state.selectedId) return state;
  return { ...state, focusedIndex, selectedId };
}

function onKey(state: NavState, key: string, rows: readonly Row[]): NavState {
  const index = clampIndex(state.focusedIndex, rows.length);
  const row = rows[index];

  switch (key) {
    case 'j':
    case 'ArrowDown':
      return focusAt(state, index + 1, rows);
    case 'k':
    case 'ArrowUp':
      return focusAt(state, index - 1, rows);
    case 'Home':
      return focusAt(state, 0, rows);
    case 'End':
      return focusAt(state, rows.length - 1, rows);
    case 'Enter':
      if (row === undefined || row.id === state.selectedId) return focusAt(state, index, rows);
      return { ...state, focusedIndex: index, selectedId: row.id };
    case 'Escape':
      return focusAt(state, indexOfParent(rows, index), rows);
    case 'ArrowRight':
      if (row === undefined || !row.hasChildren) return focusAt(state, index, rows);
      // Closed: open it, and stay put. Open: step onto the first child, which
      // pre-order guarantees is the very next row.
      if (!row.expanded) {
        return { ...state, focusedIndex: index, expandedIds: withId(state.expandedIds, row.id) };
      }
      return focusAt(state, index + 1, rows);
    case 'ArrowLeft':
      // Open: close it. Focus stays on the row that just closed, which is by
      // definition the nearest still-on-screen ancestor of everything it took
      // away — including a `selectedId` sitting somewhere beneath it.
      if (row !== undefined && row.hasChildren && row.expanded) {
        return { ...state, focusedIndex: index, expandedIds: withoutId(state.expandedIds, row.id) };
      }
      return focusAt(state, indexOfParent(rows, index), rows);
    default:
      return focusAt(state, index, rows);
  }
}

export function navReducer(state: NavState, action: NavAction): NavState {
  if (action.type === 'rows-changed') return onRowsChanged(state, action.rows, action.modelIds);
  return onKey(state, action.key, action.rows);
}
