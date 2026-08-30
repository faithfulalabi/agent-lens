import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EventRow } from '../../../lib/api';
import { REASONING_NOT_RECORDED, buildThread } from '../../../lib/thread';
import { makeEventRow, makeSessionRow } from '../../../lib/__tests__/fixtures';
import { ThreadView } from '../ThreadView';
import { SessionHeader } from '../SessionHeader';

/*
 * Task 5.4's rendering half.
 *
 * `renderToStaticMarkup` only — the `ui` project has no DOM and effects never
 * run, which is why every decision this screen makes lives in `lib/thread.ts`
 * and this file asserts markup and nothing else.
 */

const SESSION_START = '2026-07-29T09:00:00.000Z';
const NOW = Date.parse('2026-07-29T09:10:00.000Z');

/** The thread markup for `events`, numbered in declaration order. */
function threadMarkup(events: Partial<EventRow>[], startedAt = SESSION_START): string {
  const rows = buildThread(
    events.map((event, i) => makeEventRow({ id: `ev-${i}`, seq: i, ...event })),
  );
  return renderToStaticMarkup(<ThreadView rows={rows} startedAt={startedAt} />);
}

function occurrences(markup: string, pattern: RegExp): number {
  return (markup.match(pattern) ?? []).length;
}

/* ---------------------------------------- the reading surface itself --- */

describe('the thread is a native ordered list the gate can read (AC-R1)', () => {
  const markup = threadMarkup([{ kind: 'tool_call' }, { kind: 'prompt', text: 'hello' }]);

  it('renders one <li> per row inside one <ol>', () => {
    expect(occurrences(markup, /<ol\b/g)).toBe(1);
    expect(occurrences(markup, /<li\b/g)).toBe(2);
  });

  it('adds no ARIA the elements do not already carry', () => {
    // `role="list"` only counts when every child sets `role="listitem"`, which
    // would bind all four row renderers for nothing a browser does not do.
    expect(markup).not.toContain('role="list"');
    expect(markup).not.toContain('role="listitem"');
  });

  it('carries the container slot and both per-row attributes', () => {
    expect(markup).toContain('data-slot="thread-view"');
    expect(markup).toContain('data-thread-kind="tool"');
    expect(markup).toContain('data-thread-kind="message"');
    expect(markup).toContain('data-event-id="ev-0"');
    expect(markup).toContain('data-event-id="ev-1"');
  });

  it('renders no data-event-kind, which is what makes the gate aim here', () => {
    // The pre-existing payload cross-check selects `data-event-kind`, which
    // `SpanRow` renders. If the thread carried it too, AC-R1 could go green
    // having read a tree row and never a thread row.
    expect(markup).not.toContain('data-event-kind');
  });

  it('windows nothing — every row is in the document (AC-R1 clause c)', () => {
    // A virtualizer would make the gate's rendered-marker count vacuous: fewer
    // markers than events would prove the window, not the model.
    const big = threadMarkup(Array.from({ length: 200 }, () => ({ kind: 'thinking' })));
    expect(occurrences(big, /data-thread-kind="thinking"/g)).toBe(200);
    expect(big).not.toContain('data-index');
  });
});

/* -------------------------------------------- Test 4 — the tool row --- */

