import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatCost, formatDurationMs, formatTokens, previewOf } from '@/lib/format';
import { agentStatusOf } from '@/lib/subagent';
import {
  durationSourceOf,
  eventChips,
  type ChipValues,
  type EventDurationSource,
  type EventRowModel,
} from '@/lib/turn-tree';

import { MetricChip } from './MetricChip';
import { SPAN_VISUALS, VISUAL_OF_KIND } from './span-visuals';

/*
 * One event row — `design-system.md`'s flagship component, props-in.
 *
 * `[type icon] name … [status] [duration] [tokens] [cost] [expand]`, exactly as
 * the Component Patterns section spells it, with the event's input and output
 * on a second line beneath.
 *
 * ===========================================================================
 * THE COMPONENT IS `TreeSpanRow` AND ITS SLOTS STILL SAY `span`.
 * ===========================================================================
 * The model renamed `Span` to `EventRow` with Task 5.2, but `data-slot` values
 * are a test hook that four UI suites and the render gate's `SELECTORS` pin by
 * string. Renaming them would red four suites before it changed anything a
 * reader can see, so the vocabulary mismatch is deliberate and stated here.
 *
 * ===========================================================================
 * THE NUMBER IS LABELLED BY WHERE IT CAME FROM, AND NEVER AS EXECUTION.
 * ===========================================================================
 * A 61 ms `Bash` reads as 8,063 ms when a human sits on the approval dialog, so
 * this row says what its duration MEASURED rather than implying it timed the
 * work. The label rides in `title` and in the row's accessible name, which is
 * where `design-system.md:141` already puts the status word. A fourth chip on
 * screen would contradict the three-chip row spec.
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
 * Nothing here reads a clock, and nothing here takes one: an event carries the
 * duration the projector measured, and no elapsed time is computed on screen.
 */

/** How far one nesting level shifts a row, in pixels. */
export const INDENT_PX = 14;

/** The palette entry an Agent row draws with. Its first real consumer. */
const SUBAGENT = SPAN_VISUALS.type.subagent;

/**
 * What the duration measured, one phrase per `events.duration_source`.
 *
 * Total over four arms, and `none` is the commonest of them after `elapsed`:
 * 14,211 of 30,286 events carry no source at all. `reported` is declared by
 * `src/db/schema.ts:195` and written by nothing, so it is unreachable rather
 * than absent — dropping it would make this map partial against the schema.
 * `turns.duration_source` is a different vocabulary and never arrives here.
 */
export const DURATION_LABELS: Record<EventDurationSource, string> = {
  elapsed: 'elapsed, approval wait included',
  sidecar_span: 'measured by the sub-agent span',
  reported: 'reported by the harness',
  none: 'not measured',
};

export interface TreeSpanRowProps {
  row: EventRowModel;
  /** Drives the accent wash. Selection is an id and survives a collapse. */
  selected: boolean;
  /** Drives the roving tabindex. Focus is an index and is always on screen. */
  focused: boolean;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
}

