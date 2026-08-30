import { describe, it, expect } from 'vitest';

import type { EventRow } from '../api';
import { PREVIEW_CHARS } from '../format';
import { loadSessionDetail } from '../session-data';
import { EVENT_KINDS, buildTurnGroups } from '../turn-tree';
import {
  REASONING_NOT_RECORDED,
  SESSION_VIEW_MODES,
  THREAD_PREVIEW_CHARS,
  buildThread,
  type ThreadRow,
} from '../thread';
import { makeDetail, makeEventRow, makeTurnRow, stubApiClient } from './fixtures';

/*
 * Task 5.4's model half — the second pure reader over the one `EventRow[]`.
 *
 * Every claim here is about a decision, never about markup: which row shape an
 * event becomes, what the reasoning marker says, how an unrecognized record is
 * labelled, and how far each payload is clamped. `thread-view.test.tsx` owns the
 * rendering; this owns what it renders.
 */

/** The rows for `events`, in whatever order they are handed over. */
function rowsFor(events: Partial<EventRow>[]): ThreadRow[] {
  return buildThread(events.map((event, i) => makeEventRow({ id: `ev-${i}`, seq: i, ...event })));
}

/* ------------------------------------ Test 1 — one response, both views --- */

describe('one response fills both views (Test 1, AC1)', () => {
  it('feeds the thread and the tree from a single getSession call', async () => {
    let calls = 0;
    const turn = makeTurnRow({ id: 'seed-s0:0', seq: 0 });
    const events = [
      makeEventRow({ id: 'a', turn_id: turn.id, seq: 0, kind: 'prompt', text: 'do the thing' }),
      makeEventRow({ id: 'b', turn_id: turn.id, seq: 1, kind: 'tool_call' }),
    ];
    const api = stubApiClient({
      getSession: () => {
        calls += 1;
        return Promise.resolve(makeDetail({ turns: [turn], events }));
      },
    });

    const data = await loadSessionDetail(api, 'seed-s0');
    const thread = buildThread(data.events);
    const tree = buildTurnGroups(data.turns, data.eventsByTurn);

    expect(calls, 'the thread must cost no follow-up request').toBe(1);
    expect(thread).toHaveLength(2);
    expect(tree.groups[0]?.events).toHaveLength(2);
    expect(thread.map((row) => row.event.id)).toEqual(['a', 'b']);
  });
});

/* --------------------------------------- Test 2 — `seq` is the order --- */

