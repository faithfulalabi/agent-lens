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

import { stripModelId } from '@shared/model-id.ts';

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

/** The reading order inside one session: a bare 24-hour wall clock. */
const WALL_CLOCK = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** The qualifier a row gets when its day is not the session's first day. */
const EVENT_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/**
 * Calendar identity in the reader's zone, year included so two July 30ths a year
 * apart are two days. {@link EVENT_DAY} is the label and cannot do this: it
 * would call them the same day.
 */
const DAY_KEY = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
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
 * `0` renders as the em dash, NOT as `$0` — `design-system.md:153` and
 * `spec/data-model.md:269` both state that mapping, and it is what the
 * acceptance criterion cashes out to.
 *
 * ===========================================================================
 * THIS FUNCTION CANNOT TELL THE TWO ABSENCES APART. {@link costUnknownLabel} CAN.
 * ===========================================================================
 * ⚠️ CORRECTED 2026-09-03. This comment used to claim `est_cost` is never null
 * on the wire, on the strength of a `NOT NULL DEFAULT 0` column and a
 * `COALESCE(…, 0)` in `src/db/rollups.ts:130`. Both claims are false: the
 * column is nullable and carries the note "NULL = unpriceable model, NEVER 0"
 * (`src/db/schema.ts:97`), and that rollups module no longer exists. The stale
 * premise is what let a missing price and a measured zero be read as one state.
 *
 * They are two different absences and neither has an honest currency spelling,
 * so both still render the em dash here. What separates them is the label
 * below, which the caller hands to the chip as `title` and `aria-label`: one
 * spelling on screen, two states in the markup.
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

/**
 * Why a cost is missing, when it is missing because no rate was found for the
 * model — and `undefined` when the number is real, including a real zero.
 *
 * Cost is `tokens × rate` (`src/shared/pricing.ts:139-146`), so on a priced
 * model a `0` is reachable only when every token count is zero. Re-spelling
 * that zero as `$0.00` would swap one absence for a falsehood, which is why the
 * distinction rides in `title` and `aria-label` instead of in the chip text —
 * `design-system.md:141`'s treatment for an unknown, verbatim.
 */
export function costUnknownLabel(
  value: number | null | undefined,
  model: string | null,
): string | undefined {
  if (isUsableNumber(value)) return undefined;
  return model === null
    ? 'cost unknown — no model recorded'
    : `cost unknown — no rate for ${model}`;
}

/** The harness's zero-token marker. Never a model a session "used". */
const SYNTHETIC_MODEL = '<synthetic>';

/** `claude-opus-5-5` → family `opus`, version `5-5`. */
const FAMILY_FIRST = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/;

/** The legacy order, `claude-3-5-haiku` → version `3-5`, family `haiku`. */
const VERSION_FIRST = /^claude-(\d+(?:-\d+)*)-([a-z]+)$/;

