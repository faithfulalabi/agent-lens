/*
 * The live splice, follow mode, and the one-frame bus (Task 6.2).
 *
 * ===========================================================================
 * EVERY DECISION IS A PLAIN FUNCTION HERE, AND THAT IS NOT A PREFERENCE.
 * ===========================================================================
 * The `ui` vitest project runs under `environment: 'node'`, where an effect
 * never fires and a scroll event can never be delivered. So "did the epoch move
 * backwards", "what does the splice produce", "is the reader still following"
 * and "what does the pill say" all live in this module, where a unit test can
 * drive them directly. `SessionView`, `Sessions` and `SpanTree` carry the
 * wiring, and their wiring is pinned against their own source text.
 *
 * No React import, no DOM, no `ApiClient`. The missing client argument is what
 * makes the session list's "zero additional requests" a property of a signature
 * rather than of a spy: `patchListRow` has nothing to fetch WITH.
 */

import type { SessionChangedFrame, SessionIndexedFrame, SessionRollups } from '@shared/api.ts';

import type { EventRow, SessionDetailBody } from './api.js';
import { bucketByTurn, type SessionData } from './session-data.js';
import type { SessionListData } from './session-list.js';

/* ------------------------------------------------------- the fingerprint --- */

/** The three numbers `src/db/freshness.ts:119-121` folds into one epoch string. */
export interface FoldParts {
  mtime_ms: number;
  size: number;
  sidecar_count: number;
}

/** `'<mtime_ms>:<size>:<sidecar_count>'`, or `undefined` when it is not that. */
export function parseFingerprint(fingerprint: string): FoldParts | undefined {
  const parts = fingerprint.split(':');
  if (parts.length !== 3) return undefined;
  const [mtime_ms, size, sidecar_count] = parts.map((part) =>
    part === '' ? Number.NaN : Number(part),
  );
  if (mtime_ms === undefined || size === undefined || sidecar_count === undefined) return undefined;
  if (!Number.isFinite(mtime_ms) || !Number.isFinite(size) || !Number.isFinite(sidecar_count)) {
    return undefined;
  }
  return { mtime_ms, size, sidecar_count };
}

/**
 * Did the archive's epoch go BACKWARDS — i.e. must the page be fetched again?
 *
 * ===========================================================================
 * `sidecar_count` IS NEVER COMPARED, AND THAT IS A RULING RATHER THAN A GAP.
 * ===========================================================================
 * `foldArchive` sums `size` and maxes `mtime_ms` over the parent AND every
 * sibling (`src/db/freshness.ts:108-110`), so every event that lowers the count
 * also lowers the size: sealing rewrites `x.jsonl` as a smaller `x.jsonl.zst`
 * that `:110` stops counting, and a removed sidecar takes its bytes with it. A
 * count that only RISES is a new sidecar, whose bytes raise `size` too — which
 * is forward, so it splices. The one case two components miss is a zero-byte
 * sidecar going away, and that carried no event to be wrong about.
 *
 * An empty or unreadable epoch on either side answers `true`:
 * `src/server/api.ts:446-448` ships `''` when there was no fold to take an
 * epoch from, saying in as many words that a client should ask again rather
 * than trust a stale one.
 */
export function movedBackwards(previous: string, next: string): boolean {
  const before = parseFingerprint(previous);
  const after = parseFingerprint(next);
  if (before === undefined || after === undefined) return true;
  return after.mtime_ms < before.mtime_ms || after.size < before.size;
}

/* ------------------------------------------------------------ the splice --- */

/**
 * Drop the tail, take the served page, then apply the back-patch by id.
 *
 * No arithmetic and no cursor bookkeeping, because `readEventPage`'s SQL is
 * `seq >= ?` — INCLUSIVE (`src/db/read.ts:465-471`). So dropping every local
 * event at or after `from_seq` and concatenating what the server answered is
 * exact by construction: no gap, no duplicate.
 *
 * `patched` is applied LAST and BY ID because those rows sit turns BEFORE
 * `from_seq` — the async-Agent back-patch is the whole reason the field exists
 * (`src/shared/api.ts:62-66`). Applying it by id also makes a replayed frame
 * a no-op rather than a double application.
 */
export function spliceEvents(
  local: readonly EventRow[],
  from_seq: number,
  page: readonly EventRow[],
  patched: readonly EventRow[],
): EventRow[] {
  const spliced = [...local.filter((event) => event.seq < from_seq), ...page];
  if (patched.length === 0) return spliced;
  const byId = new Map(patched.map((event) => [event.id, event]));
  return spliced.map((event) => byId.get(event.id) ?? event);
}

