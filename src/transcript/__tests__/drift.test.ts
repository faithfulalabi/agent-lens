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
      classifyLine({ type: 'mode', mode: 'default', novelField: i }, { byteOffset: i, drift });
    }
    expect(JSON.parse(drift.serialize()).unknown_top_level_fields).toEqual({ novelField: 3 });
  });

  it('a clean fixture serializes to exactly "{}"', () => {
    // Doubles as proof that the measured allowlist covers every one of the 14
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
    classifyLine({ type: 'holographic-preview', frames: 3, codec: 'x' }, { byteOffset: 0, drift });
    expect(JSON.parse(drift.serialize())).toEqual({
      unknown_line_types: { 'holographic-preview': 1 },
    });
  });

  it('an unrecognised system subtype is namespaced, so it cannot be read as a new type', () => {
    const drift = new DriftCounter();
    classifyLine({ type: 'system', subtype: 'quantum_entanglement' }, { byteOffset: 0, drift });
    expect(JSON.parse(drift.serialize()).unknown_line_types).toEqual({
      'system.quantum_entanglement': 1,
    });
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
    classifyLine([1, 2, 3], { byteOffset: 0, drift });
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
