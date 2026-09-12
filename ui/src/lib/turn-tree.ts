/*
 * The pure turn-tree model (Task 5.2): the two-level group-by that replaces
 * Task 5.3a's forest, and the single ordered `Row[]` that both keyboard
 * navigation and the virtualizer index.
 *
 * ===========================================================================
 * `Row[]` IS ONE INDEX SPACE, AND EVERYTHING DOWNSTREAM DEPENDS ON THAT.
 * ===========================================================================
 * Keyboard focus is an index into it, the virtualizer windows it, Task 6.3's
 * scroll-to-index addresses it and Task 6.2 appends to it. A second index
 * space — say, one row list per turn — is what makes `j` and the scrollbar
 * disagree, so there is exactly one and it carries turn rows and event rows
 * alike.
 *
 * ===========================================================================
 * THERE IS NO FOREST TO REBUILD. `events` CARRY THEIR `turn_id`.
 * ===========================================================================
 * Plan 001 stored a self-referential parent key on every span, and this module
 * had to re-parent orphans and cut cycles to survive it. The v2 projector folds
 * a `tool_use` and its `tool_result` into ONE event and stamps every event with
 * the turn that owns it, so tree construction is a group-by and those two walks
 * are deleted rather than ported. `seq` is a total order the server already
 * applies, so the `started_at`/`id` tiebreak went with them.
 *
 * ===========================================================================
 * THE ONE NESTING LEFT IS THE FOLD, AND IT CHAINS.
 * ===========================================================================
 * A `task_notification` turn naming a `parent_event_id` hangs UNDER that Agent
 * event instead of beside it — `foldsUnderAgent` in `session-list.ts` is the
 * predicate. Measured on the archive: on one session five turns fold into a
 * five-deep chain, on another the chain reaches six levels. So the levels
 * alternate — a turn owns events, an event owns folded turns, and so on — and
 * a SIBLING SET IS NEVER MIXED: an event's siblings are the other events of its
 * turn, a folded turn's siblings are the other turns folded under the same
 * event. That is what `setSize`/`posInSet` count.
 *
 * ===========================================================================
 * NO RECURSION OVER SERVER DATA.
 * ===========================================================================
 * Both walks below run off an explicit work list. Nesting depth is whatever the
 * harness happened to report, no schema bounds it, and a stack overflow inside
 * render is a blank screen.
 */

import type { EventRow, SessionDetailHeaderRow, TurnRow } from './api.js';
import { foldsUnderAgent } from './session-list.js';

/** Depth of a top-level turn's own row. Its events sit one below it. */
const TURN_DEPTH = 0;

/**
 * The seven values `events.kind` can hold (`src/db/schema.ts:184-185`), plus
 * the coalesce arm the wire needs.
 *
 * `ui/src/lib/api.ts` types the field as a plain `string`, because the wire
 * carries whatever the projector wrote. Narrowing is therefore mandatory rather
 * than defensive: `unknown` is a real kind the projector emits AND the answer
 * for anything it did not.
 */
export type EventKind =
  'prompt' | 'text' | 'thinking' | 'tool_call' | 'error' | 'compaction' | 'unknown';

export const EVENT_KINDS: readonly EventKind[] = [
  'prompt',
  'text',
  'thinking',
  'tool_call',
  'error',
  'compaction',
  'unknown',
];

/**
 * `events.status`, plus `unknown` for the 46.9% of rows that carry none.
 *
 * MEASURED: `status IS NULL` on 14,211 of 30,286 events — every `text`,
 * `thinking`, `prompt`, `compaction` and `unknown` row. Only `tool_call` carries
 * a status, on all 16,075 of them. A row the projector left unlabelled is
 * `unknown`, never a fabricated `ok`, and `design-system.md:141` gives `unknown`
 * its own faint dash glyph so it reads as "nobody knows".
 */
export type EventStatus = 'running' | 'ok' | 'error' | 'denied' | 'unknown';

