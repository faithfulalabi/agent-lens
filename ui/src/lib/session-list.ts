/*
 * The session-list domain (Task 5.2b): loading, narrowing, sorting, bucketing,
 * empty-state classification and the keyboard cursor — all of it as plain
 * functions over injected ports.
 *
 * The `ui` vitest project runs under `environment: 'node'`, where an effect
 * never fires and there is no DOM. Anything expressed as a decision inside a
 * component or an effect would therefore be untested by construction, so every
 * branch the acceptance criteria care about lives here instead, reachable from
 * a unit test with a hand-written `ApiClient` stub and an injected clock.
 *
 * Two spelling notes, because this file's vocabulary is a minefield:
 *
 *   - Tailwind v4 scans raw source, COMMENTS INCLUDED, so an ordinary English
 *     word that is also a utility emits a real (dead) CSS rule — and this
 *     domain's vocabulary (narrowing, sorting, sizing, layout) is unusually
 *     full of them. The prose here is worded around the bare forms
 *     deliberately, which is why it sometimes takes the long way round.
 *   - Nothing below reads an ambient clock. `now` is a parameter everywhere.
 */

import type { Session } from '@shared/entities.ts';

import type { ApiClient, SessionListRow, SessionsQuery } from './api.js';
import type { Router } from './router.js';

/* ----------------------------------------------------------- row counts --- */

/*
 * Module-level, per 5.2a's rule that every Intl formatter in this codebase is
 * constructed once: moving one into a function body costs a construction per
 * render and reds that task's Test 6.
 */
const COUNT_FORMAT = new Intl.NumberFormat('en-US');

/**
 * Spell how many rows the list is showing, for the sort strip.
 *
 * `showing` is the total AFTER narrowing by project, not the page size — the
 * question this answers is "how many am I looking at". When the page it was
 * counted from stopped early, an exact number would be a claim the UI cannot
 * support, so it degrades to `N+` on the same rule the empty-state counts use
 * (`design-system.md`, Empty states).
 */
export function formatRowCount(showing: number, pageTruncated: boolean): string {
  const noun = showing === 1 && !pageTruncated ? 'session' : 'sessions';
  return `${COUNT_FORMAT.format(showing)}${pageTruncated ? '+' : ''} ${noun}`;
}

/* --------------------------------------------------------------- ranges --- */

/** The segmented control's options, in the order the design system writes them. */
export const TIME_RANGES = ['3d', '7d', '30d', 'all'] as const;

export type TimeRange = (typeof TIME_RANGES)[number];

const RANGE_DAYS: Record<Exclude<TimeRange, 'all'>, number> = { '3d': 3, '7d': 7, '30d': 30 };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many rows one page asks for.
 *
 * The server defaults `?limit` to 100 and clamps at 10,000 rather than
 * rejecting, so an implicit limit does not fail loudly — it silently truncates,
 * and every count derived from the page (the histogram, the outside-range
 * total, the project narrowing) quietly becomes a smaller lie. Stating it is
 * the whole guard.
 */
export const LIST_LIMIT = 1000;

/**
 * The lower bound of a range, as an ISO instant.
 *
 * ★ NO LONGER SENT TO THE SERVER, AND CALLED BY NOTHING TODAY. `src/server/api.ts`
 * reads only `limit/offset/sort/project/q`, and `parsePageParams` ignores an
 * unknown param rather than 400-ing — so a `?from` sent here would be a
 * narrowing the reader set and the server silently never applied. Ruled at the
 * phase-4 gate: a silently-ignored narrowing is worse than a removed one.
 *
 * It survives as the written record of what each range MEANT, on the same
 * standing as `ui/src/lib/sse.ts`'s unwired client: Task 5.1 owns restoring the
 * feature, and doing so means giving the route a `from` param — not putting this
 * value back on the query string against a server that would drop it.
 */
export function rangeBounds(range: TimeRange, now: number | Date): { from?: string } {
  if (range === 'all') return {};
  const millis = typeof now === 'number' ? now : now.getTime();
  return { from: new Date(millis - RANGE_DAYS[range] * DAY_MS).toISOString() };
}

/* ---------------------------------------------------------------- load ---- */

export interface SessionListData {
  /**
   * The in-range page, NOT narrowed by project — it drives the project
   * selector's options, the histogram, and `no_match_for_project`'s count.
   */
  sessions: Session[];
  /** The in-range page hit {@link LIST_LIMIT}; more rows exist behind it. */
  truncated: boolean;
  /**
   * How many sessions exist with no range at all, counted only when the
   * in-range page came back empty. `null` means "not asked, because there was
   * nothing to explain".
   */
  outsideRangeCount: number | null;
  /** The PROBE's own `has_more` — see the note on {@link loadSessionList}. */
  outsideRangeTruncated: boolean;
  /**
   * The server's own answer for `project` inside the range, fetched only when
   * the client-side narrowing found nothing in a page that was truncated.
   * `null` means the page above is authoritative and no second question needed
   * asking.
   */
  projectSessions: Session[] | null;
}

