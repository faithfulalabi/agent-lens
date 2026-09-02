/*
 * Every decision the search screen makes (Task 7.2), as pure functions.
 *
 * The `ui` vitest project runs under `environment: 'node'`, where an effect
 * never fires and `renderToStaticMarkup` emits no handler attributes. A decision
 * expressed inside `pages/Search.tsx` is therefore untested by construction, so
 * the snippet split, the scope sentence, the empty-state copy, the warm fold and
 * the reveal latch all live here — reachable from a unit test with no network,
 * no browser and no rendering.
 */

import type { SearchHitRow } from './api.js';
import type { Row } from './turn-tree.js';

/* --------------------------------------------------------- the snippet --- */

/**
 * The literals `snippet(events_fts, …)` wraps each match in
 * (`src/db/read.ts:571`). Plain text on the wire, never markup to insert.
 */
const MARK_OPEN = '<mark>';
const MARK_CLOSE = '</mark>';

/** One run of snippet text, and whether the index matched on it. */
export interface SnippetPart {
  text: string;
  matched: boolean;
}

/**
 * A snippet split into matched and unmatched runs.
 *
 * ★ THIS IS WHAT REPLACES `dangerouslySetInnerHTML`, AND THE REASON IS MEASURED.
 * The markers arrive wrapped around whatever the transcript held, and
 * transcripts hold source code. Reproduce it: run `searchEvents` against
 * `.agent-lens-dev/cache.db` (293 sessions, 30,286 events) with `q=script` and
 * `limit=300`, then strip the two marker literals from each `snippet`. 81 of the
 * 300 then carry a raw `<` and 67 carry a literal opening script tag. Inserting
 * that as HTML is an injection vector on 22% of one ordinary query's results.
 * Returning runs of TEXT hands React text nodes, which it escapes.
 *
 * Total. A `null` snippet, an unterminated marker and a nested one all degrade
 * to plain unmatched text rather than throwing — MEASURED, 10 of 30,286 event
 * rows carry a literal marker in `text` or `input`, so a collision is real. Its
 * worst outcome is one mis-highlighted run inside an escaped text node.
 */
export function splitSnippet(snippet: string | null | undefined): SnippetPart[] {
  if (snippet === null || snippet === undefined || snippet === '') return [];

  const parts: SnippetPart[] = [];
  let rest = snippet;

  while (rest !== '') {
    const open = rest.indexOf(MARK_OPEN);
    if (open === -1) break;
    const close = rest.indexOf(MARK_CLOSE, open + MARK_OPEN.length);
    // An opener with no closer is not a match — the rest is ordinary text.
    if (close === -1) break;

    if (open > 0) parts.push({ text: rest.slice(0, open), matched: false });
    const inner = rest.slice(open + MARK_OPEN.length, close);
    // A nested opener inside the run is left in the text rather than recursed
    // on: it came from the transcript, so showing it is the honest answer.
    if (inner !== '') parts.push({ text: inner, matched: true });
    rest = rest.slice(close + MARK_CLOSE.length);
  }

  if (rest !== '') parts.push({ text: rest, matched: false });
  return parts;
}

/* ----------------------------------------------------------- the query --- */

/** Whether a typed query is worth a request, and what to send. */
export type SearchIntent = { kind: 'idle' } | { kind: 'search'; q: string };

/**
 * An empty or whitespace query asks nothing.
 *
 * The server 400s a missing or empty `q`, so this is what keeps the screen from
 * spending its first render on a request it knows is malformed. Everything else
 * goes raw: 7.1's phrase fallback means `foo-bar`, `ENOENT:` and `C++` all
 * return 200, so there is no malformed-query state left to build an affordance
 * for. NUL is the one remaining rejection and no keyboard produces one.
 */
export function searchIntent(raw: string): SearchIntent {
  const q = raw.trim();
  return q === '' ? { kind: 'idle' } : { kind: 'search', q };
}

/* ----------------------------------------------------------- the scope --- */

/**
 * What the screen says it just searched — the honesty requirement, in a
 * sentence.
 *
 * ★ NEVER THE WORD "sessions" FOR THE PROJECTED SCOPE, and that is a ruling
 * rather than a preference. `unprojected_count` and the search corpus both count
 * SIDECARS: measured, 272 of 293 rows are sub-agent transcripts, and for
 * `q=ENOENT` — 623 matching events, 105 of them top-level — 47 of the first 50
 * hits by rank come from a sub-agent transcript. So the majority of what a
 * reader sees on their first search is content the session list never shows, and
 * naming the scope "sessions" would make the number read as a bug to anyone who
 * counts that list.
 *
 * The sub-counts are not on the wire, so the line states the total only. A
 * per-hit sidecar label needs `parent_session_id` on `SearchHit`, which is a
 * server change and a follow-up.
 */
export function scopeLine(scope: 'projected' | 'session'): string {
  return scope === 'session'
    ? 'Searching this session.'
    : 'Searching all projected transcripts, including sub-agent transcripts the session list does not show.';
}

/**
 * What to say when a query returned nothing.
 *
 * `null` while the reader has typed nothing — an empty screen is the honest
 * answer to an empty question, and a permanent prompt would train the eye past
 * the line that carries the real message.
 *
 * The out-of-scope clause exists because "no results" is exactly the sentence a
 * reader mis-reads as "it never happened". When part of the corpus is not
 * indexed, saying so is the difference between an answer and a falsehood.
 */