/**
 * One `session_changed` frame and its `?from_seq=` response, folded into the
 * page state.
 *
 * ONLY `events` is spliced. The `?from_seq=` response carries the WHOLE turn
 * list, the whole header and the epoch regardless of the cursor
 * (`src/server/api.ts:436-450`), so every other field is replaced wholesale —
 * which is what lets a live append open a NEW turn and still draw a header.
 *
 * The epoch comes from the RESPONSE, never from the frame: it is the epoch of
 * the bytes actually served, and it may already be newer than the one that
 * announced them.
 */
export function applyFrame(
  data: SessionData,
  frame: SessionChangedFrame<EventRow>,
  body: SessionDetailBody,
): SessionData {
  const events = spliceEvents(data.events, frame.from_seq, body.events, frame.patched);
  return {
    session: body.session,
    turns: body.turns,
    eventsByTurn: bucketByTurn(events),
    events,
    hasMore: body.has_more,
    shown: events.length,
    fingerprint: body.fingerprint,
  };
}

/** What one frame asks the session view to do. */
export type FrameDecision =
  { kind: 'ignore' } | { kind: 'refetch' } | { kind: 'splice'; from_seq: number };

/**
 * The whole of the session view's frame handler, as a value.
 *
 * Keyed on the session that ARRIVED (`data.session.id`) rather than on the id
 * prop, for the reason `needsReseed` gives: the two differ by one render after
 * a move between sessions, and splicing one session's page onto another's is
 * the defect that costs.
 */
export function decideFrame(
  data: SessionData | null,
  frame: SessionChangedFrame<EventRow>,
): FrameDecision {
  if (data === null || data.session.id !== frame.session_id) return { kind: 'ignore' };
  if (movedBackwards(data.fingerprint, frame.fingerprint)) return { kind: 'refetch' };
  return { kind: 'splice', from_seq: frame.from_seq };
}

/* -------------------------------------------------------- the list patch --- */

/**
 * How recently a session must have been active to draw as live.
 *
 * Mirrored from `src/server/api.ts:226-232`, which names this module back —
 * the same two-way citation `HEARTBEAT_MS` already carries between
 * `ui/src/lib/sse.ts:47-48` and `src/server/stream.ts:53`. `live` is stamped by
 * the server and is not a column, and `ui/` can reach `../src/shared/*` alone,
 * so a patched row would keep a stale badge without this copy — in a feature
 * whose headline case is a session going live.
 */
export const LIVE_WINDOW_MS = 60_000;

/** {@link LIVE_WINDOW_MS}'s predicate, mirrored with it. */
export function isLive(last_activity_at: string, now: number): boolean {
  const at = Date.parse(last_activity_at);
  return !Number.isNaN(at) && now - at < LIVE_WINDOW_MS;
}

/**
 * The frame's own-file rollups, spread onto the row they belong to.
 *
 * ★ AN ID THE PAGE NEVER LOADED CHANGES NOTHING — the SAME object comes back,
 * not a copy. Inserting a row would make `truncated`, `outsideRangeCount` and
 * the project narrowing describe a page the server never served.
 *
 * `sub_*`, `agent_count` and `rollup_state` are not on the frame and are not
 * touched here: they are written by the sub-agent sweep, which the live path
 * never runs (`src/shared/api.ts:36-43`).
 */
export function patchListRow(
  data: SessionListData,
  session_id: string,
  rollups: SessionRollups,
  now: number,
): SessionListData {
  if (!data.sessions.some((row) => row.id === session_id)) return data;
  return {
    ...data,
    sessions: data.sessions.map((row) =>
      row.id === session_id
        ? { ...row, ...rollups, live: isLive(rollups.last_activity_at, now) }
        : row,
    ),
  };
}

/* ----------------------------------------------------------- the overlay --- */

/** A spliced value held beside a `useAsync` slot, with both of its identities. */
export interface Overlay<T> {
  /** The load key it was spliced onto — a session id, or `range|project`. */
  readonly key: string;
  /** The `useAsync` value it was spliced FROM. Compared by reference. */
  readonly base: T;
  readonly data: T;
}

