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

import type { ApiClient, SessionListRow, SessionsQuery, TurnRow } from './api.js';
import type { Router } from './router.js';
import { costUnknownLabel } from './format.js';

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

/**
 * What the list cannot say about its own cost column, or `null` when it can
 * price every row it is showing.
 *
 * ===========================================================================
 * ★ THE DENOMINATOR IS WHAT IS ON SCREEN, AND NOTHING ELSE.
 * ===========================================================================
 * The corpus-wide reading — 283 of 293 sessions unpriced — counts every
 * projected session, sidecars included. This list draws only top-level ones
 * (`src/db/read.ts:291`; 21 of those 293 qualify), so printing the corpus
 * figure above it would be a false statement about the screen it sits on. This
 * counts the rows it was handed, and `formatRowCount` supplies the `N+` when
 * the page they came from stopped early — then both halves are lower bounds
 * and the sentence stays true.
 *
 * ===========================================================================
 * ★ NO STORED STATE AND NO DISMISSAL. THE RAISE IS THE DATA.
 * ===========================================================================
 * Task 7.3's rule, for the reason plan 001 learned twice: a strip whose raise
 * depends on stored, monotonic state has a downward path nobody proved. Price
 * the model and the next response carries numbers, so this returns `null` and
 * the strip goes on its own. There is nothing to clear, so no clear can be
 * outlived. A list that can price everything says nothing at all, because a
 * permanent notice trains the reader straight past it.
 *
 * The rows counted are the rows `costUnknownLabel` marks, called rather than
 * re-implemented: a second copy of the predicate could drift, and then the
 * strip would state a number the chips under it contradict.
 */
