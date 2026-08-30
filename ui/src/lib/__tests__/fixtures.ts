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

import type { Page } from '@shared/api.ts';

import type {
  ApiClient,
  EventContentBody,
  EventRow,
  SessionDetailBody,
  SessionListRow,
  TurnRow,
} from '../api.js';
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
    raw_type: 'assistant',
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
 * The list route answers with an empty page; the two routes that need an id
 * reject by name, because a caller reaching one it did not stub is a test bug
 * worth a loud message rather than an empty object.
 */
export function stubApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const unstubbed = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`stubApiClient: ${method} was called but never stubbed`));

  return {
    listSessions: () => Promise.resolve(makePage<SessionListRow>([])),
    getSession: unstubbed('getSession'),
    getEventContent: unstubbed('getEventContent'),
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
export function expandedRows(tree: TurnTree): { model: TreeModel; rows: Row[] } {
  const model = buildTurnGroups(tree.turns, tree.eventsByTurn);
  return { model, rows: flatten(model, model.rowIds) };
}

/** {@link expandedRows} for the common one-turn page. */
export function rowsForEvents(events: Partial<EventRow>[], turn: Partial<TurnRow> = {}): Row[] {
  return expandedRows(makeTurnTree([{ id: 'seed-s0:1', seq: 1, ...turn, events }])).rows;
}
