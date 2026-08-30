import { useRef, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { Row } from '@/lib/turn-tree';

import { TraceGroup } from './TraceGroup';
import { TreeSpanRow } from './SpanRow';

/*
 * The virtualized tree shell (Task 5.3b). Props-in, and the only DOM-coupled
 * module in this feature.
 *
 * ===========================================================================
 * ONE ROW LIST, ONE VIRTUALIZER, ONE RENDERER.
 * ===========================================================================
 * `rows` is `turn-tree.ts`'s single flattened list and it carries turn headers
 * and event rows alike, so this component switches on `row.kind` rather than
 * being wrapped once per turn. A virtualizer per turn would give a ten-turn session
 * ten independent scroll areas, and "5,000 spans in one window" would quietly
 * become "500 spans in ten windows" — with the keyboard indexing one list while
 * the scrollbar indexed another.
 *
 * ===========================================================================
 * `initialRect` IS NOT AN OPTIMISATION. IT IS WHY A STATIC RENDER EMITS ROWS.
 * ===========================================================================
 * `virtual-core` resolves its viewport as `scrollRect ?? options.initialRect`
 * and then abandons the window entirely when the outer size is zero. Its
 * default rect is 0×0 and `getScrollElement()` answers null under a server
 * render, so without this prop a static render emits ZERO rows and the
 * acceptance criterion that counts them could never be written. Declaring it as
 * an explicit prop is what makes the row count assertable.
 *
 * Measured on the installed `@tanstack/react-virtual@3.14.9`: 5,000 rows at
 * `estimateSize` 28 and `overscan` 8 emit 34 rows into a 720px viewport and 21
 * into a 360px one, and 0 with no rect at all.
 *
 * ===========================================================================
 * ROWS ARE PLACED WITH `top`, NOT WITH A TRANSLATION.
 * ===========================================================================
 * The library's own example places rows with a CSS translation, and the bare
 * word naming that property is itself a Tailwind utility candidate. Tailwind v4
 * scans raw source including comments, so writing it anywhere in this directory
 * emits a real, dead CSS rule that the pre-merge stylesheet diff then has to
 * explain. An offset from the top does the identical job and names nothing.
 *
 * ===========================================================================
 * NO `ScrollArea`. THE SCROLL PARENT IS A REAL ELEMENT.
 * ===========================================================================
 * A virtualizer needs an element with a real `scrollTop`, and Radix wraps its
 * scrollport in an inner node — so the scroll element would have to be reached
 * through it. The design system specifies no scrollbar styling, so nothing is
 * lost by using the browser's own.
 */

/**
 * Row height before measurement, in pixels — an ESTIMATE, never a commitment.
 * An event row carrying an input or an output preview is taller, and
 * `measureElement` below corrects every rendered row against the real DOM.
 */
const ESTIMATED_ROW_PX = 28;

/** Rows rendered beyond the viewport, so a fast scroll does not show gaps. */
const OVERSCAN_ROWS = 8;

export interface SpanTreeProps {
  rows: readonly Row[];
  /** An id, so it survives a turn being closed over it. */
  selectedId?: string | undefined;
  /** An index into `rows`, so the focused row is on screen by construction. */
  focusedIndex: number;
  /**
   * The viewport to assume before one has been measured. See the header — this
   * is the difference between a static render emitting rows and emitting none.
   */
  initialRect?: { width: number; height: number };
  estimateSize?: number;
  overscan?: number;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
}

export function SpanTree({
  rows,
  selectedId,
  focusedIndex,
  initialRect,
  estimateSize = ESTIMATED_ROW_PX,
  overscan = OVERSCAN_ROWS,
  onKeyDown,
  onSelect,
  onToggle,
}: SpanTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    // Keyed by row id rather than by index so Task 6.2's live append does not
    // remount every row below the one it inserted.
    getItemKey: (index) => rows[index]?.id ?? index,
    ...(initialRect === undefined ? {} : { initialRect }),
  });

  return (
    <div
      ref={scrollRef}
      data-slot="span-tree-scroller"
      className="h-full overflow-y-auto"
      onKeyDown={onKeyDown}
    >
      <div
        role="tree"
        aria-label="span tree"
        data-slot="span-tree"
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (row === undefined) return null;
          return (
            <div
              key={item.key}
              // `presentation` so the positioning wrapper does not sit between
              // the tree and its items in the accessibility tree: a `tree` may
              // only own `treeitem` and `group`, and the wrapper is neither.
              role="presentation"
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 w-full"
              style={{ top: item.start }}
            >
              {row.kind === 'turn' ? (
                <TraceGroup
                  row={row}
                  selected={row.id === selectedId}
                  focused={item.index === focusedIndex}
                  {...(onSelect === undefined ? {} : { onSelect })}
                  {...(onToggle === undefined ? {} : { onToggle })}
                />
              ) : (
                <TreeSpanRow
                  row={row}
                  selected={row.id === selectedId}
                  focused={item.index === focusedIndex}
                  {...(onSelect === undefined ? {} : { onSelect })}
                  {...(onToggle === undefined ? {} : { onToggle })}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
