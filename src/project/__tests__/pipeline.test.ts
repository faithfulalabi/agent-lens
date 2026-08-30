// The hermetic half of Task 3.1. Every fixture here is SYNTHETIC and
// hand-written in the harness's own line shape, so it reaches `runPipeline`
// through `classifyLine` exactly as a production line does — never as a
// hand-built `ParsedLine[]` that could declare a line no harness ever emits.
//
// ★ `late-parent.jsonl` and `timestamps-descending.jsonl` ARE NEVER DELETED.
// Late parents and results preceding their own call are EXTINCT in the live
// corpus — re-measured 2026-08-14 at 0 and 0 — so these two files are the only
// surviving witness of why the projector makes two passes. An extinct
// phenomenon is an unwitnessed one, not an impossible one, and the harness can
// reintroduce either on its next release.

import { describe, expect, it } from 'vitest';
import { contentBlocks } from '../../transcript/blocks.js';
import { DriftCounter } from '../../transcript/drift.js';
import type { ParsedLine } from '../../transcript/line.js';
import { fixtureBytes, offsetLines } from '../../transcript/__tests__/fixtures.js';
import {
  epochMs,
  runPipeline,
  type ProjectedEvent,
  type ProjectedTurn,
  type Projection,
} from '../pipeline.js';
import { classifyProjectFixture, projectFixtureBytes } from './fixtures.js';

const SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** One fixture, classified and projected through one counter, as production does. */
function project(name: string): Projection & { lines: ParsedLine[] } {
  const { lines, drift } = classifyProjectFixture(name);
  return { ...runPipeline(lines, { session_id: SESSION, drift }), lines };
}

function kindsOf(turns: readonly ProjectedTurn[]): string[] {
  return turns.map((turn) => turn.kind);
}

function turnAt(result: Projection, seq: number): ProjectedTurn {
  const turn = result.turns[seq];
  if (turn === undefined) throw new Error(`no turn at seq ${seq}`);
  return turn;
}

