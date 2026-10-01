// Task 2.2 AC6. Drift is what makes a Claude Code format change visible on the
// first session opened after the update, so the assertions here are about the
// counter noticing things — and about `serialize()` being deterministic, since
// `sessions.drift_json` is a column that gets diffed.

import { describe, expect, it } from 'vitest';
import { DriftCounter } from '../drift.js';
import { classifyLine } from '../line.js';
import { classifyFixture, ctx } from './fixtures.js';

describe('AC6 — unrecognised top-level fields are counted', () => {
  it('counts exactly the 3 injected fields and nothing else', () => {
    const { drift } = classifyFixture('drift-injected.jsonl');
    const report = JSON.parse(drift.serialize());
    expect(Object.keys(report.unknown_top_level_fields)).toEqual([
      'aaaInjected',
      'mmmInjected',
      'zzzInjected',
    ]);
    expect(report.unknown_line_types).toBeUndefined();
  });

  it('emits sorted keys, whatever order the fields arrived in', () => {
    // The fixture injects them z, a, m. An insertion-ordered map would make two
    // identical sessions produce two different rows and every diff of the column
    // become noise.
    const { drift } = classifyFixture('drift-injected.jsonl');
    expect(drift.serialize()).toBe(
      '{"unknown_top_level_fields":{"aaaInjected":1,"mmmInjected":1,"zzzInjected":1}}',
    );
  });

  it('counts repeats rather than deduplicating them', () => {
    const drift = new DriftCounter();
    for (let i = 0; i < 3; i++) {
      classifyLine(
        { type: 'mode', mode: 'default', novelField: i },
        { byteOffset: i, byteLength: 0, drift },
      );
    }
    expect(JSON.parse(drift.serialize()).unknown_top_level_fields).toEqual({ novelField: 3 });
  });

  it('a clean fixture serializes to exactly "{}"', () => {
    // Doubles as proof that the measured allowlist covers every one of the 17
    // types: a single field missing from `LINE_TYPES` reds this.
    const { drift } = classifyFixture('all-types.jsonl');
    expect(drift.serialize()).toBe('{}');
  });

  it('a fresh counter serializes to exactly "{}"', () => {
    expect(new DriftCounter().serialize()).toBe('{}');
  });

  it('every system subtype in the fixture is clean too', () => {
    const { drift } = classifyFixture('system-subtypes.jsonl');
    expect(drift.serialize()).toBe('{}');
  });
});

describe('AC6 — unknown line types are counted separately from fields', () => {
  it('an unnameable type is counted as a type, not as a pile of fields', () => {
    // A whole new type would otherwise flood the field report with its entire
    // legitimate inventory, burying the one field that actually drifted.
    const drift = new DriftCounter();
    classifyLine(
      { type: 'holographic-preview', frames: 3, codec: 'x' },
      { byteOffset: 0, byteLength: 0, drift },
    );
    expect(JSON.parse(drift.serialize())).toEqual({
      unknown_line_types: { 'holographic-preview': 1 },
    });
  });

  it('an unrecognised system subtype is namespaced, so it cannot be read as a new type', () => {
    const drift = new DriftCounter();
    classifyLine(
      { type: 'system', subtype: 'quantum_entanglement' },
      { byteOffset: 0, byteLength: 0, drift },
    );
    expect(JSON.parse(drift.serialize()).unknown_line_types).toEqual({
      'system.quantum_entanglement': 1,
    });
  });
});

describe('AC8 — unjoined tool calls are a scalar, and silence stays silent', () => {
  it('sorts `unjoined_tool_uses` FIRST, proved on a counter carrying two buckets', () => {
    // ★ The ordering claim belongs HERE and not on a projected fixture: a
    // fixture that drifts one way gives a ONE-KEY object, in which ordering is
    // undefined by vacuity. `serialize()`'s contract is `serialize()`'s to test.
    // `'unjoined' < 'unknown'` — `j` before `k` — and the column is diffed, so
    // two identically drifted sessions must produce byte-identical rows.
    const drift = new DriftCounter();
    drift.noteUnjoinedToolUse();
    drift.noteUnknownBlock('hologram');

    expect(Object.keys(JSON.parse(drift.serialize()))).toEqual([
      'unjoined_tool_uses',
      'unknown_block_types',
    ]);
  });

  it('counts each unanswered call rather than merely flagging that one existed', () => {
    const drift = new DriftCounter();
    for (let i = 0; i < 3; i++) drift.noteUnjoinedToolUse();
    expect(JSON.parse(drift.serialize()).unjoined_tool_uses).toBe(3);
  });

  it('OMITS the key at zero, which is what keeps a clean session at exactly `{}`', () => {
    // Load-bearing in two places, and neither is obvious: this file's exact
    // strings, and `pipeline.test.ts`'s exact-KEY assertion on `runPipeline`'s
    // drift output. A counter emitting `0` instead of omitting reds both.
    const drift = new DriftCounter();
    expect(drift.serialize()).toBe('{}');

    drift.noteUnknownBlock('hologram');
    expect(drift.serialize()).toBe('{"unknown_block_types":{"hologram":1}}');
  });
});

