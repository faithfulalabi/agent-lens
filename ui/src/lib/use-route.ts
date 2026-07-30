/*
 * The one React binding over the router (Task 5.1c, AC3).
 *
 * `useSyncExternalStore` rather than `useState` + an effect: it gives correct
 * StrictMode and concurrent behaviour for free, and leaves no effect-ordering
 * window in which a render could show a route the store has already left.
 *
 * The shared router is built on FIRST CALL, never at module load. Constructing
 * it eagerly would run `browserHistoryPort()` — which reads the address bar —
 * at import time, and that makes this module, and transitively `App.tsx`,
 * un-importable under the DOM-free `environment: 'node'` this project's tests
 * run in. The `router` parameter is the other half of that: Tasks 5.2 and 5.3
 * can render pages against a fake port without touching any global.
 */

import { useSyncExternalStore } from 'react';

import type { Route } from './route-match.js';
import { createRouter, type Router } from './router.js';

let shared: Router | undefined;

/** The app-wide router, constructed lazily and then reused. */
export function defaultRouter(): Router {
  shared ??= createRouter();
  return shared;
}

/** The current route, re-rendering the caller whenever it changes. */
export function useRoute(router: Router = defaultRouter()): Route {
  return useSyncExternalStore(router.subscribe, router.getRoute, router.getRoute);
}
