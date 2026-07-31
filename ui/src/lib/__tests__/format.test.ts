import { describe, it, expect, vi } from 'vitest';

import {
  formatCost,
  formatDuration,
  formatDurationMs,
  formatStartedAt,
  formatTokens,
} from '../format';
import { makeSession, makeTrace } from './fixtures';

/*
 * AC2 — Tests 3 to 6 of the task plan.
 *
 * The session factory is used rather than bare literals so that a change to
 * `@shared/entities.ts` reaches these assertions as a compile error.
 */

const NO_VALUE = '—';

/* --------------------------------------------------------------- Test 3 --- */

describe('formatCost never spells a priced session as free', () => {
  it.each([
    // Zero is THE case the acceptance criterion is about. A session's est_cost
    // is `NOT NULL DEFAULT 0` and src/db/rollups.ts:130 sums it under
    // COALESCE(…, 0), so "unpriced" reaches the browser as 0 and never as null.
    [0, NO_VALUE],
    [null, NO_VALUE],
    [undefined, NO_VALUE],
    [Number.NaN, NO_VALUE],
    [0.0004, '<$0.001'],
    [0.001, '$0.001'],
    [0.0042, '$0.004'],
    [1.2345, '$1.23'],
    [1234.5, '$1,234.50'],
  ])('%s renders as %s', (value, expected) => {
    expect(formatCost(value)).toBe(expected);
  });

  it('renders a real session cost, and the zero session as the em dash', () => {
    expect(formatCost(makeSession({ est_cost: 0.0123 }).est_cost)).toBe('$0.01');
    expect(formatCost(makeSession({ est_cost: 0 }).est_cost)).toBe(NO_VALUE);
  });
});

/* ------------------------------------------------- Test 5 (formatTokens) --- */

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1,000'],
    [1234567, '1,234,567'],
    [null, NO_VALUE],
    [undefined, NO_VALUE],
  ])('%s renders as %s', (value, expected) => {
    expect(formatTokens(value)).toBe(expected);
  });

  it('separates thousands for a real session total', () => {
    expect(formatTokens(makeSession({ total_tokens: 48250 }).total_tokens)).toBe('48,250');
  });
});

/* --------------------------------------------------------------- Test 4 --- */

describe('formatDuration reads the injected clock and never the ambient one', () => {
  const live = makeSession({
    status: 'live',
    started_at: '2026-07-29T09:00:00.000Z',
    ended_at: undefined,
  });

  it('gives a different answer for the same live session at two clocks', () => {
    const early = formatDuration(
      live.started_at,
      live.ended_at,
      Date.parse('2026-07-29T09:00:30.000Z'),
    );
    const later = formatDuration(
      live.started_at,
      live.ended_at,
      Date.parse('2026-07-29T09:05:00.000Z'),
    );
    expect(early).toBe('30.00s');
    expect(later).toBe('5m 0s');
    expect(early).not.toBe(later);
  });

  it('closes a completed session at its own end, ignoring the clock entirely', () => {
    const done = makeSession({
      started_at: '2026-07-29T09:00:00.000Z',
      ended_at: '2026-07-29T09:30:00.000Z',
    });
    const atOneClock = formatDuration(done.started_at, done.ended_at, Date.parse('2027-01-01'));
    const atAnother = formatDuration(done.started_at, done.ended_at, Date.parse('2030-01-01'));
    expect(atOneClock).toBe('30m 0s');
    expect(atAnother).toBe(atOneClock);
  });

  it('answers the em dash, never NaN, for an open interval with no clock', () => {
    const answer = formatDuration(live.started_at, undefined, undefined);
    expect(answer).toBe(NO_VALUE);
    expect(answer).not.toContain('NaN');
  });

  it.each([
    ['2026-07-29T09:00:00.000Z', '2026-07-29T09:00:00.020Z', '20ms'],
    ['2026-07-29T09:00:00.000Z', '2026-07-29T09:00:01.020Z', '1.02s'],
    ['2026-07-29T09:00:00.000Z', '2026-07-29T09:02:03.000Z', '2m 3s'],
    ['2026-07-29T09:00:00.000Z', '2026-07-29T11:07:00.000Z', '2h 7m'],
  ])('%s -> %s renders as %s', (started, ended, expected) => {
    expect(formatDuration(started, ended)).toBe(expected);
  });

  it.each([
    ['not a timestamp', undefined],
    ['2026-07-29T09:00:00.000Z', 'not a timestamp'],
  ])('answers the em dash for unparseable input (%s, %s)', (started, ended) => {
    expect(formatDuration(started, ended, Date.parse('2026-07-29T10:00:00.000Z'))).toBe(NO_VALUE);
  });
});

