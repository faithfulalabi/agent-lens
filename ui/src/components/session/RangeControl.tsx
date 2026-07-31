import { cn } from '@/lib/utils';
import { TIME_RANGES, type TimeRange } from '@/lib/session-list';

/*
 * The time-range segmented control and the project narrowing (Task 5.2b).
 *
 * `design-system.md`'s Tables section names the segmented control by shape —
 * 3d / 7d / 30d / all — and its Forms section scopes native controls to exactly
 * this kind of surface. The project chooser is therefore a plain `<select>`:
 * only `tabs` and `context-menu` were retokenized, so anything richer means
 * building a new component, and the dropdown itself is drawn by the OS where no
 * token of ours reaches anyway.
 *
 * Both controls are uncontrolled-looking but fully controlled: the page module
 * owns the state, this file owns none. Props in, JSX out, so one server render
 * asserts everything it does.
 *
 * The options come from `TIME_RANGES`, the same const the domain module keys its
 * bounds off — one list, so an added range cannot appear here and be unhandled
 * there.
 */

export interface RangeControlProps {
  range: TimeRange;
  onRangeChange: (range: TimeRange) => void;
  /** Every project present in the loaded page. */
  projects: readonly string[];
  /** `undefined` means every project. */
  project?: string;
  onProjectChange: (project: string | undefined) => void;
}

/** The value the `<option>` for "no narrowing" carries; `''` is never a path. */
const ALL_PROJECTS = '';

export function RangeControl({
  range,
  onRangeChange,
  projects,
  project,
  onProjectChange,
}: RangeControlProps) {
  return (
    <div data-slot="range-control" className="flex items-center justify-between gap-4">
      <div
        role="group"
        aria-label="Time range"
        className="inline-flex items-center gap-0.5 rounded-md bg-surface p-0.5"
      >
        {TIME_RANGES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === range}
            onClick={() => {
              onRangeChange(option);
            }}
            className={cn(
              'rounded-md px-2 py-1 text-xs transition-colors',
              option === range ? 'bg-surface-raised text-foreground' : 'text-muted',
            )}
          >
            {option}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs text-muted">
        Project
        <select
          value={project ?? ALL_PROJECTS}
          onChange={(event) => {
            const chosen = event.target.value;
            onProjectChange(chosen === ALL_PROJECTS ? undefined : chosen);
          }}
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
        >
          <option value={ALL_PROJECTS}>All projects</option>
          {projects.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
