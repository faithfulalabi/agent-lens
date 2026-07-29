/*
 * The router store (Task 5.1c, AC3): every browser touch this app makes to the
 * URL, behind one small injected port.
 *
 * The port is the seam Task 5.5's deep-link acceptance criterion is cashed
 * against — and this task ships the seam rather than claiming to satisfy that
 * criterion. It is also what makes the store testable at all: the `ui` vitest
 * project runs under `environment: 'node'` with no DOM, so the real
 * `browserHistoryPort()` cannot run there and a fake stands in.
 *
 * `getRoute()` returns a cached object that changes identity only when the path
 * changes. That is a hard requirement of `useSyncExternalStore`, which loops
 * forever if the snapshot is a fresh object on every read.
 */

import { hrefFor, matchRoute, type Route } from './route-match.js';

/** The browser surface the router needs, and the whole of it. */
export interface HistoryPort {
  /** The current path, as the address bar has it. */
  path(): string;
  push(href: string): void;
  replace(href: string): void;
  /** Back/forward notifications. Returns an unsubscribe function. */
  onPopState(listener: () => void): () => void;
}

/**
 * The real port. Behavioural proof that this wiring works belongs to Task 5.5's
 * deep-link criterion, in a real browser; `router.test.ts` asserts only that
 * the binding exists, and says so.
 */
export function browserHistoryPort(): HistoryPort {
  return {
    path: () => window.location.pathname,
    push: (href) => {
      window.history.pushState(null, '', href);
    },
    replace: (href) => {
      window.history.replaceState(null, '', href);
    },
    onPopState: (listener) => {
      window.addEventListener('popstate', listener);
      return () => {
        window.removeEventListener('popstate', listener);
      };
    },
  };
}

export interface NavigateOptions {
  /** Overwrite the current entry instead of pushing a new one. */
  replace?: boolean;
}

export interface Router {
  getRoute(): Route;
  navigate(route: Route, options?: NavigateOptions): void;
  subscribe(listener: () => void): () => void;
}

export function createRouter(port: HistoryPort = browserHistoryPort()): Router {
  const listeners = new Set<() => void>();
  let currentPath = port.path();
  let currentRoute = matchRoute(currentPath);

  /**
   * Re-read the port and notify if the path moved. Called on back/forward, and
   * directly after a push: browsers do not fire a pop event for a programmatic
   * navigation, so nothing else would.
   */
  function sync(): void {
    const path = port.path();
    if (path === currentPath) return;
    currentPath = path;
    currentRoute = matchRoute(path);
    for (const listener of [...listeners]) listener();
  }

  // Attached for the router's whole life rather than on first subscriber: one
  // router serves the app, and a store whose snapshot goes stale between
  // subscriptions is a worse trade than one listener that outlives them.
  port.onPopState(sync);

  return {
    getRoute: () => currentRoute,
    navigate(route, options = {}) {
      const href = hrefFor(route);
      if (options.replace === true) port.replace(href);
      else port.push(href);
      sync();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
