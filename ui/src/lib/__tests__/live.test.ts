import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventRow, SessionDetailBody, TurnRow } from '../api';
import {
  applyFrame,
  decideFrame,
  isLive,
  LIVE_WINDOW_MS,
  movedBackwards,
  overlayData,
  parseFingerprint,
  patchListRow,
  spliceEvents,
  createLiveBus,
} from '../live';
import { bucketByTurn, type SessionData } from '../session-data';
import type { SessionListData } from '../session-list';
import { makeChangedFrame, makeSessionRow, makeTurnTree, type TurnTreeSpec } from './fixtures';

/*
 * AC1's source scan, AC2's three splice branches, and AC3's list patch.
 *
 * Everything here is a plain function over plain data. That is the whole design
 * of `live.ts`: the `ui` project runs under `environment: 'node'`, so a decision
 * left inside a component or an effect could not be asserted at all.
 */

/* ------------------------------------- AC1: the deleted vocabulary, gone --- */

const UI_SRC = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The patterns AC1 says must not appear, held as data and fed to the scanner —
 * so the scanner can be driven over a fixture, and so this file's own text is
 * never the thing that trips it.
 *
 * ★ THE PATTERN SET IS THE LOAD-BEARING PART, NOT THE SCOPE.
 * Two obvious spellings would red against this task's own prescribed end state:
 *
 *   - a bare `from_seq` survives in `ui/src/lib/api.ts` (the typed query, on the
 *     do-not-touch list) and the splice ADDS occurrences of its own. `from_seq`
 *     is the splice's vocabulary; banning the token bans the feature.
 *   - a bare `EventSource` matches the prose at `sse.ts:5` explaining why the
 *     native one cannot be used — in a file this task deliberately keeps. Hence
 *     a CONSTRUCTION, which prose does not contain.
 */
