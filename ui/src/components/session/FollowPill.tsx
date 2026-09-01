import { ChevronDown } from 'lucide-react';

/*
 * The "following paused" pill (Task 6.2), props-in.
 *
 * Its own component for the reason `TruncationNotice` gives next door: the page
 * module fetches inside an effect, effects never run under this project's
 * `environment: 'node'`, and a static render of that module emits its pending
 * branch alone — so an assertion about this pill would have had nowhere to live.
 * Props-in, it is one render call away.
 *
 * The copy is `pillLabel`'s, computed in `@/lib/live` beside the reducer that
 * counts, on the same rule the truncation copy follows: wording in a pure
 * function is wording a test can pin.
 *
 * Nothing to say means nothing on screen. While the reader is following there is
 * no backlog, and a permanent badge saying so would be noise over the one state
 * it exists to report.
 */

export interface FollowPillProps {
  /** `pillLabel(follow)` — `null` while following, or at zero. */
  label: string | null;
  onResume?: () => void;
}

export function FollowPill({ label, onResume }: FollowPillProps) {
  if (label === null) return null;

  return (
    <button
      type="button"
      data-slot="follow-pill"
      onClick={onResume}
      className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-2xs text-fg shadow-sm"
    >
      <span>Following paused — {label}</span>
      <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
    </button>
  );
}