export const EVENT_STATUSES: readonly EventStatus[] = [
  'running',
  'ok',
  'error',
  'denied',
  'unknown',
];

/**
 * Where a `duration_ms` came from. `none` is the absence, which is the second
 * commonest value on the wire and the reason this map is four arms wide.
 *
 * `reported` is total but unreachable: `src/db/schema.ts:195` still declares it
 * and `src/project/pipeline.ts:130` types the field without it, so it has zero
 * writers and zero rows. `turns.duration_source` is a DIFFERENT vocabulary
 * (`derived` | `turn_duration`) and never reaches here — a turn header reads its
 * stored rollup, not an event.
 */
export type EventDurationSource = 'elapsed' | 'sidecar_span' | 'reported' | 'none';

const EVENT_DURATION_SOURCES: readonly EventDurationSource[] = [
  'elapsed',
  'sidecar_span',
  'reported',
  'none',
];

/** The wire's `kind`, narrowed. Anything off the list reads as `unknown`. */
export function eventKindOf(kind: string | null): EventKind {
  return EVENT_KINDS.find((known) => known === kind) ?? 'unknown';
}

/** The wire's `status`, narrowed. Null and anything off the list are `unknown`. */
export function eventStatusOf(status: string | null): EventStatus {
  return EVENT_STATUSES.find((known) => known === status) ?? 'unknown';
}

/** The wire's `duration_source`, narrowed. Absence is `none`, never `elapsed`. */
export function durationSourceOf(source: string | null): EventDurationSource {
  return EVENT_DURATION_SOURCES.find((known) => known === source) ?? 'none';
}

/** One event, already narrowed, and the turns folded beneath it. */
export interface EventNode {
  readonly event: EventRow;
  readonly kind: EventKind;
  readonly status: EventStatus;
  /** Distance from the tree root: an event of a top-level turn is `1`. */
  readonly depth: number;
  readonly children: readonly TurnNode[];
}

/** One turn and its own events, in `seq` order. */
export interface TurnNode {
  readonly turn: TurnRow;
  /** `0` for a top-level turn; a folded turn sits at its Agent event plus one. */
  readonly depth: number;
  readonly events: readonly EventNode[];
}

export interface TreeModel {
  /** The turns at depth 0. Folded turns hang inside them, not here. */
  readonly groups: readonly TurnNode[];
  /**
   * Every id that can appear as a row — turns and events alike, whether or not
   * a collapse is currently keeping it off screen. This is what lets the
   * navigation reducer tell "selected but collapsed away" (keep it) from
   * "selected but no longer in the model" (drop it).
   */
  readonly rowIds: ReadonlySet<string>;
  /**
   * Events whose `turn_id` named no turn on this page. They are counted so the
   * notice strip can say so, never silently dropped.
   */
  readonly unmatchedEventCount: number;
}

/* -------------------------------------------------------------- build --- */

interface Ranked {
  readonly turn: TurnRow;
  readonly depth: number;
}

/**
 * The turn groups for one session's turns and the events belonging to them.
 *
 * `eventsByTurn` is keyed by `turn_id`; a key naming no turn in `turns` is
 * counted into {@link TreeModel.unmatchedEventCount}.
 */
