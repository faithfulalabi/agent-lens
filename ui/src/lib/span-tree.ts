/*
 * The pure span-tree model (Task 5.3a): a forest built from the flat page the
 * read API serves, and the single ordered `Row[]` that both keyboard
 * navigation and Task 5.3b's virtualizer index.
 *
 * ===========================================================================
 * `Row[]` IS ONE INDEX SPACE, AND EVERYTHING DOWNSTREAM DEPENDS ON THAT.
 * ===========================================================================
 * Keyboard focus is an index into it, the virtualizer windows it, Task 6.3's
 * scroll-to-index addresses it and Task 6.2 appends to it. A second index
 * space — say, one row list per turn — is what makes `j` and the scrollbar
 * disagree, so there is exactly one and it carries trace rows and span rows
 * alike.
 *
 * Three properties this module owes its callers, none of which the server
 * guarantees:
 *
 *   - **Deterministic sibling order.** `readSessionSpans` orders `started_at
 *     ASC` with no tiebreaker (`db/reads.ts`), and millisecond ties are real,
 *     so ordering is re-done here with `id` as the tiebreak.
 *   - **Totality against real data.** A `parent_span_id` naming a span that is
 *     not on the page re-parents to the turn; a cycle is cut rather than
 *     followed; a span belonging to no turn on the page is counted rather than
 *     dropped. Nothing throws and nothing loops.
 *   - **No recursion over server data.** Both walks below run off an explicit
 *     work list. Nesting depth is whatever the harness happened to report, no
 *     schema bounds it, and a stack overflow inside render is a blank screen.
 */

import type { Span, Trace } from '@shared/entities.ts';

/** Depth of a turn's own row. Its direct span children sit one below it. */
const TRACE_DEPTH = 0;

/** Bottom-up totals over one span and every descendant beneath it. */
export interface SubtreeRollup {
  /** `tokens_in + tokens_out`, summed — the server's own `total_tokens` rule. */
  readonly tokens: number;
  /** `est_cost`, summed. Absent costs contribute nothing rather than `NaN`. */
  readonly cost: number;
  /** Spans whose status is `error` or `denied`, matching the server's count. */
  readonly errorCount: number;
  /** Earliest parseable `started_at` in the subtree, in epoch milliseconds. */
  readonly startedAtMs: number | undefined;
  /** Latest parseable `ended_at` in the subtree. Absent when none has ended. */
  readonly endedAtMs: number | undefined;
  /** True while any span in the subtree is still open. */
  readonly open: boolean;
}

/** One span, its ordered children, and the totals for everything below it. */
export interface SpanNode {
  readonly span: Span;
  /** Distance from the turn's row: a direct child of the turn is `1`. */
  readonly depth: number;
  readonly children: readonly SpanNode[];
  readonly rollup: SubtreeRollup;
}

/** One turn and the span forest beneath it. */
export interface TraceNode {
  readonly trace: Trace;
  readonly children: readonly SpanNode[];
}

export interface TreeModel {
  readonly traces: readonly TraceNode[];
  /**
   * Every id that can appear as a row — turns and spans alike, whether or not
   * a collapse is currently keeping it off screen. This is what lets the
   * navigation reducer tell "selected but collapsed away" (keep it) from
   * "selected but no longer in the model" (drop it).
   */
  readonly rowIds: ReadonlySet<string>;
  /**
   * Spans whose `trace_id` named no turn on this page.
   *
   * Ordinary pagination produces them: `SessionDetail.traces` is a capped
   * page while the span query filters on `session_id` alone, so span 101's
   * turn can simply not be here. They are counted so Task 5.3b can say so,
   * never silently dropped.
   */
  readonly unmatchedSpanCount: number;
}

/* -------------------------------------------------------------- build --- */