export function TreeSpanRow({ row, selected, focused, onSelect, onToggle }: TreeSpanRowProps) {
  const { event, kind, status: statusKey } = row.node;
  const type = VISUAL_OF_KIND[kind];
  const status = SPAN_VISUALS.status[statusKey];
  const name = event.name ?? event.kind;
  const durationSource = durationSourceOf(event.duration_source);
  const durationLabel = DURATION_LABELS[durationSource];
  const input = previewOf(event.input);
  const output = previewOf(event.text);
  /*
   * Keyed on `child_session_id`, never on `kind`. Every one of these rows is a
   * `tool_call`, so the kind says nothing; naming a child session is what makes
   * a row a sub-agent, and it is 1:1 with the sidecar it names.
   */
  const childSessionId = event.child_session_id;
  const agent =
    childSessionId === null
      ? null
      : {
          type: event.agent_type ?? SPAN_VISUALS.type.subagent.label,
          status: agentStatusOf(event.agent_status),
        };

  return (
    <div
      role="treeitem"
      data-slot="span-row"
      data-span-status={statusKey}
      data-event-kind={kind}
      data-event-id={event.id}
      // Whose transcript this row came from. The client is what chose which
      // session to ask for, so it can write this honestly — the same move
      // `EventDetail` made with `data-event-id`.
      data-session-id={row.sessionId}
      {...(childSessionId === null ? {} : { 'data-child-session-id': childSessionId })}
      /*
       * `Row.depth` is 0 for a top-level turn and 1 for its events, while
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
       * be every chip in the row read out as one run-on string. What the
       * duration measured is folded in rather than left to a tooltip: naming
       * the row REPLACES its children for a screen reader, so a qualifier that
       * only existed as a `title` would stop being announced at all.
       */
      aria-label={[
        `${type.label} ${name}`,
        ...(agent === null ? [] : [`sub-agent ${agent.type}, ${agent.status}`]),
        status.label,
        durationLabel,
      ].join(', ')}
      // The ARIA treeview's roving tabindex: exactly one row is reachable by
      // tab, and the arrow keys move which one that is.
      tabIndex={focused ? 0 : -1}
      onClick={() => onSelect?.(row.id)}
      className={cn(
        'border-l-2 text-xs text-foreground',
        status.row,
        selected ? 'border-l-accent bg-accent-muted' : 'border-l-background',
      )}
      style={{ paddingLeft: row.depth * INDENT_PX }}
    >
      <div className="flex h-7 items-center gap-2 pr-2">
        <ExpandToggle row={row} name={name} onToggle={onToggle} />

        <span data-slot="span-type" className={cn('shrink-0', type.tint)}>
          <type.Icon size={12} aria-hidden="true" />
        </span>

        <span data-slot="span-name" className="min-w-0 flex-1 truncate">
          {name}
        </span>

        {/*
         * The sub-agent identity strip: whose agent this was, and how it ended.
         *
         * `--span-subagent` has been in the locked palette since the design
         * system landed and had no real consumer until now; this is it. The
         * status word is text rather than a tint alone, per the accessibility
         * baseline, and `unknown` is the honest answer on the 39 of 260 rows
         * whose `agent_status` is null.
         *
         * The description and the rollup are NOT here: both live only on the
         * child's header, which does not exist until the sidecar is fetched.
         * They render on the child's root turn row instead.
         */}
        {agent === null ? null : (
          <span
            data-slot="span-subagent"
            className={cn('flex shrink-0 items-center gap-1', SUBAGENT.tint)}
          >
            <SUBAGENT.Icon size={12} aria-hidden="true" />
            <span className="font-mono text-2xs">{agent.type}</span>
            <span className={SPAN_VISUALS.triggerBadge}>{agent.status}</span>
          </span>
        )}

        {/*
         * The status glyph carries its own word in `title` and `aria-label`.
         * `design-system.md`'s accessibility baseline forbids conveying status
         * by colour alone, and the row tint on its own would do exactly that.
         *
         * `role="img"` is what makes the label count: this element has no text
         * of its own, and a name on a plain span (whose role is generic) is
         * dropped by the accessible-name computation. The histogram next door
         * names its bars the same way.
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

        <span
          data-slot="span-metrics"
          data-duration-source={durationSource}
          title={durationLabel}
          className="shrink-0"
        >
          {/*
           * `showErrors` is false, and that is a choice rather than a hedge. An
           * event's only possible child is a folded turn, whose own header
           * renders its stored `error_count` one row down — so the rollup
           * reading is not lost, it renders where the number is stored. On the
           * event itself the chip could only ever read `1 err`, beside a status
           * glyph that already carries the word and an 8% row wash.
           */}
          <RowChips values={eventChips(event)} showErrors={false} />
        </span>
      </div>

      {input === null && output === null ? null : (
        <div data-slot="span-payload" className="flex items-center gap-2 pb-1 pl-6 pr-2">
          {input === null ? null : (
            <span
              data-slot="span-input"
              className={cn('min-w-0 truncate', SPAN_VISUALS.payloadChip)}
            >
              {input}
            </span>
          )}
          {output === null ? null : (
            <span
              data-slot="span-output"
              className={cn('min-w-0 truncate', SPAN_VISUALS.payloadChip)}
            >
              {output}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ExpandToggle({
  row,
  name,
  onToggle,
}: {
  row: EventRowModel;
  name: string;
  onToggle?: (id: string) => void;
}) {
  if (!row.hasChildren) {
    // The space is held so names line up whether or not an event has children.
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
      aria-label={row.expanded ? `collapse ${name}` : `expand ${name}`}
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
 * Shared with `TraceGroup` so a turn header and an event row cannot spell the
 * same four numbers two different ways.
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
 *
 * An UNPRICED row is not a zero. When `costUnknown` is set — a null `est_cost`
 * on a row that recorded real usage — the chip renders the em dash toned faint
 * with the label in `title` and `aria-label`, exactly `SessionHeader`'s
 * treatment one level down. Omitting it here would make an unpriced call
 * indistinguishable from a free one, the bug Task 0.8 removed at the header.
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
        {...(values.costUnknown !== undefined
          ? { cost: formatCost(values.cost), costUnknown: values.costUnknown }
          : values.cost !== null && values.cost > 0
            ? { cost: formatCost(values.cost) }
            : {})}
      />
    </>
  );
}