export function buildTurnGroups(
  turns: readonly TurnRow[],
  eventsByTurn: ReadonlyMap<string, readonly EventRow[]>,
): TreeModel {
  const turnIds = new Set(turns.map((turn) => turn.id));

  // Sorted ONCE per turn, because the walks below read each bucket three times.
  // `src/db/read.ts:467` already orders by `seq`; this is a belt on that brace,
  // and `seq` is the only total order there is.
  const sorted = new Map<string, readonly EventRow[]>();
  const presentEventIds = new Set<string>();
  for (const turn of turns) {
    const own = [...(eventsByTurn.get(turn.id) ?? [])].sort((a, b) => a.seq - b.seq);
    sorted.set(turn.id, own);
    for (const event of own) presentEventIds.add(event.id);
  }
  const eventsOf = (turn: TurnRow): readonly EventRow[] => sorted.get(turn.id) ?? [];

  // Which turns hang under which event. A turn whose `parent_event_id` names an
  // event this page does not carry stays top-level rather than vanishing.
  const foldedUnder = new Map<string, TurnRow[]>();
  const parentOf = (turn: TurnRow): string | null => {
    const named = turn.parent_event_id;
    if (named === null || !foldsUnderAgent(turn) || !presentEventIds.has(named)) return null;
    return named;
  };
  for (const turn of turns) {
    const parentId = parentOf(turn);
    if (parentId === null) continue;
    const bucket = foldedUnder.get(parentId);
    if (bucket === undefined) foldedUnder.set(parentId, [turn]);
    else bucket.push(turn);
  }

  // Breadth first off an explicit work list, so the ranking is ordered by
  // non-decreasing depth and nothing recurses over server data.
  const ranked: Ranked[] = [];
  const placed = new Set<string>();
  let cursor = 0;

  const enqueue = (turn: TurnRow, depth: number): void => {
    if (placed.has(turn.id)) return;
    placed.add(turn.id);
    ranked.push({ turn, depth });
  };

  const drain = (): void => {
    for (; cursor < ranked.length; cursor += 1) {
      const entry = ranked[cursor];
      if (entry === undefined) continue;
      for (const event of eventsOf(entry.turn)) {
        for (const folded of foldedUnder.get(event.id) ?? []) enqueue(folded, entry.depth + 2);
      }
    }
  };

  for (const turn of turns) if (parentOf(turn) === null) enqueue(turn, TURN_DEPTH);
  drain();
  // `parent_event_id` is a foreign key with no acyclicity constraint, so two
  // turns can name events inside each other. The walk above cannot reach them;
  // rooting them here is what keeps the model total — nothing is dropped and
  // nothing loops.
  for (const turn of turns) {
    if (placed.has(turn.id)) continue;
    enqueue(turn, TURN_DEPTH);
    drain();
  }

  // Then deepest first, so every folded turn is already built when the event
  // that owns it is.
  const rowIds = new Set<string>();
  const built = new Map<string, TurnNode>();
  for (let i = ranked.length - 1; i >= 0; i -= 1) {
    const entry = ranked[i];
    if (entry === undefined) continue;
    rowIds.add(entry.turn.id);
    const events: EventNode[] = eventsOf(entry.turn).map((event) => {
      rowIds.add(event.id);
      const children: TurnNode[] = [];
      for (const folded of foldedUnder.get(event.id) ?? []) {
        const node = built.get(folded.id);
        if (node !== undefined) children.push(node);
      }
      return {
        event,
        kind: eventKindOf(event.kind),
        status: eventStatusOf(event.status),
        depth: entry.depth + 1,
        children,
      };
    });
    built.set(entry.turn.id, { turn: entry.turn, depth: entry.depth, events });
  }

  const groups: TurnNode[] = [];
  for (const entry of ranked) {
    if (entry.depth !== TURN_DEPTH) continue;
    const node = built.get(entry.turn.id);
    if (node !== undefined) groups.push(node);
  }

  let unmatchedEventCount = 0;
  for (const [turnId, events] of eventsByTurn) {
    if (!turnIds.has(turnId)) unmatchedEventCount += events.length;
  }

  return { groups, rowIds, unmatchedEventCount };
}

/* ------------------------------------------------------------ flatten --- */