describe('every tool call renders inline (Test 4, AC2)', () => {
  const markup = threadMarkup([
    {
      kind: 'tool_call',
      name: 'Bash',
      status: 'ok',
      input: '{"cmd":"ls -la /tmp"}',
      text: 'total 0\ndrwxr-xr-x  2 root root',
      ts: '2026-07-29T09:04:05.000Z',
    },
  ]);

  it('shows what was called, its status, its input and its output', () => {
    expect(markup).toContain('Bash');
    expect(markup).toContain('{&quot;cmd&quot;:&quot;ls -la /tmp&quot;}');
    expect(markup).toContain('drwxr-xr-x');
    expect(markup).toContain('data-slot="thread-input"');
    expect(markup).toContain('data-slot="thread-output"');
  });

  it('says the status in words, never in colour alone', () => {
    expect(markup).toContain('ok');
  });

  it('shows when it was called, as a real <time> with a machine-readable stamp', () => {
    // Case-insensitive: HTML attribute names are, and React emits the JSX
    // spelling verbatim here.
    expect(markup).toMatch(/<time datetime="2026-07-29T09:04:05\.000Z"/i);
    // The reader's own zone decides the digits, so the assertion is the shape.
    expect(markup).toMatch(/>\d{2}:\d{2}:\d{2}</);
  });

  it('omits a payload block the event has nothing for', () => {
    const bare = threadMarkup([{ kind: 'tool_call', input: null, text: null }]);
    expect(bare).not.toContain('data-slot="thread-input"');
    expect(bare).not.toContain('data-slot="thread-output"');
  });

  it('spells an unmeasured duration as the em dash, never as 0ms (Test 6, AC2)', () => {
    const unmeasured = threadMarkup([{ kind: 'tool_call', duration_ms: null }]);
    expect(unmeasured).toContain('—');
    expect(unmeasured).not.toContain('0ms');
  });
});

/* ---------------------------------- Test 5 — the reading order in a day --- */

describe('two events in one day read as two different times (Test 5, AC2)', () => {
  it('gives a 90-second gap two distinct wall clocks', () => {
    // `formatStartedAt` would answer `Nm ago` for both, i.e. the identical
    // string on every row of a same-day session. That is not a reading order.
    const markup = threadMarkup([
      { kind: 'prompt', ts: '2026-07-29T09:00:00.000Z', text: 'first' },
      { kind: 'prompt', ts: '2026-07-29T09:01:30.000Z', text: 'second' },
    ]);
    const times = [...markup.matchAll(/>(\d{2}:\d{2}:\d{2})</g)].map((hit) => hit[1]);

    expect(times).toHaveLength(2);
    expect(times[0]).not.toBe(times[1]);
    expect(markup, 'a same-day row stays a bare clock').not.toMatch(/>[A-Z][a-z]{2} \d/);
  });

  it('qualifies a row with its day once the day changes (F3)', () => {
    // MEASURED: 11 of 293 sessions cross a calendar day and the widest spans
    // 230.9 hours. On those a bare clock renders 23:59 then 00:01 and the
    // reading order appears to run backwards.
    const markup = threadMarkup(
      [
        { kind: 'prompt', ts: '2026-07-29T12:00:00.000Z', text: 'first' },
        { kind: 'prompt', ts: '2026-08-07T12:00:00.000Z', text: 'nine days later' },
      ],
      '2026-07-29T12:00:00.000Z',
    );
    expect(markup).toMatch(/>[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2}</);
  });
});

/* ------------------------------------- Test 8/9 — the reasoning marker --- */

describe('thinking rows carry the marker, and none is empty (Test 8, AC3)', () => {
  it('renders one marker per event, with the copy verbatim', () => {
    const markup = threadMarkup(
      Array.from({ length: 3 }, () => ({ kind: 'thinking', text: REASONING_NOT_RECORDED })),
    );

    expect(occurrences(markup, /data-thread-kind="thinking"/g)).toBe(3);
    expect(occurrences(markup, /reasoning not recorded \(signature only\)/g)).toBe(3);

    // AC3's "no marker is empty", read off the rendered text rather than the
    // model: a row that dropped its own copy would still count above.
    const bodies = [...markup.matchAll(/data-slot="thread-thinking"[^>]*>([^<]*)</g)];
    expect(bodies).toHaveLength(3);
    for (const [, body] of bodies) expect(body?.trim()).not.toBe('');
  });

  it('promises nothing it cannot open', () => {
    // The signature is in no column the wire sends, so the marker is terminal.
    // A disclosure here would offer a reader something that does not exist.
    const markup = threadMarkup([{ kind: 'thinking', text: REASONING_NOT_RECORDED }]);
    expect(markup).not.toContain('<details');
  });

  it('renders recorded reasoning as prose in the ordinary colour (Test 9, AC3)', () => {
    const markup = threadMarkup([{ kind: 'thinking', text: 'read the file first' }]);

    expect(markup).toContain('read the file first');
    expect(markup).not.toContain('reasoning not recorded');
    // The quiet gray says "nothing was written down". Real reasoning was, so
    // the paragraph reads in the ordinary colour — the glyph beside it stays
    // the thinking glyph either way.
    expect(markup).toMatch(/data-slot="thread-thinking"[^>]*text-foreground/);
    expect(markup).not.toMatch(/data-slot="thread-thinking"[^>]*text-span-thinking/);
  });
});

