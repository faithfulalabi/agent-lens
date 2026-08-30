import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@shared/api.ts';

import {
  AuthError,
  HttpError,
  NetworkError,
  createApiClient,
  isAuthError,
  type ApiClient,
  type SessionDetailBody,
  type SessionListRow,
} from '../api';
import type { Bootstrap } from '../bootstrap';

/*
 * AC1 — the typed read-API client.
 *
 * Three things are asserted here that a green-looking client can still get
 * wrong:
 *
 *   1. The credential travels as a HEADER whose NAME came off the bootstrap.
 *      The fixture below therefore uses a deliberately non-default header name:
 *      a client that hardcoded `x-agentlens-token` passes with the real name
 *      and fails here, which is the point.
 *   2. No request path carries a scheme. `no-egress.test.ts` polices the built
 *      bundle; this polices the client that produces the requests, and catches
 *      a configurable base URL before it can reach a bundle at all.
 *   3. 401/403 arrive as `text/plain` from `token-auth.ts` and `host-guard.ts`,
 *      while 400/404/500 are `{ error }` JSON. A client that called
 *      `res.json()` on the failure path would throw a SyntaxError on exactly
 *      the two statuses AC1 wants told apart, so the bodies below are the real
 *      shapes, not convenient ones.
 */

const BOOTSTRAP: Bootstrap = Object.freeze({
  token: 'tok-abc-123-secret',
  // Deliberately NOT the real header name — see (1) above.
  tokenHeader: 'x-test-header-name',
});

interface Recorded {
  url: string;
  headers: Headers;
}

