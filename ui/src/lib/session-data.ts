/*
 * Loading one session's turns and spans, and the two pure decisions the
 * page module would otherwise bury inside an effect (Task 5.3b).
 *
 * The `ui` vitest project runs under `environment: 'node'`, where an effect
 * never fires. Anything expressed as a decision inside `pages/SessionView.tsx`
 * is therefore untested by construction, so the fetch loop, the opening
 * expansion state and the navigation action a fresh model produces all live
 * here — reachable from a unit test with a hand-written `ApiClient` stub, no
 * network and no rendering.
 *
 * ===========================================================================
 * EVERY REQUEST STATES ITS OWN `limit`. THIS IS THE WHOLE POINT OF THE FILE.
 * ===========================================================================
 * The read API defaults `?limit` to 100 and CLAMPS rather than rejecting
 * (`src/server/read-api.ts`), so an implicit limit does not fail loudly — a
 * 5,000-span session quietly loads 100 spans and the tree renders a truncated
 * session that looks complete. Flow 3 forbids exactly that: a partial trace may
 * never be presented as a whole one. So the limits below are stated, the loop
 * follows `has_more`, and anything the client cap stops short of is reported as
 * {@link SessionData.truncated} for the notice strip to say out loud.
 *
 * The server's own ceiling cannot be imported: `read-api.ts` pulls in
 * `../db/reads.js`, which needs `node:sqlite`. The constants below are
 * `ui`-local and name that ceiling in prose instead.
 */

import type { Session, Span, Trace } from '@shared/entities.ts';

import type { ApiClient } from './api.js';
import type { Row, TreeModel } from './span-tree.js';
import type { NavAction } from './tree-nav.js';

/**
 * Turns per session request.
 *
 * The server's own ceiling is 10,000 and its default is 100. A session with
 * more than a thousand turns is not a session anybody scrolls, and the spans
 * belonging to turns past this page are counted rather than dropped —
 * `TreeModel.unmatchedSpanCount` is exactly that count.
 */
export const TRACE_PAGE = 1000;

/** Spans per request. Half the server's 10,000 ceiling, so no page is clamped. */
export const SPAN_PAGE = 5000;

/**
 * The client's own row cap, past which the tree stops loading and says so.
 *
 * Twice the server's ceiling. Higher turns a pathological session into a hang
 * — every span becomes a row and every row is measured — and lower would make
 * the truncation strip a routine sight on ordinary sessions rather than the
 * rare, meaningful one it is.
 */
export const SPAN_CAP = 20_000;

export interface SessionData {
  readonly session: Session;
  /** The turns on this page, in `turn_seq` order, as the server returns them. */
  readonly traces: readonly Trace[];
  /** Turns exist past {@link TRACE_PAGE}; their spans have no turn to hang on. */
  readonly tracesTruncated: boolean;
  /** Bucketed by `trace_id`, which is the shape `buildTreeModel` takes. */
  readonly spansByTrace: ReadonlyMap<string, readonly Span[]>;
  /** The span load stopped at {@link SPAN_CAP} with more still to come. */
  readonly truncated: boolean;
  /** How many spans actually arrived — the number the notice strip spells. */
  readonly shown: number;
}

