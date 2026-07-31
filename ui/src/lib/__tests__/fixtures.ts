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

import type { Message, Session, Span, SpanStatus, Trace, TraceTrigger } from '@shared/entities.ts';
import type { Page } from '@shared/api.ts';

import type { ApiClient } from '../api.js';
import { buildTreeModel, flatten, type Row, type TreeModel } from '../span-tree.js';

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

/* ------------------------------------------------ Task 5.3a: the tree --- */

/** The wall-clock origin every span factory below counts forward from. */
const TREE_EPOCH = Date.parse('2026-07-29T09:00:00.000Z');

/** `TREE_EPOCH + n` seconds, as the ISO string the server puts on the wire. */
export function atSecond(second: number): string {
  return new Date(TREE_EPOCH + second * 1000).toISOString();
}

/** A complete, plausible turn. Rollup fields are the server's, not a sum. */
export function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    id: 'seed-s0:1',
    session_id: 'seed-s0',
    turn_seq: 1,
    trigger: 'user_prompt',
    prompt_preview: 'add a span tree',
    started_at: atSecond(0),
    ended_at: atSecond(60),
    status: 'complete',
    total_tokens: 1200,
    tokens_in: 1000,
    tokens_out: 200,
    tokens_cache_read: 50,
    tokens_cache_write: 10,
    est_cost: 0.0123,
    duration_ms: 60_000,
    tool_call_count: 2,
    error_count: 0,
    ...overrides,
  };
}

/** A complete, plausible span. Every field is overridable. */
export function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    id: 'sp-1',
    trace_id: 'seed-s0:1',
    span_type: 'tool_call',
    name: 'Read',
    status: 'ok',
    started_at: atSecond(0),
    ended_at: atSecond(1),
    source: 'hook',
    tags: [],
    attrs: {},
    ...overrides,
  };
}

/** One node of the nested literal {@link makeSpanTree} reads. */
export interface SpanTreeSpec extends Partial<Span> {
  id: string;
  children?: SpanTreeSpec[];
}

/**
 * A nested literal, flattened into the page the server actually serves:
 * `parent_span_id` wired from the nesting and the result sorted by
 * `started_at` — because `readSessionSpans` orders `started_at ASC` and
 * nothing else, so the array a real client receives is time-ordered and NOT
 * tree-ordered. A spec that pins its own timestamps therefore produces a page
 * whose array order genuinely disagrees with its tree order.
 *
 * Unpinned spans walk one second forward per node in declaration order, which
 * keeps the two orders equal — useful when a test is about something else.
 */
export function makeSpanTree(specs: SpanTreeSpec[], base: Partial<Span> = {}): Span[] {
  const spans: Span[] = [];
  let clock = 0;

  const walk = (nodes: SpanTreeSpec[], parentSpanId: string | undefined): void => {
    for (const node of nodes) {
      const { children, ...fields } = node;
      const second = clock;
      clock += 1;
      spans.push(
        makeSpan({
          started_at: atSecond(second),
          ended_at: atSecond(second + 1),
          ...base,
          ...fields,
          ...(parentSpanId === undefined ? {} : { parent_span_id: parentSpanId }),
        }),
      );
      if (children !== undefined) walk(children, node.id);
    }
  };

  walk(specs, undefined);
  spans.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  return spans;
}

/**
 * A page whose second span names a parent that is not on it.
 *
 * Real and routine, from two independent causes: the span page is capped, so a
 * child can arrive without its parent, and the `unattributed` tag marks spans
 * the normalizer could not attach at all.
 */
export function makeOrphanPage(): Span[] {
  return [
    makeSpan({ id: 'sp-kept', started_at: atSecond(0), ended_at: atSecond(1) }),
    makeSpan({
      id: 'sp-orphan',
      parent_span_id: 'sp-off-page',
      tags: ['unattributed'],
      started_at: atSecond(2),
      ended_at: atSecond(3),
    }),
  ];
}

/**
 * Two spans that name each other as parent.
 *
 * `parent_span_id` is a self-FK with `ON DELETE SET NULL` and no cycle
 * constraint (`db/migrations/001-initial-schema.ts`), so the database will
 * happily store this and the client owns termination.
 */
export function makeCyclePage(): Span[] {
  return [
    makeSpan({
      id: 'sp-a',
      parent_span_id: 'sp-b',
      started_at: atSecond(0),
      ended_at: atSecond(1),
    }),
    makeSpan({
      id: 'sp-b',
      parent_span_id: 'sp-a',
      started_at: atSecond(2),
      ended_at: atSecond(3),
    }),
  ];
}

/* --------------------------------------------- Task 5.3b: rendered rows --- */

