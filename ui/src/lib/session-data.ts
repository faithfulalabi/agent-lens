/*
 * Loading one session's turns and events, and the two pure decisions the page
 * module would otherwise bury inside an effect (Task 5.3b).
 *
 * The `ui` vitest project runs under `environment: 'node'`, where an effect
 * never fires. Anything expressed as a decision inside `pages/SessionView.tsx`
 * is therefore untested by construction, so the fetch loop, the opening
 * expansion state and the navigation action a fresh model produces all live
 * here — reachable from a unit test with a hand-written `ApiClient` stub, no
 * network and no rendering.
 *
 * ===========================================================================
 * THE EVENT PAGE IS A CURSOR, NOT AN OFFSET WINDOW.
 * ===========================================================================
 * `GET /api/sessions/:id` answers `next_seq` and `has_more`, and the next
 * request passes `from_seq: next_seq`. Task 4.5 rewrote the old
 * `?limit`/`?offset` loop onto it, because an offset window renumbers its whole
 * page whenever the file grows mid-scroll — which is the state a live tail is in
 * by definition. `limit` is still stated on every request: the server CLAMPS
 * rather than rejecting, so an implicit limit does not fail loudly, and Flow 3
 * forbids presenting a partial trace as a whole one. Anything the client cap
 * stops short of is reported as {@link SessionData.truncated} for the notice
 * strip to say out loud.
 *
 * ===========================================================================
 * ★ THE `Trace`/`Span` ADAPTER BELOW IS TASK 5.1'S TO DELETE.
 * ===========================================================================
 * The v2 route answers `turns` and `events`; the screens still consume plan
 * 001's `Trace` and `Span`. Task 4.5's scope is compile-and-contract — the ruling
 * at the phase-4 gate is explicit that 5.1 builds the screens — so the mapping
 * lives here, in ONE place, marked, rather than being spread through
 * `pages/SessionView.tsx` and `lib/span-tree.ts`. Every field it cannot source
 * from the wire is given a stated default rather than a plausible invention.
 */

import type { Session, Span, Trace } from '@shared/entities.ts';

import type { ApiClient, EventRow, SessionDetailBody, TurnRow } from './api.js';
import type { Row, TreeModel } from './span-tree.js';
import type { NavAction } from './tree-nav.js';

/**
 * Turns per session request.
 *
 * The server's ceiling is 10,000 and its detail default is 1,000. A session with
 * more than a thousand turns is not a session anybody scrolls, and events
 * belonging to turns past this page are counted rather than dropped —
 * `TreeModel.unmatchedSpanCount` is exactly that count.
 */
export const TRACE_PAGE = 1000;

/** Events per request. Half the server's 10,000 ceiling, so no page is clamped. */
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
 * The session, its turns, and every event the cap allows — bucketed by turn.
 *
 * ===========================================================================
 * THE CALLER BUCKETS, AND THE CALLER IS THIS FUNCTION.
 * ===========================================================================
 * `buildTreeModel(traces, spansByTrace)` takes a map keyed by `trace_id`, which
 * makes bucketing somebody's job. It is deliberately NOT the page module's: doing
 * it there would put a real decision — which turn an event belongs to — behind
 * the effect boundary, where this project can assert nothing about it. Here it
 * is a unit test with a stub client.
 *
 * The loop guards its own termination. A page answering `has_more` with an empty
 * event array, or with a `next_seq` that does not advance, would otherwise spin
 * forever against a server bug, and an unbounded client loop is a frozen tab
 * rather than an error anybody can read.
 */
export async function loadSessionSpans(
  api: ApiClient,
  sessionId: string,
  { cap = SPAN_CAP, limit = SPAN_PAGE, signal }: LoadSessionOptions = {},
): Promise<SessionData> {
  const options = signal === undefined ? undefined : { signal };

  const first = await api.getSession(sessionId, { limit }, options);
  const events: EventRow[] = [...first.events];
  let cursor = first.next_seq;
  let hasMore = first.has_more;
  let truncated = false;

  while (hasMore) {
    if (events.length >= cap) {
      truncated = true;
      break;
    }
    const page = await api.getSession(sessionId, { limit, from_seq: cursor }, options);
    if (page.events.length === 0 || page.next_seq <= cursor) break;
    events.push(...page.events);
    cursor = page.next_seq;
    hasMore = page.has_more;
  }

  const spansByTrace = new Map<string, Span[]>();
  for (const event of events) {
    const span = toSpan(event);
    const bucket = spansByTrace.get(span.trace_id);
    if (bucket === undefined) spansByTrace.set(span.trace_id, [span]);
    else bucket.push(span);
  }

  return {
    session: toSession(first),
    traces: first.turns.slice(0, TRACE_PAGE).map((turn) => toTrace(sessionId, turn)),
    tracesTruncated: first.turns.length > TRACE_PAGE,
    spansByTrace,
    truncated,
    shown: events.length,
  };
}

