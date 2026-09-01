import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  atBottom,
  followReducer,
  initialFollowState,
  pillLabel,
  FOLLOW_EPSILON_PX,
  type FollowAction,
  type FollowState,
} from '../live';

/*
 * AC3's follow-mode limb.
 *
 * The reducer, the copy and the at-the-end test are plain functions, so the
 * whole matrix is a table. The wiring between them and the screen is pinned
 * against source text, for the reason `span-tree.test.tsx:231-249` states: there
 * is no document here, so a scroll cannot be delivered and an effect never runs.
 */

const SESSION_VIEW = readFileSync(
  fileURLToPath(new URL('../../pages/SessionView.tsx', import.meta.url)),
  'utf8',
);

/** Fold a script of actions over the opening state. */
function run(...actions: FollowAction[]): FollowState {
  return actions.reduce(followReducer, initialFollowState);
}

describe('the follow state machine (AC3)', () => {
  it('follows from the moment a session opens', () => {
    expect(initialFollowState).toEqual({ following: true, pending: 0 });
  });

  it.each([
    ['appending while following leaves nothing pending', [{ type: 'appended', count: 4 }], true, 0],
    ['selecting a row pauses, and counts nothing yet', [{ type: 'selected' }], false, 0],
    [
      'events that arrive while paused are counted',
      [{ type: 'selected' }, { type: 'appended', count: 3 }],
      false,
      3,
    ],
    [
      'three appends while paused sum',
      [
        { type: 'selected' },
        { type: 'appended', count: 1 },
        { type: 'appended', count: 2 },
        { type: 'appended', count: 4 },
      ],
      false,
      7,
    ],
    [
      'scrolling away from the end pauses',
      [
        { type: 'scrolled', atBottom: false },
        { type: 'appended', count: 2 },
      ],
      false,
      2,
    ],
    [
      'scrolling back to the end resumes and clears the backlog',
      [{ type: 'selected' }, { type: 'appended', count: 5 }, { type: 'scrolled', atBottom: true }],
      true,
      0,
    ],
    [
      'the pill resumes and clears the backlog',
      [{ type: 'selected' }, { type: 'appended', count: 5 }, { type: 'resumed' }],
      true,
      0,
    ],
    [
      'a new turn arriving while following does not pause',
      [
        { type: 'appended', count: 1 },
        { type: 'appended', count: 12 },
      ],
      true,
      0,
    ],
    [
      'reset opens the next session following, with nothing pending',
      [{ type: 'selected' }, { type: 'appended', count: 9 }, { type: 'reset' }],
      true,
      0,
    ],
  ] as [string, FollowAction[], boolean, number][])('%s', (_label, actions, following, pending) => {
    expect(run(...actions)).toEqual({ following, pending });
  });

  it('never counts a negative append', () => {
    // A reprojection that removed events refetches from zero rather than
    // splicing, so the difference the page hands in is never below zero — and
    // the clamp keeps a bad reading from spelling a negative pill.
    expect(run({ type: 'selected' }, { type: 'appended', count: -5 })).toEqual({
      following: false,
      pending: 0,
    });
  });
});

describe('the pill copy (AC3)', () => {
  it.each([
    ['while following', { following: true, pending: 0 }, null],
    ['while following with a stale count', { following: true, pending: 4 }, null],
    ['paused with nothing new', { following: false, pending: 0 }, null],
    ['paused with one event', { following: false, pending: 1 }, '1 new event'],
    ['paused with seven', { following: false, pending: 7 }, '7 new events'],
  ] as [string, FollowState, string | null][])('%s', (_label, state, label) => {
    expect(pillLabel(state)).toBe(label);
  });
});

describe('at-the-end, to within the epsilon (AC3)', () => {
  const metrics = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 });

  it.each([
    ['exactly at the end', 600, true],
    ['one pixel inside the epsilon', 600 - FOLLOW_EPSILON_PX, true],
    ['one pixel outside it', 600 - FOLLOW_EPSILON_PX - 1, false],
    ['scrolled well up', 0, false],
    // A rounding overshoot: browsers report fractional heights, and a strict
    // equality here would drop out of follow mode at the bottom of the list.
    ['overshot by a fraction', 600.5, true],
  ])('%s', (_label, scrollTop, expected) => {
    expect(atBottom(metrics(scrollTop))).toBe(expected);
  });
});

/* ------------------------------------------- the wiring, as source text --- */

describe('the session view is wired to the reducer (AC3)', () => {
  it('pauses the tail when a row is selected', () => {
    expect(SESSION_VIEW, 'reading beats following — 04-live-tail.md:18').toContain(
      "dispatchFollow({ type: 'selected' })",
    );
  });

  it('resets follow when the session that arrived changes', () => {
    // Beside the sub-agent reset, and for the same reason: state belonging to
    // the previous session must not outlive it.
    expect(SESSION_VIEW).toMatch(
      /dispatchSub\(\{ type: 'reset' \}\);[\s\S]{0,400}dispatchFollow\(\{ type: 'reset' \}\)/,
    );
  });

  it('hands the tree a follow index ONLY while following', () => {
    // Structural, not conditional-on-a-flag-inside-the-tree: while paused there
    // is no index at all, so a programmatic scroll cannot land under a reader.
    expect(SESSION_VIEW).toContain(
      'followIndex={follow.following && rows.length > 0 ? rows.length - 1 : undefined}',
    );
  });

  it('turns a scroll into an atBottom decision made in live.ts', () => {
    expect(SESSION_VIEW).toContain(
      "dispatchFollow({ type: 'scrolled', atBottom: atBottom(metrics)",
    );
  });

  it('asks for exactly one page, at the frame cursor, with no offset', () => {
    /*
     * Source text, and it has to be: the request is issued inside an effect and
     * effects never run under `environment: 'node'`. The WIRE half of this
     * claim — that `from_seq` travels as a cursor and never as an offset — is
     * behavioural, in `api.test.ts`'s "getSession sends from_seq as a cursor".
     */
    expect(SESSION_VIEW).toContain(
      '.getSession(sessionId, { from_seq: decision.from_seq, limit: EVENT_LIMIT })',
    );
    expect(SESSION_VIEW, 'an offset renumbers a page that is growing under it').not.toContain(
      'offset',
    );
  });

  it('never clears the overlay on the refetch branch', () => {
    /*
     * Clearing it walks the render `overlay -> stale -> null -> new`, and at
     * `null` the page blanks: the scroll anchor and the virtualizer's
     * measurement cache both go, and the scroll event that follows reaches the
     * reducer as a reader who moved. `overlayData` retires the overlay by
     * identity instead, with no cleanup path to get wrong.
     */
    const refetchBranch = SESSION_VIEW.slice(
      SESSION_VIEW.indexOf("if (decision.kind === 'refetch')"),
      SESSION_VIEW.indexOf('.getSession(sessionId'),
    );
    expect(refetchBranch, 'the refetch branch bumps the token AND NOTHING ELSE').toContain(
      'setRefresh((token) => token + 1)',
    );
    expect(refetchBranch).not.toContain('setOverlay');
  });

  it('reads the load through the refresh token useAsync was given for it', () => {
    expect(SESSION_VIEW).toMatch(/useAsync<SessionData>\([\s\S]{0,200}refresh,\s*\)/);
  });
});
