import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { createRouter } from '../router';
import type { Route } from '../route-match';
import { useRoute } from '../use-route';
import { fakeHistoryPort } from './helpers';

/*
 * AC3 (React half) — the ten lines on top of the router.
 *
 * Two properties, and deliberately nothing else. This hook has no branches, and
 * asserting more here would be asserting React.
 *
 *   1. It reads from the router it is GIVEN.
 *   2. Importing it does not touch the browser.
 *
 * (2) is the load-bearing one. `browserHistoryPort()` reads the current path,
 * so a module-scope `createRouter()` would throw at IMPORT time under
 * `environment: 'node'` — taking use-route.ts, and transitively App.tsx, with
 * it. Nothing in this task would notice today (components.test.tsx reads
 * App.tsx as a file and alias.test.ts only builds it), but Tasks 5.2 and 5.3
 * will want to render pages in this project, and a module-scope singleton would
 * block them. Hence the lazy default, and hence a dynamic import below rather
 * than a static one — a static import is hoisted, so the failure would land
 * before any assertion could observe it.
 */

const MODULE_PATH = fileURLToPath(new URL('../use-route.ts', import.meta.url));

function Probe({ router }: { router: ReturnType<typeof createRouter> }) {
  const route: Route = useRoute(router);
  return createElement('span', null, `${route.name}:${hrefish(route)}`);
}

function hrefish(route: Route): string {
  return 'sessionId' in route ? route.sessionId : '-';
}

describe('useRoute', () => {
  it('renders the route from an injected router', () => {
    const router = createRouter(fakeHistoryPort('/session/abc/trace/2'));
    // renderToStaticMarkup is how this DOM-free project renders (precedent:
    // components.test.tsx). It exercises useSyncExternalStore's server
    // snapshot, so this also pins the third argument being supplied at all —
    // React throws "Missing getServerSnapshot" without it.
    expect(renderToStaticMarkup(createElement(Probe, { router }))).toContain('trace:abc');
  });

  it('re-reads the router after a navigation', () => {
    const router = createRouter(fakeHistoryPort('/'));
    expect(renderToStaticMarkup(createElement(Probe, { router }))).toContain('sessions:-');
    router.navigate({ name: 'session', sessionId: 'sess-9' });
    expect(renderToStaticMarkup(createElement(Probe, { router }))).toContain('session:sess-9');
  });

  it('imports without touching the browser', async () => {
    // The real assertion: this import throws under environment: 'node' the
    // moment the shared router stops being lazy.
    const module = await import('../use-route');
    expect(typeof module.useRoute).toBe('function');
    expect(typeof module.defaultRouter).toBe('function');
  });

  it('constructs the shared router inside a function, never at module scope', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    // A top-level call starts at column 0; the lazy one is indented inside
    // defaultRouter(). This is the mechanical form of the assertion above.
    expect(source).not.toMatch(/^(const|let|var)\s+\w+\s*=\s*createRouter\(/m);
    expect(source).toMatch(/^export function defaultRouter/m);
  });
});
