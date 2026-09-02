/*
 * Loading one session, and the three pure decisions the page module would
 * otherwise bury inside an effect.
 *
 * The `ui` vitest project runs under `environment: 'node'`, where an effect
 * never fires. Anything expressed as a decision inside `pages/SessionView.tsx`
 * is therefore untested by construction, so the fetch, the opening expansion
 * state and the navigation action a fresh model produces all live here —
 * reachable from a unit test with a hand-written `ApiClient` stub, no network
 * and no rendering.
 *
 * ===========================================================================
 * ONE REQUEST FILLS THE WHOLE SCREEN. THERE IS NO LOOP LEFT.
 * ===========================================================================
 * `GET /api/sessions/:id` answers the header, EVERY turn, and a page of events
 * with their content INLINE up to 64 KB. Task 4.5 rewrote plan 001's paging
 * onto a cursor and Task 5.2 deleted it outright: the largest session in the
 * measured archive holds 624 events against a `MAX_LIMIT` of 10,000, so the
 * loop never executed, and a loop nobody runs is a loop nobody can trust. One
 * request is asked at the server's own ceiling — the server CLAMPS rather than
 * rejecting, so an over-large limit fails quietly rather than loudly.
 *
 * `has_more` is therefore not a reason to ask again. It is a fact the notice
 * strip states out loud, because Flow 3 forbids presenting a partial trace as a
 * whole one.
 *
 * The plan-001 `Trace`/`Span` adapter that used to sit here went with Task 5.2,
 * and with it the `Session`, `Span` and `Trace` entity types. The screens read
 * `TurnRow` and `EventRow` off the wire directly now.
 */

import type { ApiClient, EventRow, SessionDetailBody, TurnRow } from './api.js';
import type { Row, TreeModel } from './turn-tree.js';
import type { NavAction } from './tree-nav.js';
import { mergedRowIds, type SubagentState } from './subagent.js';

/**
 * Events per request: the server's own ceiling (`src/server/api.ts:68`).
 *
 * Stated rather than omitted. The read API's default is 1,000, so an implicit
 * limit would serve a 5,000-event session's first fifth and the tree would
 * render a truncated session that looks whole.
 */
export const EVENT_LIMIT = 10_000;

export interface SessionData {
  /** The detail header, verbatim off the wire. No adapter, no inventions. */
  readonly session: SessionDetailBody['session'];
  /** Every turn, in `seq` order, as the server returns them — unpaginated. */
  readonly turns: readonly TurnRow[];
  /** Bucketed by `turn_id`, which is the shape `buildTurnGroups` takes. */
  readonly eventsByTurn: ReadonlyMap<string, readonly EventRow[]>;
  /**
   * The same page, still flat and still in `seq` order — what `buildThread`
   * reads. Carried rather than rebuilt from the buckets above, because that is
   * what makes one response fill both screens with no second request.
   */
  readonly events: readonly EventRow[];
  /** The server has events past this page. Reported, never chased. */
  readonly hasMore: boolean;
  /** How many events actually arrived — the number the notice strip spells. */
  readonly shown: number;
  /**
   * The live-tail epoch of the bytes this data was served from, verbatim.
   *
   * `'<mtime_ms>:<size>:<sidecar_count>'`, or `''` when the archive held no
   * bytes to fold. `movedBackwards` in `live.ts` is the only reader: a frame
   * whose epoch went backwards describes a file this page cannot be spliced
   * onto, so the page is fetched again from zero instead.
   */
  readonly fingerprint: string;
}

export interface LoadSessionOptions {
  limit?: number;
  signal?: AbortSignal;
}

/**
 * The session, its turns, and its first page of events — bucketed by turn.
 *
 * ===========================================================================
 * THE CALLER BUCKETS, AND THE CALLER IS THIS FUNCTION.
 * ===========================================================================
 * `buildTurnGroups(turns, eventsByTurn)` takes a map keyed by `turn_id`, which
 * makes bucketing somebody's job. It is deliberately NOT the page module's:
 * doing it there would put a real decision — which turn an event belongs to —
 * behind the effect boundary, where this project can assert nothing about it.
 * Here it is a unit test with a stub client.
 */