/** Epoch milliseconds, or `undefined` for anything `Date.parse` cannot read. */
function parsedOrUndefined(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function timeOf(iso: string): number {
  // An unreadable stamp sorts last, and does so consistently, so the order
  // stays total. Returning NaN here would make every comparison false and the
  // resulting order implementation-defined.
  return parsedOrUndefined(iso) ?? Number.POSITIVE_INFINITY;
}

/** `started_at`, then `id`. The `id` half is the whole point: ties are real. */
function compareSpans(a: Span, b: Span): number {
  const at = timeOf(a.started_at);
  const bt = timeOf(b.started_at);
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Each span's effective parent, with `undefined` meaning "child of the turn".
 *
 * Two rewrites happen here. A `parent_span_id` that names nothing on this page
 * (or names the span itself) becomes `undefined` — the span attaches to the
 * turn rather than vanishing. And any cycle gets one edge cut, at the node the
 * walk re-enters, so both spans survive exactly once and the walk terminates.
 */
function resolveParents(spans: readonly Span[]): Map<string, string | undefined> {
  const present = new Set(spans.map((span) => span.id));
  const parentOf = new Map<string, string | undefined>();
  for (const span of spans) {
    const named = span.parent_span_id;
    const usable = named !== undefined && named !== span.id && present.has(named);
    parentOf.set(span.id, usable ? named : undefined);
  }

  // `walking` marks the path currently being followed; re-entering it is the
  // cycle. `settled` marks a node already known to reach a root.
  const walking = new Set<string>();
  const settled = new Set<string>();
  for (const span of spans) {
    if (settled.has(span.id)) continue;
    walking.clear();
    let cursor: string | undefined = span.id;
    while (cursor !== undefined && !settled.has(cursor) && !walking.has(cursor)) {
      walking.add(cursor);
      cursor = parentOf.get(cursor);
    }
    if (cursor !== undefined && walking.has(cursor)) parentOf.set(cursor, undefined);
    for (const id of walking) settled.add(id);
  }
  return parentOf;
}

interface Ranked {
  readonly span: Span;
  readonly depth: number;
}

/** The span forest for one turn, ordered, depth-assigned and rolled up. */
function buildForest(spans: readonly Span[]): SpanNode[] {
  const parentOf = resolveParents(spans);

  const roots: Span[] = [];
  const childrenOf = new Map<string, Span[]>();
  for (const span of spans) {
    const parent = parentOf.get(span.id);
    if (parent === undefined) {
      roots.push(span);
      continue;
    }
    const bucket = childrenOf.get(parent);
    if (bucket === undefined) childrenOf.set(parent, [span]);
    else bucket.push(span);
  }
  roots.sort(compareSpans);
  for (const bucket of childrenOf.values()) bucket.sort(compareSpans);

  // Breadth first, so the list is ordered by non-decreasing depth.
  const ranked: Ranked[] = roots.map((span) => ({ span, depth: TRACE_DEPTH + 1 }));
  for (let i = 0; i < ranked.length; i += 1) {
    const entry = ranked[i];
    if (entry === undefined) continue;
    for (const child of childrenOf.get(entry.span.id) ?? []) {
      ranked.push({ span: child, depth: entry.depth + 1 });
    }
  }

  // Then deepest first, so every child is already built when its parent is.
  const built = new Map<string, SpanNode>();
  for (let i = ranked.length - 1; i >= 0; i -= 1) {
    const entry = ranked[i];
    if (entry === undefined) continue;
    const children: SpanNode[] = [];
    for (const child of childrenOf.get(entry.span.id) ?? []) {
      const node = built.get(child.id);
      if (node !== undefined) children.push(node);
    }
    built.set(entry.span.id, {
      span: entry.span,
      depth: entry.depth,
      children,
      rollup: rollupOf(entry.span, children),
    });
  }

  const forest: SpanNode[] = [];
  for (const root of roots) {
    const node = built.get(root.id);
    if (node !== undefined) forest.push(node);
  }
  return forest;
}

function rollupOf(span: Span, children: readonly SpanNode[]): SubtreeRollup {
  let tokens = (span.tokens_in ?? 0) + (span.tokens_out ?? 0);
  let cost = span.est_cost ?? 0;
  let errorCount = span.status === 'error' || span.status === 'denied' ? 1 : 0;
  let startedAtMs = parsedOrUndefined(span.started_at);
  let endedAtMs = parsedOrUndefined(span.ended_at);
  let open = endedAtMs === undefined;

  for (const child of children) {
    const below = child.rollup;
    tokens += below.tokens;
    cost += below.cost;
    errorCount += below.errorCount;
    if (below.startedAtMs !== undefined) {
      startedAtMs =
        startedAtMs === undefined ? below.startedAtMs : Math.min(startedAtMs, below.startedAtMs);
    }
    if (below.endedAtMs !== undefined) {
      endedAtMs = endedAtMs === undefined ? below.endedAtMs : Math.max(endedAtMs, below.endedAtMs);
    }
    open = open || below.open;
  }

  return { tokens, cost, errorCount, startedAtMs, endedAtMs, open };
}

/**
 * The forest for a page of turns and the spans belonging to them.
 *
 * `spansByTrace` is keyed by `trace_id`; a key naming no turn in `traces` is
 * counted into {@link TreeModel.unmatchedSpanCount}.
 */
export function buildTreeModel(
  traces: readonly Trace[],
  spansByTrace: ReadonlyMap<string, readonly Span[]>,
): TreeModel {
  const rowIds = new Set<string>();
  const traceIds = new Set<string>();
  const traceNodes: TraceNode[] = [];
  for (const trace of traces) {
    rowIds.add(trace.id);
    traceIds.add(trace.id);
    const own = spansByTrace.get(trace.id) ?? [];
    for (const span of own) rowIds.add(span.id);
    traceNodes.push({ trace, children: buildForest(own) });
  }

  let unmatchedSpanCount = 0;
  for (const [traceId, spans] of spansByTrace) {
    if (!traceIds.has(traceId)) unmatchedSpanCount += spans.length;
  }

  return { traces: traceNodes, rowIds, unmatchedSpanCount };
}

/* ------------------------------------------------------------ flatten --- */

interface RowShape {
  /** The turn id or the span id — unique across the whole row list. */
  readonly id: string;
  /** `0` for a turn, `1` for its direct span children, and so on. */
  readonly depth: number;
  /** The turn this row belongs to, so a span row can read its turn cheaply. */
  readonly trace: Trace;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /**
   * Sibling count within this row's own parent, and this row's 1-based place
   * in it — NOT relative to the window. Task 5.3b feeds them to `aria-setsize`
   * and `aria-posinset`, and with roughly 34 of 5,000 rows in the document at
   * any moment, a window-relative number would have the tree announce "1 of
   * 34" for a whole session. A collapse takes a subtree away as a unit, so no
   * sibling's place ever shifts.
   */
  readonly setSize: number;
  readonly posInSet: number;
}

export interface TraceRow extends RowShape {
  readonly kind: 'trace';
}

export interface SpanRow extends RowShape {
  readonly kind: 'span';
  readonly node: SpanNode;
}

export type Row = TraceRow | SpanRow;

/**
 * Task 7.2's seam: a row answering `false` is left out, and so is everything
 * beneath it. Leaving a child in while dropping its parent would emit a row
 * whose `aria-level` names an ancestor that is not there.
 */
export type RowPredicate = (row: Row) => boolean;

interface Sibling {
  readonly node: SpanNode;
  readonly setSize: number;
  readonly posInSet: number;
}

function pushSiblings(pending: Sibling[], siblings: readonly SpanNode[]): void {
  // Reversed, because this is a stack and pre-order wants the first sibling
  // popped first.
  for (let i = siblings.length - 1; i >= 0; i -= 1) {
    const node = siblings[i];
    if (node !== undefined) pending.push({ node, setSize: siblings.length, posInSet: i + 1 });
  }
}

/**
 * The ordered row list for the current expansion state.
 *
 * A turn or span whose id is absent from `expandedIds` contributes its own row
 * and nothing beneath it, so a collapse and the matching expansion round-trip
 * to exactly the same rows in exactly the same order.
 */
export function flatten(
  model: TreeModel,
  expandedIds: ReadonlySet<string>,
  keepRow?: RowPredicate,
): Row[] {
  const rows: Row[] = [];
  const turnCount = model.traces.length;

  for (const [index, traceNode] of model.traces.entries()) {
    const traceRow: TraceRow = {
      kind: 'trace',
      id: traceNode.trace.id,
      depth: TRACE_DEPTH,
      trace: traceNode.trace,
      hasChildren: traceNode.children.length > 0,
      expanded: expandedIds.has(traceNode.trace.id),
      setSize: turnCount,
      posInSet: index + 1,
    };
    if (keepRow !== undefined && !keepRow(traceRow)) continue;
    rows.push(traceRow);
    if (!traceRow.expanded) continue;

    const pending: Sibling[] = [];
    pushSiblings(pending, traceNode.children);
    while (pending.length > 0) {
      const entry = pending.pop();
      if (entry === undefined) break;
      const spanRow: SpanRow = {
        kind: 'span',
        id: entry.node.span.id,
        depth: entry.node.depth,
        trace: traceNode.trace,
        node: entry.node,
        hasChildren: entry.node.children.length > 0,
        expanded: expandedIds.has(entry.node.span.id),
        setSize: entry.setSize,
        posInSet: entry.posInSet,
      };
      if (keepRow !== undefined && !keepRow(spanRow)) continue;
      rows.push(spanRow);
      if (spanRow.expanded) pushSiblings(pending, entry.node.children);
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
 * How long a subtree took, as wall clock and never as a sum.
 *
 * `max(descendant ended_at) − min(descendant started_at)`, floored at zero.
 * Summing descendant durations is wrong twice over: a parent's own elapsed
 * time already contains its children's, so every nesting level double-counts,
 * and two tool calls running side by side sum to more time than actually
 * passed.
 *
 * A subtree still running does NOT read as unknown. It closes at `now` when
 * the caller passes a clock, and otherwise at the latest descendant that HAS
 * ended — exactly what `recomputeTraceRollup` does with `COALESCE(ended_at,
 * (SELECT MAX(ended_at) …))`, where SQLite's `MAX` skips nulls so a live turn
 * closes at its latest closed span. `undefined` comes back only when nothing
 * in the subtree has ended and no clock was offered; anything else would put
 * an em dash on the whole ancestor chain above a running span while the turn
 * header directly overhead showed a real, advancing duration.
 *
 * The floor is the server's rule too: an out-of-order `Stop` (which Task 2.3
 * deliberately tolerates) can put an end before its own start, and a negative
 * duration is a nonsense no screen should render.
 */
export function subtreeDuration(node: SpanNode, now?: number | Date): number | undefined {
  const { startedAtMs, endedAtMs, open } = node.rollup;
  if (startedAtMs === undefined) return undefined;
  const closedAt =
    open && now !== undefined ? (typeof now === 'number' ? now : now.getTime()) : endedAtMs;
  if (closedAt === undefined) return undefined;
  return Math.max(closedAt - startedAtMs, 0);
}

/**
 * A turn's chips are READ off the server's own rollup — never recomputed.
 *
 * The node's children are right here and are deliberately ignored. The server
 * rolls up span → trace → session in one transaction; recomputing from the
 * spans that happen to be on this page would disagree with it the moment the
 * page is capped, and the number the user sees would then depend on how far
 * they had scrolled.
 */
export function traceChips(node: TraceNode): ChipValues {
  return {
    durationMs: node.trace.duration_ms,
    tokens: node.trace.total_tokens,
    cost: node.trace.est_cost,
    errorCount: node.trace.error_count,
  };
}

/**
 * A sub-agent group's chips ARE computed, bottom up, because nothing else
 * computes them: the server's rollups stop at the turn, so a subtree inside
 * one has no stored total to read.
 */
export function subtreeChips(node: SpanNode, now?: number | Date): ChipValues {
  return {
    durationMs: subtreeDuration(node, now),
    tokens: node.rollup.tokens,
    cost: node.rollup.cost,
    errorCount: node.rollup.errorCount,
  };
}
