import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ContentState } from '../../../lib/event-content';
import { makeEventContent, makeEventRow } from '../../../lib/__tests__/fixtures';
import { EventDetail } from '../EventDetail';

/*
 * Task 5.3's rendering half — AC1, AC4 and the two render-gate invariants.
 *
 * `renderToStaticMarkup` only, and `builtCss()` is never called here: the class
 * scan is `retokenized.test.ts`'s job and `build-ui.ts` memoizes that Vite run
 * per test file, so a second caller pays for a second full build.
 *
 * The pane is props-in, so one static render sees everything it does. What it
 * DECIDES is `lib/event-content.ts`'s and is asserted there; what is left here
 * is that both halves reach the screen, that the two attributes the gate waits
 * on are present, and that the three features which put plan 001's pane through
 * three revise rounds are absent.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('../EventDetail.tsx', import.meta.url)), 'utf8');

function render(markup: React.ReactElement): string {
  return renderToStaticMarkup(markup);
}

describe('both halves of an event reach the screen (AC1)', () => {
  it('renders the input, the output and a storage word for each', () => {
    const event = makeEventRow({
      input: '{"file_path":"/tmp/plan.md"}',
      input_storage: 'inline',
      text: 'read 412 lines from plan.md',
      output_storage: 'inline',
    });

    const html = render(<EventDetail event={event} fetched={null} />);

    expect(html).toContain('INPUT');
    expect(html).toContain('OUTPUT');
    expect(html).toContain('/tmp/plan.md');
    expect(html).toContain('read 412 lines from plan.md');
    // The word AC-R1 greps the live pane for. Two sections, two labels.
    expect(html.match(/data-content-state="inline"/g)).toHaveLength(2);
  });

  it('is never silently blank for an event carrying neither half', () => {
    // The 1,596-row case seen from the screen: no body, and a sentence saying
    // so, rather than an empty pane under a confident label.
    const event = makeEventRow({
      input: null,
      input_storage: null,
      text: null,
      output_storage: null,
    });

    const html = render(<EventDetail event={event} fetched={null} />);

    expect(html).toContain('Nothing was recorded for this half.');
    expect(html).toContain('data-content-state="empty"');
  });

  it('offers the refetch control only where a second request could help', () => {
    const spill = makeEventRow({ output_storage: 'spill', text: null });
    const inline = makeEventRow({ output_storage: 'inline', text: 'here already' });

    expect(
      render(<EventDetail event={spill} fetched={null} onShowFull={() => undefined} />),
    ).toContain('Show full');
    expect(
      render(<EventDetail event={inline} fetched={null} onShowFull={() => undefined} />),
    ).not.toContain('Show full');
  });

  it('paints a refetched body in place of the preview', () => {
    const event = makeEventRow({ id: 'ev-9', output_storage: 'spill', text: null });
    const fetched = makeEventContent({ id: 'ev-9', field: 'text', content: 'the resolved file' });

    const html = render(
      <EventDetail event={event} fetched={fetched} onShowFull={() => undefined} />,
    );

    expect(html).toContain('the resolved file');
    expect(html).not.toContain('Show full');
  });
});

describe('the two attributes the render gate waits on (AC-R1)', () => {
  it('carries data-slot="span-detail" and the selected event id', () => {
    // Invariant (a): `SELECTORS.spanDetail` moved here from the aside this task
    // deleted, and `render-gate.test.ts` greps `ui/src` for the value.
    // Invariant (c): the probe waits for THIS id before it reads the pane, so
    // it can never assert the previous event's body under the new selection.
    const html = render(<EventDetail event={makeEventRow({ id: 'ev-42' })} fetched={null} />);

    expect(html).toContain('data-slot="span-detail"');
    expect(html).toContain('data-event-id="ev-42"');
  });

  it('renders no event id at all when nothing is selected', () => {
    // An id attribute on an empty pane would let the probe settle on a pane
    // that is not showing the row it clicked.
    expect(render(<EventDetail event={null} fetched={null} />)).not.toContain('data-event-id');
  });
});

describe('the unselected pane says something, and not either dead literal (AC1)', () => {
  it('renders a sentence neither `report.ts` regex arm matches', () => {
    /*
     * Asserted against the literal strings rather than against
     * `PLACEHOLDER_DETAIL`: that constant is module-private, this task deletes
     * it, and `ui/tsconfig.json` scopes the UI to `src` with only `@/*` and
     * `@shared/*` paths — so `src/render-gate/report.ts` is unreachable from
     * here in any case. Keeps `detail-t0-non-empty` green.
     */
    const html = render(<EventDetail event={null} fetched={null} />);
    const text = html.replace(/<[^>]*>/g, '').trim();

    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe('Select a span to see its detail.');
    expect(text).not.toContain('arrives with the detail pane.');
  });
});

describe('the raw disclosure shows the stored record, closed (AC4)', () => {
  it('renders every column of the row inside a collapsed `details`', () => {
    const event = makeEventRow({ spill_path: 'tool-results/abc.txt', spill_bytes: 4_096 });

    const html = render(<EventDetail event={event} fetched={null} />);

    expect(html).toContain('<details');
    // A `details` with no `open` attribute is closed. Asserting the absence is
    // what catches a disclosure that ships expanded.
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    for (const key of Object.keys(event)) expect(html).toContain(key);
    expect(html).toContain('tool-results/abc.txt');
  });
});

describe('the three inclusions that cost plan 001 three revise rounds (AC4)', () => {
  it('ships no context menu, no byte threshold and no async matrix', () => {
    expect(SOURCE).not.toMatch(/ContextMenu|context-menu/);
    expect(SOURCE).not.toMatch(/[Bb]yteThreshold|largePayloadBytes/);
    expect(SOURCE).not.toMatch(/\bloading\b|isLoading|\bpending\b/);
  });

  it('has no loading member on the state it renders', () => {
    // Type-level, because an arm that does not exist cannot be rendered and so
    // cannot be asserted against at runtime.
    const noLoading: 'loading' extends ContentState['kind'] ? never : true = true;
    expect(noLoading).toBe(true);
  });
});
