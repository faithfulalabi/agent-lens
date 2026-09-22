// Task 2.2 AC1-AC5 and AC7. Every count quoted here was measured against
// `~/.agent-lens/archive` on 2026-08-13 and is asserted against a FROZEN fixture,
// never against the live corpus: the archive is append-only and grew 40,701 ->
// 41,911 lines between the approach being written and this suite being written.
// An absolute count asserted against live data decays into a false failure.

import { describe, expect, it } from 'vitest';
import {
  classifyLine,
  foldControlLines,
  foldSessionEnvelope,
  type ParsedKind,
  type ParsedLine,
} from '../line.js';
import { classifyFixture, ctx, fixtureBytes } from './fixtures.js';

/** The 14 measured top-level types, with their 2026-08-13 archive counts. */
const TOP_LEVEL_TYPES: ReadonlyArray<readonly [string, number]> = [
  ['assistant', 22748],
  ['user', 13620],
  ['attachment', 912],
  ['mode', 799],
  ['last-prompt', 790],
  ['permission-mode', 727],
  ['system', 602],
  ['queue-operation', 534],
  ['ai-title', 474],
  ['pr-link', 346],
  ['file-history-snapshot', 210],
  ['file-history-delta', 125],
  ['started', 12],
  ['result', 12],
];

/** The 7 declared `system` subtypes. `api_error` is the one with no witness. */
const SYSTEM_SUBTYPES = [
  'turn_duration',
  'stop_hook_summary',
  'away_summary',
  'local_command',
  'compact_boundary',
  'informational',
  'api_error',
] as const;

describe('AC1 — every measured top-level type classifies to its own kind', () => {
  const { lines } = classifyFixture('all-types.jsonl');

  it('covers all 14 measured types, one fixture line each', () => {
    expect(TOP_LEVEL_TYPES).toHaveLength(14);
    expect(lines).toHaveLength(14);
    // A set: the fixture is ordered for readability, the list above by measured
    // frequency, and neither ordering is a property worth pinning.
    expect(new Set(lines.map((line) => line.kind))).toEqual(
      new Set(TOP_LEVEL_TYPES.map(([name]) => name)),
    );
  });

  it('classifies nothing in the measured fixture as unknown', () => {
    expect(lines.filter((line) => line.kind === 'unknown')).toEqual([]);
  });

  it('the union is exhaustive — a new kind will not compile', () => {
    // The `never` default is the assertion: adding an arm to `ParsedLine` without
    // adding it here is a TYPE error, which is the only way to keep this list and
    // the union in step once the harness ships a 15th type.
    const label = (line: ParsedLine): string => {
      switch (line.kind) {
        case 'assistant':
        case 'user':
        case 'attachment':
        case 'mode':
        case 'last-prompt':
        case 'permission-mode':
        case 'queue-operation':
        case 'ai-title':
        case 'pr-link':
        case 'file-history-snapshot':
        case 'file-history-delta':
        case 'started':
        case 'result':
          return line.kind;
        case 'system':
          return `system.${line.subtype}`;
        case 'unknown':
          return `unknown:${line.raw_type}`;
        default: {
          const impossible: never = line;
          return impossible;
        }
      }
    };
    expect(lines.map(label)).toContain('system.turn_duration');
  });

  it('reads identity out of the four types that carry a uuid', () => {
    const withUuid = lines.filter((line) => line.uuid !== undefined).map((line) => line.kind);
    expect(withUuid).toEqual(['assistant', 'user', 'system', 'attachment']);
  });
});

