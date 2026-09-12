import { describe, it, expect } from 'vitest';

import {
  EVENT_KINDS,
  EVENT_STATUSES,
  buildTurnGroups,
  durationSourceOf,
  eventChips,
  eventKindOf,
  eventStatusOf,
  flatten,
  turnChips,
  type TreeModel,
} from '../turn-tree';
import { makeEventRow, makeTurnRow, makeTurnTree } from './fixtures';

/*
 * Task 5.2's pure half — the group-by that replaced the forest builder.
 *
 * Everything here is pure, so nothing is stubbed, nothing is mocked and no
 * clock is read: an event carries the duration the projector measured.
 */

function modelOf(specs: Parameters<typeof makeTurnTree>[0]): TreeModel {
  const tree = makeTurnTree(specs);
  return buildTurnGroups(tree.turns, tree.eventsByTurn);
}

function idsOf(model: TreeModel, expandedIds: ReadonlySet<string> = model.rowIds): string[] {
  return flatten(model, expandedIds).map((row) => row.id);
}

/** Every group in the model, at ANY depth — the reading AC2 was ruled onto. */
function groupCount(model: TreeModel): number {
  return flatten(model, model.rowIds).filter((row) => row.kind === 'turn').length;
}

/* ------------------------------------------- Test 1 — the group-by is total --- */

