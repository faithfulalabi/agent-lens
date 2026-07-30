/*
 * Display formatters, shared by Tasks 5.2b, 5.3 and 5.4.
 *
 * ===========================================================================
 * EVERY Intl FORMATTER IS BUILT ONCE, AT MODULE LOAD.
 * ===========================================================================
 * Constructing an `Intl` formatter costs roughly two orders of magnitude more
 * than calling `.format()` on one, and the session list calls into this module
 * four times per row across hundreds of rows. Moving any construction below
 * into a function body is the one change here that turns a fast screen into a
 * slow one, and `__tests__/format.test.ts` counts the constructions to stop it.
 *
 * Two further rules:
 *
 *   - **Every function is total.** Nothing throws; unusable input yields the
 *     em dash. These run inside render, where a throw is a blank screen.
 *   - **The clock is a parameter.** Nothing here reads `Date.now()`. A live
 *     session's elapsed time is derived from an injected `now`, which is what
 *     makes it assertable at all.
 */

/** What the design system renders in place of an unknown or absent number. */
const NO_VALUE = '—';

/** Below this, no decimal spelling is honest, so the answer is a bound. */
const SMALLEST_SHOWN_COST = 0.001;

/** Under a cent, two decimals would read as `$0.00`, so three are used. */
const NEEDS_THREE_DECIMALS = 0.01;

/** Beyond this age a timestamp reads better as a date than as an interval. */
const RELATIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MONEY = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const SMALL_MONEY = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const COUNT = new Intl.NumberFormat('en-US');

const CALENDAR_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function isUsableNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function millisOf(when: number | Date): number {
  return typeof when === 'number' ? when : when.getTime();
}

/**
 * Estimated cost.
 *
 * `0` renders as the em dash, NOT as `$0`. That is the whole rule, and it is
 * the one the acceptance criterion cashes out to: a session's `est_cost` is
 * never null on the wire — the column is `NOT NULL DEFAULT 0` and
 * `src/db/rollups.ts:130` wraps the sum in `COALESCE(…, 0)` — so "unpriced"
 * arrives as zero and nothing else. `design-system.md:141` mandates the same
 * mapping independently. Null and undefined are still handled, because span
 * level costs genuinely are nullable and Task 5.4 will pass them here.
 *
 * `$0.00` is unreachable by construction, not just for the zero case: a real
 * cost under a cent gets a third decimal, and one under a tenth of a cent gets
 * the `<` bound. A priced session that reads as free is the same lie whether
 * the zero came from the database or from rounding.
 */
export function formatCost(value: number | null | undefined): string {
  if (!isUsableNumber(value) || value === 0) return NO_VALUE;
  const magnitude = Math.abs(value);
  if (magnitude < SMALLEST_SHOWN_COST) return `<$${SMALLEST_SHOWN_COST}`;
  if (magnitude < NEEDS_THREE_DECIMALS) return `$${SMALL_MONEY.format(value)}`;
  return `$${MONEY.format(value)}`;
}

/** A token count with thousands separators. `0` is a real answer, not a gap. */
export function formatTokens(value: number | null | undefined): string {
  if (!isUsableNumber(value)) return NO_VALUE;
  return COUNT.format(value);
}

/**
 * How long something ran.
 *
 * `endedAt` absent means it is still running, and then `now` is what closes the
 * interval — pass it for a live row and the elapsed time advances with the
 * caller's clock. Omit BOTH and the answer is genuinely unknown, so the em dash
 * is returned rather than a duration computed from `NaN`.
 */
export function formatDuration(startedAt: string, endedAt?: string, now?: number | Date): string {
  const start = Date.parse(startedAt);
  const end =
    endedAt === undefined ? (now === undefined ? Number.NaN : millisOf(now)) : Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return NO_VALUE;

  const elapsed = end - start;
  if (elapsed < 0) return NO_VALUE;
  if (elapsed < 1000) return `${Math.round(elapsed)}ms`;
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(2)}s`;

  const totalSeconds = Math.round(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * When something began, as an interval for anything recent and as a calendar
 * day beyond that. `now` is a parameter for the same reason it is on
 * {@link formatDuration}: an ambient clock makes the output untestable.
 *
 * The calendar spelling is rendered in the reader's own zone, which is right
 * for a tool that only ever runs on the reader's machine.
 */
export function formatStartedAt(iso: string, now: number | Date): string {
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return NO_VALUE;

  const age = millisOf(now) - started;
  if (age < 0 || age >= RELATIVE_WINDOW_MS) return CALENDAR_DAY.format(started);
  if (age < 60_000) return 'just now';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
