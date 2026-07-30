import { describe, expect, it } from 'vitest';
import { makeEnvelope } from '../envelope.js';
import { deriveEventId } from '../event-id.js';

describe('makeEnvelope', () => {
  it('builds a hook envelope with event_id === deriveEventId(input)', () => {
    const env = makeEnvelope({
      source: 'hook',
      session_id: 'sess',
      hook_name: 'PostToolUse',
      tool_use_id: 'toolu_1',
      ts: '2026-07-22T00:00:00.000Z',
      raw_payload: { tool_name: 'Edit' },
    });
    expect(env.event_id).toBe(
      deriveEventId({
        source: 'hook',
        session_id: 'sess',
        hook_name: 'PostToolUse',
        tool_use_id: 'toolu_1',
        raw_payload: { tool_name: 'Edit' },
      }),
    );
    expect(env).toMatchObject({
      session_id: 'sess',
      harness: 'claude-code',
      source: 'hook',
      hook_name: 'PostToolUse',
      ts: '2026-07-22T00:00:00.000Z',
      raw_payload: { tool_name: 'Edit' },
    });
  });

  it('omits hook_name for a transcript envelope', () => {
    const env = makeEnvelope({
      source: 'transcript',
      session_id: 'sess',
      file_identity: '/proj/sess.jsonl',
      line_offset: 0,
      line: '{"type":"assistant"}',
      uuid: 'line-uuid',
      ts: '2026-07-22T00:00:01.000Z',
      raw_payload: { type: 'assistant' },
    });
    expect(env.hook_name).toBeUndefined();
    expect(env.event_id).toBe('sess:transcript:line-uuid');
  });

  it('survives a JSON round-trip structurally (spool safety)', () => {
    const env = makeEnvelope({
      source: 'backfill',
      session_id: 'sess',
      ts: '2026-07-22T00:00:02.000Z',
      raw_payload: { nested: { a: 1 }, list: [1, 2, 3] },
    });
    const roundTripped = JSON.parse(JSON.stringify(env));
    expect(roundTripped).toEqual(env);
  });

  it('defaults harness to claude-code but honors an override', () => {
    const env = makeEnvelope({
      source: 'backfill',
      session_id: 'sess',
      harness: 'other-harness',
      ts: '2026-07-22T00:00:03.000Z',
      raw_payload: {},
    });
    expect(env.harness).toBe('other-harness');
  });
});
