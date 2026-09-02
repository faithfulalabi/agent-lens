import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SearchHitRow as SearchHit } from '../../../lib/api';
import { makeSessionRow } from '../../../lib/__tests__/fixtures';
import { SearchHitRow } from '../SearchHitRow';
import { SearchScope } from '../SearchScope';
import { SessionHeader } from '../SessionHeader';

/*
 * Task 7.2's three surfaces, rendered. Props-in, so `renderToStaticMarkup` can
 * read them — the page module that owns them cannot be rendered past its
 * pending branch. `drift-banner.test.tsx` is the shape.
 */

function makeHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    session_id: 's-1',
    session_title: 'a session',
    project_path: '/repo',
    turn_id: 't-1',
    event_id: 'ev-1',
    seq: 42,
    kind: 'tool_call',
    name: 'Bash',
    ts: '2026-09-01T00:00:00.000Z',
    snippet: 'before <mark>ENOENT</mark> after',
    ...overrides,
  };
}

/* ------------------------------------------------------------- Test 3 --- */

describe('a search hit renders its highlight and its jump target (Test 3)', () => {
  it('carries the slot the gate drives, one highlight per match, and the href', () => {
    const markup = renderToStaticMarkup(<SearchHitRow hit={makeHit()} />);

    expect(markup).toContain('data-slot="search-hit"');
    // The gate reads this attribute off the hit and then waits for the ROW
    // carrying it to become `aria-selected` — so it has to be on the anchor.
    expect(markup).toContain('data-event-id="ev-1"');
    expect(markup.match(/<mark/g) ?? []).toHaveLength(1);
    expect(markup).toContain('ENOENT');
    expect(markup, 'the jump names the session and the event seq').toContain(
      'href="/session/s-1/event/42"',
    );
  });

  it('renders several highlights and none at all', () => {
    const many = renderToStaticMarkup(
      <SearchHitRow hit={makeHit({ snippet: '<mark>a</mark> x <mark>b</mark>' })} />,
    );
    expect(many.match(/<mark/g) ?? []).toHaveLength(2);

    const none = renderToStaticMarkup(<SearchHitRow hit={makeHit({ snippet: 'no markers' })} />);
    expect(none.match(/<mark/g) ?? []).toHaveLength(0);
    expect(none).toContain('no markers');
  });

  it('★ escapes a snippet carrying a script tag rather than emitting one', () => {
    /*
     * The end-to-end half of `search.test.ts`'s Test 2, at the component.
     * MEASURED: `searchEvents` against `.agent-lens-dev/cache.db` with
     * `q=script`, `limit=300`, stripping the two marker literals — 81 of 300
     * snippets carry a raw `<` and 67 carry a literal opening script tag. This
     * is why the component splits into text runs instead of inserting HTML.
     */
    const markup = renderToStaticMarkup(
      <SearchHitRow hit={makeHit({ snippet: '<mark><script>alert(1)</script></mark>' })} />,
    );
    expect(markup).toContain('&lt;script&gt;');
    expect(markup, 'a live tag here is the injection').not.toContain('<script>');
  });

  it('survives a null snippet and a null name', () => {
    const markup = renderToStaticMarkup(
      <SearchHitRow hit={makeHit({ snippet: null, name: null })} />,
    );
    expect(markup).toContain('data-slot="search-hit"');
    expect(markup).not.toContain('null');
  });

  it('percent-encodes a session id that would otherwise split the path', () => {
    const markup = renderToStaticMarkup(<SearchHitRow hit={makeHit({ session_id: 'a/b' })} />);
    expect(markup).toContain('href="/session/a%2Fb/event/42"');
  });
});

/* --------------------------------------------------------- Tests 13, 19 --- */

describe('the scope strip states what was searched (Test 13)', () => {
  it('names the session scope and draws the slot the gate reads', () => {
    const markup = renderToStaticMarkup(<SearchScope scope="session" unprojectedCount={0} />);
    expect(markup).toContain('data-slot="search-scope"');
    expect(markup).toContain('this session');
  });

  it('names the projected scope in transcript terms, never as sessions', () => {
    // MEASURED: 272 of 293 rows are sub-agent sidecars, and 47 of the first 50
    // hits by rank for `q=ENOENT` come from one. Calling the scope "sessions"
    // would make the count read as a bug to anyone who counts the list.
    const markup = renderToStaticMarkup(<SearchScope scope="projected" unprojectedCount={0} />);
    expect(markup).toContain('projected transcripts');
    expect(markup).toContain('sub-agent');
  });

  it('renders nothing at all before the first answer', () => {
    // Total, on `DriftBanner`'s instrument: an empty string is the only reading
    // that proves no strip was drawn. A "does not contain the copy" assertion
    // would pass over an empty bordered box.
    expect(renderToStaticMarkup(<SearchScope scope={null} unprojectedCount={0} />)).toBe('');
    expect(renderToStaticMarkup(<SearchScope unprojectedCount={7} />)).toBe('');
  });
});

describe('the warm control appears only when there is something to warm (Test 19)', () => {
  it('shows the number and the control above zero', () => {
    const markup = renderToStaticMarkup(<SearchScope scope="projected" unprojectedCount={12} />);
    expect(markup).toContain('data-slot="search-warm"');
    expect(markup).toContain('12');
  });

  it('draws no control at zero, while the scope line stays', () => {
    const markup = renderToStaticMarkup(<SearchScope scope="projected" unprojectedCount={0} />);
    expect(markup, 'a control stuck permanently on is the defect this catches').not.toContain(
      'data-slot="search-warm"',
    );
    expect(markup, 'the scope is still stated — that clause is unconditional').toContain(
      'data-slot="search-scope"',
    );
  });

  it('counts through a run once progress has been folded in', () => {
    const markup = renderToStaticMarkup(
      <SearchScope scope="projected" unprojectedCount={12} warm={{ done: 5, total: 12 }} />,
    );
    expect(markup).toContain('5');
  });
});

/* ------------------------------------------------------------ Test 14 --- */

describe('in-session search is reachable from the session view (Test 14)', () => {
  it('the header carries an anchor naming the open session', () => {
    const markup = renderToStaticMarkup(
      <SessionHeader session={makeSessionRow({ id: 'sess-9' })} now={0} />,
    );
    expect(markup).toContain('data-slot="in-session-search"');
    expect(markup).toContain('href="/search/session/sess-9"');
  });

  it('★ the anchor scopes to the session rather than to the whole corpus', () => {
    /*
     * The falsifiable half. `SessionHeader` always has a session — `session` is
     * a required prop and `SessionListRow.id` is not nullable — so "absent when
     * no session id is given" is unrepresentable. What CAN be got wrong is an
     * anchor that reached `/search` and dropped the scope, which is AC2's
     * clause failing silently: the screen would then search the whole corpus
     * from inside one session and still look right.
     */
    const markup = renderToStaticMarkup(
      <SessionHeader session={makeSessionRow({ id: 'sess-9' })} now={0} />,
    );
    expect(markup).not.toContain('href="/search"');
  });

  it('encodes a session id that would otherwise split the path', () => {
    const markup = renderToStaticMarkup(
      <SessionHeader session={makeSessionRow({ id: 'a/b' })} now={0} />,
    );
    expect(markup).toContain('href="/search/session/a%2Fb"');
  });
});