function recordingFetch(respond: (url: string) => Response | Promise<Response>): {
  calls: Recorded[];
  fetchImpl: typeof fetch;
} {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return Promise.resolve(respond(url));
  };
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The real shape of a rejected request: plain text, no JSON anywhere. */
function plainText(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

const EMPTY_PAGE = { items: [], limit: 100, offset: 0, has_more: false };

/** Every method, so header/URL assertions are table-driven rather than sampled. */
const METHODS: readonly { name: string; path: string; call: (c: ApiClient) => Promise<unknown> }[] =
  [
    { name: 'listSessions', path: '/api/sessions', call: (c) => c.listSessions() },
    { name: 'getSession', path: '/api/sessions/s1', call: (c) => c.getSession('s1') },
  ];

describe('the API client authenticates by header', () => {
  it.each(METHODS)(
    '$name sends the bootstrap token under the bootstrap header',
    async ({ call }) => {
      const { calls, fetchImpl } = recordingFetch(() => json(EMPTY_PAGE));
      await call(createApiClient({ fetchImpl, bootstrap: BOOTSTRAP }));

      expect(calls).toHaveLength(1);
      const [recorded] = calls;
      expect(recorded?.headers.get(BOOTSTRAP.tokenHeader)).toBe(BOOTSTRAP.token);
      expect(
        recorded?.headers.get('x-agentlens-token'),
        'the header NAME must come off the bootstrap, not a hardcoded constant',
      ).toBeNull();
    },
  );

  it('never puts the token in a URL', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(EMPTY_PAGE));
    const client = createApiClient({ fetchImpl, bootstrap: BOOTSTRAP });
    for (const { call } of METHODS) await call(client);
    await client.listSessions({ project: 'p', q: 'needle', limit: 5, offset: 10 });
    await client.getSession('s1', { limit: 5, from_seq: 200 });

    expect(calls.length).toBeGreaterThan(METHODS.length);
    for (const { url } of calls) {
      // Mirrors static-bootstrap.test.ts's no-token-in-URL assertion, from the
      // client side: the URL is about to become the shareable deep-link surface.
      expect(url, `token leaked into ${url}`).not.toContain(BOOTSTRAP.token);
      expect(new URL(url, 'https://example.invalid').search).not.toContain(BOOTSTRAP.token);
    }
  });

  it.each(METHODS)('$name requests an origin-relative path', async ({ call, path }) => {
    const { calls, fetchImpl } = recordingFetch(() => json(EMPTY_PAGE));
    await call(createApiClient({ fetchImpl, bootstrap: BOOTSTRAP }));

    const url = calls[0]?.url ?? '';
    expect(url).toBe(path);
    expect(url).toMatch(/^\/api\//);
    expect(url, 'an absolute URL here is egress, and would red no-egress.test.ts').not.toMatch(
      /^[a-z][a-z0-9+.-]*:/i,
    );
    expect(url, 'a protocol-relative reference is off-origin too').not.toMatch(/^\/\//);
  });
});

describe('the API client distinguishes its three failure classes', () => {
  it.each([401, 403] as const)(
    'HTTP %i with a plain-text body becomes an AuthError',
    async (status) => {
      const body = status === 401 ? 'Unauthorized' : 'Forbidden';
      const { fetchImpl } = recordingFetch(() => plainText(body, status));
      const client = createApiClient({ fetchImpl, bootstrap: BOOTSTRAP });

      // A client that decoded the failure body with res.json() would throw a
      // SyntaxError here instead of the typed error.
      const error = await client.listSessions().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthError);
      expect(isAuthError(error)).toBe(true);
      expect((error as AuthError).kind).toBe('auth');
      expect((error as AuthError).status).toBe(status);
      expect((error as AuthError).message).toBe(body);
    },
  );

  it('HTTP 500 is an HttpError and is NOT an AuthError', async () => {
    const { fetchImpl } = recordingFetch(() => json({ error: 'internal error' }, 500));
    const client = createApiClient({ fetchImpl, bootstrap: BOOTSTRAP });

    const error = await client.listSessions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).not.toBeInstanceOf(AuthError);
    expect(isAuthError(error)).toBe(false);
    expect((error as HttpError).kind).toBe('http');
    expect((error as HttpError).status).toBe(500);
    expect((error as HttpError).message).toBe('internal error');
  });

  it('a dead server is a NetworkError, distinguishable from an HTTP 500', async () => {
    const cause = new TypeError('fetch failed');
    const dead = createApiClient({
      fetchImpl: () => Promise.reject(cause),
      bootstrap: BOOTSTRAP,
    });
    const five = createApiClient({
      fetchImpl: recordingFetch(() => json({ error: 'internal error' }, 500)).fetchImpl,
      bootstrap: BOOTSTRAP,
    });
    const denied = createApiClient({
      fetchImpl: recordingFetch(() => plainText('Unauthorized', 401)).fetchImpl,
      bootstrap: BOOTSTRAP,
    });

    const network = (await dead.listSessions().catch((e: unknown) => e)) as NetworkError;
    const http = (await five.listSessions().catch((e: unknown) => e)) as HttpError;
    const auth = (await denied.listSessions().catch((e: unknown) => e)) as AuthError;

    expect(network).toBeInstanceOf(NetworkError);
    expect(network.cause).toBe(cause);

    // The literal wording of AC1: three states, told apart, side by side.
    expect(new Set([auth.kind, http.kind, network.kind])).toEqual(
      new Set(['auth', 'http', 'network']),
    );
  });

  it.each([
    {
      label: 'JSON {error} body',
      response: () => json({ error: 'invalid limit' }, 400),
      message: 'invalid limit',
    },
    {
      label: 'plain-text body',
      response: () => plainText('Forbidden', 403),
      message: 'Forbidden',
    },
    {
      label: 'empty body, status text as last resort',
      response: () => new Response('', { status: 503, statusText: 'Service Unavailable' }),
      message: 'Service Unavailable',
    },
  ])('takes its message from the $label', async ({ response, message }) => {
    const { fetchImpl } = recordingFetch(response);
    const client = createApiClient({ fetchImpl, bootstrap: BOOTSTRAP });
    const error = (await client.listSessions().catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(message);
  });

  it('a 200 whose body is not JSON is a typed failure, not a raw SyntaxError', async () => {
    // Reachable when a proxy substitutes an HTML error page but keeps the 200 —
    // the caller still gets something it can switch on.
    const { fetchImpl } = recordingFetch(() => new Response('<html>nope</html>', { status: 200 }));
    const error = await createApiClient({ fetchImpl, bootstrap: BOOTSTRAP })
      .listSessions()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as HttpError).message).toContain('/api/sessions');
  });
});