/*
 * Task 5.3a deliberately left the four factories below to this task, saying so
 * in as many words: they serve the rendered tree's tests and nothing in the
 * pure model needed them.
 *
 * Every one of them answers with the shapes the SERVER can actually produce —
 * the whole `SpanStatus` union, the whole `TraceTrigger` union, and the four
 * degradation tags the normalizer writes — rather than with the one or two a
 * particular assertion happens to want. That is what makes "and the ordinary
 * case draws none of it" assertable on the same fixture.
 */

/** How many spans hang under each turn in {@link makeLargeTree} by default. */
const LARGE_SPANS_PER_TRACE = 500;

/** How many turns {@link makeLargeTree} builds by default. */
const LARGE_TRACES = 10;

export interface LargeTree {
  readonly traces: Trace[];
  readonly spansByTrace: Map<string, Span[]>;
}

/**
 * A session at real scale: 10 turns of 500 spans, i.e. 5,000 spans.
 *
 * The same shape the manual measurement recipe seeds on disk
 * (`seedFixtureDb(dir, {sessions: 1, tracesPerSession: 10, spansPerTrace: 500})`),
 * so the automated row-count assertion and the hand-run browser measurement are
 * looking at a session of the same size rather than at two different ones.
 *
 * Flat rather than deeply nested on purpose: this fixture exists to measure the
 * row count and the model's complexity, and nesting would make the row count
 * depend on expansion state instead of on the viewport.
 */
export function makeLargeTree({
  traces = LARGE_TRACES,
  spansPerTrace = LARGE_SPANS_PER_TRACE,
}: { traces?: number; spansPerTrace?: number } = {}): LargeTree {
  const turns: Trace[] = [];
  const spansByTrace = new Map<string, Span[]>();

  for (let t = 0; t < traces; t += 1) {
    const id = `seed-s0:${t}`;
    turns.push(makeTrace({ id, turn_seq: t, prompt_preview: `turn ${t}` }));
    spansByTrace.set(
      id,
      Array.from({ length: spansPerTrace }, (_, s) =>
        makeSpan({
          id: `${id}-sp-${s}`,
          trace_id: id,
          name: `step ${s}`,
          started_at: atSecond(t * spansPerTrace + s),
          ended_at: atSecond(t * spansPerTrace + s + 1),
        }),
      ),
    );
  }

  return { traces: turns, spansByTrace };
}

/** One span per `SpanStatus`, in a stable order, all under one turn. */
export function makeStatusPage(): Span[] {
  const statuses: readonly SpanStatus[] = ['running', 'ok', 'error', 'denied', 'unknown'];
  return statuses.map((status, i) =>
    makeSpan({
      id: `sp-${status}`,
      name: status,
      status,
      started_at: atSecond(i),
      // A running span has not ended. Giving it an `ended_at` would make it the
      // one shape on this page that cannot exercise the live spelling.
      ...(status === 'running' ? { ended_at: undefined } : { ended_at: atSecond(i + 1) }),
    }),
  );
}

/** The four tags the normalizer writes, plus one span carrying none of them. */
export function makeDegradedPage(): Span[] {
  const tags = ['degraded', 'transcript_only', 'synthetic_open', 'unattributed'];
  return [
    ...tags.map((tag, i) =>
      makeSpan({
        id: `sp-${tag}`,
        tags: [tag],
        started_at: atSecond(i),
        ended_at: atSecond(i + 1),
      }),
    ),
    makeSpan({ id: 'sp-clean', tags: [], started_at: atSecond(9), ended_at: atSecond(10) }),
  ];
}

/**
 * One turn per `TraceTrigger`.
 *
 * A trigger that is not `user_prompt` is what "synthetic trace" means — there
 * is no other marker on the wire — so the ordinary case has to be on the same
 * fixture for "and it draws no badge" to mean anything.
 */
export function makeSyntheticTraces(): Trace[] {
  const triggers: readonly TraceTrigger[] = [
    'user_prompt',
    'system_resume',
    'compaction',
    'unknown',
  ];
  return triggers.map((trigger, i) =>
    makeTrace({ id: `seed-s0:${i}`, turn_seq: i, trigger, prompt_preview: `turn ${i}` }),
  );
}

/**
 * A model and the row list it flattens to with everything opened.
 *
 * `model.rowIds` is every id that can be a row, so passing it as the expansion
 * set opens the whole forest — which is what a render assertion about a nested
 * span wants, and it saves each test hand-building an expansion set that would
 * then be the thing under test rather than the thing being assumed.
 */
export function expandedRows(
  traces: readonly Trace[],
  spansByTrace: ReadonlyMap<string, readonly Span[]>,
): { model: TreeModel; rows: Row[] } {
  const model = buildTreeModel(traces, spansByTrace);
  return { model, rows: flatten(model, model.rowIds) };
}

/** {@link expandedRows} for the common one-turn page. */
export function rowsForSpans(spans: readonly Span[], trace: Trace = makeTrace()): Row[] {
  return expandedRows(
    [trace],
    new Map([[trace.id, spans.map((s) => ({ ...s, trace_id: trace.id }))]]),
  ).rows;
}