interface RowShape {
  /** The turn id or the event id — unique across the whole row list. */
  readonly id: string;
  /** `0` for a top-level turn, `1` for its events, and so on. */
  readonly depth: number;
  /**
   * Which session's transcript this row came from.
   *
   * Required on EVERY row, turn and event alike. `flatten` is one flat stack:
   * once a spliced child's root turn has been popped, nothing else tells its
   * events apart from the parent session's, so an id carried only on the root
   * would leave every nested event row unattributed.
   */
  readonly sessionId: string;
  /** The turn this row belongs to, so an event row can read its turn cheaply. */
  readonly turn: TurnRow;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /**
   * The sub-agent's own header, on a spliced child's ROOT turn rows and nowhere
   * else. `SpanTree` forwards the row and nothing else, and a `TurnRow` carries
   * neither `agent_description` nor the child's rollup — so this is the only
   * route those two numbers have to the screen.
   */
  readonly subagent?: { readonly header: SessionDetailHeaderRow };
  /**
   * Sibling count within this row's own parent, and this row's 1-based place
   * in it — NOT relative to the window. `aria-setsize` and `aria-posinset` read
   * them, and with roughly 34 of 5,000 rows in the document at any moment, a
   * window-relative number would have the tree announce "1 of 34" for a whole
   * session. A collapse takes a subtree away as a unit, so no sibling's place
   * ever shifts.
   */
  readonly setSize: number;
  readonly posInSet: number;
}

export interface TurnRowModel extends RowShape {
  readonly kind: 'turn';
  readonly node: TurnNode;
}

export interface EventRowModel extends RowShape {
  readonly kind: 'event';
  readonly node: EventNode;
}

export type Row = TurnRowModel | EventRowModel;

/**
 * Task 7.2's seam: a row answering `false` is left out, and so is everything
 * beneath it. Leaving a child in while dropping its parent would emit a row
 * whose `aria-level` names an ancestor that is not there.
 */
export type RowPredicate = (row: Row) => boolean;

/**
 * One loaded sub-agent session, ready to splice under the Agent event that
 * spawned it. `subagent.ts` builds these; this module only reads them.
 */
export interface Subtree {
  /** The sidecar's own session id — what its spliced rows are stamped with. */
  readonly sessionId: string;
  readonly model: TreeModel;
  readonly header: SessionDetailHeaderRow;
}

/**
 * The walk's fourth argument: whose transcript this is, and which sidecars have
 * been loaded, keyed by `events.child_session_id`.
 *
 * A single object rather than two positional parameters, because `keepRow` is
 * already optional and third — a required id after an optional argument is a
 * call-order trap.
 */
export interface FlattenOptions {
  readonly rootSessionId: string;
  readonly subtrees?: ReadonlyMap<string, Subtree>;
}

/**
 * What a row inherits from the entry that pushed it, rather than from its node.
 *
 * `depthOffset` is what makes a spliced subtree sit at the right indent:
 * `buildTurnGroups` numbered its depths against the sidecar's OWN model, so
 * every one of them needs the same shift added. It rides down through both
 * pushes and survives any number of turn/event alternations, which is what
 * makes a depth-2 sub-agent take the identical path.
 */
interface Inherited {
  readonly depthOffset: number;
  readonly sessionId: string;
}

interface TurnEntry extends Inherited {
  readonly node: TurnNode;
  /** Set only on a spliced child's root turns. Nothing else is a sub-agent. */
  readonly subagent?: { readonly header: SessionDetailHeaderRow };
}

interface EventEntry extends Inherited {
  readonly node: EventNode;
}

/**
 * One item on the walk's stack, with the sibling place its row will announce.
 *
 * Two shapes rather than one, because the levels alternate: a turn's siblings
 * are turns and an event's siblings are events, so no set ever mixes the two.
 */
type Pending =
  | (TurnEntry & {
      readonly on: 'turn';
      readonly setSize: number;
      readonly posInSet: number;
    })
  | (EventEntry & {
      readonly on: 'event';
      readonly turn: TurnRow;
      readonly setSize: number;
      readonly posInSet: number;
    });