describe('the API client returns the shared wire shapes', () => {
  const ROW: SessionListRow = {
    id: 's1',
    title: 'add a span tree',
    preview: 'add a span tree',
    project_path: '/repo',
    git_branch: 'main',
    model: 'claude-sonnet-5',
    harness_version: '2.0.0',
    started_at: '2026-07-29T10:00:00.000Z',
    last_activity_at: '2026-07-29T10:05:00.000Z',
    turn_count: 1,
    tool_call_count: 1,
    error_count: 0,
    tokens_in: 8,
    tokens_out: 4,
    tokens_cache_read: 2,
    tokens_cache_write: 1,
    est_cost: 0.01,
    agent_count: 0,
    sub_tool_call_count: 0,
    sub_error_count: 0,
    sub_tokens_in: 0,
    sub_tokens_out: 0,
    sub_tokens_cache_read: 0,
    sub_tokens_cache_write: 0,
    sub_est_cost: 0,
    rollup_state: 'complete',
    has_drift: false,
    live: true,
  };

  it('listSessions returns Page<SessionListRow>', async () => {
    const body: Page<SessionListRow> = { items: [ROW], limit: 100, offset: 0, has_more: true };
    const { fetchImpl } = recordingFetch(() => json(body));
    // The type annotation IS the assertion — `tsc --noEmit` is the other half
    // of this test, and the reason `npm run typecheck` runs beside `npm test`.
    const page: Page<SessionListRow> = await createApiClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
    }).listSessions();

    expect(page.has_more).toBe(true);
    // `live` is stamped by the server and is not a column, which is exactly the
    // field a `Session`-typed client could not carry.
    expect(page.items[0]?.live).toBe(true);
    expect(page, 'the envelope deliberately has no total').not.toHaveProperty('total');
  });

  it('getSession returns the detail body, cursor fields included', async () => {
    const body: SessionDetailBody = {
      session: { ...ROW, projection: { state: 'ready' } },
      turns: [],
      events: [],
      next_seq: 0,
      has_more: false,
      fingerprint: '1:2:3',
    };
    const { fetchImpl } = recordingFetch(() => json(body));
    const detail: SessionDetailBody = await createApiClient({
      fetchImpl,
      bootstrap: BOOTSTRAP,
    }).getSession('s1');

    expect(detail.session.id).toBe('s1');
    expect(detail.has_more).toBe(false);
    // The live-tail epoch rides on the detail response, not on a second route.
    expect(detail.fingerprint).toBe('1:2:3');
  });

  it('getSession sends from_seq as a cursor, never an offset', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(EMPTY_PAGE));
    await createApiClient({ fetchImpl, bootstrap: BOOTSTRAP }).getSession('s1', {
      limit: 500,
      from_seq: 1200,
    });

    expect(calls[0]?.url).toBe('/api/sessions/s1?limit=500&from_seq=1200');
    expect(calls[0]?.url, 'offset paging was replaced by the cursor').not.toContain('offset');
  });

  it.each([
    { label: 'no params', query: {}, search: '' },
    { label: 'undefined dropped', query: { project: undefined }, search: '' },
    // The server treats '' as "param not supplied"; sending it would be a lie.
    { label: 'empty string dropped', query: { project: '' }, search: '' },
    { label: 'numbers stringified', query: { limit: 5, offset: 10 }, search: '?limit=5&offset=10' },
    {
      label: 'filters encoded',
      query: { project: '/a b', from: '2026-01-01' },
      search: '?project=%2Fa+b&from=2026-01-01',
    },
  ])('serialises the session-list query ($label)', async ({ query, search }) => {
    const { calls, fetchImpl } = recordingFetch(() => json(EMPTY_PAGE));
    await createApiClient({ fetchImpl, bootstrap: BOOTSTRAP }).listSessions(query);
    expect(calls[0]?.url).toBe(`/api/sessions${search}`);
  });

  it('passes an AbortSignal through to fetch', async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(json(EMPTY_PAGE));
    };
    const controller = new AbortController();
    await createApiClient({ fetchImpl, bootstrap: BOOTSTRAP }).listSessions(
      {},
      { signal: controller.signal },
    );
    expect(seen).toBe(controller.signal);
  });
});

/*
 * The lint rule in eslint.config.js catches new code that imports the barrel.
 * This catches the case the lint rule cannot: someone deleting the lint rule.
 * Deny-list style borrowed from retokenized.test.ts.
 */
describe('no UI module imports the shared barrel', () => {
  const UI_SRC = fileURLToPath(new URL('../../', import.meta.url));

  /*
   * Assembled from fragments rather than written out, because this scan reads
   * every file under ui/src — including itself. A spelled-out needle would
   * match its own source and red on arrival. Same trap, same fix, as
   * retokenized.test.ts's comment-aware deny-list.
   */
  const BARREL_SPECIFIERS = ['@shared', 'src/shared'].map((prefix) => `${prefix}/${'index'}`);

  function uiSources(): { name: string; text: string }[] {
    return readdirSync(UI_SRC, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
      .map((name) => ({ name, text: readFileSync(join(UI_SRC, name), 'utf8') }));
  }

  it('the scan sees a real number of files', () => {
    expect(
      uiSources().length,
      'the source scan found almost nothing — it regressed',
    ).toBeGreaterThan(10);
    expect(BARREL_SPECIFIERS).toHaveLength(2);
  });

  it('nothing imports the barrel under either specifier', () => {
    // The barrel re-exports token.js and pricing.js, which pull node:crypto/fs/
    // os/path into whatever imports them — fatal in a browser bundle.
    for (const { name, text } of uiSources()) {
      for (const specifier of BARREL_SPECIFIERS) {
        expect(text.includes(specifier), `${name} imports the shared barrel`).toBe(false);
      }
    }
  });
});
