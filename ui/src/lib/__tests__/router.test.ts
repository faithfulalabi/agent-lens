import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createRouter } from '../router';
import type { Route } from '../route-match';
import { fakeHistoryPort } from './helpers';

/*
 * AC3 (store half) — navigate and back/forward, against the injected port.
 *
 * The port is asserted here, not a real browser: this project has no DOM
 * (`ui/vitest.config.ts`: `environment: 'node'`), and adding one would mean a
 * new devDependency plus a second test environment in a config that documents
 * "No DOM" as a decision. What that costs is stated plainly in the last test
 * rather than papered over — the behavioural proof is Task 5.5's AC2.
 *
 * The port is also not scaffolding. Task 6.3's follow-mode machine and Task
 * 5.5's deep-link tests both need to drive navigation deterministically, and a
 * global they have to reset between cases is the thing that makes that flaky.
 */

const ROUTER_PATH = fileURLToPath(new URL('../router.ts', import.meta.url));

const TRACE: Route = { name: 'trace', sessionId: 'sess-1', turnSeq: 4 };

describe('createRouter', () => {
  it('seeds the current route from the port', () => {
    expect(createRouter(fakeHistoryPort('/session/abc/trace/2')).getRoute()).toEqual({
      name: 'trace',
      sessionId: 'abc',
      turnSeq: 2,
    });
  });

  it('returns a stable snapshot until the path actually changes', () => {
    // Not a nicety: useSyncExternalStore re-renders forever if getSnapshot
    // hands back a fresh object each read.
    const router = createRouter(fakeHistoryPort('/'));
    expect(router.getRoute()).toBe(router.getRoute());

    const before = router.getRoute();
    router.navigate({ name: 'sessions' });
    expect(router.getRoute(), 'navigating to where we already are is not a change').toBe(before);

    router.navigate(TRACE);
    expect(router.getRoute()).not.toBe(before);
  });

  it('pushes the route href and notifies subscribers synchronously', () => {
    const port = fakeHistoryPort('/');
    const router = createRouter(port);
    let notifications = 0;
    router.subscribe(() => {
      notifications += 1;
    });

    router.navigate(TRACE);

    // Browsers do not fire a pop event for a programmatic navigation, so if the
    // router did not notify here nothing would.
    expect(notifications).toBe(1);
    expect(port.entries).toEqual(['/', '/session/sess-1/trace/4']);
    expect(router.getRoute()).toEqual(TRACE);
  });

  it('replaces without growing the stack', () => {
    const port = fakeHistoryPort('/');
    const router = createRouter(port);
    router.navigate({ name: 'session', sessionId: 'abc' });
    expect(port.entries).toHaveLength(2);

    router.navigate(TRACE, { replace: true });
    expect(port.entries).toEqual(['/', '/session/sess-1/trace/4']);
    expect(router.getRoute()).toEqual(TRACE);
  });

  it('round-trips back through the port to the previous route', () => {
    const port = fakeHistoryPort('/');
    const router = createRouter(port);
    const seen: Route[] = [];
    router.subscribe(() => seen.push(router.getRoute()));

    router.navigate({ name: 'session', sessionId: 'sess-1' });
    router.navigate(TRACE);
    expect(router.getRoute()).toEqual(TRACE);

    port.back();
    expect(router.getRoute()).toEqual({ name: 'session', sessionId: 'sess-1' });
    port.back();
    expect(router.getRoute()).toEqual({ name: 'sessions' });

    expect(seen.map((route) => route.name)).toEqual(['session', 'trace', 'session', 'sessions']);
  });

  it('stops notifying an unsubscribed listener', () => {
    const port = fakeHistoryPort('/');
    const router = createRouter(port);
    let notifications = 0;
    const unsubscribe = router.subscribe(() => {
      notifications += 1;
    });

    router.navigate(TRACE);
    unsubscribe();
    router.navigate({ name: 'sessions' });

    expect(notifications).toBe(1);
    expect(router.getRoute()).toEqual({ name: 'sessions' });
  });
});

/*
 * An honest limit, written the way components.test.tsx writes its own: naming
 * what this does NOT prove beats a vacuous assertion that pretends otherwise.
 *
 * This is a source-text assertion. It proves the default port is wired to the
 * real browser API and to no other, and nothing about whether that wiring
 * behaves. The behavioural proof belongs to Task 5.5's AC2 — "any deep link
 * cold-loads to the exact view state; back/forward walks history correctly" —
 * which runs against a real browser. The port is ~15 lines with no branches,
 * which is what makes that split affordable.
 */
describe('browserHistoryPort binds the real browser API', () => {
  it('references pushState, replaceState, the path and the pop event', () => {
    const source = readFileSync(ROUTER_PATH, 'utf8');
    for (const binding of [
      'window.history.pushState',
      'window.history.replaceState',
      'window.location.pathname',
      "window.addEventListener('popstate'",
      "window.removeEventListener('popstate'",
    ]) {
      expect(source, `browserHistoryPort does not bind ${binding}`).toContain(binding);
    }
  });

  it('is the only module that touches those globals', () => {
    // The counterpart to route-match.test.ts's purity scan: the browser surface
    // is concentrated in one small function, in one file, on purpose.
    const source = readFileSync(ROUTER_PATH, 'utf8');
    const port = source.slice(source.indexOf('export function browserHistoryPort'));
    const rest = source.slice(0, source.indexOf('export function browserHistoryPort'));
    expect(port).toContain('window.');
    expect(rest, 'a browser reference escaped browserHistoryPort()').not.toContain('window.');
  });
});
