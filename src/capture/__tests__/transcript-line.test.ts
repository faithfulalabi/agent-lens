// Task 3.1 AC3 — defensive parsing, at the unit level. The transcript format is
// officially unstable, so every case here is a shape the parser must survive
// rather than a shape it is allowed to expect. Line shapes are modelled on the
// measured corpus (4197 lines): 32.7% carry no `uuid`, 5.2% carry no
// `sessionId`, and the tool-output body is a pointer, not the output.

import { describe, expect, it } from 'vitest';
import { parseTranscriptLine, transcriptDeadLetter } from '../transcript-line.js';
import type { TranscriptLineContext } from '../transcript-line.js';

const FILE = '/private/tmp/projects/proj/sess-uuid.jsonl';
const MTIME = '2026-07-26T00:00:00.000Z';

function ctx(overrides: Partial<TranscriptLineContext> = {}): TranscriptLineContext {
  return {
    filePath: FILE,
    lineOffset: 0,
    fallbackSessionId: 'sess-uuid',
    fallbackTs: MTIME,
    ...overrides,
  };
}

describe('parseTranscriptLine — identity', () => {
  it('prefers the line uuid for the event id', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'line-uuid',
      sessionId: 'sess-real',
      timestamp: '2026-07-26T00:00:05.000Z',
    });
    const parsed = parseTranscriptLine(line, ctx());
    expect(parsed.kind).toBe('envelope');
    expect(parsed.envelope.event_id).toBe('sess-real:transcript:line-uuid');
    expect(parsed.envelope.source).toBe('transcript');
    expect(parsed.envelope.hook_name).toBeUndefined();
    expect(parsed.envelope.ts).toBe('2026-07-26T00:00:05.000Z');
  });

  it('falls back to the filename stem when the line carries no sessionId', () => {
    // The measured 5.2%: `file-history-snapshot` / `file-history-delta`.
    const line = JSON.stringify({ type: 'file-history-snapshot', messageId: 'm1' });
    const parsed = parseTranscriptLine(line, ctx());
    expect(parsed.kind).toBe('envelope');
    expect(parsed.envelope.session_id).toBe('sess-uuid');
  });

  it('falls back to the file mtime when the line carries no usable timestamp', () => {
    const noTs = parseTranscriptLine(JSON.stringify({ type: 'mode' }), ctx());
    expect(noTs.envelope.ts).toBe(MTIME);
    const badTs = parseTranscriptLine(
      JSON.stringify({ type: 'mode', timestamp: 'not-a-date' }),
      ctx(),
    );
    expect(badTs.envelope.ts).toBe(MTIME);
  });

  it('gives byte-identical uuid-less lines distinct ids by offset', () => {
    // 16.6% of the corpus is byte-identical uuid-less duplicates, including
    // `last-prompt` — losing one loses a user prompt permanently.
    const line = JSON.stringify({ type: 'last-prompt', prompt: 'ship it' });
    const a = parseTranscriptLine(line, ctx({ lineOffset: 0 }));
    const b = parseTranscriptLine(line, ctx({ lineOffset: 4096 }));
    expect(a.envelope.event_id).not.toBe(b.envelope.event_id);
    // Same line, same offset -> same id, so a re-read dedupes.
    expect(parseTranscriptLine(line, ctx({ lineOffset: 4096 })).envelope.event_id).toBe(
      b.envelope.event_id,
    );
  });
});

describe('parseTranscriptLine — preservation', () => {
  it('keeps the payload verbatim, with no field allowlist', () => {
    const payload = {
      type: 'assistant',
      uuid: 'u1',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
      futureFieldWeHaveNeverSeen: { nested: [1, 2, 3] },
    };
    const parsed = parseTranscriptLine(JSON.stringify(payload), ctx());
    expect(parsed.envelope.raw_payload).toEqual(payload);
  });

  it('preserves the persisted-output pointer without resolving it', () => {
    // Task 1.6 decision #1 was reversed: the body carries a preview plus a
    // pointer, and the complete bytes live in a sidecar. 3.1 preserves the
    // pointer; resolving it is a separate backfill task.
    const marker = [
      '<persisted-output>preview…',
      'Full output saved to: /tmp/p/tool-results/toolu_1.txt</persisted-output>',
    ].join('\n');
    const parsed = parseTranscriptLine(
      JSON.stringify({ type: 'user', uuid: 'u2', content: marker }),
      ctx(),
    );
    const payload = parsed.envelope.raw_payload as Record<string, unknown>;
    expect(payload.content).toBe(marker);
  });
});

describe('parseTranscriptLine — dead letters', () => {
  it.each([
    ['not JSON at all', '{"type":'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '42'],
    ['a JSON null', 'null'],
    ['a JSON string', '"hello"'],
  ])('dead-letters %s while keeping the bytes', (_label, line) => {
    const parsed = parseTranscriptLine(line, ctx());
    expect(parsed.kind).toBe('dead_letter');
    expect(parsed.envelope.raw_payload).toBe(line);
    expect(parsed.envelope.session_id).toBe('sess-uuid');
  });

  it('derives a stable dead-letter id, so a re-read dedupes', () => {
    const line = '{"type":';
    expect(parseTranscriptLine(line, ctx()).envelope.event_id).toBe(
      parseTranscriptLine(line, ctx()).envelope.event_id,
    );
  });

  it('transcriptDeadLetter wraps arbitrary text at a given offset', () => {
    const a = transcriptDeadLetter('<omitted>', ctx({ lineOffset: 0 }));
    const b = transcriptDeadLetter('<omitted>', ctx({ lineOffset: 10 }));
    expect(a.source).toBe('transcript');
    expect(a.raw_payload).toBe('<omitted>');
    expect(a.event_id).not.toBe(b.event_id);
  });
});