describe('AC1 — every declared system subtype classifies', () => {
  const { lines } = classifyFixture('system-subtypes.jsonl');

  it('classifies all 7 declared subtypes', () => {
    expect(lines.map((line) => (line.kind === 'system' ? line.subtype : line.kind))).toEqual([
      ...SYSTEM_SUBTYPES,
    ]);
  });

  it('reaches compact_boundary ONLY through system.subtype, never the top level', () => {
    // The trap: `compact_boundary` is not a top-level type (0 occurrences there,
    // 3 as a subtype). Anything that greps for it at the top level silently drops
    // every compaction in the corpus.
    const boundary = lines.find(
      (line) => line.kind === 'system' && line.subtype === 'compact_boundary',
    );
    expect(boundary?.kind).toBe('system');

    const asTopLevel = classifyLine({ type: 'compact_boundary' }, ctx());
    expect(asTopLevel.kind).toBe('unknown');
  });

  it('an unrecognised subtype is unknown with raw_type "system", not a generic system row', () => {
    const line = classifyLine(
      { type: 'system', subtype: 'quantum_entanglement', uuid: 'u1' },
      ctx(64),
    );
    expect(line.kind).toBe('unknown');
    if (line.kind !== 'unknown') throw new Error('unreachable');
    expect(line.raw_type).toBe('system');
    expect(line.raw_subtype).toBe('quantum_entanglement');
    expect(line.byte_offset).toBe(64);
  });
});

describe('AC1 — started and result are sidecar-only and both classify', () => {
  // Both live exclusively in `subagents/workflows/wf_*/journal.jsonl`, 12 each,
  // paired 1:1. `result` was absent from the original type list; the 2026-08-13
  // ruling classifies it rather than dropping it to unknown, because Task 3.3
  // (sub-agent linkage) needs both ends of the workflow span.
  const { lines } = classifyFixture('all-types.jsonl');

  it('classifies both, and neither carries a uuid', () => {
    const pair = lines.filter((line) => line.kind === 'started' || line.kind === 'result');
    expect(pair.map((line) => line.kind)).toEqual(['started', 'result']);
    expect(pair.map((line) => line.uuid)).toEqual([undefined, undefined]);
  });
});

describe('AC2 — api_error keeps its branch with no live witness', () => {
  // DEFENSIVE AND DATED. `api_error` measured 9 occurrences on 2026-08-07 and 0
  // on 2026-08-13: pure transcript expiry, not removal from the harness —
  // `isApiErrorMessage` is still sent on 9 assistant lines in the same archive.
  // There is therefore NO corpus witness for this line, and the fixture below is
  // hand-authored. Deleting the branch because "nothing produces it" would make
  // the next API outage classify as unknown.
  it('classifies from a synthetic fixture', () => {
    const { lines } = classifyFixture('system-subtypes.jsonl');
    const apiError = lines.find((line) => line.kind === 'system' && line.subtype === 'api_error');
    expect(apiError).toBeDefined();
  });
});

describe('AC3 — unknown lines render, never drop', () => {
  const { lines, offsets, drift } = classifyFixture('unknown-types.jsonl');

  it('yields N rows for N lines, all unknown, none dropped', () => {
    expect(lines).toHaveLength(offsets.length);
    expect(lines.every((line) => line.kind === 'unknown')).toBe(true);
  });

  it('carries raw_type, raw_subtype and the byte offset verbatim', () => {
    const unknowns = lines.map((line) =>
      line.kind === 'unknown'
        ? { raw_type: line.raw_type, raw_subtype: line.raw_subtype, byte_offset: line.byte_offset }
        : undefined,
    );
    expect(unknowns.map((u) => u?.raw_type)).toEqual([
      'summary',
      'holographic-preview',
      'system',
      '<number>',
      '<null>',
      '<undefined>',
      '',
    ]);
    expect(unknowns.map((u) => u?.raw_subtype)).toEqual([
      '',
      '',
      'quantum_entanglement',
      '',
      '',
      '',
      '',
    ]);
    expect(unknowns.map((u) => u?.byte_offset)).toEqual(offsets.map((o) => o.byteOffset));
  });

  it('counts each unnameable type in drift, keeping number, null and absent apart', () => {
    const counted = JSON.parse(drift.serialize()).unknown_line_types;
    expect(Object.keys(counted)).toEqual([
      '',
      '<null>',
      '<number>',
      '<undefined>',
      'holographic-preview',
      'summary',
      'system.quantum_entanglement',
    ]);
  });

  it.each([
    ['an array', [1, 2, 3]],
    ['a bare string', 'not an object'],
    ['a number', 7],
    ['null', null],
    ['a boolean', true],
  ])('%s is still one row, never a throw', (_label, value) => {
    const line = classifyLine(value, ctx(11));
    expect(line.kind).toBe('unknown');
    expect(line.byte_offset).toBe(11);
  });
});