export interface LoadOptions {
  range: TimeRange;
  now: number | Date;
  /** The project narrowing in force, if any. Only ever used to AVOID a lie. */
  project?: string;
  signal?: AbortSignal;
}

/**
 * One request on the hot path, and at most one more in an already-empty state.
 *
 * ===========================================================================
 * TWO TRUNCATION FLAGS, NOT ONE.
 * ===========================================================================
 * `truncated` is the in-range page's `has_more`. The unfiltered probe fires
 * only when that page is EMPTY, and the server derives `has_more` from a
 * `LIMIT n+1` row — so zero rows means `has_more === false` by construction.
 * Degrading the outside-range count to `N+` off `truncated` would therefore
 * make that branch unreachable. The probe reports its own `has_more`, and that
 * is what {@link SessionListData.outsideRangeTruncated} carries.
 *
 * ===========================================================================
 * `all` SKIPS THE PROBE.
 * ===========================================================================
 * `rangeBounds('all')` sets no lower bound, so the probe would be byte-identical
 * to the request just made. An empty page under `all` means an empty database,
 * which is `never_captured` — exactly what a count of zero yields.
 *
 * ===========================================================================
 * THE PROJECT RE-QUERY IS A TRUTH GUARD, NOT AN OPTIMISATION.
 * ===========================================================================
 * The project narrowing is client-side over ONE page. A project whose in-range
 * sessions all sit past {@link LIST_LIMIT} is invisible to that narrowing, and
 * the screen would then say "no sessions in this project in this range" while
 * the database holds some. Degrading the COUNT to `N+` does not repair a false
 * CLAIM. So when — and only when — a TRUNCATED page narrows to nothing, the
 * question is put to the server, which supports `?project` natively and has a
 * composite index for exactly this shape. An untruncated page is already the
 * whole in-range set, so zero matches in it is the true answer and no second
 * request is warranted.
 */
export async function loadSessionList(
  api: ApiClient,
  // `now` is unread here since task 4.5 removed the range param from the query;
  // it stays on `LoadOptions` because the caller passes one bag to this and to
  // `volumeBuckets`, which does read it.
  { range, project, signal }: LoadOptions,
): Promise<SessionListData> {
  const options = signal === undefined ? undefined : { signal };
  const page = await api.listSessions({ limit: LIST_LIMIT }, options);

  const data: SessionListData = {
    sessions: page.items.map(toSession),
    truncated: page.has_more,
    outsideRangeCount: null,
    outsideRangeTruncated: false,
    projectSessions: null,
  };

  if (page.items.length === 0) {
    if (range === 'all') {
      // An empty page under `all` IS the empty database: there is no wider
      // question left to ask, and asking it would repeat this exact request.
      data.outsideRangeCount = 0;
      return data;
    }
    const probe = await api.listSessions({ limit: LIST_LIMIT }, options);
    data.outsideRangeCount = probe.items.length;
    data.outsideRangeTruncated = probe.has_more;
    return data;
  }

  if (needsProjectProof(data.sessions, page.has_more, project)) {
    const narrowed = await api.listSessions(
      { project, limit: LIST_LIMIT } satisfies SessionsQuery,
      options,
    );
    data.projectSessions = narrowed.items.map(toSession);
  }

  return data;
}

/**
 * Would claiming "no sessions in this project" be a guess rather than a fact?
 *
 * Only when a project was actually asked for, the page stopped short of the
 * whole in-range set, and no row of that project appears in what did arrive.
 */
function needsProjectProof(
  items: readonly Session[],
  hasMore: boolean,
  project: string | undefined,
): project is string {
  if (project === undefined || project === '' || !hasMore) return false;
  return !items.some((session) => session.project_path === project);
}

/* -------------------------------------------------------------- select ---- */

/** The columns the header strip can sort by. */
export const SORT_COLUMNS = ['started_at', 'project_path', 'total_tokens', 'est_cost'] as const;

export type SortColumn = (typeof SORT_COLUMNS)[number];
export type SortDirection = 'asc' | 'desc';

export interface SelectOptions {
  project?: string;
  sort: SortColumn;
  direction: SortDirection;
}

/**
 * The rows to draw: narrowed to the chosen project, then sorted.
 *
 * The comparison ALWAYS ends on the id. The server's `ORDER BY started_at DESC`
 * carries no tiebreaker on purpose — one indexed pass is the point — so two
 * sessions that started in the same millisecond come back in unspecified order,
 * and a sort without a final discriminator lets those rows swap places between
 * renders. Sorting a copy keeps the fetched page reusable across sorts.
 *
 * `options.project` must be the SAME project the data was loaded for — the
 * server-narrowed pool was fetched for one project and means nothing for
 * another. The caller keeps them in step by putting the project in the load
 * key, so the two can never be a render apart.
 */
