import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { traceChips, type TraceRow } from '@/lib/span-tree';

import { RowChips } from './SpanRow';
import { SPAN_VISUALS } from './span-visuals';

/*
 * A turn's header row (Task 5.3b), props-in.
 *
 * ===========================================================================
 * THIS IS A ROW IN THE SAME LIST, NOT A SECTION AROUND ONE.
 * ===========================================================================
 * Task 5.3a shipped `Row = TraceRow | SpanRow` with turn headers INSIDE the row
 * list, so there is one flattened list and one virtualizer over it. Rendering
 * this component as a sibling of `SpanTree` — one header above each turn's own
 * tree — would draw every header twice and give the keyboard a second index
 * space to disagree with the scrollbar about. `SpanTree` switches on `row.kind`
 * and renders this for `'trace'`, and that is the only place it is used.
 *
 * It is a `treeitem` for the same reason: it is one of the rows the arrow keys
 * move through, and a section heading would be a lie about what focus can land
 * on.
 *
 * ===========================================================================
 * THE CHIPS ARE READ OFF THE TURN, NEVER SUMMED FROM ITS SPANS.
 * ===========================================================================
 * The server rolls up span to turn to session in one transaction. Recomputing
 * from the spans that happen to be on this page would disagree with it the
 * moment the page is capped, and the number on screen would then depend on how
 * far the reader had scrolled. `traceChips` is where that rule lives, and Task
 * 5.3a's own test proves it by handing it a turn whose stored totals contradict
 * its spans.
 */

export interface TraceGroupProps {
  row: TraceRow;
  selected: boolean;
  focused: boolean;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
}

export function TraceGroup({ row, selected, focused, onSelect, onToggle }: TraceGroupProps) {
  const { trace } = row;
  const { Icon, tint, label } = SPAN_VISUALS.trace;
  const Glyph = row.expanded ? ChevronDown : ChevronRight;

  /*
   * `traceChips` reads the stored rollup off the turn and deliberately ignores
   * the node's children, so an empty child list is a legal argument here: the
   * row model carries the turn rather than the node, and the answer would be
   * identical if it carried both.
   */
  const chips = traceChips({ trace, children: [] });

  return (
    <div
      role="treeitem"
      data-slot="trace-group"
      data-trace-trigger={trace.trigger}
      // A turn sits at the root of the tree, so `depth` is 0 and the 1-based
      // ARIA level is 1. The formula is the same one every span row uses.
      aria-level={row.depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-selected={selected}
      {...(row.hasChildren ? { 'aria-expanded': row.expanded } : {})}
      aria-label={`${label} ${trace.turn_seq}: ${trace.prompt_preview}`}
      tabIndex={focused ? 0 : -1}
      onClick={() => onSelect?.(row.id)}
      className={cn(
        'flex h-9 items-center gap-2 border-l-2 border-b border-b-border bg-surface pr-2 text-xs text-foreground',
        selected ? 'border-l-accent bg-accent-muted' : 'border-l-background',
      )}
    >
      <button
        type="button"
        data-slot="trace-expand"
        // Out of the tab sequence, for the reason spelled out on the span row's
        // toggle: a focusable child survives its row's `tabIndex={-1}`, and one
        // extra tab stop per turn header would break the tree's roving-tabindex
        // contract outright.
        tabIndex={-1}
        aria-label={
          row.expanded ? `collapse turn ${trace.turn_seq}` : `expand turn ${trace.turn_seq}`
        }
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
        {trace.prompt_preview}
      </span>

      {/*
       * A turn whose trigger is not a user prompt was started by the system —
       * a resume, a compaction, or something the harness never named. That is
       * informational rather than degraded, so it takes the neutral chip atom
       * and not the warning tone.
       */}
      {trace.trigger === 'user_prompt' ? null : (
        <span
          data-slot="trace-trigger"
          title={`started by ${trace.trigger}`}
          aria-label={`started by ${trace.trigger}`}
          className={SPAN_VISUALS.triggerBadge}
        >
          {trace.trigger}
        </span>
      )}

      <RowChips values={chips} showErrors />
    </div>
  );
}