describe('AC4 — byte offsets are archive-relative and multibyte-safe', () => {
  const NAME = 'multibyte-offsets.jsonl';
  const bytes = fixtureBytes(NAME);
  const { lines, offsets } = classifyFixture(NAME);

  it('points at the real first byte of the target line, past a 4-byte emoji', () => {
    const target = lines.at(-1);
    expect(target?.kind).toBe('ai-title');
    const offset = target?.byte_offset ?? -1;
    expect(bytes.subarray(offset, offset + 18).toString('utf8')).toBe('{"type":"ai-title"');
  });

  it('a string index would have been wrong — the fixture is non-vacuous', () => {
    // Without this the test above would pass on an ASCII-only fixture and prove
    // nothing. `🚀` is 4 bytes and 2 UTF-16 units, so the two disagree.
    const text = bytes.toString('utf8');
    const stringIndex = text.indexOf('{"type":"ai-title"');
    const byteOffset = offsets.at(-1)?.byteOffset ?? -1;
    expect(byteOffset).toBeGreaterThan(stringIndex);
    expect(text).toContain('🚀');
  });

  it('every offset lands on a line start', () => {
    for (const { byteOffset } of offsets) {
      expect(bytes.subarray(byteOffset, byteOffset + 1).toString('utf8')).toBe('{');
    }
  });
});

describe('AC5 — the 10 uuid-less types project to nothing, bar two exceptions', () => {
  const UUID_LESS: readonly ParsedKind[] = [
    'mode',
    'permission-mode',
    'file-history-snapshot',
    'last-prompt',
    'ai-title',
    'queue-operation',
    'file-history-delta',
    'pr-link',
    'started',
    'result',
  ];

  it('is exactly 10 types, and none of them carries a uuid', () => {
    // 34.7% of session-file lines (3,779 of 10,879) on 2026-08-13.
    expect(UUID_LESS).toHaveLength(10);
    const { lines } = classifyFixture('all-types.jsonl');
    const uuidLess = lines.filter((line) => line.uuid === undefined).map((line) => line.kind);
    expect(new Set(uuidLess)).toEqual(new Set(UUID_LESS));
  });

  it('projects nothing at all from the eight that are not exceptions', () => {
    const { lines } = classifyFixture('all-types.jsonl');
    const projection = foldControlLines(
      lines.filter((line) => line.kind !== 'ai-title' && line.kind !== 'last-prompt'),
    );
    expect(projection).toEqual({
      ai_title: undefined,
      last_prompt: undefined,
      last_prompt_leaf_uuid: undefined,
    });
  });

  it('the LAST ai-title and the LAST last-prompt win, not the first', () => {
    // The fixture carries 3 of each with distinct values, none in a final
    // position. Non-vacuous in reality: 19 of 26 archived session files carry
    // more than one `ai-title`, one of them 66. A first-wins implementation
    // reds here, which is the whole reason the values differ.
    const { lines } = classifyFixture('control-lines.jsonl');
    expect(lines.filter((line) => line.kind === 'ai-title')).toHaveLength(3);
    expect(lines.filter((line) => line.kind === 'last-prompt')).toHaveLength(3);
    expect(lines.at(-1)?.kind).not.toBe('ai-title');
    expect(lines.at(-1)?.kind).not.toBe('last-prompt');

    expect(foldControlLines(lines)).toEqual({
      ai_title: 'third title',
      last_prompt: 'third prompt',
      last_prompt_leaf_uuid: 'aaaaaaaa-3333-4333-8333-333333333333',
    });
  });

  it('a first-wins fold would produce the stale title this test forbids', () => {
    // Names the bug the assertion above exists to catch, so a future reader can
    // see it is about ordering rather than about which fixture line was picked.
    const { lines } = classifyFixture('control-lines.jsonl');
    const firstWins = lines.find((line) => line.kind === 'ai-title');
    expect(firstWins?.raw.aiTitle).toBe('first title');
    expect(foldControlLines(lines).ai_title).not.toBe('first title');
  });
});