describe('tree construction is a group-by on turn_id (Test 1, AC2)', () => {
  const SHAPE = [
    { id: 't0', seq: 0, events: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    { id: 't1', seq: 1, events: [{ name: 'd' }, { name: 'e' }] },
  ];

  it('produces N groups holding M rows, with nothing dropped', () => {
    const model = modelOf(SHAPE);
    expect(groupCount(model)).toBe(2);
    expect(idsOf(model)).toEqual([
      't0',
      't0-ev-0',
      't0-ev-1',
      't0-ev-2',
      't1',
      't1-ev-0',
      't1-ev-1',
    ]);
    expect(model.unmatchedEventCount).toBe(0);
  });

  it('orders each group by seq, whatever order the page arrived in', () => {
    /*
     * Mutation check, verified by hand: bucketing on `seq` instead of `turn_id`
     * puts every event in its own group and this goes red.
     *
     * The page is handed over reversed on purpose. `src/db/read.ts:467` orders
     * by `seq`, so this is a belt on a server brace — but `seq` is the only
     * total order there is, and re-sorting here costs one pass.
     */
    const turn = makeTurnRow({ id: 'seed-s0:1' });
    const events = [2, 0, 1].map((seq) => makeEventRow({ id: `ev-${seq}`, turn_id: turn.id, seq }));
    const model = buildTurnGroups([turn], new Map([[turn.id, events]]));
    expect(idsOf(model)).toEqual(['seed-s0:1', 'ev-0', 'ev-1', 'ev-2']);
  });

  it('places every event under the turn it names, never under its neighbour', () => {
    const turns = [makeTurnRow({ id: 'a', seq: 0 }), makeTurnRow({ id: 'b', seq: 1 })];
    const model = buildTurnGroups(
      turns,
      new Map([
        [
          'a',
          [
            makeEventRow({ id: 'a1', turn_id: 'a', seq: 0 }),
            makeEventRow({ id: 'a2', turn_id: 'a', seq: 2 }),
          ],
        ],
        ['b', [makeEventRow({ id: 'b1', turn_id: 'b', seq: 1 })]],
      ]),
    );
    expect(idsOf(model)).toEqual(['a', 'a1', 'a2', 'b', 'b1']);
  });
});

/* --------------------------- Test 2 — the deleted paths cannot come back --- */

describe('the orphan and cycle paths are gone, and the model still cannot throw (Test 2, AC2)', () => {
  it('counts an event whose turn is not on the page rather than dropping it', () => {
    const turn = makeTurnRow({ id: 'seed-s0:0', seq: 0 });
    const model = buildTurnGroups(
      [turn],
      new Map([
        [turn.id, [makeEventRow({ id: 'here', turn_id: turn.id })]],
        ['seed-s0:404', [makeEventRow({ id: 'elsewhere', turn_id: 'seed-s0:404' })]],
      ]),
    );
    expect(model.unmatchedEventCount).toBe(1);
    expect(idsOf(model)).toEqual(['seed-s0:0', 'here']);
  });

  it('survives two turns that name events inside each other', () => {
    /*
     * `turns.parent_event_id` is a foreign key with no acyclicity constraint,
     * so the database will store this. Reaching the expectation at all is half
     * the assertion: an unguarded walk is an infinite loop here rather than a
     * wrong answer, and a hang inside render is a blank screen.
     */
    const a = makeTurnRow({
      id: 'a',
      seq: 0,
      kind: 'task_notification',
      parent_event_id: 'b1',
    });
    const b = makeTurnRow({
      id: 'b',
      seq: 1,
      kind: 'task_notification',
      parent_event_id: 'a1',
    });
    const model = buildTurnGroups(
      [a, b],
      new Map([
        ['a', [makeEventRow({ id: 'a1', turn_id: 'a', seq: 0 })]],
        ['b', [makeEventRow({ id: 'b1', turn_id: 'b', seq: 1 })]],
      ]),
    );
    const rows = idsOf(model);
    expect(new Set(rows)).toEqual(new Set(['a', 'a1', 'b', 'b1']));
    expect(rows, 'every row appears exactly once').toHaveLength(4);
  });

  it('names no forest-builder symbol anywhere in ui/src', async () => {
    // The grep control AC2 asks for: the orphan re-parenting and the cycle cut
    // were DELETED with the model that needed them, not renamed into a corner.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../..', import.meta.url));

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(root);

    expect(files.length, 'the scan is not vacuous').toBeGreaterThan(25);
    const self = fileURLToPath(import.meta.url);
    for (const term of ['resolveParents', 'buildForest', 'parent_span_id']) {
      const hits = files.filter(
        (file) => file !== self && readFileSync(file, 'utf8').includes(term),
      );
      expect(hits, `${term} still lives in ui/src`).toEqual([]);
    }
  });
});

/* --------------------------------- the narrows the coalesce moved in here --- */

describe('the wire is narrowed here, because nothing else narrows it (AC2)', () => {
  it.each([...EVENT_KINDS])('keeps %s', (kind) => {
    expect(eventKindOf(kind)).toBe(kind);
  });

  it.each([...EVENT_STATUSES])('keeps %s', (status) => {
    expect(eventStatusOf(status)).toBe(status);
  });

  it('coalesces a null status to unknown, which 46.9% of real events carry', () => {
    // Mutation check, verified by hand: drop the coalesce and every `text`,
    // `thinking`, `prompt` and `compaction` row indexes the visual manifest
    // with `null` and the row throws on render.
    expect(eventStatusOf(null)).toBe('unknown');
    expect(eventStatusOf('wat')).toBe('unknown');
    expect(eventKindOf(null)).toBe('unknown');
    expect(eventKindOf('wat')).toBe('unknown');
  });

  it('reads an absent duration_source as none, never as elapsed', () => {
    expect(durationSourceOf(null)).toBe('none');
    expect(durationSourceOf('elapsed')).toBe('elapsed');
    expect(durationSourceOf('sidecar_span')).toBe('sidecar_span');
    expect(durationSourceOf('reported')).toBe('reported');
    // The TURN vocabulary. It is a different field on a different table and it
    // must never resolve to an event's answer.
    expect(durationSourceOf('derived')).toBe('none');
    expect(durationSourceOf('turn_duration')).toBe('none');
  });

  it('narrows the node it builds, so no component has to', () => {
    const turn = makeTurnRow({ id: 'seed-s0:1' });
    const model = buildTurnGroups(
      [turn],
      new Map([
        [turn.id, [makeEventRow({ id: 'e', turn_id: turn.id, kind: 'wat', status: null })]],
      ]),
    );
    const node = model.groups[0]?.events[0];
    expect(node?.kind).toBe('unknown');
    expect(node?.status).toBe('unknown');
  });
});

/* ------------------------- Test 10 and 11 — the fold, and its false default --- */

describe('task_notification turns fold under their Agent event, and the fold chains (Test 10, AC3)', () => {
  /*
   * The measured shape, in miniature: turn 0 owns an Agent call, turn 1 folds
   * under it, turn 2 folds under an Agent call inside turn 1, and a human turn
   * sits beside all of them. On the archived session the gate drives, five
   * turns fold into a five-deep chain and the deepest reaches six levels.
   */
  const CHAIN = [
    {
      id: 't0',
      seq: 0,
      events: [{ name: 'Read' }, { name: 'Agent' }],
      folded: [
        {
          id: 't1',
          seq: 1,
          events: [{ name: 'Grep' }, { name: 'Agent' }],
          folded: [{ id: 't2', seq: 2, events: [{ name: 'Bash' }] }],
        },
      ],
    },
    { id: 't3', seq: 3, kind: 'human', events: [{ name: 'Edit' }] },
  ];

  const model = modelOf(CHAIN);
  const rows = flatten(model, model.rowIds);
  const depthOf = new Map(rows.map((row) => [row.id, row.depth]));

  it('emits every turn and every event exactly once, in pre-order', () => {
    expect(rows.map((row) => row.id)).toEqual([
      't0',
      't0-ev-0',
      't0-ev-1',
      't1',
      't1-ev-0',
      't1-ev-1',
      't2',
      't2-ev-0',
      't3',
      't3-ev-0',
    ]);
  });

  it('sits a folded turn one level below the event that spawned it', () => {
    // Mutation check, verified by hand: ignore `parent_event_id` and t1 and t2
    // both flatten back to depth 0, which reds all four of these.
    expect(depthOf.get('t0')).toBe(0);
    expect(depthOf.get('t0-ev-1')).toBe(1);
    expect(depthOf.get('t1')).toBe(2);
    expect(depthOf.get('t1-ev-1')).toBe(3);
  });

  it('chains: the second fold is two levels deeper than the first', () => {
    // Second mutation check: flattening the chain to one level answers 2 here.
    expect(depthOf.get('t2')).toBe(4);
    expect(depthOf.get('t2-ev-0')).toBe(5);
  });

  it('leaves a human turn at depth 0 beside the whole chain', () => {
    expect(depthOf.get('t3')).toBe(0);
    expect(model.groups.map((group) => group.turn.id)).toEqual(['t0', 't3']);
  });

  it('counts groups at ANY depth, which is the only arithmetic that works', () => {
    // Four turns, two of them folded. A depth-0 count answers 2 and would make
    // "N turns produce N groups" false on every session that folds anything.
    expect(groupCount(model)).toBe(4);
  });

  it('never mixes a sibling set: events sit with events, turns with turns', () => {
    const place = new Map(rows.map((row) => [row.id, `${row.posInSet}/${row.setSize}`]));
    expect(Object.fromEntries(place)).toEqual({
      t0: '1/2',
      't0-ev-0': '1/2',
      't0-ev-1': '2/2',
      t1: '1/1',
      't1-ev-0': '1/2',
      't1-ev-1': '2/2',
      t2: '1/1',
      't2-ev-0': '1/1',
      t3: '2/2',
      't3-ev-0': '1/1',
    });
  });
});

describe('the fold is false by default and never orphans (Test 11, AC3)', () => {
  it('leaves a task_notification turn with no parent event at the top level', () => {
    const model = modelOf([
      { id: 't0', seq: 0, events: [{ name: 'Read' }] },
      { id: 't1', seq: 1, kind: 'task_notification', parent_event_id: null, events: [] },
    ]);
    expect(model.groups.map((group) => group.turn.id)).toEqual(['t0', 't1']);
  });

  it('leaves a turn naming an event that is not on the page at the top level', () => {
    const model = modelOf([
      { id: 't0', seq: 0, events: [{ name: 'Read' }] },
      {
        id: 't1',
        seq: 1,
        kind: 'task_notification',
        parent_event_id: 'ev-off-page',
        events: [{ name: 'Bash' }],
      },
    ]);
    expect(model.groups.map((group) => group.turn.id)).toEqual(['t0', 't1']);
    expect(idsOf(model)).toContain('t1-ev-0');
  });

  it('never folds a kind that is not task_notification', () => {
    // `foldsUnderAgent` tests the kind FIRST, which is why all 25 slash_command
    // turns in the archive keep their raw titles at the top level.
    const model = modelOf([
      { id: 't0', seq: 0, events: [{ name: 'Agent' }] },
      { id: 't1', seq: 1, kind: 'slash_command', parent_event_id: 't0-ev-0', events: [] },
    ]);
    expect(model.groups.map((group) => group.turn.id)).toEqual(['t0', 't1']);
  });
});

/* --------------------------------------------- flatten answers to expansion --- */

describe('flatten answers to the expansion state', () => {
  const model = modelOf([
    {
      id: 't0',
      seq: 0,
      events: [{ name: 'a' }, { name: 'Agent' }],
      folded: [{ id: 't1', seq: 1, events: [{ name: 'b' }] }],
    },
  ]);
  const everything = model.rowIds;

  it('contributes zero rows for a closed subtree, and round-trips exactly', () => {
    const open = idsOf(model, everything);

    const closed = new Set(everything);
    closed.delete('t0-ev-1');
    expect(idsOf(model, closed)).toEqual(['t0', 't0-ev-0', 't0-ev-1']);

    expect(idsOf(model, everything)).toEqual(open);
  });

  it('drops a whole turn to one row when the turn itself is closed', () => {
    const closed = new Set(everything);
    closed.delete('t0');
    expect(idsOf(model, closed)).toEqual(['t0']);
  });

  it('removes the row a predicate rejects, and everything beneath it', () => {
    // Task 7.2's seam. A parameter can type-check, satisfy no-unused-vars and
    // still do nothing, so this asserts it actually decides something.
    expect(flatten(model, everything, (row) => row.id !== 't0-ev-1').map((r) => r.id)).toEqual([
      't0',
      't0-ev-0',
    ]);
  });

  it('hands the predicate a fully built row, aria counts included', () => {
    const seen: string[] = [];
    flatten(model, everything, (row) => {
      seen.push(`${row.kind}:${row.id}:${row.depth}:${row.posInSet}/${row.setSize}`);
      return true;
    });
    expect(seen).toContain('turn:t0:0:1/1');
    expect(seen).toContain('event:t0-ev-1:1:2/2');
    expect(seen).toContain('turn:t1:2:1/1');
  });

  it('survives a session with no turns at all', () => {
    const empty = buildTurnGroups([], new Map());
    expect(flatten(empty, new Set())).toEqual([]);
    expect(empty.unmatchedEventCount).toBe(0);
  });

  it('is unchanged by an empty subtrees map (Test 8, AC1, AC2)', () => {
    /*
     * The regression guard on the merged walk. Task 5.5 rewrote both pushes and
     * added an offset that rides through every turn/event alternation, so the
     * claim worth pinning is that a session with no sub-agent loaded flattens to
     * exactly what it flattened to before — same ids, same depths, same
     * `setSize`/`posInSet`, same order.
     */
    const shape = (rows: readonly ReturnType<typeof flatten>[number][]) =>
      rows.map((row) => `${row.kind}:${row.id}:${row.depth}:${row.posInSet}/${row.setSize}`);

    const bare = flatten(model, everything);
    const empty = flatten(model, everything, undefined, {
      rootSessionId: 'seed-s0',
      subtrees: new Map(),
    });

    expect(shape(empty)).toEqual(shape(bare));
    expect(empty.every((row) => row.subagent === undefined)).toBe(true);
    expect(new Set(empty.map((row) => row.sessionId))).toEqual(new Set(['seed-s0']));
    expect(new Set(bare.map((row) => row.sessionId))).toEqual(new Set(['']));
  });
});

/* ---------------------------------------------------------------- chips --- */

describe('turn chips are read off the server rollup, never recomputed', () => {
  it('answers the stored total even when it disagrees with the events on the page', () => {
    // Deliberately inconsistent: the server rolled up every event in the turn,
    // this page carries one of them. Recomputing would make the number the
    // user sees depend on how far they had scrolled.
    const turn = makeTurnRow({
      tokens_in: 80_000,
      tokens_out: 10_000,
      est_cost: 9.5,
      duration_ms: 123_456,
      error_count: 7,
    });
    expect(turnChips(turn)).toEqual({
      durationMs: 123_456,
      tokens: 90_000,
      cost: 9.5,
      costUnknown: undefined,
      errorCount: 7,
    });
    // Mutation check, verified by hand: summing the page's events answers 0.
    expect(turnChips(turn).tokens).not.toBe(0);
  });

  it('spells an absent duration or cost as absent, never as zero', () => {
    // ★ `cost` used to be `est_cost ?? 0` — the same conflation Task 0.8
    // removed from `SessionHeader`, reintroduced one layer down. A null with
    // real usage now carries its label; the model is deliberately unnamed,
    // because a turn can span more than one request group.
    expect(turnChips(makeTurnRow({ duration_ms: null, est_cost: null }))).toEqual({
      durationMs: undefined,
      tokens: 1200,
      cost: null,
      costUnknown: 'cost unknown — no model recorded',
      errorCount: 0,
    });
  });

  it('an unpriced turn that moved no tokens earns no label — nothing ran', () => {
    const chips = turnChips(
      makeTurnRow({
        est_cost: null,
        tokens_in: 0,
        tokens_out: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      }),
    );
    expect(chips.cost).toBeNull();
    expect(chips.costUnknown).toBeUndefined();
  });

  it('cache-only usage still counts as real spend for the label', () => {
    // Mirrors the write path's guard, which reads all four token counts.
    const chips = turnChips(
      makeTurnRow({
        est_cost: null,
        tokens_in: 0,
        tokens_out: 0,
        tokens_cache_read: 5_000,
        tokens_cache_write: 0,
      }),
    );
    expect(chips.costUnknown).toBe('cost unknown — no model recorded');
  });
});

describe('event chips report the row itself, and refuse to invent a duration', () => {
  it('reads the numbers the projector wrote', () => {
    expect(
      eventChips(
        makeEventRow({ duration_ms: 2_500, tokens_in: 100, tokens_out: 20, est_cost: 0.5 }),
      ),
    ).toEqual({ durationMs: 2_500, tokens: 120, cost: 0.5, costUnknown: undefined, errorCount: 0 });
  });

  it('★ an unpriced event with real usage names its model in the label', () => {
    // Mutation check, verified by hand: reinstate `est_cost ?? 0` and the
    // label vanishes — cost reads as a silently-omitted $0 chip instead.
    const chips = eventChips(
      makeEventRow({ tokens_in: 100, tokens_out: 20, est_cost: null, model: 'claude-opus-5' }),
    );
    expect(chips.cost).toBeNull();
    expect(chips.costUnknown).toBe('cost unknown — no rate for claude-opus-5');

    const anonymous = eventChips(
      makeEventRow({ tokens_in: 100, tokens_out: 20, est_cost: null, model: null }),
    );
    expect(anonymous.costUnknown).toBe('cost unknown — no model recorded');
  });

  it('answers undefined for an unmeasured row, and NEVER 0ms', () => {
    /*
     * ★ 14,211 of 30,286 events carry no `duration_ms` — every `text`,
     * `thinking`, `prompt`, `compaction` and `unknown` row. `formatDurationMs`
     * spells `undefined` as an em dash; a `0` would spell it `0ms`, which is a
     * measurement nobody took.
     *
     * Mutation check, verified by hand: `?? 0` here answers 0 and reds this.
     */
    const chips = eventChips(makeEventRow({ kind: 'thinking', duration_ms: null, status: null }));
    expect(chips.durationMs).toBeUndefined();
    expect(chips.durationMs).not.toBe(0);
  });

  it('treats an absent token or cost field as nothing, never as NaN', () => {
    const chips = eventChips(makeEventRow({ tokens_in: null, tokens_out: null, est_cost: null }));
    expect(chips.tokens).toBe(0);
    // Null passes through untouched — and with no usage there is no label:
    // a row that moved nothing is not "unpriced", it is free by vacuity.
    expect(chips.cost).toBeNull();
    expect(chips.costUnknown).toBeUndefined();
  });

  it.each([
    ['error', 1],
    ['denied', 1],
    ['ok', 0],
    ['running', 0],
    [null, 0],
  ])('counts a %s event as %i errors, matching the server', (status, expected) => {
    expect(eventChips(makeEventRow({ status })).errorCount).toBe(expected);
  });
});