export function selectRows(data: SessionListData, options: SelectOptions): Session[] {
  const pool = data.projectSessions ?? data.sessions;
  const narrowed =
    options.project === undefined || options.project === ''
      ? pool
      : pool.filter((session) => session.project_path === options.project);

  const sign = options.direction === 'asc' ? 1 : -1;
  return [...narrowed].sort((a, b) => {
    const ordered = compareBy(a, b, options.sort);
    return ordered !== 0 ? sign * ordered : a.id.localeCompare(b.id);
  });
}

function compareBy(a: Session, b: Session, column: SortColumn): number {
  if (column === 'started_at') return a.started_at.localeCompare(b.started_at);
  if (column === 'project_path') return a.project_path.localeCompare(b.project_path);
  return a[column] - b[column];
}

/** Every project present in the page, sorted, for the narrowing control. */
export function projectsIn(sessions: readonly Session[]): string[] {
  return [...new Set(sessions.map((session) => session.project_path))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/* ------------------------------------------------------------ histogram --- */

export interface VolumeBucket {
  /** Epoch millis, inclusive. */
  start: number;
  /** Epoch millis, exclusive — except on the final bucket, which is closed. */
  end: number;
  count: number;
}

export interface BucketOptions {
  range: TimeRange;
  now: number | Date;
  bucketCount: number;
}

/**
 * Session starts, counted into a constant number of contiguous buckets.
 *
 * Constant rather than range-dependent so the component draws the same number of
 * bars whatever the range, and never an empty pane: no sessions yields
 * all-zero bars, which is a shape rather than a hole.
 *
 * Buckets are half-open (`start <= t < end`) so a session landing exactly on an
 * internal boundary is counted once, never twice and never zero times. The last
 * bucket closes at its end so `now` itself still lands somewhere. For `all` the
 * window runs from the oldest start to `now`, because there is no other lower
 * bound to draw against.
 */
export function volumeBuckets(
  sessions: readonly Session[],
  { range, now, bucketCount }: BucketOptions,
): VolumeBucket[] {
  const end = typeof now === 'number' ? now : now.getTime();
  const start = windowStart(sessions, range, end);
  const width = Math.max(1, (end - start) / bucketCount);

  const buckets: VolumeBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    start: start + i * width,
    end: i === bucketCount - 1 ? end : start + (i + 1) * width,
    count: 0,
  }));

  for (const session of sessions) {
    const at = Date.parse(session.started_at);
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const index = Math.min(bucketCount - 1, Math.floor((at - start) / width));
    const bucket = buckets[index];
    if (bucket !== undefined) bucket.count += 1;
  }
  return buckets;
}

function windowStart(sessions: readonly Session[], range: TimeRange, end: number): number {
  if (range !== 'all') return end - RANGE_DAYS[range] * DAY_MS;
  const starts = sessions.map((s) => Date.parse(s.started_at)).filter(Number.isFinite);
  const oldest = starts.length === 0 ? end - DAY_MS : Math.min(...starts);
  // A single session, or several in the same millisecond, would give a
  // zero-width window and every bucket the same bounds.
  return oldest < end ? oldest : end - DAY_MS;
}

/* ---------------------------------------------------------- empty state --- */

/**
 * The four ways the table can have nothing to show.
 *
 * `no_match_for_project` is the one the two-state spec did not have: an in-range
 * page narrowed to nothing by the project control is neither "never captured"
 * nor "outside range" — those sessions ARE in range — and `design-system.md`
 * forbids a blank pane outright.
 */
export type EmptyState =
  | { kind: 'none' }
  | { kind: 'never_captured' }
  | { kind: 'outside_range'; count: number; truncated: boolean }
  | { kind: 'no_match_for_project'; project: string; count: number; truncated: boolean };

export function emptyStateOf(
  data: SessionListData,
  rows: readonly Session[],
  { project }: { project?: string },
): EmptyState {
  if (rows.length > 0) return { kind: 'none' };
  if (project !== undefined && project !== '' && data.sessions.length > 0) {
    return {
      kind: 'no_match_for_project',
      project,
      count: data.sessions.length,
      truncated: data.truncated,
    };
  }
  const outside = data.outsideRangeCount;
  if (outside !== null && outside > 0) {
    return { kind: 'outside_range', count: outside, truncated: data.outsideRangeTruncated };
  }
  return { kind: 'never_captured' };
}

/** Everything but `none` — the states that actually put words on the screen. */
export type EmptyStateShown = Exclude<EmptyState, { kind: 'none' }>;