export async function loadSessionDetail(
  api: ApiClient,
  sessionId: string,
  { limit = EVENT_LIMIT, signal }: LoadSessionOptions = {},
): Promise<SessionData> {
  const options = signal === undefined ? undefined : { signal };
  const body = await api.getSession(sessionId, { limit }, options);

  return {
    session: body.session,
    turns: body.turns,
    eventsByTurn: bucketByTurn(body.events),
    events: body.events,
    hasMore: body.has_more,
    shown: body.events.length,
    fingerprint: body.fingerprint,
  };
}

/**
 * Events grouped by `turn_id`, in arrival order — the shape `buildTurnGroups` takes.
 *
 * Exported so the cold load above and `live.ts`'s splice share ONE bucketing
 * rule. Two copies would be two chances for a spliced page to group differently
 * from the page it replaced.
 */
export function bucketByTurn(events: readonly EventRow[]): Map<string, EventRow[]> {
  const eventsByTurn = new Map<string, EventRow[]>();
  for (const event of events) {
    const bucket = eventsByTurn.get(event.turn_id);
    if (bucket === undefined) eventsByTurn.set(event.turn_id, [event]);
    else bucket.push(event);
  }
  return eventsByTurn;
}

/* ------------------------------------------------------ the notice strip --- */

/*
 * Module-level, on the same rule every other `Intl` formatter in this codebase
 * follows: constructing one costs roughly two orders of magnitude more than
 * calling it, and moving this into the function body would pay that cost on
 * every render of the session view.
 */
const COUNT_FORMAT = new Intl.NumberFormat('en-US');

export interface TruncationFacts {
  readonly shown: number;
  /** {@link SessionData.hasMore} — the server holds events past this page. */
  readonly hasMore: boolean;
  readonly unmatchedEventCount: number;
}

/**
 * What the session view has to say out loud about what it is NOT showing.
 *
 * Copy rather than markup, and a plain function rather than a branch inside a
 * component, so the wording is assertable. Flow 3's rule is the reason it
 * exists at all: a partial trace may never be presented as a whole one, and a
 * tree that silently stops short does exactly that.
 *
 * TWO independent shortfalls, and one session can have both:
 *
 *   - the server answered `has_more`, so events exist past this page;
 *   - events arrived belonging to turns this page does not carry, so they have
 *     no header to hang under.
 *
 * An empty list is the ordinary case and means the tree is complete.
 */
export function truncationNotes({
  shown,
  hasMore,
  unmatchedEventCount,
}: TruncationFacts): string[] {
  const notes: string[] = [];
  if (hasMore) {
    notes.push(
      `Showing the first ${COUNT_FORMAT.format(shown)} events of this session — more were captured than this view loads.`,
    );
  }
  if (unmatchedEventCount > 0) {
    notes.push(
      `${COUNT_FORMAT.format(unmatchedEventCount)} more events belong to turns outside this page.`,
    );
  }
  return notes;
}

/** What the session row already says about its own drift. Nothing stored. */
export interface DriftFacts {
  readonly hasDrift: boolean;
  readonly harnessVersion: string | null;
}

/**
 * The durability alarm's copy: this session holds records the projector did not
 * recognise, and the release that wrote them.
 *
 * ★ A PURE FUNCTION OF THE ROW ON SCREEN, WITH NO STORED STATE, AND THAT IS THE
 * DESIGN. Plan 001's task 3.3 built a banner twice around stored, monotonic
 * state and twice the raise could not be falsified by the clear — a stamp ahead
 * of the clock pinned the key in the future, and a `MIN` that never advances
 * suppressed the alarm for as long as it stayed a candidate. There is no
 * timestamp here and no suppression: the raise IS the data, so it clears when
 * the row does. Reproject without the unrecognised line and the next response
 * says false, which the 1 Hz tick already delivers through `applyFrame`.
 *
 * `null` means silence. A permanent "no drift" strip would train the reader to
 * stop reading it, on the same rule `truncationNotes` follows next door.
 */
