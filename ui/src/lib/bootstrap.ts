/*
 * The one place the UI learns its credential (Task 5.1c).
 *
 * The server injects `window.__AGENT_LENS__ = Object.freeze({ token,
 * tokenHeader })` into the served `index.html` — the published contract at the
 * top of `src/server/static-ui.ts`. `tokenHeader` travels beside the token
 * because the module that exports the header name as a constant also drags in
 * `node:crypto`/`fs`/`os`/`path` and so is unusable from a browser bundle; the
 * `api.test.ts` scan and the eslint rule both enforce that. Re-deriving the
 * header name here would be a second source of truth that drifts silently.
 *
 * Never a cookie (the header design is what defeats CSRF), never a query param
 * (the URL is about to become the shareable deep-link surface), never
 * `localStorage` (the token is regenerable on disk, so a cached copy yields
 * mysterious 401s).
 *
 * The `scope` parameter is the seam: the `ui` vitest project runs under
 * `environment: 'node'` with no DOM at all, so injecting the carrier object is
 * the only way to test any of this.
 */

/** The injected bootstrap payload, exactly as `static-ui.ts` freezes it. */
export interface Bootstrap {
  readonly token: string;
  /** Always `x-agentlens-token` in practice — read it, never hardcode it. */
  readonly tokenHeader: string;
}

/** Anything that might carry the injected global — the real one is `window`. */
export interface BootstrapScope {
  __AGENT_LENS__?: Bootstrap;
}

declare global {
  interface Window {
    __AGENT_LENS__?: Bootstrap;
  }
}

/**
 * Thrown when the page was served without the bootstrap script. The message
 * names the server module responsible, because the symptom otherwise is every
 * request 401ing with nothing to explain why.
 */
export class BootstrapMissingError extends Error {
  constructor(detail: string) {
    super(
      `agent-lens: window.__AGENT_LENS__ ${detail}. The page must be served by ` +
        'the agent-lens server, which injects it (see src/server/static-ui.ts).',
    );
    this.name = 'BootstrapMissingError';
  }
}

/** Memoised for the default scope only — see `readBootstrap`. */
let ambient: Bootstrap | undefined;

/**
 * The injected token and header name.
 *
 * Called with no argument it reads the ambient global once and caches it, which
 * is what makes `createApiClient()`'s default parameter free. Called with an
 * explicit scope it never caches, so tests stay independent of each other.
 *
 * @throws BootstrapMissingError when the global is absent or malformed.
 */
export function readBootstrap(scope?: BootstrapScope): Bootstrap {
  if (scope !== undefined) return validate(scope.__AGENT_LENS__);
  ambient ??= validate((globalThis as BootstrapScope).__AGENT_LENS__);
  return ambient;
}

function validate(value: Bootstrap | undefined): Bootstrap {
  if (value === undefined || value === null) throw new BootstrapMissingError('is not defined');
  if (typeof value.token !== 'string' || value.token === '') {
    throw new BootstrapMissingError('carries no token');
  }
  if (typeof value.tokenHeader !== 'string' || value.tokenHeader === '') {
    throw new BootstrapMissingError('carries no tokenHeader');
  }
  return value;
}
