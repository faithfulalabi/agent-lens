import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatCost, formatDurationMs, formatTokens } from '@/lib/format';
import { subtreeChips, type ChipValues, type SpanRow as SpanRowModel } from '@/lib/span-tree';

import { MetricChip } from './MetricChip';
import { SPAN_VISUALS, degradedTagsOf } from './span-visuals';

/*
 * One span row — `design-system.md`'s flagship component, props-in.
 *
 * `[type icon] name … [status] [duration] [tokens] [cost] [expand]`, exactly as
 * the Component Patterns section spells it.
 *
 * ===========================================================================
 * THE COMPONENT IS `TreeSpanRow`. THE MODEL'S ROW TYPE IS `SpanRow`.
 * ===========================================================================
 * `span-tree.ts` already exports an interface called `SpanRow`, and this file
 * is called `SpanRow.tsx`. Naming the component the same thing would mean every
 * consumer aliasing one of the two on import, so the component takes the longer
 * name and the model keeps the short one it was shipped with.
 *
 * ===========================================================================
 * INDENTATION IS AN INLINE STYLE, AND IT HAS TO BE.
 * ===========================================================================
 * Depth is data, so the natural spelling is a class name built from it — and a
 * class name assembled at runtime is invisible to Tailwind's scanner, which is
 * a regex over raw source. It would compile to no rule at all, silently, and
 * every row in a nested tree would sit at the same offset. The histogram bars
 * next door take the same route for the same reason.
 *
 * ===========================================================================
 * THE LEFT EDGE IS ALWAYS TWO PIXELS WIDE.
 * ===========================================================================
 * The design system draws the selected row with an accent wash and a 2px accent
 * left edge. Adding that edge only when selected would move every character in
 * the row two pixels sideways the moment the cursor arrived, so the edge is
 * always there and only its colour changes — to the canvas colour, against
 * which it cannot be seen.
 *
 * Nothing here reads a clock. `now` is a parameter, which is what lets a
 * running span's elapsed time be asserted at all.
 */

/** How far one nesting level shifts a row, in pixels. */
const INDENT_PX = 14;

export interface TreeSpanRowProps {
  row: SpanRowModel;
  /** Drives the accent wash. Selection is an id and survives a collapse. */
  selected: boolean;
  /** Drives the roving tabindex. Focus is an index and is always on screen. */
  focused: boolean;
  now: number | Date;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
}

