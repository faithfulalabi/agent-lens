/*
 * Shared factories for the UI suites. NOT a test file — the `ui` project only
 * collects `*.test.ts(x)`, the same convention `helpers.ts` and
 * `../../__tests__/build-ui.ts` already follow.
 *
 * Every factory returns a COMPLETE wire row rather than a partial cast, so a
 * change to `ui/src/lib/api.ts` breaks this file at compile time instead of
 * leaving every suite asserting against a shape the server no longer sends.
 *
 * Task 5.2 deleted the `Session`/`Span`/`Trace` builders with the entity types
 * they constructed. The v2 wire is what the screens read, so it is what the
 * fixtures build.
 */

import type { Page, SessionChangedFrame } from '@shared/api.ts';

import type {
  ApiClient,
  EventContentBody,
  EventRow,
  SessionDetailBody,
  SessionDetailHeaderRow,
  SessionListRow,
  TurnRow,
} from '../api.js';
import type { SessionData } from '../session-data.js';
import { buildTurnGroups, flatten, type Row, type TreeModel } from '../turn-tree.js';

/** The one pagination envelope the read API serves on every list route. */
export function makePage<T>(items: T[], overrides: Partial<Page<T>> = {}): Page<T> {
  return { items, limit: 100, offset: 0, has_more: false, ...overrides };
}

/* ------------------------------------------------- the v2 wire shapes --- */

/** A complete, plausible `GET /api/sessions` row. Every field is overridable. */
export function makeSessionRow(overrides: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id: 'seed-s0',
    title: 'seed session',
    preview: 'seed session',
    project_path: '/tmp/agent-lens/project-0',
    git_branch: 'main',
    model: 'claude-sonnet-5',
    harness_version: '2.0.0',
    started_at: '2026-07-29T09:00:00.000Z',
    last_activity_at: '2026-07-29T09:30:00.000Z',
    turn_count: 2,
    tool_call_count: 2,
    error_count: 0,
    tokens_in: 1000,
    tokens_out: 200,
    tokens_cache_read: 50,
    tokens_cache_write: 10,
    est_cost: 0.0123,
    agent_count: 0,
    sub_tool_call_count: 0,
    sub_error_count: 0,
    sub_tokens_in: 0,
    sub_tokens_out: 0,
    sub_tokens_cache_read: 0,
    sub_tokens_cache_write: 0,
    sub_est_cost: 0,
    // The settled state. A row testing the skeleton opts into `own` explicitly,
    // so no unrelated fixture renders a loading placeholder by accident.
    rollup_state: 'complete',
    has_drift: false,
    live: false,
    ...overrides,
  };
}

/** The wall-clock origin every factory below counts forward from. */
const TREE_EPOCH = Date.parse('2026-07-29T09:00:00.000Z');

/** `TREE_EPOCH + n` seconds, as the ISO string the server puts on the wire. */
export function atSecond(second: number): string {
  return new Date(TREE_EPOCH + second * 1000).toISOString();
}

/** One row of the detail response's `turns` array. */
export function makeTurnRow(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    id: 'seed-s0:1',
    seq: 1,
    kind: 'human',
    parent_event_id: null,
    title: 'add a span tree',
    started_at: atSecond(0),
    ended_at: atSecond(60),
    duration_ms: 60_000,
    tokens_in: 1000,
    tokens_out: 200,
    tokens_cache_read: 50,
    tokens_cache_write: 10,
    est_cost: 0.0123,
    tool_call_count: 2,
    error_count: 0,
    first_seq: 0,
    last_seq: 9,
    ...overrides,
  };
}

/** One row of the detail response's `events` array — a folded tool call. */
export function makeEventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 'ev-1',
    turn_id: 'seed-s0:1',
    seq: 0,
    kind: 'tool_call',
    ts: atSecond(0),
    name: 'Read',
    status: 'ok',
    duration_ms: 1000,
    duration_source: 'elapsed',
    input: '{"file_path":"a.txt"}',
    input_bytes: 21,
    input_storage: 'inline',
    text: 'stdout',
    text_bytes: 6,
    output_storage: 'inline',
    spill_path: null,
    spill_bytes: null,
    model: 'claude-sonnet-5',
    tokens_in: null,
    tokens_out: null,
    est_cost: null,
    child_session_id: null,
    agent_type: null,
    agent_status: null,
    raw_type: 'assistant',
    raw_subtype: null,
    ...overrides,
  };
}

