import { useState } from 'react';

import { EVENT_DAY } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { TimeSpan, VolumeBucket } from '@/lib/session-list';

/*
 * Sessions per day over the chosen range — the strip that sits above
 * the table in Flow 3's entry screen.
 *
 * ===========================================================================
 * EVERY COMPUTED DIMENSION GOES THROUGH `style`, NEVER THROUGH A CLASS.
 * ===========================================================================
 * Tailwind's scanner is a regex over raw source: it can only emit rules for
 * names it can SEE written down. A height utility with the percentage baked
 * into its own name and assembled at runtime exists only after the build, so it
 * compiles to nothing at all, and nothing is not an error. Percentages
 * therefore land in an inline style, which is also the only honest place for a
 * value that is data.
 *
 * (This paragraph names that shape rather than spelling one out. The scanner
 * reads comments too, so an example here would emit the very dead rule it is
 * warning about.)
 *
 * `volumeBuckets` draws every day of the range whatever the input, so an empty
 * range draws a flat baseline rather than an empty pane — the same rule the
 * empty states serve, applied to a chart.
 */

export interface VolumeHistogramProps {
  buckets: readonly VolumeBucket[];
  selection: TimeSpan | undefined;
  onSelect: (span: TimeSpan | undefined) => void;
}

/** Enough height for a zero bucket to read as a baseline rather than as a gap. */
const BASELINE_PERCENT = 2;

const AXIS_LABELS = 7;

export function VolumeHistogram({ buckets, selection, onSelect }: VolumeHistogramProps) {
  const [active, setActive] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const peak = buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0);
  const labelEvery = Math.ceil(buckets.length / AXIS_LABELS);

  const choose = (from: number, to: number) => {
    const days = buckets.slice(Math.min(from, to), Math.max(from, to) + 1);
    const first = days[0];
    const last = days.at(-1);
    // An empty span would turn the list into an empty state that blames the archive.
    if (first === undefined || last === undefined || days.every((d) => d.count === 0)) return;
    onSelect({ start: first.start, end: last.end });
  };

  const endDrag = () => {
    if (drag !== null) choose(drag.from, drag.to);
    setDrag(null);
  };

  const selected = (bucket: VolumeBucket, i: number) =>
    drag !== null
      ? i >= Math.min(drag.from, drag.to) && i <= Math.max(drag.from, drag.to)
      : selection !== undefined && bucket.start >= selection.start && bucket.end <= selection.end;

  const hovered = active === null ? undefined : buckets[active];

  return (
    <div
      data-slot="volume-histogram"
      role="group"
      aria-label="Sessions per day"
      className="flex select-none flex-col gap-1"
      // The page opens the cursor row on a window-level Enter.
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.stopPropagation();
      }}
    >
      <div className="flex h-5 items-center justify-between gap-4 text-xs text-muted">
        <span>
          {hovered !== undefined
            ? `${EVENT_DAY.format(hovered.start)} · ${sessionCount(hovered.count)}`
            : selection !== undefined
              ? spanText(selection)
              : 'Drag across days to filter the list'}
        </span>
        {selection === undefined ? null : (
          <button
            type="button"
            onClick={() => onSelect(undefined)}
            className="rounded-md px-2 text-accent hover:text-accent-hover"
          >
            Clear
          </button>
        )}
      </div>
      <div
        className="flex h-12 items-end gap-0.5"
        onPointerUp={endDrag}
        onPointerLeave={() => {
          endDrag();
          setActive(null);
        }}
      >
        {buckets.map((bucket, i) => (
          <button
            key={bucket.start}
            type="button"
            data-slot="volume-bucket"
            data-count={bucket.count}
            aria-label={`${EVENT_DAY.format(bucket.start)}: ${sessionCount(bucket.count)}`}
            aria-pressed={selected(bucket, i)}
            className="flex h-full flex-1 items-end rounded-md"
            onPointerDown={() => setDrag({ from: i, to: i })}
            onPointerEnter={() => {
              setActive(i);
              if (drag !== null) setDrag({ from: drag.from, to: i });
            }}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            onClick={() => choose(i, i)}
          >
            <span
              style={{
                height: `${peak === 0 ? BASELINE_PERCENT : percentOf(bucket.count, peak)}%`,
              }}
              className={cn(
                'w-full rounded-md',
                selected(bucket, i) ? 'bg-accent' : 'bg-accent-muted',
              )}
            />
          </button>
        ))}
      </div>
      <div aria-hidden="true" className="flex gap-0.5 text-2xs text-faint">
        {buckets.map((bucket, i) => (
          <span key={bucket.start} className="min-w-0 flex-1 whitespace-nowrap">
            {i % labelEvery === 0 ? EVENT_DAY.format(bucket.start) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A non-zero count always draws something, so one session never disappears. */
function percentOf(count: number, peak: number): number {
  if (count === 0) return BASELINE_PERCENT;
  return Math.max(BASELINE_PERCENT, Math.round((count / peak) * 100));
}

function sessionCount(count: number): string {
  return `${count} ${count === 1 ? 'session' : 'sessions'}`;
}

function spanText({ start, end }: TimeSpan): string {
  const from = EVENT_DAY.format(start);
  const to = EVENT_DAY.format(end - 1);
  return from === to ? from : `${from} – ${to}`;
}
