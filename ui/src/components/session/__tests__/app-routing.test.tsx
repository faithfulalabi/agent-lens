import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { App } from '../../../App';
import { createRouter } from '../../../lib/router';
import { fakeHistoryPort } from '../../../lib/__tests__/helpers';
import { makeDetail, makeTurnRow, stubApiClient } from '../../../lib/__tests__/fixtures';

/*
 * Test 20 — `App.tsx` routes `session` and `trace` to the session view, inside
 * the shell (Task 5.3b).
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AT ALL, AND WHY `App` GREW TWO PROPS.
 * ===========================================================================
 * Nothing in this repo rendered `<App />` before this task, and the reason was
 * not oversight — it could not be done. `useRoute()` with no argument builds
 * the shared router over the browser history port, and `createRouter` asks that
 * port for the current path EAGERLY at construction, so the call reached
 * `window.location` under `environment: 'node'`. Past that, the page it
 * rendered built its own API client, whose factory reads the page bootstrap and
 * throws outside a browser.
 *
 * Both are now injectable, both default to the real thing in production, and
 * this file is what that buys: the routing table and the shell wrapper asserted
 * end to end rather than by reading source.
 *
 * The rendering IS legal despite the store being external state:
 * `useRoute` passes `getRoute` as `useSyncExternalStore`'s `getServerSnapshot`,
 * so a static render resolves a real route with no document anywhere.
 *
 * The two SOURCE pins over `App.tsx` live elsewhere and are deliberately not
 * touched here — Task 5.2a generalised both to derive the page list from
 * `App.tsx`'s own imports, so shipping this page cost one import and no test
 * edit. `route-match.ts` and its test are under a standing do-not-touch rule.
 */

/** A client that answers the session view's one request with an empty session. */
function emptySessionApi() {
  return stubApiClient({
    getSession: () => Promise.resolve(makeDetail({ turns: [makeTurnRow()] })),
  });
}

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <App router={createRouter(fakeHistoryPort(path))} api={emptySessionApi()} />,
  );
}

describe('App routes the session URLs to the session view (Test 20)', () => {
  it('renders /session/:id as the session view, inside the shell', () => {
    const markup = renderAt('/session/seed-s0');
    expect(markup).toContain('data-slot="app-shell"');
    expect(markup).toContain('data-slot="session-view"');
    expect(markup).toContain('data-slot="span-tree"');
    expect(markup, 'the session list is the other branch and must not also render').not.toContain(
      'data-slot="range-control"',
    );
  });

  it('renders a trace deep link as the same view', () => {
    // Task 5.5 owns anchoring the view on the turn; resolving the route to the
    // session it names is this task's half.
    expect(renderAt('/session/seed-s0/trace/3')).toContain('data-slot="session-view"');
  });

  it('leaves / on the session list and /showcase on the showcase', () => {
    /*
     * The list's own rows arrive through an effect too, so the marker for
     * "this is the list page" is the control strip it keeps on screen while a
     * load is pending — asserting on the rows would assert on nothing.
     */
    expect(renderAt('/')).toContain('data-slot="range-control"');
    expect(renderAt('/')).not.toContain('data-slot="session-view"');
    expect(renderAt('/showcase')).not.toContain('data-slot="session-view"');
  });

  it('falls through to the list for a path that matches nothing', () => {
    // Correct by scope rather than by accident: Task 5.5 owns the 404 view.
    expect(renderAt('/nope')).toContain('data-slot="range-control"');
  });

  it('renders the pending branch without reaching the address bar or the bootstrap', () => {
    expect(() => renderAt('/session/seed-s0')).not.toThrow();
    const markup = renderAt('/session/seed-s0');
    expect(
      markup,
      'effects never run here, so the load has not been made let alone ' +
        'answered — the header and the rows arrive with the data.',
    ).not.toContain('data-slot="session-header"');
    expect(markup).not.toContain('data-slot="span-row"');
  });

  it('keeps the session id out of the markup as an id and in it as a route', () => {
    // A percent-encoded id has to survive the round trip through the route
    // table, or a deep link to a session whose id carries a slash lands nowhere.
    expect(renderAt('/session/a%2Fb')).toContain('data-slot="session-view"');
  });
});

/*
 * ★ Test 18 — `App.tsx` BRANCHES on Task 7.2's two arms.
 *
 * Neither existing instrument can fail on this. The page-list pin derives its
 * list from `App.tsx`'s own imports, so importing the page and never routing to
 * it passes; and `route-match.test.ts` proves the table round-trips a path the
 * app may never act on. Without these two cases the only thing that would catch
 * a missing branch is the render gate, a browser away.
 */
describe('App routes Task 7.2 search and event URLs (Test 18)', () => {
  it('renders /search as the search screen and NOT as the session view', () => {
    const markup = renderAt('/search');
    expect(markup).toContain('data-slot="app-shell"');
    expect(markup).toContain('data-slot="search-view"');
    expect(markup).toContain('data-slot="search-input"');
    expect(markup, 'the session view is another branch and must not also render').not.toContain(
      'data-slot="session-view"',
    );
    expect(markup, 'the list is the fall-through and must not draw either').not.toContain(
      'data-slot="range-control"',
    );
  });

  it('renders /search/session/:id as the same screen, scoped', () => {
    expect(renderAt('/search/session/seed-s0')).toContain('data-slot="search-input"');
  });

  it('renders an event deep link as the session view', () => {
    // `/session/:id/event/:seq` is where a search hit lands. It resolves to the
    // session; the scroll to the row is `revealStep`'s and fires on an effect,
    // which never runs here.
    const markup = renderAt('/session/seed-s0/event/3');
    expect(markup).toContain('data-slot="session-view"');
    expect(markup).not.toContain('data-slot="search-input"');
  });

  it('leaves an event path with a non-numeric seq on the fall-through', () => {
    expect(renderAt('/session/seed-s0/event/x')).toContain('data-slot="range-control"');
  });
});