describe('AC7 — summary has no branch', () => {
  it('a top-level summary line classifies as unknown', () => {
    // 0 top-level occurrences across the whole archive, re-confirmed 2026-08-13.
    // Both `"type":"summary"` hits in the corpus are nested inside other
    // payloads, which a top-level classifier never sees.
    const line = classifyLine({ type: 'summary', summary: 'text' }, ctx());
    expect(line.kind).toBe('unknown');
    if (line.kind !== 'unknown') throw new Error('unreachable');
    expect(line.raw_type).toBe('summary');
  });
});

describe('Task 0.13 — foldSessionEnvelope answers `model` on its own rule', () => {
  /** One assistant line naming `model`, classified the way production does. */
  function modelLine(model: string, over: Record<string, unknown> = {}): ParsedLine {
    return classifyLine(
      {
        type: 'assistant',
        uuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        timestamp: '2026-08-14T09:00:00.000Z',
        cwd: '/Users/dev/proj',
        gitBranch: 'main',
        version: '2.1.212',
        requestId: 'req_one',
        ...over,
        message: { role: 'assistant', model, content: [] },
      },
      ctx(),
    );
  }

  it('drops `<synthetic>` before the tally, so the marker never folds through', () => {
    const lines = [modelLine('claude-opus-5'), modelLine('<synthetic>')];
    expect(foldSessionEnvelope(lines).model).toBe('claude-opus-5');
  });

  it('answers undefined when `<synthetic>` is the only model named', () => {
    // The NULL floor. A marker that names no model must not be priced, and
    // must not be reported as though a model of that name had run.
    const lines = [modelLine('<synthetic>'), modelLine('<synthetic>')];
    expect(foldSessionEnvelope(lines).model).toBeUndefined();
  });

  it('lets the most-named model beat a real model on the last line', () => {
    const lines = [
      modelLine('claude-opus-5'),
      modelLine('claude-opus-5'),
      modelLine('claude-haiku-4-5-20251001'),
    ];
    expect(foldSessionEnvelope(lines).model).toBe('claude-opus-5');
  });

  it('breaks a tie to the FIRST model seen, which IS first-real-model-wins', () => {
    // Asserted from both directions because the tie-break is a semantic
    // choice, not a consequence of `Map` iteration order. On a
    // one-line-against-one-line tie this rule is candidate (a), which is wrong
    // on a session that switched deliberately — it is taken because it is
    // deterministic and because no measured session ties.
    const forward = [modelLine('claude-opus-5'), modelLine('claude-sonnet-5')];
    const reversed = [modelLine('claude-sonnet-5'), modelLine('claude-opus-5')];

    expect(foldSessionEnvelope(forward).model).toBe('claude-opus-5');
    expect(foldSessionEnvelope(reversed).model).toBe('claude-sonnet-5');
  });

  it('folds the same lines twice into the same envelope', () => {
    const lines = [
      modelLine('claude-opus-5'),
      modelLine('claude-sonnet-5'),
      modelLine('claude-opus-5'),
      modelLine('<synthetic>'),
    ];

    expect(foldSessionEnvelope(lines).model).toBe('claude-opus-5');
    expect(foldSessionEnvelope(lines)).toEqual(foldSessionEnvelope(lines));
  });

  it('leaves cwd, branch and version last-wins on the very line it excludes', () => {
    // The exclusion is scoped to `model`. A `<synthetic>` line carries the
    // session's real `cwd`, `gitBranch` and `version` — measured, 8 of 8 — so
    // skipping the whole line would lose three fields to fix one.
    const lines = [
      modelLine('claude-opus-5'),
      modelLine('<synthetic>', {
        cwd: '/Users/dev/proj/deeper',
        gitBranch: 'release',
        version: '2.1.213',
      }),
    ];
    const envelope = foldSessionEnvelope(lines);

    expect(envelope.model).toBe('claude-opus-5');
    expect(envelope.project_path).toBe('/Users/dev/proj/deeper');
    expect(envelope.git_branch).toBe('release');
    expect(envelope.harness_version).toBe('2.1.213');
  });
});