/* -------------------------------------- Test 10/11 — the drift alarm --- */

describe('an unrecognized record is shown, never swallowed (Test 10/11, AC3)', () => {
  const markup = threadMarkup([
    { kind: 'unknown', raw_type: 'system', raw_subtype: 'turn_duration' },
  ]);

  it('names the type and the subtype on screen', () => {
    expect(markup).toContain('unrecognized record (type=system/turn_duration)');
    expect(markup).toContain('data-thread-kind="unknown"');
  });

  it('offers the wire row’s own scalars as a closed disclosure', () => {
    expect(markup).toContain('data-slot="thread-raw"');
    expect(markup).not.toContain('<details open');
    for (const field of ['id', 'seq', 'ts', 'raw_type', 'raw_subtype']) {
      expect(markup).toContain(`&quot;${field}&quot;`);
    }
  });

  it('stops at the 5.3 boundary: no storage word, no refetch control', () => {
    expect(markup).not.toContain('output_storage');
    expect(markup).not.toContain('detail-show-full');
  });
});

/* ------------------------------------------ the prose reading surface --- */

describe('prose renders whole, at the reading step', () => {
  it('keeps a message body unclamped and preserves its line breaks', () => {
    const body = `${'p'.repeat(4_000)}\nsecond line`;
    const markup = threadMarkup([{ kind: 'prompt', text: body }]);

    expect(markup).toContain('p'.repeat(4_000));
    expect(markup).not.toContain('…');
    expect(markup).toContain('whitespace-pre-wrap');
  });

  it('renders the 14px step for prose and the 13px step for chrome', () => {
    const markup = threadMarkup([{ kind: 'prompt', text: 'hello' }]);
    expect(markup).toContain('text-base');
    expect(markup).toContain('text-2xs');
  });

  it('renders no paragraph for a message the wire left blank', () => {
    const markup = threadMarkup([{ kind: 'prompt', text: '   ' }]);
    expect(markup).toContain('data-thread-kind="message"');
    expect(markup).not.toContain('data-slot="thread-message"');
  });
});

/* ----------------------------------------- Test 12 — the view toggle --- */

describe('the view toggle is props-in and reachable (Test 12, AC-R1)', () => {
  const session = makeSessionRow();

  it.each([
    ['tree', 'thread'],
    ['thread', 'tree'],
  ] as const)('marks %s pressed and %s not', (pressed, other) => {
    const markup = renderToStaticMarkup(
      <SessionHeader session={session} now={NOW} view={pressed} onViewChange={() => undefined} />,
    );

    expect(markup).toContain('data-slot="thread-toggle"');
    expect(markup).toMatch(new RegExp(`aria-pressed="true"[^>]*>${pressed}<`));
    expect(markup).toMatch(new RegExp(`aria-pressed="false"[^>]*>${other}<`));
    expect(markup).toContain('aria-label="Session view"');
  });

  it('renders no toggle at all for a caller that passes neither prop', () => {
    // Both props are optional precisely so every pre-5.4 caller and every
    // pre-5.4 render assertion stays true.
    const markup = renderToStaticMarkup(<SessionHeader session={session} now={NOW} />);
    expect(markup).not.toContain('data-slot="thread-toggle"');
    expect(markup).toContain('data-slot="session-header"');
  });
});