/**
 * The `Agent` tool call that spawns a sidecar — the row Task 5.5 expands.
 *
 * `child_session_id` is what makes a row a sub-agent; `kind` is `tool_call` on
 * every one of them and says nothing. The defaults mirror the commonest measured
 * shape: a `general-purpose` agent that completed.
 */
export function makeAgentEvent(overrides: Partial<EventRow> = {}): Partial<EventRow> {
  return {
    name: 'Agent',
    child_session_id: 'child-0',
    agent_type: 'general-purpose',
    agent_status: 'completed',
    ...overrides,
  };
}

/**
 * A sidecar's loaded detail — a session like any other, carrying the keys an
 * expanded row reads.
 *
 * Returns what `loadSessionDetail` returns, because that is what the sub-agent
 * reducer takes: {@link TurnTree} has already bucketed the events by turn, so
 * building the body and re-bucketing it would duplicate the one line of the
 * loader that does any work.
 *
 * `est_cost: null` by default, because it is the measured majority: 262 of 272
 * sidecars are unpriced. A fixture that priced them would test the 3.7% case and
 * call it normal.
 */
export function makeSidecarDetail(
  sessionId: string,
  tree: TurnTree,
  header: Partial<SessionDetailHeaderRow> = {},
): SessionData {
  const events = [...tree.eventsByTurn.values()].flat();
  return {
    session: {
      ...makeSessionRow({ id: sessionId, est_cost: null, tokens_in: 900, tokens_out: 100 }),
      agent_type: 'general-purpose',
      agent_description: 'find every caller of buildTurnGroups',
      parent_session_id: 'seed-s0',
      spawn_depth: 1,
      ...header,
      projection: { state: 'ready' },
    },
    turns: tree.turns,
    eventsByTurn: tree.eventsByTurn,
    events,
    hasMore: false,
    shown: events.length,
    fingerprint: '900:500:2',
  };
}

/**
 * One `session_changed` frame, complete, with an epoch that moved FORWARD.
 *
 * Forward by default because the splice is the ordinary case: a fixture whose
 * default refetched would make every splice test opt into the thing it tests.
 * The epoch pairs with {@link makeSidecarDetail}'s `'900:500:2'`.
 */
export function makeChangedFrame(
  overrides: Partial<SessionChangedFrame<EventRow>> = {},
): SessionChangedFrame<EventRow> {
  return {
    session_id: 'seed-s0',
    fingerprint: '1000:800:2',
    from_seq: 0,
    patched: [],
    rollups: {
      last_activity_at: '2026-07-29T09:31:00.000Z',
      turn_count: 3,
      tool_call_count: 4,
      error_count: 1,
      tokens_in: 2000,
      tokens_out: 400,
      tokens_cache_read: 100,
      tokens_cache_write: 20,
      est_cost: 0.0246,
    },
    ...overrides,
  };
}

/** A `GET /api/sessions/:id` body with the cursor fields at their quiet values. */
export function makeDetail(overrides: Partial<SessionDetailBody> = {}): SessionDetailBody {
  return {
    session: { ...makeSessionRow(), projection: { state: 'ready' } },
    turns: [],
    events: [],
    next_seq: 0,
    has_more: false,
    fingerprint: '1:2:3',
    ...overrides,
  };
}

/** A `GET /api/events/:id/content` body, whole and untruncated by default. */
export function makeEventContent(overrides: Partial<EventContentBody> = {}): EventContentBody {
  const content = overrides.content ?? 'the whole body';
  return {
    id: 'ev-1',
    field: 'text',
    storage: 'inline',
    byte_size: content.length,
    range: { start: 0, end: Math.max(content.length - 1, 0) },
    truncated: false,
    ...overrides,
    content,
  };
}

/**
 * An `ApiClient` whose methods a test replaces one at a time.
 *
 * The list route answers with an empty page; every other route rejects by name,
 * because a caller reaching one it did not stub is a test bug worth a loud
 * message rather than an empty object.
 */
export function stubApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const unstubbed = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`stubApiClient: ${method} was called but never stubbed`));

  return {
    listSessions: () => Promise.resolve(makePage<SessionListRow>([])),
    getSession: unstubbed('getSession'),
    getEventContent: unstubbed('getEventContent'),
    search: unstubbed('search'),
    warm: unstubbed('warm'),
    ...overrides,
  };
}

