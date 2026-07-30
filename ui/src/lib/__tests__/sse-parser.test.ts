import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseSseChunks, type SseFrame } from '../sse';
import { sseFrame } from './helpers';

/*
 * AC2 (wire-format half) — the incremental frame parser, tested with no
 * transport at all.
 *
 * The format is pinned against hono 4.12.31's serialiser, which is what the
 * server actually runs: `event: X`, then one `data:` line per line of payload,
 * then `id:` only when the id is truthy. `sseFrame()` in helpers.ts reproduces
 * that byte for byte, and the heartbeat test below bypasses it entirely and
 * feeds literal bytes, because the exact heartbeat shape is the whole point.
 *
 * fast-check@3.23.2 is a root devDependency and resolves here by node walk-up
 * (precedent: src/capture/__tests__/idempotency.property.test.ts).
 */

/** Feed a whole stream through in one go. */
function parseAll(chunks: readonly string[]): SseFrame[] {
  const parser = parseSseChunks();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe('parseSseChunks', () => {
  it('parses a raw_event frame into event, data and id', () => {
    const payload = { seq: 7, span_id: 'sp-1' };
    const frames = parseAll([sseFrame('raw_event', JSON.stringify(payload), '7')]);

    expect(frames).toEqual([{ event: 'raw_event', data: JSON.stringify(payload), id: '7' }]);
    expect(JSON.parse(frames[0]?.data ?? '')).toEqual(payload);
  });

  /*
   * ⭐ The regression pin for the parser Task 5.1b deleted.
   *
   * These are the literal bytes `writeSSE({ event: 'heartbeat', data: '' })`
   * emits: an EMPTY data line — not an SSE comment — and NO id line, because
   * hono drops a falsy id. The deleted parser looked for a line beginning
   * `data:`, found this one, fed '' to JSON.parse and swallowed the throw with
   * a bare catch. Any parser that branches on "has a data line" instead of on
   * the event name reproduces that bug and fails here.
   */
  it('emits a heartbeat as a real frame with an empty data value and no id', () => {
    const frames = parseAll(['event: heartbeat\ndata: \n\n']);
    expect(frames).toEqual([{ event: 'heartbeat', data: '' }]);
    expect(frames[0]).not.toHaveProperty('id');
  });

  it('defaults a frame with no event field to "message"', () => {
    expect(parseAll(['data: hi\n\n'])).toEqual([{ event: 'message', data: 'hi' }]);
  });

  it('joins repeated data lines with a newline and strips one leading space', () => {
    // Two leading spaces means the value really starts with one.
    expect(parseAll(['event: x\ndata: a\ndata:  b\ndata:\n\n'])).toEqual([
      { event: 'x', data: 'a\n b\n' },
    ]);
  });

  it('ignores comment lines and blocks that carry no field at all', () => {
    expect(parseAll([': keep-alive\n\n'])).toEqual([]);
    expect(parseAll(['\n\n\n\n'])).toEqual([]);
    expect(parseAll([': keep-alive\nevent: ping\ndata: 1\n\n'])).toEqual([
      { event: 'ping', data: '1' },
    ]);
  });

  it('parses retry and ignores a malformed one', () => {
    expect(parseAll(['retry: 2500\ndata: x\n\n'])).toEqual([
      { event: 'message', data: 'x', retry: 2500 },
    ]);
    expect(parseAll(['retry: soon\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it.each([
    { label: 'CRLF', terminator: '\r\n' },
    { label: 'bare CR', terminator: '\r' },
    { label: 'LF', terminator: '\n' },
  ])('treats $label as a line terminator', ({ terminator }) => {
    const raw =
      ['event: raw_event', 'data: {"a":1}', 'id: 4'].join(terminator) + terminator.repeat(2);
    expect(parseAll([raw])).toEqual([{ event: 'raw_event', data: '{"a":1}', id: '4' }]);
  });

  it('does not split a frame when a CRLF straddles a chunk boundary', () => {
    // The trap: normalising each chunk on its own turns "…\r" + "\n…" into two
    // newlines, which fabricates a frame boundary out of one line ending.
    const parser = parseSseChunks();
    const first = parser.push('event: raw_event\r\ndata: {"a":1}\r');
    const second = parser.push('\nid: 9\r\n\r\n');
    expect(first).toEqual([]);
    expect(second).toEqual([{ event: 'raw_event', data: '{"a":1}', id: '9' }]);
  });

  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const stream =
      sseFrame('raw_event', '{"seq":1}', '1') +
      'event: heartbeat\ndata: \n\n' +
      ': a comment\n\n' +
      sseFrame('raw_event', '{"seq":2}\nsecond line', '2');
    const expected = parseAll([stream]);
    expect(expected.length).toBe(3);

    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1 }), (sizes) => {
        const chunks: string[] = [];
        let index = 0;
        for (const size of sizes) {
          if (index >= stream.length) break;
          chunks.push(stream.slice(index, index + size));
          index += size;
        }
        if (index < stream.length) chunks.push(stream.slice(index));
        expect(parseAll(chunks)).toEqual(expected);
      }),
      { numRuns: 250 },
    );
  });

  it('holds an incomplete trailing frame until its blank line arrives', () => {
    const parser = parseSseChunks();
    expect(parser.push('event: raw_event\ndata: {"a":1}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'raw_event', data: '{"a":1}' }]);
  });
});