const BANNED: ReadonlyMap<string, RegExp> = new Map([
  ['RESUME_PARAM', /RESUME_PARAM/i],
  ['stream_id', /stream_?id/i],
  ['resume verdict', /resume ?verdict/i],
  ['new EventSource(', /new EventSource\(/],
]);

/** Production TS/TSX under `ui/src` — `__tests__` lifted, as `sql-one-door` does. */
function uiSourceFiles(): string[] {
  return readdirSync(UI_SRC, { recursive: true, encoding: 'utf8' })
    .map((name) => name.split('\\').join('/'))
    .filter((name) => /\.tsx?$/.test(name))
    .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'))
    .filter((name) => !name.includes('__tests__/'))
    .sort();
}

/** One hit per matching line per pattern. `text` is defaulted so a control can feed a fixture. */
function scanFile(file: string, text = readFileSync(join(UI_SRC, file), 'utf8')): string[] {
  const hits: string[] = [];
  for (const [name, pattern] of BANNED) {
    for (const [index, line] of text.split('\n').entries()) {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}:${name} — ${line.trim()}`);
    }
  }
  return hits;
}

describe('AC1 — the per-session resume vocabulary is gone from ui/src', () => {
  it('finds no resume param, stream id, resume verdict or EventSource construction', () => {
    const files = uiSourceFiles();

    // Vacuity guard: an empty file list would green the loop below.
    expect(files, 'the scan must reach the module it is about').toContain('lib/sse.ts');
    expect(files.length).toBeGreaterThan(20);

    expect(files.flatMap((file) => scanFile(file))).toEqual([]);
  });

  it('the scanner finds a planted hit, so the clean result above means something', () => {
    const planted = ['const url = new EventSource(path);', 'const RESUME_PARAM = 1;'].join('\n');
    expect(scanFile('lib/planted.ts', planted)).toHaveLength(2);
  });
});

/* --------------------------------------------------- the in-memory oracle --- */

const SESSION_ID = 'seed-s0';

interface Archive {
  turns: TurnRow[];
  events: EventRow[];
  fingerprint: string;
}

function archiveOf(specs: TurnTreeSpec[], fingerprint: string): Archive {
  const tree = makeTurnTree(specs);
  return {
    turns: tree.turns,
    events: [...tree.eventsByTurn.values()].flat(),
    fingerprint,
  };
}

/**
 * `GET /api/sessions/:id?from_seq=` over an in-memory archive.
 *
 * `seq >= from_seq`, INCLUSIVE — the same rule as `src/db/read.ts:468`. Five
 * lines, so "the splice equals a cold GET" is a real oracle rather than the
 * splice checking itself. `turns`, `session` and `fingerprint` come back WHOLE
 * whatever the cursor, exactly as `src/server/api.ts:436-450` serves them.
 */
function serve(archive: Archive, from_seq = 0): SessionDetailBody {
  const events = archive.events.filter((event) => event.seq >= from_seq);
  return {
    session: { ...makeSessionRow({ id: SESSION_ID }), projection: { state: 'ready' } },
    turns: archive.turns,
    events,
    next_seq: (events[events.length - 1]?.seq ?? -1) + 1,
    has_more: false,
    fingerprint: archive.fingerprint,
  };
}

/** What the client holds after a cold load of `archive`. */
function coldLoad(archive: Archive): SessionData {
  const body = serve(archive);
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

/** Two turns of three events: seq 0-2 in turn 1, seq 3-5 in turn 2. */
function twoTurns(tail: Partial<EventRow>[] = []): TurnTreeSpec[] {
  return [
    {
      id: `${SESSION_ID}:1`,
      seq: 1,
      events: [{ name: 'Read' }, { name: 'Agent' }, { name: 'Bash' }],
    },
    {
      id: `${SESSION_ID}:2`,
      seq: 2,
      events: [{ name: 'Grep' }, { name: 'Edit' }, { name: 'Write' }, ...tail],
    },
  ];
}

/** `first_seq` of the last turn — what the server puts on the frame. */
function lastTurnStart(archive: Archive): number {
  const last = archive.turns[archive.turns.length - 1];
  if (last === undefined) throw new Error('the fixture has no turns');
  return last.first_seq;
}

/* ------------------------------- AC2 branch 1: the epoch moved backwards --- */

describe('AC2 branch 1 — a fingerprint that moved backwards refetches from zero', () => {
  it('parses the three components, and refuses anything else', () => {
    expect(parseFingerprint('900:500:2')).toEqual({ mtime_ms: 900, size: 500, sidecar_count: 2 });
    expect(parseFingerprint('')).toBeUndefined();
    expect(parseFingerprint('abc:def:ghi')).toBeUndefined();
    expect(parseFingerprint('900:500')).toBeUndefined();
  });

  it('the mtime component moving backwards refetches', () => {
    expect(movedBackwards('900:500:2', '800:500:2')).toBe(true);
    expect(movedBackwards('900:500:2', '1000:600:2')).toBe(false);
  });

  it.each([
    ['a plain shrink', '900:500:2', '900:400:2'],
    // Sealing rewrites `x.jsonl` as a smaller `.zst` that the count stops
    // counting, so the count drops with the size. Two components see it.
    ['a sealed sidecar', '900:500:2', '900:120:1'],
  ])('the size component moving backwards refetches (%s)', (_label, before, after) => {
    expect(movedBackwards(before, after)).toBe(true);
  });

  it.each([
    ['an empty epoch on the left', '', '900:500:2'],
    ['an empty epoch on the right', '900:500:2', ''],
    ['an unparseable epoch', '900:500:2', 'abc:def:ghi'],
  ])('%s refetches rather than trusting a stale one', (_label, before, after) => {
    expect(movedBackwards(before, after)).toBe(true);
  });

  it('sidecar_count alone never refetches, in either direction', () => {
    // The negative control that keeps `movedBackwards` from growing a third
    // comparison: a count that moves on its own carries no lost bytes.
    expect(movedBackwards('900:500:2', '900:500:3')).toBe(false);
    expect(movedBackwards('900:500:2', '900:500:1')).toBe(false);
  });

  it('decideFrame answers refetch, and the page in hand is left alone', () => {
    const data = coldLoad(archiveOf(twoTurns(), '900:500:2'));
    const frame = makeChangedFrame({ session_id: SESSION_ID, fingerprint: '800:500:2' });

    expect(decideFrame(data, frame)).toEqual({ kind: 'refetch' });
  });
});

/* ---------------------------------- AC2 branches 2 and 3: the splice itself --- */

describe('AC2 branch 2 — drop, fetch, splice, and the result equals a cold GET', () => {
  it('splices three appended events into the last turn', () => {
    const before = archiveOf(twoTurns(), '900:500:2');
    const after = archiveOf(
      twoTurns([{ name: 'Read' }, { name: 'Bash' }, { name: 'Edit' }]),
      '1000:800:2',
    );
    const from_seq = lastTurnStart(after);
    const frame = makeChangedFrame({ session_id: SESSION_ID, from_seq, fingerprint: '1000:800:2' });

    const spliced = applyFrame(coldLoad(before), frame, serve(after, from_seq));

    // One line, and it is the acceptance criterion verbatim.
    expect(spliced.events).toEqual(serve(after).events);
    expect(spliced.events).toHaveLength(9);
  });

  it('drops every local event at or after the cursor before concatenating', () => {
    const local = [
      { id: 'a', seq: 0 },
      { id: 'b', seq: 1 },
      { id: 'c', seq: 2 },
    ] as unknown as EventRow[];
    const page = [
      { id: 'c2', seq: 2 },
      { id: 'd', seq: 3 },
    ] as unknown as EventRow[];

    // `seq >= from_seq` is inclusive on the server, so the client's drop must be
    // inclusive too: keeping `c` would duplicate the row the page re-serves.
    expect(spliceEvents(local, 2, page, []).map((event) => event.id)).toEqual([
      'a',
      'b',
      'c2',
      'd',
    ]);
  });

  it('takes turns, session and fingerprint from the response, never from the frame', () => {
    const before = archiveOf(twoTurns(), '900:500:2');
    // A third turn, opened by the append. Nothing else can draw its header.
    const after = archiveOf(
      [...twoTurns(), { id: `${SESSION_ID}:3`, seq: 3, events: [{ name: 'Read' }] }],
      '1200:900:2',
    );
    const from_seq = lastTurnStart(after);
    const frame = makeChangedFrame({
      session_id: SESSION_ID,
      from_seq,
      // Deliberately older than the response's: the epoch that announced the
      // bytes can already be behind the epoch of the bytes that were served.
      fingerprint: '1100:850:2',
    });

    const spliced = applyFrame(coldLoad(before), frame, serve(after, from_seq));

    expect(spliced.fingerprint).toBe('1200:900:2');
    expect(spliced.turns).toHaveLength(3);
    expect(spliced.turns.map((turn) => turn.id)).toContain(`${SESSION_ID}:3`);
    expect(spliced.eventsByTurn.get(`${SESSION_ID}:3`)).toHaveLength(1);
  });

  it('splicing the same frame twice changes nothing', () => {
    const before = archiveOf(twoTurns(), '900:500:2');
    const after = archiveOf(twoTurns([{ name: 'Read' }]), '1000:800:2');
    const from_seq = lastTurnStart(after);
    const frame = makeChangedFrame({ session_id: SESSION_ID, from_seq, fingerprint: '1000:800:2' });
    const body = serve(after, from_seq);

    const once = applyFrame(coldLoad(before), frame, body);
    const twice = applyFrame(once, frame, body);

    expect(twice.events).toEqual(once.events);
    expect(twice.events).toEqual(serve(after).events);
  });
});

describe('AC2 branch 3 — patched is applied by id, and reaches rows before the cursor', () => {
  it('back-patches an async-Agent row that sits turns behind the cursor', () => {
    const before = archiveOf(twoTurns(), '900:500:2');
    // The SAME session, re-projected: the Agent row at seq 1 finished.
    const after = archiveOf(
      [
        {
          id: `${SESSION_ID}:1`,
          seq: 1,
          events: [
            { name: 'Read' },
            { name: 'Agent', status: 'ok', text: 'the sub-agent is done' },
            { name: 'Bash' },
          ],
        },
        {
          id: `${SESSION_ID}:2`,
          seq: 2,
          events: [{ name: 'Grep' }, { name: 'Edit' }, { name: 'Write' }, { name: 'Read' }],
        },
      ],
      '1000:800:2',
    );
    const patchedRow = after.events.find((event) => event.seq === 1);
    if (patchedRow === undefined) throw new Error('the fixture lost its Agent row');

    const from_seq = lastTurnStart(after);
    expect(patchedRow.seq, 'the patched row must sit BEFORE the cursor').toBeLessThan(from_seq);

    const frame = makeChangedFrame({
      session_id: SESSION_ID,
      from_seq,
      fingerprint: '1000:800:2',
      patched: [patchedRow],
    });

    const spliced = applyFrame(coldLoad(before), frame, serve(after, from_seq));

    expect(spliced.events).toEqual(serve(after).events);
    // The containment check: the deep-equality above would still pass if
    // `patched` were dropped and the arrays happened to agree.
    expect(spliced.events.find((event) => event.seq === 1)?.status).toBe('ok');
    expect(spliced.events.find((event) => event.seq === 1)?.text).toBe('the sub-agent is done');
  });
});

describe('AC2 — a frame for another session changes nothing', () => {
  it('decideFrame ignores it, so applyFrame is never reached', () => {
    const data = coldLoad(archiveOf(twoTurns(), '900:500:2'));
    const frame = makeChangedFrame({ session_id: 'some-other-session' });

    expect(decideFrame(data, frame)).toEqual({ kind: 'ignore' });
  });

  it('decideFrame ignores every frame before the first load lands', () => {
    expect(decideFrame(null, makeChangedFrame())).toEqual({ kind: 'ignore' });
  });

  it('decideFrame answers splice with the frame cursor when the epoch moved forward', () => {
    const data = coldLoad(archiveOf(twoTurns(), '900:500:2'));
    const frame = makeChangedFrame({ session_id: SESSION_ID, from_seq: 3 });

    expect(decideFrame(data, frame)).toEqual({ kind: 'splice', from_seq: 3 });
  });
});

/* ------------------------------------------------ AC3: the list patch --- */

const ROLLUP_KEYS = [
  'last_activity_at',
  'turn_count',
  'tool_call_count',
  'error_count',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
] as const;

function listOf(ids: string[]): SessionListData {
  return {
    sessions: ids.map((id) => makeSessionRow({ id })),
    truncated: false,
    outsideRangeCount: 0,
    outsideRangeTruncated: false,
    projectSessions: null,
  };
}

describe('AC3 — the session list patches in place, and a fetch is unrepresentable', () => {
  const NOW = Date.parse('2026-07-29T09:31:30.000Z');

  it('lands every rollup on the matching row, and moves nothing else', () => {
    const data = listOf(['a', 'b']);
    const frame = makeChangedFrame({ session_id: 'b' });

    const next = patchListRow(data, 'b', frame.rollups, NOW);
    const before = data.sessions[1]!;
    const after = next.sessions[1]!;

    // Set equality on the CHANGED key set, never containment: a patch that also
    // moved `sub_*` or `rollup_state` would pass a containment check.
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
      (key) => after[key] !== before[key],
    );
    expect(new Set(changed)).toEqual(new Set([...ROLLUP_KEYS, 'live']));
    for (const key of ROLLUP_KEYS) expect(after[key]).toBe(frame.rollups[key]);
    expect(next.sessions[0], 'the row the frame did not name must be the same object').toBe(
      data.sessions[0],
    );
  });

  it('re-decides the live badge from the mirrored server predicate', () => {
    const data = listOf(['a']);
    const fresh = makeChangedFrame({
      session_id: 'a',
      rollups: { ...makeChangedFrame().rollups, last_activity_at: '2026-07-29T09:31:00.000Z' },
    });

    expect(patchListRow(data, 'a', fresh.rollups, NOW).sessions[0]?.live).toBe(true);
    // One millisecond past the window, and the badge goes out.
    expect(
      patchListRow(
        data,
        'a',
        fresh.rollups,
        Date.parse(fresh.rollups.last_activity_at) + LIVE_WINDOW_MS,
      ).sessions[0]?.live,
    ).toBe(false);
  });

  it('mirrors LIVE_WINDOW_MS and isLive from src/server/api.ts', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../src/server/api.ts', import.meta.url)),
      'utf8',
    );
    expect(source, 'the server side must name this mirror back').toContain('ui/src/lib/live.ts');
    expect(source).toContain('export const LIVE_WINDOW_MS = 60_000;');
    expect(LIVE_WINDOW_MS).toBe(60_000);
    expect(isLive('not a date', Date.now())).toBe(false);
  });

  it('returns the SAME object for an id the page never loaded', () => {
    const data = listOf(['a', 'b']);
    const frame = makeChangedFrame({ session_id: 'never-loaded' });

    // Identity, not deep equality: inserting a row would make `truncated`,
    // `outsideRangeCount` and the project narrowing describe a page the server
    // never served — and identity also proves no fetch was even considered.
    expect(patchListRow(data, frame.session_id, frame.rollups, NOW)).toBe(data);
  });

  it('takes no ApiClient, on either page, in either handler', () => {
    const live = readFileSync(fileURLToPath(new URL('../live.ts', import.meta.url)), 'utf8');
    const sessions = readFileSync(
      fileURLToPath(new URL('../../pages/Sessions.tsx', import.meta.url)),
      'utf8',
    );

    // A signature, not a spy: `patchListRow` has nothing to fetch WITH.
    expect(/export function patchListRow\([^)]*\)/.exec(live)?.[0]).not.toContain('Api');
    // …and the module imports nothing that could fetch: one runtime import, and
    // it is the bucketing rule the cold load already uses.
    const runtimeImports = [...live.matchAll(/^import (?!type )[\s\S]*? from '([^']+)';/gm)];
    expect(runtimeImports.map((match) => match[1])).toEqual(['./session-data.js']);

    // The list page loads exactly once, through `useAsync`, and the frame
    // handler neither loads nor invalidates.
    expect(sessions.match(/loadSessionList\(/g)).toHaveLength(1);
    const handler = sessions.slice(sessions.indexOf('bus.subscribe('));
    expect(handler).toContain('patchListRow(');
    expect(handler, 'a second list request is the one thing AC3 forbids').not.toContain(
      'loadSessionList',
    );
    expect(handler, 'invalidating the slot is the same defect by another name').not.toContain(
      'setRefresh',
    );
  });
});

/* --------------------------------------------------------- the overlay --- */

describe('AC3 — the keyed overlay, and the two reloads it stops shadowing', () => {
  const A = { tag: 'spliced' };
  const B = { tag: 'fresh' };

  it('ignores an overlay whose load key no longer matches', () => {
    // The list page: changing the range changes the key. Without this the whole
    // screen renders the snapshot the first frame landed on, forever.
    expect(overlayData({ key: 'day|', base: B, data: A }, 'week|', B)).toBe(B);
    expect(overlayData({ key: 'week|', base: B, data: A }, 'week|', B)).toBe(A);
    expect(overlayData(null, 'week|', B)).toBe(B);
  });

  it('retires itself the moment a refetch on the SAME key resolves', () => {
    // The session page: the refetch branch bumps a token with the key
    // unchanged, so a key-only guard would still match and the reloaded page
    // could never reach the screen.
    const overlay = { key: 'sess-1', base: A, data: B };
    expect(overlayData(overlay, 'sess-1', A)).toBe(B);
    expect(overlayData(overlay, 'sess-1', { tag: 'reloaded' })).toEqual({ tag: 'reloaded' });
  });

  it('holds the last good value through the request, so the tree never blanks', () => {
    // A blanked tree destroys the scroll anchor AND fires a scroll event, which
    // the follow reducer would read as a reader who moved — silently un-pausing
    // a paused one. Keeping the overlay mounted while the load is in flight is
    // what stops both.
    expect(overlayData({ key: 'sess-1', base: A, data: B }, 'sess-1', null)).toBe(B);
    expect(overlayData(null, 'sess-1', null)).toBeNull();
  });
});

/* ------------------------------------------------------------- the bus --- */

describe('the frame bus fans one stream out to whichever page is mounted', () => {
  it('delivers to every subscriber, and stops on unsubscribe', () => {
    const bus = createLiveBus();
    const seen: string[] = [];
    const stop = bus.subscribe((frame) => seen.push(`one:${frame.event}`));
    bus.subscribe((frame) => seen.push(`two:${frame.event}`));

    bus.publish({ event: 'session_indexed', data: { session_id: 'a' } });
    stop();
    bus.publish({ event: 'session_indexed', data: { session_id: 'b' } });

    expect(seen).toEqual(['one:session_indexed', 'two:session_indexed', 'two:session_indexed']);
  });

  it('survives a listener that unsubscribes itself mid-fan-out', () => {
    const bus = createLiveBus();
    const seen: string[] = [];
    const stop = bus.subscribe(() => stop());
    bus.subscribe(() => seen.push('behind'));

    bus.publish({ event: 'session_indexed', data: { session_id: 'a' } });

    expect(seen, 'the listener behind it must still be reached').toEqual(['behind']);
  });
});