/* ---------------------------------------------------- the turn tree --- */

/** One node of the nested literal {@link makeTurnTree} reads. */
export interface TurnTreeSpec extends Partial<TurnRow> {
  id: string;
  /** The events this turn owns, in the order they are declared. */
  events?: Partial<EventRow>[];
  /**
   * Turns folded under this turn's LAST declared event, each with their own
   * events and folds. This is the chain the measured archive produces.
   */
  folded?: TurnTreeSpec[];
}

export interface TurnTree {
  readonly turns: TurnRow[];
  readonly eventsByTurn: Map<string, EventRow[]>;
}

/**
 * A nested literal, flattened into the two arrays the server actually serves.
 *
 * The nesting wires `parent_event_id`: a `folded` child hangs off its parent
 * turn's last declared event and is stamped `kind: 'task_notification'`, which
 * is what `foldsUnderAgent` tests. `seq` walks one forward per event across the
 * WHOLE session, exactly as the projector numbers it, so bucket order and file
 * order agree and a test asserting on order is asserting on something real.
 */
export function makeTurnTree(specs: TurnTreeSpec[]): TurnTree {
  const turns: TurnRow[] = [];
  const eventsByTurn = new Map<string, EventRow[]>();
  let seq = 0;

  const walk = (nodes: TurnTreeSpec[], parentEventId: string | null): void => {
    for (const node of nodes) {
      const { events = [], folded = [], ...fields } = node;
      const rows = events.map((event, i) => {
        const at = seq;
        seq += 1;
        return makeEventRow({
          id: `${node.id}-ev-${i}`,
          turn_id: node.id,
          seq: at,
          ts: atSecond(at),
          ...event,
        });
      });
      turns.push(
        makeTurnRow({
          seq: turns.length,
          title: `turn ${node.id}`,
          first_seq: rows[0]?.seq ?? 0,
          last_seq: rows[rows.length - 1]?.seq ?? 0,
          ...(parentEventId === null
            ? {}
            : { kind: 'task_notification', parent_event_id: parentEventId }),
          ...fields,
        }),
      );
      eventsByTurn.set(node.id, rows);
      const anchor = rows[rows.length - 1];
      walk(folded, anchor?.id ?? null);
    }
  };

  walk(specs, null);
  return { turns, eventsByTurn };
}

/** How many events hang under each turn in {@link makeLargeTree} by default. */
const LARGE_EVENTS_PER_TURN = 500;

/** How many turns {@link makeLargeTree} builds by default. */
const LARGE_TURNS = 10;

/**
 * A session at real scale: 10 turns of 500 events, i.e. 5,000 events.
 *
 * Flat rather than folded on purpose: this fixture exists to measure the row
 * count and the model's complexity, and nesting would make the row count depend
 * on expansion state instead of on the viewport.
 */
export function makeLargeTree({
  turns = LARGE_TURNS,
  eventsPerTurn = LARGE_EVENTS_PER_TURN,
}: { turns?: number; eventsPerTurn?: number } = {}): TurnTree {
  return makeTurnTree(
    Array.from({ length: turns }, (_, t) => ({
      id: `seed-s0:${t}`,
      seq: t,
      title: `turn ${t}`,
      events: Array.from({ length: eventsPerTurn }, (_, e) => ({ name: `step ${e}` })),
    })),
  );
}

/**
 * A model and the row list it flattens to with everything opened.
 *
 * `model.rowIds` is every id that can be a row, so passing it as the expansion
 * set opens the whole tree — which is what a render assertion about a nested
 * row wants, and it saves each test hand-building an expansion set that would
 * then be the thing under test rather than the thing being assumed.
 */
export function expandedRows(
  tree: TurnTree,
  rootSessionId = 'seed-s0',
): { model: TreeModel; rows: Row[] } {
  const model = buildTurnGroups(tree.turns, tree.eventsByTurn);
  return { model, rows: flatten(model, model.rowIds, undefined, { rootSessionId }) };
}

/** {@link expandedRows} for the common one-turn page. */
export function rowsForEvents(events: Partial<EventRow>[], turn: Partial<TurnRow> = {}): Row[] {
  return expandedRows(makeTurnTree([{ id: 'seed-s0:1', seq: 1, ...turn, events }])).rows;
}