export function driftNotice({ hasDrift, harnessVersion }: DriftFacts): string | null {
  if (!hasDrift) return null;
  const who = harnessVersion === null ? 'The harness' : `Claude Code ${harnessVersion}`;
  return `Unrecognized records in this session. ${who} writes a transcript shape this build does not know.`;
}

/**
 * Which turns are open when the session first draws: the latest one, alone.
 *
 * The server returns turns in `seq` order, so the latest is the last. A session
 * opened cold is almost always opened to see what just happened, and an
 * everything-open default would put a 5,000-row list under a reader looking for
 * one turn. Everything-closed would be worse still: the screen would show ten
 * headers and no work at all.
 */
export function initialExpanded(turns: readonly TurnRow[]): Set<string> {
  const latest = turns[turns.length - 1];
  return latest === undefined ? new Set<string>() : new Set([latest.id]);
}

/**
 * The turn and event a jump names, found by `seq` in the page already loaded.
 *
 * `seq` rather than a row index, because a row index does not survive a
 * reprojection and a `seq` does. No second request is needed: `EVENT_LIMIT` is
 * 10,000 against a largest measured session of 624 events, so the target is
 * always in `data.events`.
 *
 * Total. An unknown `seq` answers `null` — a deep link to an event that has been
 * reprojected away should open the session, not blow up the render.
 */
export function revealTarget(
  data: SessionData | null,
  seq: number | undefined,
): { turnId: string; eventId: string } | null {
  if (data === null || seq === undefined) return null;
  const event = data.events.find((candidate) => candidate.seq === seq);
  return event === undefined ? null : { turnId: event.turn_id, eventId: event.id };
}

/**
 * Does the navigation state have to start over for the data now in hand?
 *
 * ===========================================================================
 * KEYED ON THE SESSION THAT ARRIVED, NEVER ON THE ONE THAT WAS ASKED FOR.
 * ===========================================================================
 * The obvious spelling compares the requested `sessionId` against the last one
 * seeded, and it is wrong by exactly one render. `useAsync` resets its slot
 * inside an effect, i.e. AFTER commit — so on the first render following a move
 * from session A to session B, the id prop already reads `B` while the data in
 * hand is still all of A. The obvious version fires there, seeds the expansion
 * set from A's turns, and marks itself done for B; when B's data finally lands
 * the guard is already satisfied and the correct seeding never happens. B then
 * renders with an expansion set naming turns that do not exist in it, so every
 * turn is closed and "a session opens on its latest turn" silently stops being
 * true — on a plain browser Back, with nothing to see in any test.
 *
 * Comparing `data.session.id` closes the window: on the transitional render it
 * is still `A`, which is what was seeded, so nothing fires until the data
 * actually changes.
 *
 * It lives here rather than inline in the page module for the usual reason —
 * that module is unreachable from a test, and this is a real decision.
 */
export function needsReseed(data: SessionData | null, seededFor: string | null): boolean {
  return data !== null && data.session.id !== seededFor;
}

/**
 * The navigation action a freshly built model produces.
 *
 * A value rather than a `dispatch` call inside the page module's effect, because
 * an effect is unreachable from this project's tests and this action's contract
 * is the one Task 6.2's live append turns on.
 *
 * `modelIds` is every id that CAN be a row — and not the ids of `rows`, which
 * holds only what the current expansion state puts on screen. Passing the latter
 * would clear the selection every time a turn was closed, which is the single
 * thing the selection/focus split exists to prevent.
 *
 * ★ THE SUB-AGENT STATE IS A REQUIRED ARGUMENT, NOT AN OPTIONAL ONE. A loaded
 * sidecar's rows are in the one row list but not in the parent model's `rowIds`,
 * so selecting one and re-rendering would drop the selection on the very next
 * pass. Making it required turns that wiring mistake into a compile error at the
 * one call site instead of a defect only a live drive could see.
 */
export function rowsChangedAction(
  model: TreeModel,
  rows: readonly Row[],
  sub: SubagentState,
): NavAction {
  return { type: 'rows-changed', rows, modelIds: mergedRowIds(model, sub) };
}