export interface EmptyStateCopy {
  /** The one sentence `design-system.md`'s empty-state pattern asks for. */
  sentence: string;
  /** The one action hint beside it. */
  hint: string;
}

/**
 * The specced copy, composed.
 *
 * ===========================================================================
 * EVERY SENTENCE BELOW IS PINNED TO A SPEC DOCUMENT, NOT INVENTED HERE.
 * ===========================================================================
 * The two original states are spelled per the 2026-07-30 ruling, which split the
 * decision by source because the documents disagreed with each other:
 *
 *   - never-captured takes Flow 1's wording ("…and it WILL appear here live"),
 *     because `design-system.md` introduces its own version with "e.g." — an
 *     example of the pattern rather than the string to ship — while the flow
 *     states it as what the screen says.
 *   - out-of-range takes "outside range", which `design-system.md` and Flow 3's
 *     diagram both write, over Flow 3's prose "outside THIS range".
 *
 * `no_match_for_project` had no specced copy at all; the ruling approved this
 * wording and it now lives in `design-system.md`'s Empty states section beside
 * the other two. `__tests__/session-list.test.tsx` pins all three against those
 * documents, so drift breaks a test rather than shipping.
 *
 * ===========================================================================
 * A COUNT TAKEN FROM A TRUNCATED PAGE IS SPELLED `N+`.
 * ===========================================================================
 * The page it was counted from stopped at {@link LIST_LIMIT}, so the exact
 * number is not known. Rendering it bare would be a precise lie where an
 * imprecise truth was available.
 */
export function emptyStateCopy(state: EmptyStateShown): EmptyStateCopy {
  if (state.kind === 'never_captured') {
    return {
      sentence: 'No sessions yet — start a Claude Code session and it will appear here live',
      hint: 'Not seeing one? agent-lens doctor reports whether capture is installed.',
    };
  }
  if (state.kind === 'outside_range') {
    const amount = countText(state.count, state.truncated);
    return {
      sentence: `${amount} ${state.count === 1 && !state.truncated ? 'session' : 'sessions'} outside range`,
      hint: 'Widen the time range to bring them into view.',
    };
  }
  return {
    sentence:
      `No sessions in ${state.project} in this range — ` +
      `${countText(state.count, state.truncated)} in this range across all projects.`,
    hint: 'Show all projects.',
  };
}

function countText(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}

/* -------------------------------------------------------------- cursor ---- */

export type CursorIntent =
  { kind: 'move'; index: number } | { kind: 'open'; index: number } | { kind: 'ignore' };

export interface CursorContext {
  index: number;
  rowCount: number;
  /** A text control has focus — j and k are letters and belong to it. */
  inEditable: boolean;
}

/**
 * What a keystroke means, as data rather than as an effect.
 *
 * The editable guard lives here rather than inside the listener so it is
 * assertable: `j` and `k` are ordinary letters, and a table that swallows them
 * makes the project control impossible to type into.
 */
export function cursorIntent(
  key: string,
  { index, rowCount, inEditable }: CursorContext,
): CursorIntent {
  if (rowCount === 0 || inEditable) return { kind: 'ignore' };
  const current = Math.min(Math.max(index, 0), rowCount - 1);
  if (key === 'j') return { kind: 'move', index: Math.min(current + 1, rowCount - 1) };
  if (key === 'k') return { kind: 'move', index: Math.max(current - 1, 0) };
  if (key === 'Enter') return { kind: 'open', index: current };
  return { kind: 'ignore' };
}

/**
 * Carry out an intent, returning the cursor's new home or `null` for "nothing
 * happened".
 *
 * One injected port and no globals, which is what turns "enter navigates rows"
 * from a caveat into an assertion — Task 5.1c shipped `HistoryPort` for exactly
 * this. Opening leaves the cursor where it was: coming back should land on the
 * row that was left.
 */
export function applyIntent(
  intent: CursorIntent,
  rows: readonly Session[],
  router: Router,
): number | null {
  if (intent.kind === 'move') return intent.index;
  if (intent.kind === 'ignore') return null;
  const session = rows[intent.index];
  if (session === undefined) return null;
  router.navigate({ name: 'session', sessionId: session.id });
  return intent.index;
}

// --- The plan-001 adapter. Task 5.1 deletes this, with the `turn_count` fix
// --- and `last_activity_at` the same ruling assigns it.

/**
 * One `GET /api/sessions` row, in the shape the list screens still consume.
 *
 * Task 4.5's UI scope is compile-and-contract: the wire changed, the screens did
 * not, and the phase-4 ruling puts the screens in 5.1. Every field the v2 row
 * cannot supply is given a STATED default here rather than a plausible
 * invention, so a wrong number on screen traces to one line in one file.
 */
function toSession(row: SessionListRow): Session {
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