function familyVersion(family: string, version: string): string {
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.replace(/-/g, '.')}`;
}

/**
 * A short display name for a model id: `claude-fable-5-1` → `Fable 5.1`,
 * `us.anthropic.claude-sonnet-4-5-20250929[1m]` → `Sonnet 4.5`. Recognises the
 * id's SHAPE, not a known family list, so a new family names itself on day one.
 * Anything else comes back verbatim — an unknown id is shown, never dropped.
 */
export function shortModelName(raw: string): string {
  const bare = stripModelId(raw);
  const familyFirst = FAMILY_FIRST.exec(bare);
  if (familyFirst !== null) return familyVersion(familyFirst[1]!, familyFirst[2]!);
  const versionFirst = VERSION_FIRST.exec(bare);
  if (versionFirst !== null) return familyVersion(versionFirst[2]!, versionFirst[1]!);
  return raw;
}

/**
 * The session list's Model cell. The text is the main session's dominant model,
 * plus `+N` for every other model the session or its sub-agents used; two ids
 * that shorten to the same name count once. The title names every full id,
 * sub-agent-only ones after a `sub-agents:` marker. No model at all is the em
 * dash, the one spelling for an absent value.
 */
export function modelCell(
  models: readonly string[],
  sub_models: readonly string[],
): { text: string; title: string | undefined } {
  const own = [...new Set(models)].filter((id) => id !== SYNTHETIC_MODEL);
  const subOnly = [...new Set(sub_models)].filter(
    (id) => id !== SYNTHETIC_MODEL && !own.includes(id),
  );
  const names = [...new Set([...own, ...subOnly].map(shortModelName))];
  if (names.length === 0) return { text: NO_VALUE, title: undefined };

  const text = names.length === 1 ? names[0]! : `${names[0]!} +${names.length - 1}`;
  const title = [
    ...(own.length > 0 ? [own.join(', ')] : []),
    ...(subOnly.length > 0 ? [`sub-agents: ${subOnly.join(', ')}`] : []),
  ].join(' · ');
  return { text, title };
}

/** A token count with thousands separators. `0` is a real answer, not a gap. */
export function formatTokens(value: number | null | undefined): string {
  if (!isUsableNumber(value)) return NO_VALUE;
  return COUNT.format(value);
}

/**
 * The one spelling of an elapsed interval, shared by both public entry points
 * so a millisecond count and a pair of timestamps can never drift apart.
 * Callers own the sign check; this speller assumes a non-negative input.
 */
function spellElapsed(elapsed: number): string {
  if (elapsed < 1000) return `${Math.round(elapsed)}ms`;
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(2)}s`;

  const totalSeconds = Math.round(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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
  return spellElapsed(elapsed);
}

/**
 * The same interval, already reduced to a millisecond count.
 *
 * `Trace.duration_ms` arrives from the server as a raw number, and every
 * subtree rollup in `span-tree.ts` produces one, so there is nothing left to
 * parse — round-tripping through ISO strings just to reach {@link
 * formatDuration} would cost two `Date.parse`es per row for no answer this
 * cannot already give.
 *
 * A negative count reads as the em dash rather than as a negative duration.
 * The server clamps its own rollups at zero for that reason (`db/rollups.ts`),
 * but a value can still reach the browser from an older row, and "-3s" is a
 * nonsense no screen should ever show.
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (!isUsableNumber(ms) || ms < 0) return NO_VALUE;
  return spellElapsed(ms);
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

/**
 * When one event happened, as an absolute reading rather than an age.
 *
 * ===========================================================================
 * THE DAY IS SPELLED OUT WHENEVER THE DAY CHANGES.
 * ===========================================================================
 * {@link formatStartedAt} answers `Nm ago` for anything inside 24 hours, so
 * every event of a same-day session renders the identical string — which is not
 * a reading order at all. A bare wall clock fixes that and breaks something
 * else: MEASURED, 11 of 293 sessions cross a calendar day, 8 run over 24 hours
 * and the widest spans 230.9 hours. On those, `23:59:00` followed by `00:01:00`
 * reads as though the session ran backwards.
 *
 * So `sessionStart` qualifies the row: same day as the session's first event and
 * the answer is the bare clock, a different day and the date leads it. Omit the
 * argument and the clock is unqualified, which is right for a caller that has no
 * session to compare against.
 */
export function formatEventTime(iso: string, sessionStart?: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return NO_VALUE;

  const clock = WALL_CLOCK.format(at);
  if (sessionStart === undefined) return clock;

  const first = Date.parse(sessionStart);
  if (!Number.isFinite(first) || DAY_KEY.format(first) === DAY_KEY.format(at)) return clock;
  return `${EVENT_DAY.format(at)} ${clock}`;
}

/* ------------------------------------------------------------- payloads --- */

/**
 * How much of an input or an output a TREE row's second line shows.
 *
 * It lives here rather than in `SpanRow.tsx` because the thread clamps the same
 * payloads at its own, larger budget, and two private clamps that drift apart
 * would render one body at two lengths on two screens.
 */
export const PREVIEW_CHARS = 96;

/** One line of an input or an output, clamped. Never the whole 64 KB. */
export function previewOf(value: string | null, max: number = PREVIEW_CHARS): string | null {
  if (value === null) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