export function unpricedNotice(
  rows: readonly SessionListRow[],
  pageTruncated: boolean,
): string | null {
  const unpriced = rows.filter((row) => costUnknownLabel(row.est_cost, row.model) !== undefined);
  if (unpriced.length === 0) return null;

  const models = [
    ...new Set(unpriced.map((row) => row.model).filter((model): model is string => model !== null)),
  ].sort();
  const cause = models.length === 0 ? 'no model recorded' : `no rate for ${models.join(', ')}`;

  return (
    `Cost unknown on ${COUNT_FORMAT.format(unpriced.length)} of ` +
    `${formatRowCount(rows.length, pageTruncated)} shown — ${cause}. ` +
    'Token counts are exact; only the price multiplication is missing.'
  );
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
 * ★ NOT A QUERY PARAM. `src/server/api.ts` reads only
 * `limit/offset/sort/project/q`, and `parsePageParams` ignores an unknown param
 * rather than 400-ing — so a `?from` sent there would be a narrowing the reader
 * set and the server never applied. Task 5.1 was ruled to narrow on the client
 * over the one page instead of widening the route, so this value is what
 * {@link withinRange} compares against and nothing puts it on a URL.
 */
export function rangeBounds(range: TimeRange, now: number | Date): { from?: string } {
  if (range === 'all') return {};
  const millis = typeof now === 'number' ? now : now.getTime();
  return { from: new Date(millis - RANGE_DAYS[range] * DAY_MS).toISOString() };
}

/**
 * The rows of `page` whose LAST ACTIVITY falls inside `range`.
 *
 * ★ `last_activity_at`, NEVER `started_at`. The range answers "what have I been
 * working on", so a session opened seven days ago and typed into three minutes
 * ago belongs in `3d`. Selecting on the start instant answers "what did I
 * begin", which is a different question and drops exactly the long-running
 * sessions the reader is most likely to want back.
 */
export function withinRange(
  page: readonly SessionListRow[],
  range: TimeRange,
  now: number | Date,
): SessionListRow[] {
  const { from } = rangeBounds(range, now);
  if (from === undefined) return [...page];
  const bound = Date.parse(from);
  return page.filter((row) => {
    const at = Date.parse(row.last_activity_at);
    // An unparseable stamp keeps its row: hiding a session because its clock is
    // unreadable is the worse of the two failures.
    return !Number.isFinite(at) || at >= bound;
  });
}

/* ---------------------------------------------------------------- load ---- */

export interface SessionListData {
  /**
   * The in-range rows, NOT narrowed by project — they drive the project
   * selector's options, the histogram, and `no_match_for_project`'s count.
   */
  sessions: SessionListRow[];
  /** Rows exist behind the page, so the in-range set above may be short. */
  truncated: boolean;
  /**
   * How many rows of the SAME page fell outside the range. Never null now that
   * one page answers both questions, so `0` means "everything fetched is in
   * range" rather than "nobody asked".
   */
  outsideRangeCount: number;
  /** The outside-range COUNT is a floor rather than a total. */
  outsideRangeTruncated: boolean;
  /**
   * The server's own answer for `project`, narrowed to the range here, fetched
   * only when the client-side pass found nothing in a page that was truncated.
   * `null` means the rows above are authoritative and no second question needed
   * asking.
   */
  projectSessions: SessionListRow[] | null;
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
 * ONE UNFILTERED PAGE ANSWERS BOTH QUESTIONS.
 * ===========================================================================
 * Task 5.1 was ruled to narrow by range on the client rather than to widen
 * `/api/sessions` with a `from` param. So the request carries no range, the
 * page holds every recent session, and {@link withinRange} splits it. The
 * second, byte-identical "unfiltered probe" that used to run on an empty
 * in-range page is DELETED rather than left dead: it repeated the request it
 * was meant to widen, which is why `outside_range` was unreachable before.
 *
 * ===========================================================================
 * TWO TRUNCATION FLAGS, NOT ONE. THEY ANSWER DIFFERENT QUESTIONS.
 * ===========================================================================
 * Both now read the SAME page's `has_more`, and collapsing them into one field
 * would still be wrong, because two different sentences degrade on them:
 *
 *   - `truncated` -> "are there in-range rows I did not see?" It degrades the
 *     row count and `no_match_for_project`'s total to `N+`.
 *   - `outsideRangeTruncated` -> "is the outside-range COUNT a floor?" It
 *     degrades the `outside_range` sentence.
 *
 * They will part company the moment anything narrows before the split — a
 * server-side `from`, a second page, a project-scoped fetch — and a single flag
 * would then quietly answer the wrong one of the two.
 *
 * ===========================================================================
 * THE PROJECT RE-QUERY IS A TRUTH GUARD, NOT AN OPTIMISATION.
 * ===========================================================================
 * The project narrowing is client-side over ONE page. A project whose sessions
 * all sit past {@link LIST_LIMIT} is invisible to that narrowing, and the screen
 * would then say "no sessions in this project in this range" while the database
 * holds some. Degrading the COUNT to `N+` does not repair a false CLAIM. So when
 * — and only when — a TRUNCATED page narrows to nothing, the question is put to
 * the server, which supports `?project` natively and has a composite index for
 * exactly this shape. Its answer is unranged too, so it goes through
 * {@link withinRange} as well: feeding raw rows in would let sessions the reader
 * has excluded by time reappear under a project narrowing, and would put an
 * out-of-range total into an in-range sentence.
 */
export async function loadSessionList(
  api: ApiClient,
  { range, now, project, signal }: LoadOptions,
): Promise<SessionListData> {
  const options = signal === undefined ? undefined : { signal };
  const page = await api.listSessions({ limit: LIST_LIMIT }, options);
  const inRange = withinRange(page.items, range, now);

  const data: SessionListData = {
    sessions: inRange,
    truncated: page.has_more,
    outsideRangeCount: page.items.length - inRange.length,
    outsideRangeTruncated: page.has_more,
    projectSessions: null,
  };

  if (needsProjectProof(inRange, page.has_more, project)) {
    const narrowed = await api.listSessions(
      { project, limit: LIST_LIMIT } satisfies SessionsQuery,
      options,
    );
    data.projectSessions = withinRange(narrowed.items, range, now);
  }

  return data;
}

/**
 * Would claiming "no sessions in this project" be a guess rather than a fact?
 *
 * Only when a project was actually asked for, the page stopped short of the
 * whole set, and no row of that project appears in what did arrive.
 */
function needsProjectProof(
  items: readonly SessionListRow[],
  hasMore: boolean,
  project: string | undefined,
): project is string {
  if (project === undefined || project === '' || !hasMore) return false;
  return !items.some((row) => row.project_path === project);
}

/* -------------------------------------------------------------- select ---- */

/**
 * The columns the header strip can sort by — project and time, and nothing else.
 *
 * Cut from four at the phase-5 gate: four controls read as a tab bar whose only
 * feedback is a chevron. The time column is `last_activity_at`, the same instant
 * the range narrows on, so the strip and the range can never disagree about
 * which moment the screen is ordered by.
 */
export const SORT_COLUMNS = ['project_path', 'last_activity_at'] as const;

export type SortColumn = (typeof SORT_COLUMNS)[number];
export type SortDirection = 'asc' | 'desc';

/**
 * What each sort control is called.
 *
 * Beside the constant it labels rather than inside the component, so the strip's
 * test can iterate the two together and a column added without a label reds
 * instead of rendering an empty button.
 */
export const COLUMN_LABELS: Record<SortColumn, string> = {
  project_path: 'Project',
  last_activity_at: 'Last active',
};

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
export function selectRows(data: SessionListData, options: SelectOptions): SessionListRow[] {
  const pool = data.projectSessions ?? data.sessions;
  const narrowed =
    options.project === undefined || options.project === ''
      ? pool
      : pool.filter((row) => row.project_path === options.project);

  const sign = options.direction === 'asc' ? 1 : -1;
  return [...narrowed].sort((a, b) => {
    // Both sortable columns are ISO or path strings, so one comparison serves.
    const ordered = a[options.sort].localeCompare(b[options.sort]);
    return ordered !== 0 ? sign * ordered : a.id.localeCompare(b.id);
  });
}

/** Every project present in the page, sorted, for the narrowing control. */
export function projectsIn(rows: readonly SessionListRow[]): string[] {
  return [...new Set(rows.map((row) => row.project_path))].sort((a, b) => a.localeCompare(b));
}

/**
 * The text a row is labelled with: the harness's own title, else its first human
 * prompt, else the project it ran in.
 *
 * ★ THE REJECTION RULE IS STRUCTURAL, AND IT NAMES NO HARNESS STRING. A stored
 * label that opens with a tag bracket is markup the harness wrote to itself, not
 * prose a person typed, and 194 of 647 turn titles in the measured archive are
 * exactly that. Matching against a list of tag names here would put a second
 * reader of harness vocabulary outside `src/transcript/`, which RFC §7 forbids;
 * the SHAPE of the value is enough and stays true when the tag names change.
 */
export function rowLabel(row: SessionListRow): string {
  for (const candidate of [row.title, row.preview]) {
    const text = candidate?.trim() ?? '';
    if (text !== '' && !text.startsWith('<')) return text;
  }
  return row.project_path;
}

/**
 * Does this turn belong UNDER an Agent call rather than beside it?
 *
 * Task 5.2 renders the fold; this is the predicate it renders from, exported
 * here so the boundary is assigned rather than left to whoever merges second.
 * Structural on purpose — `kind` and a foreign key, no harness string — so it
 * opens no second door.
 */
export function foldsUnderAgent(turn: Pick<TurnRow, 'kind' | 'parent_event_id'>): boolean {
  return turn.kind === 'task_notification' && turn.parent_event_id !== null;
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
 * Session ACTIVITY, counted into a constant number of contiguous buckets.
 *
 * Counted on `last_activity_at`, the same instant the range narrows on, so a bar
 * can never sit outside the window its own row was selected by.
 *
 * Constant rather than range-dependent so the component draws the same number of
 * bars whatever the range, and never an empty pane: no sessions yields
 * all-zero bars, which is a shape rather than a hole.
 *
 * Buckets are half-open (`start <= t < end`) so a session landing exactly on an
 * internal boundary is counted once, never twice and never zero times. The last
 * bucket closes at its end so `now` itself still lands somewhere. For `all` the
 * window runs from the oldest activity to `now`, because there is no other lower
 * bound to draw against.
 */
export function volumeBuckets(
  sessions: readonly SessionListRow[],
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
    const at = Date.parse(session.last_activity_at);
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const index = Math.min(bucketCount - 1, Math.floor((at - start) / width));
    const bucket = buckets[index];
    if (bucket !== undefined) bucket.count += 1;
  }
  return buckets;
}

function windowStart(sessions: readonly SessionListRow[], range: TimeRange, end: number): number {
  if (range !== 'all') return end - RANGE_DAYS[range] * DAY_MS;
  const starts = sessions.map((s) => Date.parse(s.last_activity_at)).filter(Number.isFinite);
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
  rows: readonly SessionListRow[],
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
  if (data.outsideRangeCount > 0) {
    return {
      kind: 'outside_range',
      count: data.outsideRangeCount,
      truncated: data.outsideRangeTruncated,
    };
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
      hint: 'Not seeing one? agent-lens doctor reports what the archive holds.',
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
  rows: readonly SessionListRow[],
  router: Router,
): number | null {
  if (intent.kind === 'move') return intent.index;
  if (intent.kind === 'ignore') return null;
  const row = rows[intent.index];
  if (row === undefined) return null;
  router.navigate({ name: 'session', sessionId: row.id });
  return intent.index;
}
