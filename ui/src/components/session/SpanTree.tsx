import { useEffect, useRef, type KeyboardEvent, type UIEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { ScrollMetrics } from '@/lib/live';
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
  /**
   * The row to keep in view, or `undefined` to leave the scroller alone.
   *
   * Passed by the page ONLY while follow mode is on, which is what keeps a
   * programmatic scroll from ever landing under a paused reader.
   */
  followIndex?: number | undefined;
  /**
   * A row to scroll to ONCE, because a search hit named it.
   *
   * Its own prop rather than a widened `followIndex`, so that prop's stated
   * invariant above stays literally true and the two land differently: a jumped
   * row is centred, a followed one sits at the end.
   *
   * ★ THE PAGE HANDS THIS OVER ON EXACTLY ONE RENDER. It is a latch consumed on
   * delivery (`revealStep` in `@/lib/search`), never `rows.findIndex(...)`
   * recomputed each render — `rows` is rebuilt on every expand and collapse, so
   * a derived index would move and yank a reader who only opened a turn.
   */
  revealIndex?: number | undefined;
  /** The scroller's own numbers. `atBottom` is decided in `@/lib/live`. */
  onScrollMetrics?: (metrics: ScrollMetrics) => void;
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
  followIndex,
  revealIndex,
  onScrollMetrics,
  onKeyDown,
  onSelect,
  onToggle,
}: SpanTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /*
   * ★ ONE SCROLL EVENT THIS COMPONENT CAUSED IS SWALLOWED, AND IT HAS TO BE.
   *
   * Rows are measured, not assumed — `measureElement` corrects each rendered row
   * against the real DOM — so `scrollToIndex` can land SHORT of the true end
   * while the rows below it are still estimates. That lands an `onScroll` whose
   * numbers say "not at the end", the reducer reads it as a reader who moved,
   * and follow mode pauses on the very frame the pill resumed it.
   */
  const programmaticScroll = useRef(false);

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

  useEffect(() => {
    if (followIndex === undefined) return;
    programmaticScroll.current = true;
    virtualizer.scrollToIndex(followIndex, { align: 'end' });
  }, [followIndex, virtualizer]);

  // The same body and the same swallow, aimed at the other prop. Centred rather
  // than ended: a jumped-to row read against the bottom edge shows no context
  // above it, which is the whole reason a reader followed the hit.
  useEffect(() => {
    if (revealIndex === undefined) return;
    programmaticScroll.current = true;
    virtualizer.scrollToIndex(revealIndex, { align: 'center' });
  }, [revealIndex, virtualizer]);

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    const element = event.currentTarget;
    onScrollMetrics?.({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    });
  };

  return (
    <div
      ref={scrollRef}
      data-slot="span-tree-scroller"
      className="h-full overflow-y-auto"
      onKeyDown={onKeyDown}
      onScroll={onScroll}
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