describe('AC1 — runPipeline is pure, and writes to exactly one argument', () => {
  it('projects the same input twice into deeply equal output', () => {
    const { lines } = classifyProjectFixture('turn-kinds.jsonl');

    const first = runPipeline(lines, { session_id: SESSION, drift: new DriftCounter() });
    const second = runPipeline(lines, { session_id: SESSION, drift: new DriftCounter() });

    // Non-vacuity: an empty projection satisfies deep equality trivially.
    expect(first.turns.length).toBeGreaterThan(0);
    expect(first.events.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('leaves `lines` and every line in it unmutated', () => {
    const { lines, drift } = classifyProjectFixture('turn-kinds.jsonl');
    const before = structuredClone(lines);

    runPipeline(lines, { session_id: SESSION, drift });

    expect(structuredClone(lines)).toEqual(before);
  });

  it('writes to ctx.drift, and that is why the counter must be fresh', () => {
    // The precondition above is proved LOAD-BEARING rather than assumed: reusing
    // one counter across two calls is asserted to change the answer.
    const { lines } = classifyProjectFixture('drift-three-ways.jsonl');
    const shared = new DriftCounter();

    const first = runPipeline(lines, { session_id: SESSION, drift: shared });
    const second = runPipeline(lines, { session_id: SESSION, drift: shared });

    expect(JSON.parse(first.drift).unknown_block_types).toEqual({ hologram: 1 });
    expect(JSON.parse(second.drift).unknown_block_types).toEqual({ hologram: 2 });
    expect(second.drift).not.toBe(first.drift);
  });
});

describe('AC3 — out-of-order input needs no special case, asserted as totality', () => {
  // NOT "the same turns and events as the in-order twin": that property is FALSE
  // by design. Segmentation follows the ARRAY POSITION of the group-carrying
  // line and `seq` IS array position, so moving a line across a boundary is
  // MEANT to change the turn count and renumber every later event.
  it.each(['late-parent.jsonl', 'timestamps-descending.jsonl'])('%s projects totally', (name) => {
    const result = project(name);
    const ids = new Set(result.turns.map((turn) => turn.id));

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.turns.length).toBeGreaterThan(0);

    for (const event of result.events) {
      expect(event.ts, event.id).not.toBe('');
      expect(ids.has(event.turn_id), `${event.id} -> ${event.turn_id}`).toBe(true);
    }

    // Every uuid-carrying line is accounted for: none is left unassigned.
    const uuids = new Set(
      result.lines.flatMap((line) => (line.uuid === undefined ? [] : [line.uuid])),
    );
    const emitting = new Set(result.events.map((event) => event.src_offset));
    expect(uuids.size).toBeGreaterThan(0);
    expect(emitting.size).toBe(uuids.size);

    for (const turn of result.turns) {
      const own = result.events.filter((event) => event.turn_id === turn.id);
      const stamps = own.map((event) => event.ts).sort();
      expect(turn.started_at).toBe(stamps[0]);
      expect(turn.ended_at).toBe(stamps[stamps.length - 1]);
    }
  });

  it('takes the min and max of a descending segment, never the first and last', () => {
    const result = project('timestamps-descending.jsonl');
    const turn = turnAt(result, 0);

    expect(turn.started_at).toBe('2026-08-14T15:00:01.000Z');
    expect(turn.ended_at).toBe('2026-08-14T15:00:03.000Z');
    expect(turn.duration_ms).toBe(2000);
  });
});

describe('AC4 — event ids, and what `seq` is actually derived from', () => {
  const FIXTURES = [
    'turn-kinds.jsonl',
    'turn-duration.jsonl',
    'late-parent.jsonl',
    'timestamps-descending.jsonl',
    'one-line-session.jsonl',
    'drift-three-ways.jsonl',
  ];

  it.each(FIXTURES)('%s emits unique ids in non-decreasing byte order', (name) => {
    const result = project(name);
    const ids = result.events.map((event) => event.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(result.events.map((event) => event.seq)).toEqual(ids.map((_, index) => index));

    // The genuinely byte-derived property, and the observable consequence of the
    // documented precondition: emitted offsets never go backwards.
    const offsets = result.events.map((event) => event.src_offset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it('uses the tool call id for a tool_call row and `<uuid>:<blockIndex>` elsewhere', () => {
    const result = project('turn-kinds.jsonl');
    const prompt = result.events.find((event) => event.kind === 'prompt');

    expect(prompt?.id).toMatch(/^[0-9a-f-]+:0$/);
    expect(result.events.every((event) => event.id !== '')).toBe(true);
  });

  it('projects the same bytes twice into the same seq sequence', () => {
    const once = project('turn-kinds.jsonl');
    const twice = project('turn-kinds.jsonl');
    expect(twice.events.map((event) => `${event.seq}:${event.id}`)).toEqual(
      once.events.map((event) => `${event.seq}:${event.id}`),
    );
  });
});

describe('AC1/AC4 — nothing is dropped, and the turn windows tile the events', () => {
  const FIXTURES = ['turn-kinds.jsonl', 'turn-duration.jsonl', 'late-parent.jsonl'];

  /** `units - toolResultUnits + blocklessUuidLines` — the whole accounting rule. */
  function census(lines: readonly ParsedLine[]): {
    units: number;
    toolResults: number;
    blockless: number;
  } {
    let units = 0;
    let toolResults = 0;
    let blockless = 0;
    for (const line of lines) {
      if (line.uuid === undefined) continue;
      const blocks = contentBlocks(line);
      units += blocks.length;
      toolResults += blocks.filter((block) => block.kind === 'tool_result').length;
      if (blocks.length === 0) blockless += 1;
    }
    return { units, toolResults, blockless };
  }

  it.each(FIXTURES)('%s accounts for every unit', (name) => {
    const result = project(name);
    const { units, toolResults, blockless } = census(result.lines);

    // A result block is an in-flight state on its call's row, not a drop.
    expect(result.events).toHaveLength(units - toolResults + blockless);
  });

  it('is non-vacuous: both correction terms are exercised', () => {
    // Without this, the formula above is just `events.length === units` on a
    // fixture set that happens to contain neither case.
    const { toolResults, blockless } = census(project('turn-kinds.jsonl').lines);
    expect(toolResults).toBeGreaterThan(0);
    expect(blockless).toBeGreaterThan(0);
  });

  it.each(FIXTURES)('%s tiles the event array with no gap and no overlap', (name) => {
    const result = project(name);

    let expected = 0;
    for (const turn of result.turns) {
      const own = result.events.filter((event) => event.turn_id === turn.id);
      expect(turn.first_seq).toBe(expected);
      expect(turn.last_seq).toBe(expected + own.length - 1);
      expected += own.length;
    }
    expect(expected).toBe(result.events.length);

    for (const event of result.events) {
      expect(event.id).not.toBe('');
      expect(event.ts).not.toBe('');
      expect(event.turn_id).not.toBe('');
    }
  });
});

describe('AC9 — turn kinds, turn ids and the header envelope', () => {
  it('reaches all six kinds, so no ladder arm can pass by never firing', () => {
    const result = project('turn-kinds.jsonl');

    expect(kindsOf(result.turns)).toEqual([
      'system',
      'human',
      'task_notification',
      'slash_command',
      'compaction',
      'unknown',
    ]);
    expect(new Set(kindsOf(result.turns)).size).toBe(6);
  });

  it('ids turns by session and seq, never by a prompt group id', () => {
    const result = project('turn-kinds.jsonl');
    const groups = new Set(
      result.lines.flatMap((line) => {
        const id: unknown = line.raw.promptId;
        return typeof id === 'string' ? [id] : [];
      }),
    );

    expect(groups.size).toBeGreaterThan(0);
    for (const [seq, turn] of result.turns.entries()) {
      expect(turn.id).toBe(`${SESSION}:${seq}`);
      expect(groups.has(turn.id)).toBe(false);
    }
  });

  it('truncates a title at 200 chars, and answers `` for a segment with no prose', () => {
    const result = project('turn-kinds.jsonl');
    const human = turnAt(result, 1);

    expect(human.kind).toBe('human');
    expect(human.title).toHaveLength(200);
    expect(human.title.startsWith('ship the projector.')).toBe(true);

    // The NOT NULL column, covered for the five kinds beyond `human`.
    expect(turnAt(result, 5).kind).toBe('unknown');
    expect(turnAt(result, 5).title).toBe('');
    for (const turn of result.turns) expect(typeof turn.title).toBe('string');
  });

  it('carries the LAST free title and the FIRST HUMAN prompt, not the first user line', () => {
    const result = project('turn-kinds.jsonl');

    expect(result.header?.title).toBe('the last title');
    expect(result.header?.preview).toHaveLength(200);
    expect(result.header?.preview?.startsWith('ship the projector.')).toBe(true);
    expect(result.header?.preview).not.toContain('system-reminder');

    expect(result.header?.project_path).toBe('/Users/dev/proj');
    expect(result.header?.git_branch).toBe('main');
    expect(result.header?.harness_version).toBe('2.1.212');
    expect(result.header?.model).toBe('claude-opus-5');
    expect(result.header?.session_id).toBe(SESSION);
  });

  it('stamps folded tokens on the first event of a request group only', () => {
    const result = project('turn-kinds.jsonl');
    const stamped = result.events.filter((event) => event.tokens_in !== undefined);

    expect(stamped).toHaveLength(1);
    expect(stamped[0]).toMatchObject({
      tokens_in: 11,
      tokens_out: 22,
      tokens_cache_read: 33,
      tokens_cache_write: 44,
    });
    expect(turnAt(result, 1).tokens_out).toBe(22);
  });

  it('folds a tool call and its result into one row', () => {
    // ★ REWRITTEN BY TASK 3.2, not repaired. This assertion pinned the seam 3.1
    // deliberately left open — `status: 'running'`, `output_storage: 'absent'`,
    // `text: undefined` — and `turn-kinds.jsonl` line 9 carries this very call's
    // `tool_result`. The moment the join landed, all three became a lie about
    // what the projector does, and a rewrite is the only honest fix. It is the
    // mirror image of the edit 3.1 made to `projector-version.test.ts`.
    const result = project('turn-kinds.jsonl');
    const call = result.events.find((event) => event.kind === 'tool_call');

    expect(call).toMatchObject({
      id: 'toolu_kinds1',
      name: 'Bash',
      // `is_error: false` on the result and no denial, so the ladder says `ok`.
      status: 'ok',
      output_storage: 'inline',
      text: 'stdout',
      text_bytes: 6,
      duration_source: 'elapsed',
      // Call stamped 09:00:03 on line 6, result 09:00:06 on line 9.
      duration_ms: 3000,
      result_block: 0,
      input_storage: 'inline',
      input_bytes: 16,
    });

    // The result LINE's own byte pair, which is what the resolver preads.
    const bytes = projectFixtureBytes('turn-kinds.jsonl');
    const slice = bytes
      .subarray(call!.result_offset!, call!.result_offset! + call!.result_len!)
      .toString('utf8');
    expect(JSON.parse(slice).uuid).toBe('77777777-1111-4111-8111-777777777777');

    expect(turnAt(result, 1).tool_call_count).toBe(1);
    // `is_error === true` exactly — never `!is_error`, which would call the
    // successful result on turn 4 a failure too.
    expect(turnAt(result, 4).error_count).toBe(0);
    expect(turnAt(result, 5).error_count).toBe(1);

    // This fixture's notification names no call, so nothing here can fold. The
    // positive limb is in the `parent_event_id` describe below.
    for (const turn of result.turns) expect(turn.parent_event_id).toBeUndefined();
    for (const event of result.events) expect(event.attrs).toBe('{}');
  });

  it('counts a failing call on its own turn, and marks that call `error`', () => {
    // The successor to `merge-e2e.test.ts` test 17b (plan 001). There, a tool
    // call that failed with no hook in the session read `ok` and silently zeroed
    // `error_count`; here every projection is hookless by construction, so the
    // status and the count are asserted together on the one call that failed.
    const result = project('tool-join.jsonl');
    const failing = result.events.find((event) => event.id === 'toolu_err');
    const turn = result.turns.find((candidate) => candidate.id === failing?.turn_id);

    expect(failing?.status).toBe('error');
    // `is_error === true` exactly. `toolu_ok`'s result carries `is_error: false`
    // and `toolu_unjoined` has no result at all, so a `!is_error` reading counts
    // three here instead of the two that really failed.
    expect(turn?.error_count).toBe(2);
  });

  it('renders an image as its placeholder, never its payload', () => {
    const result = project('turn-kinds.jsonl');
    const image = result.events.find((event) => event.text?.startsWith('[image') === true);

    expect(image?.kind).toBe('text');
    expect(image?.text).toBe('[image image/png, 0.0 KB]');
    expect(result.events.some((event) => event.text?.includes('iVBO') === true)).toBe(false);
  });

  it('reproduces the harness type verbatim on every row', () => {
    const result = project('turn-kinds.jsonl');
    const types = new Set(result.events.map((event) => event.raw_type));

    expect(types).toEqual(new Set(['system', 'user', 'assistant']));
    const compaction = result.events.find((event) => event.kind === 'compaction');
    expect(compaction?.raw_subtype).toBe('compact_boundary');
  });
});

describe('Task 5.1 — turns.parent_event_id names the Agent call a machinery turn answers', () => {
  it('stamps the Agent call, across turns', () => {
    // `toolu_marker` is called in turn 0 and answered in turn 4, which is the
    // whole reason the index is built over the finished event array rather than
    // during emission.
    const result = project('async-agent.jsonl');

    expect(turnAt(result, 4)).toMatchObject({
      kind: 'task_notification',
      parent_event_id: 'toolu_marker',
    });
    expect(turnAt(result, 5).parent_event_id).toBe('toolu_structured');

    // Non-vacuity: the id is a real event on the same projection.
    const call = result.events.find((event) => event.id === 'toolu_marker');
    expect(call?.name).toBe('Agent');

    // And nothing else is stamped.
    const stamped = result.turns.filter((turn) => turn.parent_event_id !== undefined);
    expect(stamped.map((turn) => turn.seq)).toEqual([4, 5]);
  });

  it('leaves a notification that names a Bash call unstamped', () => {
    // `tools.ts` rule 3: a notification is not Agent-exclusive, and folding a
    // `Bash` away would hide real output.
    const result = project('notification-non-agent.jsonl');
    const turn = turnAt(result, 1);

    expect(turn.kind).toBe('task_notification');
    expect(turn.parent_event_id).toBeUndefined();
    // Non-vacuity: the call it names IS on the projection, under another name.
    expect(result.events.find((event) => event.id === 'toolu_bash')?.name).toBe('Bash');
  });

  it('leaves a notification that names no call unstamped', () => {
    const result = project('turn-kinds.jsonl');
    const turn = turnAt(result, 2);

    expect(turn.kind).toBe('task_notification');
    expect(turn.parent_event_id).toBeUndefined();
  });

  it('stamps an Agent call whose only answer is the notification', () => {
    const result = project('notification-no-result.jsonl');
    expect(turnAt(result, 1).parent_event_id).toBe('toolu_noresult');
  });
});

describe('AC5 — a file that projects nothing is not a session', () => {
  it('gives a journal-shaped file no header, no turns and no events', () => {
    const result = project('not-a-session.jsonl');

    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.every((line) => line.uuid === undefined)).toBe(true);
    expect(result.turns).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.header).toBeUndefined();
    // Reported, never silently skipped.
    expect(result.drift).toBe('{}');
  });

  it('gives a one-line session a header whose bounds are that line', () => {
    const result = project('one-line-session.jsonl');

    expect(result.header?.started_at).toBe('2026-08-14T13:37:00.000Z');
    expect(result.header?.last_activity_at).toBe('2026-08-14T13:37:00.000Z');
    expect(result.turns).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });
});

describe('AC6 — turns.duration_ms on both paths', () => {
  it.each([
    ['1970-01-01T00:00:00.000Z', 0],
    ['1969-12-31T23:59:59.999Z', -1],
    ['2024-02-29T12:00:00.000Z', 1709208000000],
    ['2026-08-01T00:00:00.000Z', 1785542400000],
    ['2027-01-01T00:00:00.000Z', 1798761600000],
    ['2026-08-14T23:59:59.999Z', 1786751999999],
    ['2000-02-29T00:00:00.000Z', 951782400000],
    ['2100-03-01T00:00:00.000Z', 4107542400000],
  ])('epochMs(%s) is %i', (ts, expected) => {
    // Literal expectations, never a re-derivation: comparing against a second
    // implementation of the same arithmetic proves only that it was copied.
    expect(epochMs(ts)).toBe(expected);
  });

  it('prefers the harness-reported duration where the segment reports one', () => {
    const result = project('turn-duration.jsonl');
    const reported = turnAt(result, 0);

    expect(reported.duration_source).toBe('turn_duration');
    expect(reported.duration_ms).toBe(4242);
  });

  it('derives the duration where the segment reports none — the majority path', () => {
    const result = project('turn-duration.jsonl');
    const derived = turnAt(result, 1);

    expect(derived.duration_source).toBe('derived');
    expect(derived.duration_ms).toBe(2500);
    expect(derived.duration_ms).toBe(epochMs(derived.ended_at) - epochMs(derived.started_at));
  });

  it('answers 0, never null, for a segment whose timestamps are all equal', () => {
    const result = project('turn-duration.jsonl');
    const instant = turnAt(result, 2);

    expect(instant.started_at).toBe(instant.ended_at);
    expect(instant.duration_source).toBe('derived');
    expect(instant.duration_ms).toBe(0);
  });
});

describe('AC7 — drift is one column, carrying three buckets', () => {
  it('serializes exactly the three keys, in order, from ONE counter', () => {
    const result = project('drift-three-ways.jsonl');
    const parsed: Record<string, unknown> = JSON.parse(result.drift);

    expect(Object.keys(parsed)).toEqual([
      'unknown_block_types',
      'unknown_line_types',
      'unknown_top_level_fields',
    ]);
    expect(parsed.unknown_block_types).toEqual({ hologram: 1 });
    expect(parsed.unknown_line_types).toEqual({ 'holographic-preview': 1 });
    expect(parsed.unknown_top_level_fields).toEqual({ novelField: 1 });
  });

  it('drops the empty bucket, so a clean counter still serializes to `{}`', () => {
    expect(new DriftCounter().serialize()).toBe('{}');
    expect(project('one-line-session.jsonl').drift).toBe('{}');
  });
});

describe('AC10 — src_offset and src_len are the emitting LINE’s', () => {
  it('measures byte lengths that tile the file, even across multibyte prompts', () => {
    // The loader arm. A `.length`-instead-of-`Buffer.byteLength` regression reds
    // on the first emoji, which is why this drives the multibyte fixture.
    const bytes = fixtureBytes('multibyte-offsets.jsonl');
    const entries = offsetLines(bytes.toString('utf8'));

    expect(entries.length).toBeGreaterThan(1);
    for (const [index, entry] of entries.entries()) {
      const next = entries[index + 1];
      if (next === undefined)
        expect(entry.byteOffset + entry.byteLength).toBeLessThanOrEqual(bytes.byteLength);
      else expect(entry.byteOffset + entry.byteLength + 1).toBe(next.byteOffset);
    }
  });

  it.each(['turn-kinds.jsonl', 'turn-duration.jsonl', 'late-parent.jsonl'])(
    '%s carries the line pair on every row emitted from that line',
    (name) => {
      const result = project(name);
      const byOffset = new Map<number, ProjectedEvent[]>();

      for (const event of result.events) {
        expect(Number.isInteger(event.src_offset)).toBe(true);
        expect(Number.isInteger(event.src_len)).toBe(true);
        expect(event.src_len).toBeGreaterThan(0);
        byOffset.set(event.src_offset, [...(byOffset.get(event.src_offset) ?? []), event]);
      }

      // The pair is the LINE's, so every row from one line agrees on it.
      for (const own of byOffset.values()) {
        expect(new Set(own.map((event) => event.src_len)).size).toBe(1);
      }
    },
  );

  it.each(['turn-kinds.jsonl', 'turn-duration.jsonl'])(
    '%s round-trips: slicing the bytes at the pair parses back to the emitting line',
    (name) => {
      // Exactly what the resolver's line_ref arm does before it indexes
      // `block[block_index]`.
      const bytes = projectFixtureBytes(name);
      const result = project(name);
      const uuidAt = new Map(result.lines.map((line) => [line.byte_offset, line.uuid]));

      expect(result.events.length).toBeGreaterThan(0);
      for (const event of result.events) {
        const slice = bytes.subarray(event.src_offset, event.src_offset + event.src_len);
        const parsed: { uuid?: unknown } = JSON.parse(slice.toString('utf8'));
        expect(parsed.uuid).toBe(uuidAt.get(event.src_offset));
      }
    },
  );
});