/**
 * ★ ONE CALL PER SIBLING SET, EVEN WHEN THE SET HAS TWO SOURCES.
 *
 * An Agent event can own folded `task_notification` turns AND a spliced sidecar
 * at the same time — MEASURED, all 20 folded turns in the corpus hang under
 * events that also name a `child_session_id`, so this is the ordinary case. Two
 * calls would make each half announce itself as a complete set and a screen
 * reader would say "1 of 1" twice. So the caller combines them into one array,
 * `setSize` comes from its length, and each entry keeps its own offset.
 */
function pushTurns(pending: Pending[], siblings: readonly TurnEntry[]): void {
  // Reversed, because this is a stack and pre-order wants the first sibling
  // popped first.
  for (let i = siblings.length - 1; i >= 0; i -= 1) {
    const entry = siblings[i];
    if (entry !== undefined) {
      pending.push({ ...entry, on: 'turn', setSize: siblings.length, posInSet: i + 1 });
    }
  }
}

function pushEvents(pending: Pending[], turn: TurnRow, siblings: readonly EventEntry[]): void {
  for (let i = siblings.length - 1; i >= 0; i -= 1) {
    const entry = siblings[i];
    if (entry !== undefined) {
      pending.push({ ...entry, on: 'event', turn, setSize: siblings.length, posInSet: i + 1 });
    }
  }
}

/**
 * The ordered row list for the current expansion state.
 *
 * A turn or event whose id is absent from `expandedIds` contributes its own row
 * and nothing beneath it, so a closed turn and the matching expansion round-trip
 * to exactly the same rows in exactly the same order.
 *
 * `options.subtrees` splices a loaded sub-agent's turns and events in place,
 * beneath the Agent event that names it. There is ONE row list either way: a
 * second one, per sidecar, is what would make the keyboard and the scrollbar
 * disagree.
 *
 * `options` is optional so the fixtures that build a bare model stay call sites
 * rather than rewrites; an omitted one stamps every row with `''`, which is the
 * honest reading of "this caller never said whose session it is". The one
 * production caller always says.
 */
export function flatten(
  model: TreeModel,
  expandedIds: ReadonlySet<string>,
  keepRow?: RowPredicate,
  options?: FlattenOptions,
): Row[] {
  const rootSessionId = options?.rootSessionId ?? '';
  const subtrees = options?.subtrees;
  const rows: Row[] = [];
  const pending: Pending[] = [];
  pushTurns(
    pending,
    model.groups.map((node) => ({ node, depthOffset: 0, sessionId: rootSessionId })),
  );

  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;

    if (entry.on === 'turn') {
      const { node } = entry;
      const row: TurnRowModel = {
        kind: 'turn',
        id: node.turn.id,
        depth: node.depth + entry.depthOffset,
        sessionId: entry.sessionId,
        turn: node.turn,
        node,
        hasChildren: node.events.length > 0,
        expanded: expandedIds.has(node.turn.id),
        setSize: entry.setSize,
        posInSet: entry.posInSet,
        ...(entry.subagent === undefined ? {} : { subagent: entry.subagent }),
      };
      if (keepRow !== undefined && !keepRow(row)) continue;
      rows.push(row);
      if (row.expanded) {
        pushEvents(
          pending,
          node.turn,
          node.events.map((child) => ({
            node: child,
            depthOffset: entry.depthOffset,
            sessionId: entry.sessionId,
          })),
        );
      }
      continue;
    }

    const { node } = entry;
    const childSessionId = node.event.child_session_id;
    const subtree = childSessionId === null ? undefined : subtrees?.get(childSessionId);
    const row: EventRowModel = {
      kind: 'event',
      id: node.event.id,
      depth: node.depth + entry.depthOffset,
      sessionId: entry.sessionId,
      turn: entry.turn,
      node,
      // An Agent event has something to show before its sidecar is fetched, and
      // without the second clause its chevron never draws — so the row the whole
      // feature turns on would not be clickable at all.
      hasChildren: node.children.length > 0 || childSessionId !== null,
      expanded: expandedIds.has(node.event.id),
      setSize: entry.setSize,
      posInSet: entry.posInSet,
    };
    if (keepRow !== undefined && !keepRow(row)) continue;
    rows.push(row);
    if (row.expanded) {
      pushTurns(pending, [
        // The folded turns take THIS entry's offset, never 0: `buildTurnGroups`
        // numbered them against their own model, and when that model is itself
        // a spliced sidecar the shift still applies.
        ...node.children.map((child) => ({
          node: child,
          depthOffset: entry.depthOffset,
          sessionId: entry.sessionId,
        })),
        ...(subtree === undefined
          ? []
          : subtree.model.groups.map((child) => ({
              node: child,
              // The sidecar's root turns are at depth 0 in their own model, and
              // they belong one level under the Agent row.
              depthOffset: row.depth + 1,
              sessionId: subtree.sessionId,
              subagent: { header: subtree.header },
            }))),
      ]);
    }
  }

  return rows;
}