// --- The plan-001 adapter. Task 5.1 deletes this whole block. ---------------

/** Every `SpanType` the fold can produce, by the `events.kind` that carries it. */
const SPAN_TYPE_OF: Readonly<Record<string, Span['span_type']>> = {
  tool_call: 'tool_call',
  thinking: 'thinking',
  text: 'llm_call',
  prompt: 'generic',
  error: 'generic',
  compaction: 'generic',
  unknown: 'generic',
};

const SPAN_STATUS: readonly Span['status'][] = ['running', 'ok', 'error', 'denied', 'unknown'];

function toSpan(event: EventRow): Span {
  const status = SPAN_STATUS.find((known) => known === event.status);
  const span: Span = {
    id: event.id,
    trace_id: event.turn_id,
    span_type: SPAN_TYPE_OF[event.kind] ?? 'generic',
    name: event.name ?? event.kind,
    // A row the projector left unlabelled is `unknown`, never a fabricated `ok`.
    status: status ?? 'unknown',
    started_at: event.ts,
    // `source` is always `transcript` now: the hook path is gone, so every event
    // came out of a `.jsonl`. Kept as a field only because `Span` declares it.
    source: 'transcript',
    tags: [],
    attrs: {},
  };
  if (event.model !== null) span.model = event.model;
  if (event.tokens_in !== null) span.tokens_in = event.tokens_in;
  if (event.tokens_out !== null) span.tokens_out = event.tokens_out;
  if (event.est_cost !== null) span.est_cost = event.est_cost;
  return span;
}

function toTrace(sessionId: string, turn: TurnRow): Trace {
  const trace: Trace = {
    id: turn.id,
    session_id: sessionId,
    turn_seq: turn.seq,
    // `turns.kind` is the v2 vocabulary (human/task_notification/slash_command/
    // compaction/system/unknown) and does not map onto `TraceTrigger`; only the
    // compaction arm has a counterpart, so the rest are honestly `unknown`.
    trigger: turn.kind === 'compaction' ? 'compaction' : turn.kind === 'human' ? 'user_prompt' : 'unknown',
    prompt_preview: turn.title,
    started_at: turn.started_at,
    // A turn with no end is still running — the same reading `ended_at: null`
    // has on the row.
    status: turn.ended_at === null ? 'live' : 'complete',
    total_tokens:
      turn.tokens_in + turn.tokens_out + turn.tokens_cache_read + turn.tokens_cache_write,
    tokens_in: turn.tokens_in,
    tokens_out: turn.tokens_out,
    tokens_cache_read: turn.tokens_cache_read,
    tokens_cache_write: turn.tokens_cache_write,
    est_cost: turn.est_cost ?? 0,
    duration_ms: turn.duration_ms ?? 0,
    tool_call_count: turn.tool_call_count,
    error_count: turn.error_count,
  };
  if (turn.ended_at !== null) trace.ended_at = turn.ended_at;
  return trace;
}

function toSession(detail: SessionDetailBody): Session {
  const row = detail.session;
  const session: Session = {
    id: row.id,
    // The only harness this product reads, and the column no longer exists.
    harness: 'claude-code',
    project_path: row.project_path,
    started_at: row.started_at,
    // `live` is stamped by the server off `last_activity_at`; nothing in v2
    // distinguishes `interrupted`, so it is not invented here.
    status: row.live ? 'live' : 'complete',
    // Every session is transcript-derived now, which is what this value meant.
    capture_mode: 'transcript_only',
    total_tokens: row.tokens_in + row.tokens_out,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    est_cost: row.est_cost ?? 0,
    tool_call_count: row.tool_call_count,
    error_count: row.error_count,
    trace_count: row.turn_count,
  };
  if (row.git_branch !== null) session.git_branch = row.git_branch;
  if (row.model !== null) session.model = row.model;
  if (!row.live) session.ended_at = row.last_activity_at;
  return session;
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