/* ------------------------------------------- Task 5.3a, Test 16 (ms) --- */

describe('formatDurationMs spells a raw millisecond count', () => {
  it.each([
    [undefined, NO_VALUE],
    [null, NO_VALUE],
    [Number.NaN, NO_VALUE],
    [Number.POSITIVE_INFINITY, NO_VALUE],
    // A negative duration is a nonsense the screen must never show. The server
    // clamps its own rollups at zero for the same reason (db/rollups.ts), but
    // an older row can still carry one to the browser.
    [-1, NO_VALUE],
    [-60_000, NO_VALUE],
    [0, '0ms'],
  ])('%s renders as %s', (value, expected) => {
    expect(formatDurationMs(value)).toBe(expected);
  });

  it.each([
    [20, '20ms'],
    [999, '999ms'],
    [1_020, '1.02s'],
    [59_999, '60.00s'],
    [123_000, '2m 3s'],
    [7_620_000, '2h 7m'],
  ])('%sms renders as %s', (value, expected) => {
    expect(formatDurationMs(value)).toBe(expected);
  });

  it.each([
    ['2026-07-29T09:00:00.000Z', '2026-07-29T09:00:00.020Z'],
    ['2026-07-29T09:00:00.000Z', '2026-07-29T09:00:01.020Z'],
    ['2026-07-29T09:00:00.000Z', '2026-07-29T09:02:03.000Z'],
    ['2026-07-29T09:00:00.000Z', '2026-07-29T11:07:00.000Z'],
  ])('agrees with formatDuration across %s -> %s', (started, ended) => {
    // One speller, two entry points. This is what stops the millisecond path
    // from drifting away from the timestamp path a boundary at a time.
    expect(formatDurationMs(Date.parse(ended) - Date.parse(started))).toBe(
      formatDuration(started, ended),
    );
  });

  it('spells the duration a turn actually arrives with', () => {
    // Trace.duration_ms is a plain number on the wire — the reason this
    // function exists at all, since formatDuration only accepts ISO strings.
    expect(formatDurationMs(makeTrace({ duration_ms: 1_020 }).duration_ms)).toBe('1.02s');
  });
});

/* ---------------------------------------------- Test 5 (formatStartedAt) --- */

describe('formatStartedAt switches from an interval to a calendar day at 24h', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');
  const at = (isoOffsetMs: number): string =>
    formatStartedAt(new Date(now - isoOffsetMs).toISOString(), now);

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it.each([
    [30_000, 'just now'],
    [MINUTE, '1m ago'],
    [59 * MINUTE, '59m ago'],
    [HOUR, '1h ago'],
    [23 * HOUR, '23h ago'],
  ])('%sms ago renders as %s', (age, expected) => {
    expect(at(age)).toBe(expected);
  });

  it('crosses to the calendar spelling exactly at the boundary', () => {
    expect(at(DAY - MINUTE)).toBe('23h ago');
    const older = at(DAY);
    expect(older).not.toContain('ago');
    // The zone is the reader's own, so the assertion is on the SHAPE — the
    // exact hour depends on where the machine running this thinks it is.
    expect(older).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/);
  });

  it('answers the em dash for an unparseable timestamp', () => {
    expect(formatStartedAt('whenever', now)).toBe(NO_VALUE);
  });
});

/* --------------------------------------------------------------- Test 6 --- */

describe('every Intl formatter is built once, at module load', () => {
  it('formatting 300 rows constructs no further formatter', async () => {
    const numbers = vi.spyOn(Intl, 'NumberFormat');
    const dates = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      vi.resetModules();
      const format = await import('../format');

      const atLoad = { numbers: numbers.mock.calls.length, dates: dates.mock.calls.length };
      expect(
        atLoad.numbers,
        'the NumberFormat spy saw nothing — it is not wired up',
      ).toBeGreaterThan(0);
      expect(
        atLoad.dates,
        'the DateTimeFormat spy saw nothing — it is not wired up',
      ).toBeGreaterThan(0);

      const now = Date.parse('2026-07-29T12:00:00.000Z');
      for (let row = 0; row < 300; row += 1) {
        format.formatCost(0.0123 + row);
        format.formatTokens(1234 + row);
        format.formatDuration('2026-07-29T09:00:00.000Z', '2026-07-29T09:00:01.020Z');
        format.formatStartedAt('2026-07-20T09:00:00.000Z', now);
      }

      expect(
        { numbers: numbers.mock.calls.length, dates: dates.mock.calls.length },
        'a formatter is being constructed per call. Hoist it to module scope: ' +
          'constructing one costs ~100x what formatting with it does.',
      ).toEqual(atLoad);
    } finally {
      numbers.mockRestore();
      dates.mockRestore();
      vi.resetModules();
    }
  });
});