/* -------------------------------------------------------------- chips --- */

/** The four numbers a chip row shows. `undefined` duration means unknown. */
export interface ChipValues {
  readonly durationMs: number | undefined;
  readonly tokens: number;
  readonly cost: number;
  readonly errorCount: number;
}

/**
 * A turn's chips are READ off the server's own rollup — never recomputed.
 *
 * The argument is the turn ROW rather than its node, so the rule is structural:
 * this function cannot see the events beneath it even if a later edit wanted to
 * sum them. The server rolls up event to turn to session in one transaction;
 * recomputing from the events that happen to be on this page would disagree with
 * it the moment the page is capped, and the number the user sees would then
 * depend on how far they had scrolled.
 *
 * Three coalesces, none of them cosmetic: `TurnRow` carries no `total_tokens`,
 * and `est_cost` and `duration_ms` are both nullable on the wire.
 */
export function turnChips(turn: TurnRow): ChipValues {
  return {
    durationMs: turn.duration_ms ?? undefined,
    tokens: turn.tokens_in + turn.tokens_out,
    cost: turn.est_cost ?? 0,
    errorCount: turn.error_count,
  };
}

/** The text between `<tag>` and `</tag>`, or null when either bracket is absent. */
function tagContent(title: string, tag: string): string | null {
  const open = `<${tag}>`;
  const start = title.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = title.indexOf(`</${tag}>`, from);
  return end === -1 ? null : title.slice(from, end);
}

/**
 * What a turn's header row reads as. A `slash_command` title stores the raw
 * envelope the projector kept (`src/project/pipeline.ts` caps it at 200 chars),
 * so the command name is extracted, with the command message as fallback.
 * Anything unrecognised falls through verbatim — shown as raw markup, never
 * blank — and every other kind passes through untouched.
 */
export function turnTitle(turn: Pick<TurnRow, 'kind' | 'title'>): string {
  if (turn.kind !== 'slash_command') return turn.title;
  for (const tag of ['command-name', 'command-message']) {
    const content = tagContent(turn.title, tag)?.trim();
    if (content !== undefined && content !== '') return content;
  }
  return turn.title;
}

/**
 * One event's own numbers. There is no subtree to roll up: the fold already
 * collapsed a tool call and its result into this single row.
 *
 * ★ `durationMs` COALESCES TO `undefined`, NEVER TO `0`. MEASURED:
 * `duration_ms IS NULL` on 14,211 of 30,286 events — every `text`, `thinking`,
 * `unknown`, `prompt` and `compaction` row, and none of the 16,075 `tool_call`
 * rows. `formatDurationMs` already spells an absent value as an em dash, and a
 * `0ms` on a row nobody measured is the precise-looking lie this screen exists
 * to refuse.
 */
export function eventChips(event: EventRow): ChipValues {
  const status = eventStatusOf(event.status);
  return {
    durationMs: event.duration_ms ?? undefined,
    tokens: (event.tokens_in ?? 0) + (event.tokens_out ?? 0),
    cost: event.est_cost ?? 0,
    errorCount: status === 'error' || status === 'denied' ? 1 : 0,
  };
}