/**
 * The spliced value, or the loaded one — and BOTH identities decide it.
 *
 * ===========================================================================
 * NEITHER HALF IS OPTIONAL. A BARE `??` SHADOWS TWO DIFFERENT RELOADS.
 * ===========================================================================
 * The KEY closes the list page: `Sessions` loads on `range|project`, so an
 * overlay kept across a range change would pin the screen to the snapshot the
 * first frame landed on — for `volumeBuckets`, `projectsIn`, `emptyStateOf` and
 * the rows alike — while the control that was clicked reported a new range.
 *
 * The BASE closes the session page: the refetch-from-zero branch bumps a
 * refresh token with the key UNCHANGED (`use-async.ts:36-57`), so a key-only
 * guard still matches after the reload lands and the fresh page could never
 * reach the screen. `asyncReducer` mints a new value object per resolve
 * (`async-state.ts:56-64`), so comparing references answers exactly "is this
 * still the load I spliced onto?".
 *
 * A `null` load is a request in flight, NOT a new answer: keeping the overlay
 * across it is what stops the refetch branch blanking the tree, destroying the
 * scroll anchor, and reporting the resulting scroll as a reader who moved.
 */
export function overlayData<T>(overlay: Overlay<T> | null, key: string, fresh: T | null): T | null {
  if (overlay === null || overlay.key !== key) return fresh;
  return fresh === null || fresh === overlay.base ? overlay.data : fresh;
}

/* -------------------------------------------------------------- follow --- */

/** How close to the end still counts as the end, in pixels. */
export const FOLLOW_EPSILON_PX = 4;

/** What a scroller reports about itself. Read off the element, decided here. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Is the scroller at its end, to within {@link FOLLOW_EPSILON_PX}? */
export function atBottom({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): boolean {
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_EPSILON_PX;
}

export interface FollowState {
  readonly following: boolean;
  /** Events that arrived while paused. Always 0 while following. */
  readonly pending: number;
}

export type FollowAction =
  | { type: 'appended'; count: number }
  | { type: 'selected' }
  | { type: 'scrolled'; atBottom: boolean }
  | { type: 'resumed' }
  | { type: 'reset' };

/** Follow is ON when a session opens (`04-live-tail.md:14`). */
export const initialFollowState: FollowState = { following: true, pending: 0 };

/**
 * Follow mode, as one reducer over two fields.
 *
 * Reading beats following (`04-live-tail.md:18`), so selecting a row pauses.
 * Scrolling back to the end resumes with no action of its own, which is what
 * `04-live-tail.md:19`'s "or scrolls to bottom" asks for. A new turn arriving
 * while following just appends, because the tree is one flat row list.
 */
export function followReducer(state: FollowState, action: FollowAction): FollowState {
  switch (action.type) {
    case 'appended':
      return {
        following: state.following,
        pending: state.following ? 0 : state.pending + Math.max(0, action.count),
      };
    case 'selected':
      return { following: false, pending: state.pending };
    case 'scrolled':
      return action.atBottom
        ? { following: true, pending: 0 }
        : { following: false, pending: state.pending };
    case 'resumed':
      return { following: true, pending: 0 };
    case 'reset':
      return initialFollowState;
  }
}

/** What the pill says, or `null` when there is no pill to draw. */
export function pillLabel(state: FollowState): string | null {
  if (state.following || state.pending === 0) return null;
  return `${state.pending} new event${state.pending === 1 ? '' : 's'}`;
}

/* ----------------------------------------------------------------- bus --- */

/** One decoded frame, narrowed by name at the single decode boundary. */
export type LiveFrame =
  | { readonly event: 'session_changed'; readonly data: SessionChangedFrame<EventRow> }
  | { readonly event: 'session_indexed'; readonly data: SessionIndexedFrame };

/** The port both pages take, so either renders against a hand-built double. */
export interface LiveBus {
  /** Returns its own unsubscribe, the way `HistoryPort.onPopState` does. */
  subscribe(listener: (frame: LiveFrame) => void): () => void;
  publish(frame: LiveFrame): void;
}

/**
 * One app-wide stream, fanned out to whichever page is mounted.
 *
 * Task 6.1 ships ONE stream for the whole app and no subscriber concept, and
 * `Sessions` and `SessionView` are siblings — so the fan-out is here, as a
 * prop, matching the `api`/`router` ports both pages already take. There is no
 * React context anywhere in `ui/src` and this does not introduce the first one.
 */
export function createLiveBus(): LiveBus {
  const listeners = new Set<(frame: LiveFrame) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(frame) {
      // A copy, so a listener that unsubscribes itself mid-fan-out cannot skip
      // the listener behind it.
      for (const listener of [...listeners]) listener(frame);
    },
  };
}
