import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';

import { appSource, pagesImportedBy } from '../../__tests__/app-pages';
import { hrefFor, matchRoute, type Route } from '../route-match';

/*
 * AC3 (matcher half) — the route table.
 *
 * The locked URL scheme is `/`, `/session/:id`, `/session/:id/trace/:turn_seq`
 * and `/showcase`; everything else is `not_found`. Deep-link COLD-LOAD and
 * back/forward behaviour are Task 5.5's acceptance criteria — this task ships
 * the table and the seam, and says so rather than claiming them.
 *
 * ★ TASK 7.2 ADDED `search` AND `event`, UNDER AN EXPLICIT FOUNDER RULING.
 * `app-routing.test.tsx:35` puts this module AND this file under a standing
 * do-not-touch rule, and `route-match.ts:42` reserved query state for 7.2
 * "without touching this table". That reservation is unusable — `hrefFor` emits
 * no query and `router.ts`'s `sync()` compares the pathname alone — and task
 * 5.4's founder ruling 6 had already deferred a real deep link here by name.
 * The rule was ruled to mean "this file has one concern and its purity is
 * scanned whole", not "this file is frozen". What the rule MECHANICALLY
 * enforces is the scan at the bottom of this file, and both arms pass it
 * unchanged.
 */

const MODULE_PATH = fileURLToPath(new URL('../route-match.ts', import.meta.url));

describe('matchRoute covers every locked route plus the miss', () => {
  it.each([
    { path: '/', expected: { name: 'sessions' } },
    { path: '', expected: { name: 'sessions' } },
    { path: '/?project=x', expected: { name: 'sessions' } },
    { path: '/showcase', expected: { name: 'showcase' } },
    { path: '/showcase/', expected: { name: 'showcase' } },
    { path: '/session/abc', expected: { name: 'session', sessionId: 'abc' } },
    { path: '/session/abc/', expected: { name: 'session', sessionId: 'abc' } },
    // Both deep links Task 5.1b's SPA-fallback test cold-loads.
    { path: '/session/abc/trace/3', expected: { name: 'trace', sessionId: 'abc', turnSeq: 3 } },
    { path: '/session/abc/trace/0', expected: { name: 'trace', sessionId: 'abc', turnSeq: 0 } },
    { path: '/nope', expected: { name: 'not_found', path: '/nope' } },
    { path: '/session', expected: { name: 'not_found', path: '/session' } },
    { path: '/session/', expected: { name: 'not_found', path: '/session/' } },
    { path: '/session/abc/trace', expected: { name: 'not_found', path: '/session/abc/trace' } },
    { path: '/session/abc/trace/x', expected: { name: 'not_found', path: '/session/abc/trace/x' } },
    // -1 and 1.5 are rejected by the same digits-only rule the read API uses.
    {
      path: '/session/abc/trace/-1',
      expected: { name: 'not_found', path: '/session/abc/trace/-1' },
    },
    {
      path: '/session/abc/trace/1.5',
      expected: { name: 'not_found', path: '/session/abc/trace/1.5' },
    },
    {
      path: '/session/abc/trace/3/extra',
      expected: { name: 'not_found', path: '/session/abc/trace/3/extra' },
    },
    // Task 7.2's two arms. `/search` is the whole projected corpus;
    // `/search/session/:id` scopes to one session.
    { path: '/search', expected: { name: 'search' } },
    { path: '/search/', expected: { name: 'search' } },
    { path: '/search/session/abc', expected: { name: 'search', sessionId: 'abc' } },
    { path: '/search/session/', expected: { name: 'not_found', path: '/search/session/' } },
    { path: '/search/nope', expected: { name: 'not_found', path: '/search/nope' } },
    // An EVENT seq, which the `trace` arm above cannot express: `turnSeq`
    // numbers turns and a hit's `seq` numbers events.
    { path: '/session/abc/event/42', expected: { name: 'event', sessionId: 'abc', seq: 42 } },
    { path: '/session/abc/event/0', expected: { name: 'event', sessionId: 'abc', seq: 0 } },
    // The same digits-only rule the read API and the `trace` arm both use.
    { path: '/session/abc/event/x', expected: { name: 'not_found', path: '/session/abc/event/x' } },
    {
      path: '/session/abc/event/-1',
      expected: { name: 'not_found', path: '/session/abc/event/-1' },
    },
    {
      path: '/session/abc/event/1.5',
      expected: { name: 'not_found', path: '/session/abc/event/1.5' },
    },
    { path: '/session/abc/event', expected: { name: 'not_found', path: '/session/abc/event' } },
  ])('$path', ({ path, expected }) => {
    expect(matchRoute(path)).toEqual(expected);
  });

  it('ignores query and fragment so Task 7.2 can add query-string state', () => {
    expect(matchRoute('/session/abc?tab=spans#top')).toEqual({
      name: 'session',
      sessionId: 'abc',
    });
  });

  it('never throws on a malformed percent-encoding', () => {
    expect(matchRoute('/session/%zz')).toEqual({ name: 'session', sessionId: '%zz' });
  });
});