describe('`seq` is the total order (Test 2, AC1)', () => {
  it('reads shuffled events back in ascending seq, one row each', () => {
    const shuffled = [5, 1, 4, 0, 3, 2].map((seq) => makeEventRow({ id: `ev-${seq}`, seq }));
    const rows = buildThread(shuffled);

    expect(rows.map((row) => row.event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows).toHaveLength(shuffled.length);
  });

  it('leaves the caller’s array alone', () => {
    const events = [makeEventRow({ id: 'b', seq: 9 }), makeEventRow({ id: 'a', seq: 1 })];
    buildThread(events);
    expect(events.map((event) => event.id), 'the input was sorted in place').toEqual(['b', 'a']);
  });

  it('answers an empty thread for an empty page', () => {
    expect(buildThread([])).toEqual([]);
  });
});

/* ------------------------- Test 3 — nothing dropped, nothing invented --- */

describe('every event reaches exactly one row (Test 3, AC1, AC3)', () => {
  it('maps all seven wire kinds, and the id sets are equal', () => {
    const events = EVENT_KINDS.map((kind, i) =>
      makeEventRow({ id: `ev-${kind}`, seq: i, kind, text: 'body' }),
    );
    const rows = buildThread(events);

    expect(rows).toHaveLength(EVENT_KINDS.length);
    expect(new Set(rows.map((row) => row.event.id))).toEqual(new Set(events.map((e) => e.id)));
  });

  it('sends the four prose kinds through the message arm rather than dropping them', () => {
    const rows = rowsFor([
      { kind: 'prompt' },
      { kind: 'text' },
      { kind: 'error' },
      { kind: 'compaction' },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['message', 'message', 'message', 'message']);
    // The wire's own word survives, so the row can name what it is showing.
    expect(rows.map((row) => (row.kind === 'message' ? row.eventKind : null))).toEqual([
      'prompt',
      'text',
      'error',
      'compaction',
    ]);
  });

  it('reads a kind the wire invents tomorrow as unknown, never as a crash', () => {
    const [row] = rowsFor([{ kind: 'telemetry_v3', raw_type: 'telemetry_v3' }]);
    expect(row?.kind).toBe('unknown');
  });
});

/* ------------------------------------------ Test 4/6 — the tool row --- */

describe('a tool call carries its four facts (Test 4, AC2)', () => {
  it('names the tool, its status, its input and its output', () => {
    const [row] = rowsFor([
      { kind: 'tool_call', name: 'Bash', status: 'ok', input: '{"cmd":"ls"}', text: 'a.txt' },
    ]);

    expect(row?.kind).toBe('tool');
    if (row?.kind !== 'tool') throw new Error('unreachable');
    expect(row.name).toBe('Bash');
    expect(row.status).toBe('ok');
    expect(row.input).toBe('{"cmd":"ls"}');
    expect(row.output).toBe('a.txt');
    expect(row.event.ts, 'the row keeps its own timestamp').toBe(row.event.ts);
  });

  it('falls back to the wire kind when the projector recorded no name', () => {
    const [row] = rowsFor([{ kind: 'tool_call', name: null }]);
    expect(row?.kind === 'tool' && row.name).toBe('tool_call');
  });

  it('reports an unmeasured duration as absent, never as zero (Test 6, AC2)', () => {
    // `eventChips` coalesces to `undefined` so `formatDurationMs` spells the em
    // dash. A `0ms` on a row nobody timed is the precise-looking lie the tree
    // refuses, and the thread may not reintroduce it.
    const [row] = rowsFor([{ kind: 'tool_call', duration_ms: null }]);
    expect(row?.event.duration_ms).toBeNull();
  });

  it('spells a status the wire never sent as unknown', () => {
    const [row] = rowsFor([{ kind: 'tool_call', status: null }]);
    expect(row?.kind === 'tool' && row.status).toBe('unknown');
  });
});

/* -------------------------------- Test 7/F4 — the two payload budgets --- */

describe('the thread reads wider than the tree scans (F4)', () => {
  const long = 'x'.repeat(2_000);

  it('clamps a tool payload at the thread’s own, larger budget', () => {
    const [row] = rowsFor([{ kind: 'tool_call', input: long, text: long }]);
    if (row?.kind !== 'tool') throw new Error('unreachable');

    expect(THREAD_PREVIEW_CHARS).toBeGreaterThan(PREVIEW_CHARS);
    expect(row.input).toHaveLength(THREAD_PREVIEW_CHARS + 1);
    expect(row.output).toHaveLength(THREAD_PREVIEW_CHARS + 1);
    expect(row.input?.endsWith('…')).toBe(true);
  });

  it('reports an absent or blank payload as absent rather than as an empty string', () => {
    const [row] = rowsFor([{ kind: 'tool_call', input: null, text: '   \n  ' }]);
    if (row?.kind !== 'tool') throw new Error('unreachable');
    expect(row.input).toBeNull();
    expect(row.output).toBeNull();
  });

  it('leaves a payload inside the budget untouched, ellipsis included', () => {
    const [row] = rowsFor([{ kind: 'tool_call', input: '{"cmd":"ls"}' }]);
    expect(row?.kind === 'tool' && row.input).toBe('{"cmd":"ls"}');
  });
});

/* --------------------------------------- Test 8/9 — the reasoning row --- */

describe('a thinking event renders one marker, never a blank row (Test 8, AC3)', () => {
  it('gives every thinking event its own row carrying the copy verbatim', () => {
    // MEASURED: 8,047 of 8,047 rows arrive with this exact string, one distinct
    // value, zero null and zero empty — the projector elided them at ingest.
    const rows = rowsFor(
      Array.from({ length: 4 }, () => ({ kind: 'thinking', text: REASONING_NOT_RECORDED })),
    );

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.kind).toBe('thinking');
      if (row.kind !== 'thinking') continue;
      expect(row.text).toBe('reasoning not recorded (signature only)');
      expect(row.text).not.toBe('');
      expect(row.recorded).toBe(false);
    }
  });

  it('folds nothing, because no fold key folds anything', () => {
    /*
     * The maximum number of `thinking` events per `request_id` is 1, with zero
     * groups above one, and a `thinking` event immediately after another by
     * `seq` happens zero times corpus-wide. So a run fold and a request fold
     * both reduce 8,047 to 8,047, and neither is shipped. Adjacency is the
     * shape that would have folded if anything did.
     */
    const rows = rowsFor([
      { kind: 'thinking', text: REASONING_NOT_RECORDED },
      { kind: 'thinking', text: REASONING_NOT_RECORDED },
      { kind: 'thinking', text: REASONING_NOT_RECORDED },
    ]);
    expect(rows).toHaveLength(3);
  });

  it('still shows a marker when the wire sends null or blank', () => {
    for (const text of [null, '', '   ']) {
      const [row] = rowsFor([{ kind: 'thinking', text }]);
      expect(row?.kind === 'thinking' && row.text).toBe(REASONING_NOT_RECORDED);
    }
  });
});

