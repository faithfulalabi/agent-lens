import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatCost, formatTokens } from '@/lib/format';
import { turnChips, type TurnRowModel } from '@/lib/turn-tree';

import { MetricChip } from './MetricChip';
import { INDENT_PX, RowChips } from './SpanRow';
import { SPAN_VISUALS } from './span-visuals';

/*
 * A turn's header row (Task 5.3b, repointed onto the wire by Task 5.2), props-in.
 *
 * ===========================================================================
 * THIS IS A ROW IN THE SAME LIST, NOT A SECTION AROUND ONE.
 * ===========================================================================
 * `Row = TurnRowModel | EventRowModel` puts turn headers INSIDE the row list, so
 * there is one flattened list and one virtualizer over it. Rendering this
 * component as a sibling of `SpanTree` — one header above each turn's own tree —
 * would draw every header twice and give the keyboard a second index space to
 * disagree with the scrollbar about. `SpanTree` switches on `row.kind` and
 * renders this for `'turn'`, and that is the only place it is used.
 *
 * It is a `treeitem` for the same reason: it is one of the rows the arrow keys
 * move through, and a section heading would be a lie about what focus can land
 * on.
 *
 * ===========================================================================
 * A TURN HEADER IS NO LONGER ALWAYS AT DEPTH 0.
 * ===========================================================================
 * A `task_notification` turn folds under the Agent event that spawned it, and
 * the fold CHAINS — measured six levels deep on one archived session. So this
 * row carries the same inline indent every event row does, for the same reason:
 * a class name assembled from a depth is invisible to Tailwind's scanner.
 *
 * ===========================================================================
 * THE CHIPS ARE READ OFF THE TURN, NEVER SUMMED FROM ITS EVENTS.
 * ===========================================================================
 * The server rolls up event to turn to session in one transaction. Recomputing
 * from the events that happen to be on this page would disagree with it the
 * moment the page is capped, and the number on screen would then depend on how
 * far the reader had scrolled. `turnChips` is where that rule lives, and it
 * takes the turn rather than its node so it cannot see the events at all.
 *
 * ===========================================================================
 * `data-slot="trace-trigger"` NOW CARRIES A `turns.kind`.
 * ===========================================================================
 * The badge's job is unchanged — "this turn is not you" — but its vocabulary
 * moved: `TraceTrigger` died with `Trace`, and `turns.kind` is a six-arm union
 * whose ordinary case is `human` rather than `user_prompt`. The slot NAME is
 * kept because four UI suites and the render gate pin these strings, so a
 * rename would red them before it changed anything a reader can see.
 *
 * ===========================================================================
 * THE SUB-AGENT'S COST DOES NOT GO THROUGH `RowChips`.
 * ===========================================================================
 * `RowChips` omits its cost chip outright when the number is not above zero —
 * deliberately, and pinned by a test — so an unpriced sub-agent would show
 * nothing rather than the em dash the data-model rule requires. That matters
 * more here than anywhere: 262 of 272 sidecars carry a null `est_cost`, because
 * 283 of 293 sessions run a model absent from the pricing table. So the two
 * sub-agent numbers go straight to `MetricChip` with the cost always supplied,
 * which is the shape `SessionHeader` already uses to render its own dash.
 */

export interface TraceGroupProps {
  row: TurnRowModel;
  selected: boolean;
  focused: boolean;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
}

export function TraceGroup({ row, selected, focused, onSelect, onToggle }: TraceGroupProps) {
  const { turn } = row;
  const { Icon, tint, label } = SPAN_VISUALS.trace;
  const Glyph = row.expanded ? ChevronDown : ChevronRight;

  return (
    <div
      role="treeitem"
      data-slot="trace-group"
      data-turn-kind={turn.kind}
      // See `SpanRow`: the client chose which session to ask for, so it can name
      // the one this row's data came from.
      data-session-id={row.sessionId}
      // The 1-based ARIA level is the row's depth plus one — the same formula
      // every event row uses, and a folded turn's depth is not zero.
      aria-level={row.depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-selected={selected}
      {...(row.hasChildren ? { 'aria-expanded': row.expanded } : {})}
      aria-label={`${label} ${turn.seq}: ${turn.title}`}
      tabIndex={focused ? 0 : -1}
      onClick={() => onSelect?.(row.id)}
      className={cn(
        'flex h-9 items-center gap-2 border-l-2 border-b border-b-border bg-surface pr-2 text-xs text-foreground',
        selected ? 'border-l-accent bg-accent-muted' : 'border-l-background',
      )}
      style={{ paddingLeft: row.depth * INDENT_PX }}
    >
      <button
        type="button"
        data-slot="trace-expand"
        // Out of the tab sequence, for the reason spelled out on the event row's
        // toggle: a focusable child survives its row's `tabIndex={-1}`, and one
        // extra tab stop per turn header would break the tree's roving-tabindex
        // contract outright.
        tabIndex={-1}
        aria-label={row.expanded ? `collapse turn ${turn.seq}` : `expand turn ${turn.seq}`}
        onClick={(event) => {
          event.stopPropagation();
          onToggle?.(row.id);
        }}
        className="shrink-0 pl-1 text-faint"
      >
        <Glyph size={14} aria-hidden="true" />
      </button>

      <span data-slot="trace-icon" className={cn('shrink-0', tint)}>
        <Icon size={12} aria-hidden="true" />
      </span>

      <span data-slot="trace-preview" className="min-w-0 flex-1 truncate font-medium">
        {turn.title}
      </span>

      {/*
       * A spliced sidecar's ROOT turn, and only that row, carries the child's
       * own header. What it says is the half of the sub-agent's identity that
       * cannot exist before the fetch: what it was asked to do, and what the
       * whole sidecar cost. The Agent row above it already said whose agent it
       * was and how it ended.
       */}
      {row.subagent === undefined ? null : (
        <span data-slot="trace-subagent" className="flex min-w-0 items-center gap-2">
          <span
            data-slot="trace-agent-description"
            className="min-w-0 truncate font-mono text-2xs text-muted"
          >
            {row.subagent.header.agent_description ?? ''}
          </span>
          <MetricChip
            className="shrink-0"
            tokens={`${formatTokens(row.subagent.header.tokens_in + row.subagent.header.tokens_out)} tok`}
            cost={formatCost(row.subagent.header.est_cost)}
          />
        </span>
      )}

      {/*
       * A turn whose kind is not `human` was started by the system — a task
       * notification, a slash command, a compaction, or something the projector
       * never named. That is informational rather than degraded, so it takes the
       * neutral chip atom and not the warning tone. A `human` turn carries no
       * badge, because a badge on every turn says nothing about any of them.
       */}
      {turn.kind === 'human' ? null : (
        <span
          data-slot="trace-trigger"
          title={`started by ${turn.kind}`}
          aria-label={`started by ${turn.kind}`}
          className={SPAN_VISUALS.triggerBadge}
        >
          {turn.kind}
        </span>
      )}

      <RowChips values={turnChips(turn)} showErrors />
    </div>
  );
}