export function emptyResultCopy(
  intent: SearchIntent,
  hitCount: number,
  unprojectedCount: number,
): string | null {
  if (intent.kind === 'idle' || hitCount > 0) return null;
  const base = `No matches for ${JSON.stringify(intent.q)}.`;
  return unprojectedCount > 0
    ? `${base} ${unprojectedCount} transcripts are not indexed yet, so this answer covers part of the corpus.`
    : base;
}

/* ------------------------------------------------------------ the hits --- */

/** One session's hits, in the order the index ranked them. */
export interface SessionHits {
  sessionId: string;
  title: string | null;
  projectPath: string;
  hits: SearchHitRow[];
}

/**
 * Hits grouped by session, groups in first-appearance order and hits in rank
 * order within each group.
 *
 * Rank order is what the server sorted by, so re-sorting would throw away the
 * only relevance signal the screen has. Grouping is first-appearance rather than
 * alphabetical for the same reason: the best-ranked session leads.
 */
export function hitsBySession(hits: readonly SearchHitRow[]): SessionHits[] {
  const groups = new Map<string, SessionHits>();
  for (const hit of hits) {
    const group = groups.get(hit.session_id);
    if (group === undefined) {
      groups.set(hit.session_id, {
        sessionId: hit.session_id,
        title: hit.session_title,
        projectPath: hit.project_path,
        hits: [hit],
      });
      continue;
    }
    group.hits.push(hit);
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------ the warm --- */

/**
 * How far the warm run has got.
 *
 * ★ DECLARED HERE, NOT IMPORTED FROM THE FRAME TYPE. Task 7.4 owns the
 * `warm_progress` decode — the shared payload type, the `LiveFrame` arm and the
 * `use-live.ts` limb are all its commit, in the same change that ships the
 * producer. This module folds the shape and nothing more, so 7.2 asserts only
 * what 7.2 can exercise.
 */
export interface WarmState {
  done: number;
  total: number;
}

/**
 * Fold one progress reading into the running one, MONOTONICALLY.
 *
 * A frame that moves `done` backwards is ignored rather than applied: frames are
 * one-way notifications with no ordering guarantee, and a count that walked
 * backwards on screen would read as a failure rather than as a reorder. The
 * first reading seeds the state, which is what makes `total` arrive at all.
 */
export function warmState(current: WarmState | null, next: WarmState): WarmState {
  if (current === null) return next;
  if (next.total !== current.total) return next;
  return next.done < current.done ? current : next;
}

/** The warm control's own line: what it will do, or how far it has got. */
export function warmLabel(unprojectedCount: number, state: WarmState | null): string {
  if (state === null) return `Warm the remaining ${unprojectedCount}`;
  return state.done >= state.total
    ? `Warmed ${state.total} transcripts`
    : `Warming ${state.done} of ${state.total}`;
}

/* ---------------------------------------------------------- the reveal --- */

/** The event a jump is aiming at, held until the row carrying it exists. */
export interface RevealLatch {
  turnId: string;
  eventId: string;
}

/** What the session view should do about the latch on this render. */
export interface RevealStep {
  /** The latch to keep. `null` once the row was delivered, or when none was set. */
  latch: RevealLatch | null;
  /** The row index to scroll to, ONCE. `undefined` on every other render. */
  revealIndex: number | undefined;
  selectedId?: string;
  focusedIndex?: number;
}

/**
 * ★ THE JUMP, AS A ONE-SHOT LATCH CONSUMED ON DELIVERY.
 *
 * The naive spelling is `revealIndex = rows.findIndex(…)`, recomputed each
 * render, and it is a live scroll bug. `rows` is memoised on `nav.expandedIds`
 * (`pages/SessionView.tsx:205-208`), so it is rebuilt on every expand and
 * collapse; the index then moves, `SpanTree`'s effect deps `[revealIndex,
 * virtualizer]` change, and the scroller yanks a reader who only opened a turn.
 * That is precisely the failure `SpanTree.tsx:79-85` documents `followIndex`
 * existing to prevent.
 *
 * So the target is state, and it is consumed at exactly one point:
 *
 *   - no latch            -> nothing to do;
 *   - the row is ABSENT   -> KEEP the latch. The turn is still opening, and the
 *                            row appears one render later.
 *   - the row is FOUND    -> deliver the index and DROP the latch, setting
 *                            selection and focus in the same answer, the shape
 *                            `SessionView.tsx:360` already uses.
 *
 * ★ ON DELIVERY, NEVER ON SELECTION. Clearing the latch when `selectedId`
 * matches would consume it on the render right after seeding, so `SpanTree`
 * would receive no index at all and the scroll would never fire. Leaving it
 * unconsumed re-fires the scroll on every later expand, which is the defect it
 * exists to prevent. Delivery is the only point that is both reachable and
 * terminal.
 */
export function revealStep(latch: RevealLatch | null, rows: readonly Row[]): RevealStep {
  if (latch === null) return { latch: null, revealIndex: undefined };

  const index = rows.findIndex((row) => row.id === latch.eventId);
  if (index === -1) return { latch, revealIndex: undefined };

  return {
    latch: null,
    revealIndex: index,
    selectedId: latch.eventId,
    focusedIndex: index,
  };
}
