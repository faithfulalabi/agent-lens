import type { VolumeBucket } from '@/lib/session-list';

/*
 * Session volume over the chosen range (Task 5.2b) — the strip that sits above
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
 * `volumeBuckets` guarantees a constant number of buckets whatever the input, so
 * an empty range draws a flat baseline rather than an empty pane — the same rule
 * the empty states serve, applied to a chart.
 */

export interface VolumeHistogramProps {
  buckets: readonly VolumeBucket[];
}

/** Enough height for a zero bucket to read as a baseline rather than as a gap. */
const BASELINE_PERCENT = 2;

export function VolumeHistogram({ buckets }: VolumeHistogramProps) {
  const peak = buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0);

  return (
    <div
      data-slot="volume-histogram"
      role="img"
      aria-label={`Session volume: ${buckets.reduce((sum, b) => sum + b.count, 0)} in range`}
      className="flex h-12 items-end gap-0.5"
    >
      {buckets.map((bucket) => (
        <span
          key={bucket.start}
          data-slot="volume-bucket"
          data-count={bucket.count}
          style={{ height: `${peak === 0 ? BASELINE_PERCENT : percentOf(bucket.count, peak)}%` }}
          className="flex-1 rounded-md bg-accent-muted"
        />
      ))}
    </div>
  );
}

/** A non-zero count always draws something, so one session never disappears. */
function percentOf(count: number, peak: number): number {
  if (count === 0) return BASELINE_PERCENT;
  return Math.max(BASELINE_PERCENT, Math.round((count / peak) * 100));
}