export function TreeSpanRow({ row, selected, focused, now, onSelect, onToggle }: TreeSpanRowProps) {
  const { span } = row.node;
  const type = SPAN_VISUALS.type[span.span_type];
  const status = SPAN_VISUALS.status[span.status];
  const degraded = degradedTagsOf(span.tags);

  return (
    <div
      role="treeitem"
      data-slot="span-row"
      data-span-status={span.status}
      /*
       * `Row.depth` is 0 for a turn and 1 for its direct span children, while
       * `aria-level` is 1-based from the root of the tree — so every row's
       * level is its depth plus one, turn headers included.
       */
      aria-level={row.depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-selected={selected}
      {...(row.hasChildren ? { 'aria-expanded': row.expanded } : {})}
      /*
       * An explicit name, because a `treeitem`'s computed name would otherwise
       * be every chip in the row read out as one run-on string. The degradation
       * is folded in rather than left to the chips: naming the row REPLACES its
       * children for a screen reader, so a tag that only existed as a chip
       * would stop being announced at all.
       */
      aria-label={[`${type.label} ${span.name}`, status.label, ...degraded].join(', ')}
      // The ARIA treeview's roving tabindex: exactly one row is reachable by
      // tab, and the arrow keys move which one that is.
      tabIndex={focused ? 0 : -1}
      onClick={() => onSelect?.(row.id)}
      className={cn(
        'flex h-7 items-center gap-2 border-l-2 pr-2 text-xs text-foreground',
        status.row,
        selected ? 'border-l-accent bg-accent-muted' : 'border-l-background',
      )}
      style={{ paddingLeft: row.depth * INDENT_PX }}
    >
      <ExpandToggle row={row} onToggle={onToggle} />

      <span data-slot="span-type" className={cn('shrink-0', type.tint)}>
        <type.Icon size={12} aria-hidden="true" />
      </span>

      <span data-slot="span-name" className="min-w-0 flex-1 truncate">
        {span.name}
      </span>

      {degraded.map((tag) => (
        <span
          key={tag}
          data-slot="degraded-tag"
          title={`degraded capture: ${tag}`}
          aria-label={`degraded capture: ${tag}`}
          className={SPAN_VISUALS.degradedChip}
        >
          {tag}
        </span>
      ))}

      {/*
       * The status glyph carries its own word in `title` and `aria-label`.
       * `design-system.md`'s accessibility baseline forbids conveying status by
       * colour alone, and the row tint on its own would do exactly that.
       *
       * `role="img"` is what makes the label count: this element has no text of
       * its own, and a name on a plain span (whose role is generic) is dropped
       * by the accessible-name computation. The histogram next door names its
       * bars the same way.
       */}
      <span
        data-slot="span-status"
        role="img"
        title={status.label}
        aria-label={status.label}
        className={cn('shrink-0', status.tint)}
      >
        <status.Icon size={12} aria-hidden="true" />
      </span>

      <RowChips values={subtreeChips(row.node, now)} showErrors={row.hasChildren} />
    </div>
  );
}

function ExpandToggle({ row, onToggle }: { row: SpanRowModel; onToggle?: (id: string) => void }) {
  if (!row.hasChildren) {
    // The space is held so names line up whether or not a span has children.
    return <span data-slot="span-expand-space" aria-hidden="true" className="w-3.5 shrink-0" />;
  }
  const Glyph = row.expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      data-slot="span-expand"
      /*
       * OUT of the tab sequence, deliberately. A button is focusable by
       * default and putting `tabIndex={-1}` on the row does NOT take its
       * children out — so without this, every expandable row in the window
       * adds its own tab stop and the tree's roving-tabindex contract ("exactly
       * one row is reachable by tab") becomes false the moment anything nests.
       * This is the mouse's affordance; the keyboard expands with the arrows.
       */
      tabIndex={-1}
      aria-label={row.expanded ? `collapse ${row.node.span.name}` : `expand ${row.node.span.name}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle?.(row.id);
      }}
      className="shrink-0 text-faint"
    >
      <Glyph size={14} aria-hidden="true" />
    </button>
  );
}

/**
 * The three-chip metric strip, plus the error count when there is one.
 *
 * Shared with `TraceGroup` so a turn header and a sub-agent header cannot spell
 * the same four numbers two different ways.
 *
 * ===========================================================================
 * THE ERROR COUNT IS A LOCAL CHIP, NOT A FOURTH `MetricChip` SLOT.
 * ===========================================================================
 * Ruled 2026-07-31. `design-system.md` specs this row as exactly three chips —
 * duration, tokens, cost — so a fourth slot on the shared atom would contradict
 * the document it was built from. The session list already renders its own
 * error count beside the atom rather than inside it, so this is the established
 * shape rather than a new one, and it leaves a merged component untouched.
 *
 * A zero omits its chip rather than rendering `0`: a leaf tool call has no
 * tokens of its own, and a column of zeroes down a 5,000-row tree is noise that
 * makes the rows carrying real numbers harder to find.
 */
export function RowChips({ values, showErrors }: { values: ChipValues; showErrors: boolean }) {
  return (
    <>
      {showErrors && values.errorCount > 0 ? (
        <span data-slot="row-errors" className={SPAN_VISUALS.errorChip}>
          {values.errorCount} err
        </span>
      ) : null}
      <MetricChip
        className="shrink-0"
        duration={formatDurationMs(values.durationMs)}
        {...(values.tokens > 0 ? { tokens: `${formatTokens(values.tokens)} tok` } : {})}
        {...(values.cost > 0 ? { cost: formatCost(values.cost) } : {})}
      />
    </>
  );
}
