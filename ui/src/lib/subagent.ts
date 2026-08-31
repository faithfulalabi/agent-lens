/*
 * Sub-agent expansion (Task 5.5), as a pure reducer over the row index space.
 *
 * ===========================================================================
 * A SIDECAR IS A `sessions` ROW, SO THERE IS NO NEW ENTITY HERE.
 * ===========================================================================
 * Expanding an Agent `tool_call` calls `GET /api/sessions/:id` with that event's
 * `child_session_id` — the same route the screen already loaded itself from, no
 * new handler and no new endpoint. What this module owns is everything AROUND
 * that request: which child ids the current expansion demands, what a loaded
 * child contributes to the one `Row[]`, and which turn ids have to open so the
 * child draws its events rather than only its header.
 *
 * ===========================================================================
 * IT IS PURE BECAUSE THE FETCH IS UNOBSERVABLE.
 * ===========================================================================
 * `ui/vitest.config.ts` runs `environment: 'node'`, where an effect never fires.
 * A decision expressed inside `pages/SessionView.tsx` is therefore untested by
 * construction, so every decision is here and what is left there is wiring —
 * the same split `session-data.ts` and `tree-nav.ts` already make.
 *
 * ===========================================================================
 * NO `hasMore` IS CARRIED, AND THAT IS MEASURED RATHER THAN ASSUMED.
 * ===========================================================================
 * The largest sidecar in the archive holds 368 events against the route's 10,000
 * clamp, and the p99 is 213 — so no child can be capped today. A flag nothing
 * renders and no test asserts is the same debt as a notice nobody reads, so the
 * measurement is stated here and nothing is stored.
 *
 * ===========================================================================
 * A CLOSED SUB-AGENT KEEPS ITS MODEL.
 * ===========================================================================
 * Re-opening one then costs no request. A finished sidecar is immutable, so
 * discarding it would buy a second fetch of bytes that cannot have changed.
 */

import type { SessionDetailHeaderRow } from './api.js';
import type { SessionData } from './session-data.js';
import { buildTurnGroups, type Row, type Subtree, type TreeModel } from './turn-tree.js';

/**
 * `events.agent_status`, plus `unknown` for the 39 of 260 child-bearing events
 * that carry none.
 *
 * `killed` has ZERO rows in the archive and it stays in the union anyway: its
 * writer is live at `src/project/tools.ts:203`, which assigns the notification's
 * status verbatim, and the parser is proven to return it. Reachable-but-unobserved
 * is not the same as dead, and dropping the arm would make this map partial
 * against the schema.
 */
export type AgentStatus = 'completed' | 'failed' | 'killed' | 'running' | 'unknown';

const AGENT_STATUSES: readonly AgentStatus[] = [
  'completed',
  'failed',
  'killed',
  'running',
  'unknown',
];

/** The wire's `agent_status`, narrowed. Null and anything off the list are `unknown`. */
export function agentStatusOf(status: string | null): AgentStatus {
  return AGENT_STATUSES.find((known) => known === status) ?? 'unknown';
}

/**
 * One sidecar, fetched and built.
 *
 * No turn-id list beside the model: `model.rowIds` already names every turn, and
 * `turnIdsToOpen` reads the response the page has in hand at the moment it has
 * to open them. A third copy of the same ids would be state nobody reads, which
 * is the debt this module refuses everywhere else.
 */
export interface LoadedChild {
  readonly header: SessionDetailHeaderRow;
  readonly model: TreeModel;
}

export interface SubagentState {
  readonly loaded: ReadonlyMap<string, LoadedChild>;
  readonly pending: ReadonlySet<string>;
  /**
   * Ids whose fetch failed. A `Set`, not a map to a message: no component
   * renders a reason, and a failure leaves the Agent row standing rather than
   * reddening the screen — 5.3's rule, kept.
   */
  readonly failed: ReadonlySet<string>;
}

export type SubagentAction =
  | { type: 'requested'; childId: string }
  | { type: 'loaded'; childId: string; child: SessionData }
  | { type: 'failed'; childId: string }
  /** A different session is on screen; nothing loaded for the old one applies. */
  | { type: 'reset' };

export const initialSubagentState: SubagentState = {
  loaded: new Map(),
  pending: new Set(),
  failed: new Set(),
};

function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (ids.has(id)) return ids;
  const next = new Set(ids);
  next.add(id);
  return next;
}

function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!ids.has(id)) return ids;
  const next = new Set(ids);
  next.delete(id);
  return next;
}

export function subagentReducer(state: SubagentState, action: SubagentAction): SubagentState {
  switch (action.type) {
    case 'requested':
      return { ...state, pending: withId(state.pending, action.childId) };
    case 'loaded': {
      const { child } = action;
      const loaded = new Map(state.loaded);
      loaded.set(action.childId, {
        header: child.session,
        model: buildTurnGroups(child.turns, child.eventsByTurn),
      });
      return {
        loaded,
        pending: withoutId(state.pending, action.childId),
        failed: withoutId(state.failed, action.childId),
      };
    }
    case 'failed':
      return {
        ...state,
        pending: withoutId(state.pending, action.childId),
        failed: withId(state.failed, action.childId),
      };
    case 'reset':
      return initialSubagentState;
  }
}

/**
 * The child ids this expansion demands and does not already have, in stable
 * `rows` order.
 *
 * ★ THE ORDER IS LOAD-BEARING. The page joins this list into ONE string and
 * keys its fetch effect on it, so an unstable order would churn the key and
 * re-issue requests that are already in flight. Row order is the tree's own
 * order, which changes only when the tree does.
 *
 * `expandedIds` rather than `row.expanded`: the set is the authority and the
 * rows are derived from it, so reading the set cannot lag a stale row list.
 */
export function childIdsToFetch(
  rows: readonly Row[],
  expandedIds: ReadonlySet<string>,
  state: SubagentState,
): string[] {
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind !== 'event') continue;
    const childId = row.node.event.child_session_id;
    if (childId === null || !expandedIds.has(row.id)) continue;
    if (seen.has(childId)) continue;
    seen.add(childId);
    if (state.loaded.has(childId) || state.pending.has(childId) || state.failed.has(childId)) {
      continue;
    }
    wanted.push(childId);
  }
  return wanted;
}

/**
 * Every id that CAN be a row, the parent's and every loaded child's alike.
 *
 * `rows-changed` resets a `selectedId` the new model does not hold. Without the
 * children in this union, selecting a spliced row and then re-rendering would
 * clear the selection immediately — the exact failure `onRowsChanged` exists to
 * prevent, arriving through the one path it cannot see.
 */
export function mergedRowIds(model: TreeModel, state: SubagentState): ReadonlySet<string> {
  if (state.loaded.size === 0) return model.rowIds;
  const ids = new Set(model.rowIds);
  for (const child of state.loaded.values()) for (const id of child.model.rowIds) ids.add(id);
  return ids;
}

/** The loaded children, in the shape `flatten` splices from. */
export function subtreesOf(state: SubagentState): ReadonlyMap<string, Subtree> {
  const subtrees = new Map<string, Subtree>();
  for (const [sessionId, child] of state.loaded) {
    subtrees.set(sessionId, { sessionId, model: child.model, header: child.header });
  }
  return subtrees;
}

/**
 * Every turn id in a freshly loaded child, so its events draw and not just its
 * header. See {@link import('./tree-nav.js').expandMany} for why this is needed
 * at all.
 */
export function turnIdsToOpen(child: SessionData): string[] {
  return child.turns.map((turn) => turn.id);
}