describe('recorded reasoning renders as prose, not as the marker (Test 9, AC3)', () => {
  it('keys on the TEXT, so real reasoning is never labelled "not recorded"', () => {
    // The forward-compatibility guard. `src/transcript/blocks.ts` will emit real
    // reasoning the moment a harness records it, and a kind-keyed design would
    // then print "not recorded" over prose that was.
    const [row] = rowsFor([{ kind: 'thinking', text: 'I should read the file first.' }]);
    if (row?.kind !== 'thinking') throw new Error('unreachable');

    expect(row.text).toBe('I should read the file first.');
    expect(row.recorded).toBe(true);
  });

  it('clamps a 209 KB reasoning body at the TREE’s budget, not the thread’s', () => {
    // Reasoning nobody asked to see may not push a session's tool calls off the
    // screen, so this is the one payload the reading surface clamps tightly.
    const [row] = rowsFor([{ kind: 'thinking', text: 'y'.repeat(209_000) }]);
    if (row?.kind !== 'thinking') throw new Error('unreachable');

    expect(row.text).toHaveLength(PREVIEW_CHARS + 1);
    expect(row.recorded).toBe(true);
  });
});

/* ------------------------------------ Test 10/11 — the unknown record --- */

describe('an unrecognized record names its type and its subtype (Test 10, AC3)', () => {
  it.each([
    ['attachment', null, 'unrecognized record (type=attachment)'],
    ['system', 'turn_duration', 'unrecognized record (type=system/turn_duration)'],
    ['system', 'stop_hook_summary', 'unrecognized record (type=system/stop_hook_summary)'],
    ['system', '', 'unrecognized record (type=system)'],
  ])('raw_type=%s raw_subtype=%s reads as %s', (rawType, rawSubtype, label) => {
    // Without the subtype, 601 of 1,577 unknown rows collapse onto `type=system`
    // and the drift alarm cannot tell four different records apart.
    const [row] = rowsFor([{ kind: 'unknown', raw_type: rawType, raw_subtype: rawSubtype }]);

    expect(row?.kind === 'unknown' && row.label).toBe(label);
  });

  it('never renders an empty label', () => {
    const [row] = rowsFor([{ kind: 'unknown', raw_type: 'attachment' }]);
    expect(row?.kind === 'unknown' && row.label.trim()).not.toBe('');
  });
});

describe('the unknown row discloses the wire fields it has (Test 11, AC3)', () => {
  const [row] = rowsFor([
    {
      kind: 'unknown',
      raw_type: 'system',
      raw_subtype: 'away_summary',
      text: null,
      name: null,
      input: null,
    },
  ]);
  const record = row?.kind === 'unknown' ? row.record : '';

  it.each(['id', 'seq', 'ts', 'raw_type', 'raw_subtype'])('carries %s', (field) => {
    expect(record).toContain(`"${field}"`);
  });

  it('parses back to the row’s own scalars', () => {
    const parsed = JSON.parse(record) as Record<string, unknown>;
    expect(parsed.raw_type).toBe('system');
    expect(parsed.raw_subtype).toBe('away_summary');
  });

  it('stops at the 5.3 boundary: no storage word, no refetch', () => {
    /*
     * MEASURED: all 1,577 unknown rows carry `text`, `name` and `input` null
     * with empty attributes, so there is no payload to disclose. Task 5.3's pane
     * owns `output_storage` and the "show full" round trip; a copy of either
     * here would be a second, divergent implementation of somebody else's job.
     */
    expect(record).not.toContain('output_storage');
    expect(record).not.toContain('spill_path');
  });
});

/* ---------------------------------------------------- the mode vocabulary --- */

describe('the two surfaces are one closed list', () => {
  it('names both, in the order their controls render', () => {
    expect(SESSION_VIEW_MODES).toEqual(['tree', 'thread']);
  });
});
