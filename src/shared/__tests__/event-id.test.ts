import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deriveEventId, canonicalJson } from '../event-id.js';
import type { EventIdInput } from '../event-id.js';

// A small generator of arbitrary EventIdInput values covering all three
// sources, with and without the optional correlator/uuid fields.
const hookInput = fc.record(
  {
    source: fc.constant('hook' as const),
    session_id: fc.string({ minLength: 1 }),
    hook_name: fc.string({ minLength: 1 }),
    tool_use_id: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    prompt_id: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    raw_payload: fc.object(),
  },
  { requiredKeys: ['source', 'session_id', 'hook_name', 'raw_payload'] },
);

const transcriptInput = fc.record(
  {
    source: fc.constant('transcript' as const),
    session_id: fc.string({ minLength: 1 }),
    file_identity: fc.string({ minLength: 1 }),
    line_offset: fc.nat(),
    line: fc.string(),
    uuid: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    raw_payload: fc.object(),
  },
  {
    requiredKeys: [
      'source',
      'session_id',
      'file_identity',
      'line_offset',
      'line',
      'raw_payload',
    ],
  },
);

const genericInput = fc.record({
  source: fc.constantFrom('backfill' as const, 'spool_replay' as const),
  session_id: fc.string({ minLength: 1 }),
  raw_payload: fc.object(),
});

const anyInput: fc.Arbitrary<EventIdInput> = fc.oneof(
  hookInput as fc.Arbitrary<EventIdInput>,
  transcriptInput as fc.Arbitrary<EventIdInput>,
  genericInput as fc.Arbitrary<EventIdInput>,
);

describe('deriveEventId — determinism (property)', () => {
  it('same input always yields the same id', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        expect(deriveEventId(input)).toBe(deriveEventId(input));
      }),
    );
  });

  it('id is stable under shuffled raw_payload key order (cross-process safe)', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.string({ minLength: 1 }),
        (payload, session_id) => {
          const a: EventIdInput = {
            source: 'backfill',
            session_id,
            raw_payload: payload,
          };
          // Rebuild the payload object with keys inserted in reverse order.
          const reordered: Record<string, unknown> = {};
          for (const key of Object.keys(payload).reverse()) {
            reordered[key] = (payload as Record<string, unknown>)[key];
          }
          const b: EventIdInput = {
            source: 'backfill',
            session_id,
            raw_payload: reordered,
          };
          expect(deriveEventId(a)).toBe(deriveEventId(b));
        },
      ),
    );
  });
});

describe('deriveEventId — no collisions (property)', () => {
  it('10k distinct inputs produce 10k distinct ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(
        deriveEventId({
          source: 'backfill',
          session_id: `s${i % 7}`,
          raw_payload: { seq: i, marker: `m-${i}` },
        }),
      );
    }
    expect(ids.size).toBe(10_000);
  });
});

describe('deriveEventId — hook precedence', () => {
  it('tool_use_id wins over prompt_id and hash', () => {
    const id = deriveEventId({
      source: 'hook',
      session_id: 'sess',
      hook_name: 'PostToolUse',
      tool_use_id: 'toolu_123',
      prompt_id: 'prompt_9',
      raw_payload: { a: 1 },
    });
    expect(id).toBe('sess:hook:PostToolUse:toolu_123');
  });

  it('prompt_id used when tool_use_id absent', () => {
    const id = deriveEventId({
      source: 'hook',
      session_id: 'sess',
      hook_name: 'UserPromptSubmit',
      prompt_id: 'prompt_9',
      raw_payload: { a: 1 },
    });
    expect(id).toBe('sess:hook:UserPromptSubmit:prompt_9');
  });

  it('stateless content hash used when both correlators absent', () => {
    const input: EventIdInput = {
      source: 'hook',
      session_id: 'sess',
      hook_name: 'Notification',
      raw_payload: { b: 2, a: 1 },
    };
    const id = deriveEventId(input);
    const expectedHash = canonicalJson(input.raw_payload);
    expect(id).toMatch(/^sess:hook:Notification:[0-9a-f]{32}$/);
    // Re-derivation is stable and matches the canonicalized-payload hash form.
    expect(deriveEventId(input)).toBe(id);
    // Sanity: canonicalization sorts keys deterministically.
    expect(expectedHash).toBe('{"a":1,"b":2}');
  });
});

describe('deriveEventId — transcript precedence', () => {
  it('uuid wins when present', () => {
    const id = deriveEventId({
      source: 'transcript',
      session_id: 'sess',
      file_identity: '/proj/sess.jsonl',
      line_offset: 4096,
      line: '{"type":"assistant"}',
      uuid: 'abc-uuid',
      raw_payload: {},
    });
    expect(id).toBe('sess:transcript:abc-uuid');
  });

  it('uuid ignores line_offset, so a uuid line survives a shift', () => {
    const base = {
      source: 'transcript' as const,
      session_id: 'sess',
      file_identity: '/proj/sess.jsonl',
      line: '{"type":"assistant"}',
      uuid: 'abc-uuid',
      raw_payload: {},
    };
    expect(deriveEventId({ ...base, line_offset: 0 })).toBe(
      deriveEventId({ ...base, line_offset: 900 }),
    );
  });

  it('content hash of file identity + offset + line when uuid absent', () => {
    const base = {
      source: 'transcript' as const,
      session_id: 'sess',
      file_identity: '/proj/sess.jsonl',
      line_offset: 0,
      line: '{"type":"assistant","text":"hi"}',
      raw_payload: {},
    };
    const id = deriveEventId(base);
    expect(id).toMatch(/^sess:transcript:[0-9a-f]{32}$/);
    // Identical file+offset+line -> identical id (idempotent re-read).
    expect(deriveEventId({ ...base })).toBe(id);
    // Different line -> different id.
    expect(deriveEventId({ ...base, line: 'other' })).not.toBe(id);
  });

  it('byte-identical uuid-less lines at different offsets are distinct events', () => {
    // 16.6% of the measured corpus is byte-identical uuid-less duplicates
    // (`mode`, `permission-mode`, `ai-title`, and `last-prompt` — which carries
    // the user's prompt text). Colliding them drops the later copy permanently.
    const base = {
      source: 'transcript' as const,
      session_id: 'sess',
      file_identity: '/proj/sess.jsonl',
      line: '{"type":"last-prompt","prompt":"ship it"}',
      raw_payload: {},
    };
    const first = deriveEventId({ ...base, line_offset: 0 });
    const second = deriveEventId({ ...base, line_offset: 512 });
    expect(first).not.toBe(second);
    // ...and the same line at the same offset is stable across re-reads.
    expect(deriveEventId({ ...base, line_offset: 512 })).toBe(second);
  });
});

describe('deriveEventId — universal fallback', () => {
  it('opaque payload hashes canonically', () => {
    const input: EventIdInput = {
      source: 'spool_replay',
      session_id: 'sess',
      raw_payload: { z: 9, a: 1 },
    };
    const id = deriveEventId(input);
    expect(id).toMatch(/^sess:spool_replay:[0-9a-f]{32}$/);
    expect(deriveEventId(input)).toBe(id);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys recursively and strips whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":1}',
    );
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});
