/*
 * The typed read-API client (Task 5.1c, AC1).
 *
 * Five methods, one per route registered by `src/server/read-api.ts`, returning
 * the shared wire types verbatim. Two rules shape everything below:
 *
 * 1. **Every path is origin-relative.** `ui/src/__tests__/no-egress.test.ts`
 *    fails the build on any new absolute URL literal in the bundle, and "zero
 *    egress" is a product guarantee rather than a preference. There is
 *    deliberately no configurable base — the UI is always served by the process
 *    it talks to.
 *
 * 2. **Failures are decoded from text, never from `res.json()`.** The server's
 *    error bodies are not uniformly JSON: `tokenAuth` answers 401 with a plain
 *    `Unauthorized` and `hostGuard` answers 403 with a plain `Forbidden`, while
 *    the read API's 400/404s and `app.onError`'s 500 are `{ error }` objects.
 *    A client that called `res.json()` on the failure path would throw a
 *    SyntaxError on exactly the two statuses AC1 wants told apart.
 *
 * The error taxonomy is the AC1 deliverable: `auth`, `http` and `network` are
 * three distinct classes with a `kind` discriminant, so a caller can switch
 * exhaustively and a dead server never looks like an HTTP 500.
 */

import type { Message, Session, Span } from '@shared/entities.ts';
import type { Page, PayloadSlice, SessionDetail } from '@shared/api.ts';

import { readBootstrap, type Bootstrap } from './bootstrap.js';

/** Discriminant shared by every failure this client throws. */
export type ApiErrorKind = 'auth' | 'http' | 'network';

/** Base of the three failure classes. Never thrown directly. */
export abstract class ApiError extends Error {
  abstract readonly kind: ApiErrorKind;
}

/**
 * 401 or 403 — a bad or missing token, or a blocked Host header.
 *
 * The only terminal class: retrying cannot help, and `sse.ts` relies on that to
 * stop a bad token hammering the server forever.
 */
export class AuthError extends ApiError {
  readonly kind = 'auth';

  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Any other non-2xx response. `message` comes from the body when it has one. */
export class HttpError extends ApiError {
  readonly kind = 'http';

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * The request never produced a response — the server is down, or the machine is
 * offline. Distinct from an HTTP 500 by construction, which is the distinction
 * AC1 asks for.
 */
export class NetworkError extends ApiError {
  readonly kind = 'network';

  constructor(readonly cause: unknown) {
    super(`agent-lens: the request did not reach the server (${describe(cause)})`);
    this.name = 'NetworkError';
  }
}

/** Every failure `ApiClient` throws, as a closed union. */
export type ApiFailure = AuthError | HttpError | NetworkError;

/** Narrowing helper for the one class that must never be retried. */
export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}

/** `?limit`/`?offset`, shared by every list route. */
export interface PageQuery {
  limit?: number;
  offset?: number;
}

/** `GET /api/sessions` filters. Empty strings are omitted, as the server does. */
export interface SessionsQuery extends PageQuery {
  from?: string;
  to?: string;
  project?: string;
}

/** `GET /api/sessions/:id/spans` — `?trace=` narrows to a single turn. */
export interface SpansQuery extends PageQuery {
  trace?: string;
}

/** Per-request cancellation, passed straight through to `fetch`. */
export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ApiClient {
  listSessions(query?: SessionsQuery, options?: RequestOptions): Promise<Page<Session>>;
  getSession(id: string, page?: PageQuery, options?: RequestOptions): Promise<SessionDetail>;
  listSpans(id: string, query?: SpansQuery, options?: RequestOptions): Promise<Page<Span>>;
  listMessages(traceId: string, page?: PageQuery, options?: RequestOptions): Promise<Page<Message>>;
  /** `range` is the raw `start-end` string; `end` is omissible (`1024-`). */
  getPayload(id: string, range?: string, options?: RequestOptions): Promise<PayloadSlice>;
}

export interface ApiClientOptions {
  /** Injected so the whole client is testable without a network or a DOM. */
  fetchImpl?: typeof fetch;
  bootstrap?: Bootstrap;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const bootstrap = options.bootstrap ?? readBootstrap();

  async function request<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    requestOptions: RequestOptions | undefined,
  ): Promise<T> {
    const url = buildUrl(path, query);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        // The credential rides in a header and nowhere else, so it never lands
        // in a URL, a referrer or a server log.
        headers: { [bootstrap.tokenHeader]: bootstrap.token },
        ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
    } catch (cause) {
      throw new NetworkError(cause);
    }

    const body = await readText(res);
    if (!res.ok) throw toApiError(res, body);

    const parsed = tryParseJson(body);
    if (!parsed.ok) {
      throw new HttpError(res.status, `agent-lens: ${path} returned a body that is not JSON`);
    }
    return parsed.value as T;
  }

  return {
    listSessions: (query = {}, options) =>
      request<Page<Session>>('/api/sessions', { ...query }, options),

    getSession: (id, page = {}, options) =>
      request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`, { ...page }, options),

    listSpans: (id, query = {}, options) =>
      request<Page<Span>>(`/api/sessions/${encodeURIComponent(id)}/spans`, { ...query }, options),

    listMessages: (traceId, page = {}, options) =>
      request<Page<Message>>(
        `/api/traces/${encodeURIComponent(traceId)}/messages`,
        { ...page },
        options,
      ),

    getPayload: (id, range, options) =>
      request<PayloadSlice>(`/api/payloads/${encodeURIComponent(id)}`, { range }, options),
  };
}

/**
 * An origin-relative path with its query appended. Absent and empty values are
 * dropped, matching the server, which treats `''` as "param not supplied".
 */
function buildUrl(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** Body text, or `''` when the body cannot be read — never a throw. */
async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function toApiError(res: Response, body: string): ApiFailure {
  const message = messageFrom(res, body);
  if (res.status === 401 || res.status === 403) return new AuthError(res.status, message);
  return new HttpError(res.status, message);
}

/** `{ error }` when the body is that shape, else the raw text, else the status. */
function messageFrom(res: Response, body: string): string {
  const text = body.trim();
  if (text !== '') {
    const parsed = tryParseJson(text);
    if (parsed.ok && isRecord(parsed.value)) {
      const { error } = parsed.value;
      if (typeof error === 'string' && error !== '') return error;
    }
    return text;
  }
  return res.statusText === '' ? `HTTP ${res.status}` : res.statusText;
}

/** Mirrors `read-api.ts`'s ParseResult: a tagged result, never a sentinel. */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
