/*
 * Shared factories for the UI suites (Task 5.2a). NOT a test file — the `ui`
 * project only collects `*.test.ts(x)`, the same convention `helpers.ts` and
 * `../../__tests__/build-ui.ts` already follow.
 *
 * `makeSession` returns a full `Session`, not a partial cast, so a change to
 * `@shared/entities.ts` breaks this file at compile time instead of leaving
 * every suite asserting against a shape the server no longer sends.
 *
 * Tasks 5.2b and 5.3a EXTEND this module rather than starting rivals to it.
 */

import type { Message, Session, Span } from '@shared/entities.ts';
import type { Page } from '@shared/api.ts';

import type { ApiClient } from '../api.js';

/** A complete, plausible session. Every field is overridable. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'seed-s0',
    harness: 'claude-code',
    project_path: '/tmp/agent-lens/project-0',
    git_branch: 'main',
    model: 'claude-sonnet-5',
    started_at: '2026-07-29T09:00:00.000Z',
    ended_at: '2026-07-29T09:30:00.000Z',
    status: 'complete',
    capture_mode: 'full',
    transcript_path: '/tmp/agent-lens/transcripts/seed-s0.jsonl',
    total_tokens: 1200,
    tokens_in: 1000,
    tokens_out: 200,
    tokens_cache_read: 50,
    tokens_cache_write: 10,
    est_cost: 0.0123,
    tool_call_count: 2,
    error_count: 0,
    trace_count: 2,
    ...overrides,
  };
}

/** The one pagination envelope the read API serves on every list route. */
export function makePage<T>(items: T[], overrides: Partial<Page<T>> = {}): Page<T> {
  return { items, limit: 100, offset: 0, has_more: false, ...overrides };
}

/**
 * An `ApiClient` whose methods a test replaces one at a time.
 *
 * The unstubbed list routes answer with an empty page; the two single-entity
 * routes reject by name, because a caller reaching one it did not stub is a
 * test bug worth a loud message rather than an empty object.
 */
export function stubApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const unstubbed = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`stubApiClient: ${method} was called but never stubbed`));

  return {
    listSessions: () => Promise.resolve(makePage<Session>([])),
    listSpans: () => Promise.resolve(makePage<Span>([])),
    listMessages: () => Promise.resolve(makePage<Message>([])),
    getSession: unstubbed('getSession'),
    getPayload: unstubbed('getPayload'),
    ...overrides,
  };
}