describe('hrefFor inverts matchRoute', () => {
  it.each([
    { route: { name: 'sessions' } as Route, href: '/' },
    { route: { name: 'showcase' } as Route, href: '/showcase' },
    { route: { name: 'session', sessionId: 'abc' } as Route, href: '/session/abc' },
    {
      route: { name: 'trace', sessionId: 'abc', turnSeq: 0 } as Route,
      href: '/session/abc/trace/0',
    },
    { route: { name: 'search' } as Route, href: '/search' },
    { route: { name: 'search', sessionId: 'abc' } as Route, href: '/search/session/abc' },
    {
      route: { name: 'event', sessionId: 'abc', seq: 42 } as Route,
      href: '/session/abc/event/42',
    },
  ])('$href', ({ route, href }) => {
    expect(hrefFor(route)).toBe(href);
  });

  it('round-trips ids containing slashes, percent signs, spaces and unicode', () => {
    // A trace id is `{session_id}:{turn_seq}`, so a colon has to survive too —
    // and a raw slash in an id would split into extra segments if it were not
    // encoded, which is the failure this property exists to catch.
    const sessionId = fc.string({ minLength: 1 }).filter((value) => value.trim() !== '');
    fc.assert(
      fc.property(sessionId, fc.nat({ max: 100_000 }), (id, seq) => {
        const session: Route = { name: 'session', sessionId: id };
        const trace: Route = { name: 'trace', sessionId: id, turnSeq: seq };
        // Task 7.2's arms ride the same property: a search hit's href is built
        // by `hrefFor` and resolved back by `matchRoute` one navigation later,
        // so an id that does not survive the round trip lands the reader
        // nowhere — which is AC1's second clause failing.
        const search: Route = { name: 'search', sessionId: id };
        const event: Route = { name: 'event', sessionId: id, seq };
        expect(matchRoute(hrefFor(session))).toEqual(session);
        expect(matchRoute(hrefFor(trace))).toEqual(trace);
        expect(matchRoute(hrefFor(search))).toEqual(search);
        expect(matchRoute(hrefFor(event))).toEqual(event);
      }),
      { numRuns: 500 },
    );

    for (const id of ['a/b', 'a%b', 'a b', 'sess:0', '日本語', 'a?b#c']) {
      for (const route of [
        { name: 'trace', sessionId: id, turnSeq: 7 } as Route,
        { name: 'search', sessionId: id } as Route,
        { name: 'event', sessionId: id, seq: 7 } as Route,
      ]) {
        expect(matchRoute(hrefFor(route))).toEqual(route);
      }
    }
  });
});

/*
 * ⭐ The reason this module lives alone in its own file.
 *
 * `environment: 'node'` proves almost nothing about purity: on Node 26 the four
 * browser ambients are simply `undefined`, so a bare reference throws only on a
 * line some test actually executes, while an optional-chained read of one, or a
 * clock, or a random source, or module-level mutable state, all stay green
 * forever. A WHOLE-FILE source scan is the assertion that does hold — and it is
 * only defensible when the file has exactly one concern, because a scan over
 * "part of a file" has no boundary anyone can point at.
 *
 * It does not contradict the assertion in router.test.ts that the default port
 * DOES reference the browser: that scans a different file. Splitting the two
 * makes both true statements about whole files.
 *
 * The scan reads raw source INCLUDING COMMENTS, exactly like
 * retokenized.test.ts's class deny-list — so route-match.ts's own header has to
 * describe its purity by role instead of spelling any of these tokens. That is
 * a real constraint that was hit and corrected while writing it, not a guess.
 */
describe('route-match.ts is pure, asserted over the whole file', () => {
  const FORBIDDEN = [
    'window',
    'document',
    'history',
    'location',
    'globalThis',
    'navigator',
    'fetch(',
    'Date.',
    'Math.random',
    'process.',
  ] as const;

  it('the scan reads a real module', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    expect(source.length, 'the purity scan read an empty file').toBeGreaterThan(500);
    expect(source).toContain('export function matchRoute');
    expect(source).toContain('export function hrefFor');
  });

  it.each(FORBIDDEN)('contains no "%s" anywhere, comments included', (token) => {
    expect(readFileSync(MODULE_PATH, 'utf8')).not.toContain(token);
  });

  it('declares no module-level mutable binding', () => {
    // Indentation is the test: a top-level declaration starts at column 0, and
    // module state is the one impurity a token scan would otherwise miss.
    const source = readFileSync(MODULE_PATH, 'utf8');
    expect(source).not.toMatch(/^(let|var)\s/m);
  });
});

/*
 * The showcase is the only human-eyeball surface for Task 5.1a's design tokens.
 * Task 5.1a promised "5.1c deletes it in one line" — the line deleted is the
 * ad-hoc path check in App.tsx, not the route, and this says which.
 */
describe('the temporary /showcase switch became a real route', () => {
  it('keeps /showcase reachable', () => {
    expect(matchRoute('/showcase').name).toBe('showcase');
  });

  it('leaves App.tsx reading the router instead of the address bar', () => {
    const source = appSource();
    expect(source, 'the ad-hoc path check is what 5.1c replaces').not.toContain(
      'window.location.pathname',
    );
    expect(source).toContain('useRoute');
    /*
     * Belt and braces beside components.test.tsx's own App.tsx page pin.
     *
     * That pin IS amended — by Task 5.2a, and this one with it. (The line that
     * used to sit here said the opposite; it was written when 5.1c chose not to
     * touch either, and it went stale the moment 5.2a generalised both.) Both
     * now derive the page list from App.tsx's own imports rather than naming
     * pages, so shipping a page costs one import and no test edit.
     */
    const pages = pagesImportedBy(source);
    expect(pages.length, 'no page import was derived from App.tsx').toBeGreaterThan(0);
    expect(pages, 'the vacuity guard — see app-pages.ts').toContain('Showcase');
    for (const page of pages) {
      expect(source, `App.tsx imports ${page} but never renders it`).toContain(`<${page}`);
    }
  });
});