describe('Task 0.16 — the 2.1.277-2.1.284 shapes are absorbed, and only those', () => {
  // Measured 2026-09-30 against `~/.claude/projects` by importing THIS
  // `classifyLine` and THIS `DriftCounter`, not by re-implementing them: 48 files,
  // 10,637 lines, 3 unknown top-level types and exactly 17 unknown top-level
  // fields, each field on exactly one owning type. The fixture below carries all
  // 17 on the types they were measured on.
  //
  // The point of absorbing is PRECISION, not silence. Four of these five tests
  // exist to prove the alarm still works: a never-seen type is still counted, a
  // never-seen field beside an absorbed one is still counted, and an absorbed
  // field on the WRONG type is still counted.

  it('every one of the 17 absorbed fields is silent on its measured type', () => {
    const { lines, drift } = classifyFixture('harness-2-1-2xx.jsonl');
    expect(lines.map((line) => line.kind)).toEqual([
      'assistant',
      'user',
      'attachment',
      'queue-operation',
      'last-prompt',
    ]);
    expect(drift.serialize()).toBe('{}');
  });

  it('each of the 3 absorbed types classifies to its own kind, none unknown', () => {
    // The kind name is the harness `type` VERBATIM, which is what keeps
    // `project/pipeline.ts`'s `rawTypeOf` total. All three are uuid-less, so they
    // project no event and this is a `drift_json`-only change.
    const { lines } = classifyFixture('all-types.jsonl');
    const absorbed = lines.filter(
      (line) =>
        line.kind === 'atis-latch' ||
        line.kind === 'cost-state' ||
        line.kind === 'fork-context-ref',
    );
    expect(absorbed.map((line) => line.kind)).toEqual([
      'atis-latch',
      'cost-state',
      'fork-context-ref',
    ]);
    expect(absorbed.map((line) => line.uuid)).toEqual([undefined, undefined, undefined]);
  });

  it('a never-seen type is STILL unknown and still counted — the non-vacuity case', () => {
    // Inline rather than a line in `unknown-types.jsonl`: four exact-length
    // `toEqual` arrays are pinned over that fixture in `line.test.ts`, so one added
    // line reds three or four assertions that are about something else entirely.
    const shared = ctx();
    const line = classifyLine({ type: 'atis-latch-v2', atis: 'x', sessionId: 's' }, shared);
    expect(line.kind).toBe('unknown');
    if (line.kind !== 'unknown') throw new Error('unreachable');
    expect(line.raw_type).toBe('atis-latch-v2');
    expect(JSON.parse(shared.drift.serialize())).toEqual({
      unknown_line_types: { 'atis-latch-v2': 1 },
    });
  });

  it('an absorbed field does not cover for a new one on the same line', () => {
    const shared = ctx();
    classifyLine(
      {
        type: 'assistant',
        uuid: '22222222-2222-4222-8222-222222222222',
        wireToolInputs: { toolu_01: {} },
        zzzBrandNew: true,
      },
      shared,
    );
    expect(JSON.parse(shared.drift.serialize()).unknown_top_level_fields).toEqual({
      zzzBrandNew: 1,
    });
  });

  it('absorbs per measured type, never globally — `rendered` on a `mode` line still counts', () => {
    // Meaningful precisely because `mode` does not union `ENVELOPE` and because
    // `noteLine` diffs against `knownFields` alone: there is no second global
    // allowlist for a name to leak through.
    const onAttachment = ctx();
    classifyLine(
      { type: 'attachment', uuid: '66666666-6666-4666-8666-666666666666', rendered: 'text' },
      onAttachment,
    );
    expect(onAttachment.drift.serialize()).toBe('{}');

    const onMode = ctx();
    classifyLine({ type: 'mode', mode: 'default', rendered: 'text' }, onMode);
    expect(JSON.parse(onMode.drift.serialize()).unknown_top_level_fields).toEqual({ rendered: 1 });
  });
});

describe('the counter is total and cannot be tricked by a transcript', () => {
  it('a literal __proto__ field is counted as data, not applied as a prototype', () => {
    // A transcript controls these key names. `Object.fromEntries` DEFINES rather
    // than assigns, so this stays an own property.
    const drift = new DriftCounter();
    drift.noteLine(JSON.parse('{"__proto__":{"polluted":true},"type":"mode"}'), new Set(['type']));
    const report = JSON.parse(drift.serialize());
    expect(Object.keys(report.unknown_top_level_fields)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a line whose fields are all known adds nothing', () => {
    const drift = new DriftCounter();
    drift.noteLine({ a: 1, b: 2 }, new Set(['a', 'b']));
    expect(drift.serialize()).toBe('{}');
  });

  it('a non-object line counts its type but no fields', () => {
    const drift = new DriftCounter();
    classifyLine([1, 2, 3], { byteOffset: 0, byteLength: 0, drift });
    expect(JSON.parse(drift.serialize())).toEqual({ unknown_line_types: { '<undefined>': 1 } });
  });

  it('classification and counting are one pass over the same ctx', () => {
    // The 2026-08-13 ruling: `ctx` carries the counter, because the moment of
    // classification is the only moment an unmeasured field is still visible.
    const shared = ctx();
    classifyLine({ type: 'mode', mode: 'default', driftA: 1 }, shared);
    classifyLine({ type: 'ai-title', aiTitle: 't', driftB: 2 }, shared);
    expect(JSON.parse(shared.drift.serialize()).unknown_top_level_fields).toEqual({
      driftA: 1,
      driftB: 1,
    });
  });
});
