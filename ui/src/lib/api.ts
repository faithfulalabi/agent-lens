/*
 * The typed read-API client (Task 5.1c, AC1).
 *
 * Two methods, against two of the ten routes `src/server/api.ts` registers.
 * Task 4.5 deleted the other three — `listSpans`, `listMessages` and
 * `getPayload` — with the routes they called: the tool-call fold makes a span
 * list an event page, and `/api/traces/:id/messages` and `/api/payloads/:id` do
 * not exist. `/api/events/:id/content` replaces the last of them and Task 5.3
 * writes its client. Two rules shape everything below:
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

import type { Page } from '@shared/api.ts';

import { readBootstrap, type Bootstrap } from './bootstrap.js';

/*
 * The v2 response shapes, declared here rather than in `src/shared/api.ts`.
 *
 * They are the browser's half of the contract and nothing server-side needs
 * them; Task 5.1 owns consolidating the wire types when it rewrites the screens,
 * and putting them in the shared module first would mean editing a file this
 * cutover otherwise only reads.
 */

/**
 * One row of `GET /api/sessions`. `live` is stamped by the server, never stored.
 *
 * Every other field is a column `src/db/read.ts`'s `SessionRow` declares and
 * `src/server/api.ts` spreads onto the response verbatim. Task 4.5 omitted eight
 * of them here because no screen read them yet; Task 5.1's row does, and a
 * declared-but-unsent field would fail loudly rather than silently, so the two
 * shapes are kept in step instead.
 */
export interface SessionListRow {
  id: string;
  title: string | null;
  preview: string | null;
  project_path: string;
  git_branch: string | null;
  model: string | null;
  harness_version: string | null;
  started_at: string;
  last_activity_at: string;
  turn_count: number;
  tool_call_count: number;
  error_count: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  est_cost: number | null;
  agent_count: number;
  sub_tool_call_count: number;
  sub_error_count: number;
  sub_tokens_in: number;
  sub_tokens_out: number;
  sub_tokens_cache_read: number;
  sub_tokens_cache_write: number;
  sub_est_cost: number | null;
  /** `own` means the sub-agent sweep has not folded the sidecars in yet. */
  rollup_state: 'own' | 'complete';
  has_drift: boolean;
  live: boolean;
}

/** One row of the `turns` array on the detail response. */
export interface TurnRow {
  id: string;
  seq: number;
  kind: string;
  /** The `Agent` call a `task_notification` turn answers, else null. */
  parent_event_id: string | null;
  title: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  est_cost: number | null;
  tool_call_count: number;
  error_count: number;
  first_seq: number;
  last_seq: number;
}

/**
 * One row of the `events` array — the tool_use/tool_result fold, already done.
 *
 * `input`, `input_bytes`, `input_storage` and `duration_source` were declared by
 * Task 5.2: `src/db/read.ts`'s `EVENT_COLUMNS` has always sent them, and the row
 * cannot say what a tool call was asked to do, or what its number measures,
 * without them. Neither `kind` nor `status` is narrowed here — the wire carries
 * whatever the projector wrote, and `lib/turn-tree.ts` owns the narrowing.
 */
export interface EventRow {
  id: string;
  turn_id: string;
  seq: number;
  kind: string;
  ts: string;
  name: string | null;
  status: string | null;
  duration_ms: number | null;
  /** `elapsed` | `sidecar_span` | `reported`; null on every non-tool row. */
  duration_source: string | null;
  /** The tool's input as JSON text — full, or an 8 KB head preview. */
  input: string | null;
  input_bytes: number | null;
  input_storage: string | null;
  text: string | null;
  text_bytes: number | null;
  output_storage: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  est_cost: number | null;
  child_session_id: string | null;
  agent_type: string | null;
  raw_type: string;
}

/**
 * `GET /api/sessions/:id` — the header, its turns, and ONE PAGE of events.
 *
 * The event page is a CURSOR, not an offset window: `next_seq` is where the
 * following request starts, and `has_more` says whether to make one. An offset
 * scheme would renumber the whole page whenever the file grew mid-scroll, which
 * is the state a live tail is in by definition.
 */
export interface SessionDetailBody {
  session: SessionListRow & { projection: { state: string; error?: string | null } };
  turns: TurnRow[];
  events: EventRow[];
  next_seq: number;
  has_more: boolean;
  /** The live-tail epoch. Empty when the archive had no bytes to fold. */
  fingerprint: string;
}

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

/**
 * `GET /api/sessions` filters. Empty strings are omitted, as the server does.
 *
 * ★ STILL NO `from`/`to`, AND THAT IS NOW A RULING RATHER THAN A GAP.
 * `src/server/api.ts` reads only `limit/offset/sort/project/q` and
 * `parsePageParams` IGNORES an unknown param rather than 400-ing, so a range
 * narrowing sent here would be set by the reader and never applied by the
 * server. Task 5.1 restored the narrowing on the CLIENT instead, over the one
 * unfiltered page — see `session-list.ts` for what that costs and why the
 * truncation flags carry it.
 */
export interface SessionsQuery extends PageQuery {
  project?: string;
  q?: string;
  sort?: 'recent' | 'cost' | 'tokens' | 'errors';
}

/** `GET /api/sessions/:id` — `from_seq` is the event cursor, not an offset. */
export interface SessionDetailQuery {
  limit?: number;
  from_seq?: number;
}

/** Per-request cancellation, passed straight through to `fetch`. */
export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ApiClient {
  listSessions(query?: SessionsQuery, options?: RequestOptions): Promise<Page<SessionListRow>>;
  getSession(
    id: string,
    query?: SessionDetailQuery,
    options?: RequestOptions,
  ): Promise<SessionDetailBody>;
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
      request<Page<SessionListRow>>('/api/sessions', { ...query }, options),

    getSession: (id, query = {}, options) =>
      request<SessionDetailBody>(
        `/api/sessions/${encodeURIComponent(id)}`,
        { ...query },
        options,
      ),
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