export interface LoadSessionOptions {
  /** Overridable so a test can reach the cap without seeding 20,000 spans. */
  cap?: number;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * The session, its turns, and every span the cap allows — bucketed by turn.
 *
 * ===========================================================================
 * THE CALLER BUCKETS, AND THE CALLER IS THIS FUNCTION.
 * ===========================================================================
 * `buildTreeModel(traces, spansByTrace)` takes a map keyed by `trace_id`, which
 * makes bucketing somebody's job. It is deliberately NOT the page module's: doing
 * it there would put a real decision — which turn a span belongs to — behind
 * the effect boundary, where this project can assert nothing about it. Here it
 * is a unit test with a stub client.
 *
 * The loop guards its own termination. A page answering `has_more` with no
 * items would otherwise spin forever against a server bug, and an unbounded
 * client loop is a frozen tab rather than an error anybody can read.
 */
export async function loadSessionSpans(
  api: ApiClient,
  sessionId: string,
  { cap = SPAN_CAP, limit = SPAN_PAGE, signal }: LoadSessionOptions = {},
): Promise<SessionData> {
  const options = signal === undefined ? undefined : { signal };
  const detail = await api.getSession(sessionId, { limit: TRACE_PAGE }, options);

  const spansByTrace = new Map<string, Span[]>();
  let shown = 0;
  let truncated = false;

  for (;;) {
    const page = await api.listSpans(sessionId, { limit, offset: shown }, options);
    for (const span of page.items) {
      const bucket = spansByTrace.get(span.trace_id);
      if (bucket === undefined) spansByTrace.set(span.trace_id, [span]);
      else bucket.push(span);
    }
    shown += page.items.length;

    if (!page.has_more || page.items.length === 0) break;
    if (shown >= cap) {
      truncated = true;
      break;
    }
  }

  return {
    session: detail.session,
    traces: detail.traces.items,
    tracesTruncated: detail.traces.has_more,
    spansByTrace,
    truncated,
    shown,
  };
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
  readonly truncated: boolean;
  readonly unmatchedSpanCount: number;
  /** {@link SessionData.tracesTruncated} — turns exist past {@link TRACE_PAGE}. */
  readonly tracesTruncated: boolean;
}

/**
 * What the session view has to say out loud about what it is NOT showing.
 *
 * Copy rather than markup, and a plain function rather than a branch inside a
 * component, so the wording is assertable. Flow 3's rule is the reason it
 * exists at all: a partial trace may never be presented as a whole one, and a
 * tree that silently stops at a cap does exactly that.
 *
 * THREE independent shortfalls, and one session can have all of them:
 *
 *   - the client row cap stopped the span load;
 *   - spans arrived belonging to turns that fell off the turn page, so they
 *     have no header to hang under;
 *   - turns themselves ran past the turn page.
 *
 * The third is not covered by the second. A turn beyond the page whose spans
 * are also beyond the span cap contributes nothing to the unmatched count, so
 * without its own sentence a session of 1,500 turns would show 1,000 of them
 * and claim to be whole. Both caps are this module's own choice, which is
 * precisely why this module owes the reader an account of them.
 *
 * An empty list is the ordinary case and means the tree is complete.
 */
export function truncationNotes({
  shown,
  truncated,
  unmatchedSpanCount,
  tracesTruncated,
}: TruncationFacts): string[] {
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `Showing the first ${COUNT_FORMAT.format(shown)} spans of this session — more were captured than this view loads.`,
    );
  }
  if (tracesTruncated) {
    notes.push(`Showing the first ${COUNT_FORMAT.format(TRACE_PAGE)} turns of this session.`);
  }
  if (unmatchedSpanCount > 0) {
    notes.push(
      `${COUNT_FORMAT.format(unmatchedSpanCount)} more spans belong to turns outside this page.`,
    );
  }
  return notes;
}

/**
 * Which turns are open when the session first draws: the latest one, alone.
 *
 * The server returns turns in `turn_seq` order, so the latest is the last. A
 * session opened cold is almost always opened to see what just happened, and an
 * everything-open default would put a 5,000-row list under a reader looking for
 * one turn. Everything-closed would be worse still: the screen would show ten
 * headers and no work at all.
 */
export function initialExpanded(traces: readonly Trace[]): Set<string> {
  const latest = traces[traces.length - 1];
  return latest === undefined ? new Set<string>() : new Set([latest.id]);
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
 * `modelIds` is `TreeModel.rowIds` — every id that CAN be a row — and not the
 * ids of `rows`, which holds only what the current expansion state puts on
 * screen. Passing the latter would clear the selection every time a turn was
 * closed, which is the single thing the selection/focus split exists to
 * prevent.
 */
export function rowsChangedAction(model: TreeModel, rows: readonly Row[]): NavAction {
  return { type: 'rows-changed', rows, modelIds: model.rowIds };
}
