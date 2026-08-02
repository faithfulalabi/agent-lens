import { Info } from 'lucide-react';

import { truncationNotes, type TruncationFacts } from '@/lib/session-data';

/*
 * The strip that says what the tree is NOT showing (Task 5.3b), props-in.
 *
 * ===========================================================================
 * ITS OWN COMPONENT, DELIBERATELY.
 * ===========================================================================
 * The obvious home for a one-line strip is the page module that owns the data.
 * That page fetches inside an effect, effects never run under this project's
 * `environment: 'node'`, and a static render of it emits its pending branch and
 * nothing else — so the assertion that this strip appears would have had no
 * home at all. Props-in, it is one render call away.
 *
 * ===========================================================================
 * NOTHING TO SAY MEANS NOTHING ON SCREEN.
 * ===========================================================================
 * A complete tree renders no strip. A permanent "showing everything" banner
 * would train the reader to stop reading it, and the one session where it says
 * something else is the one session it exists for.
 *
 * The wording lives in `@/lib/session-data` beside the load that produces the
 * numbers, on the same rule the empty-state copy next door follows: copy in a
 * pure function is copy a test can pin.
 */

export type TruncationNoticeProps = TruncationFacts;

export function TruncationNotice(facts: TruncationNoticeProps) {
  const notes = truncationNotes(facts);
  if (notes.length === 0) return null;

  return (
    <div
      data-slot="truncation-notice"
      role="status"
      className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-2xs text-warning"
    >
      <Info size={12} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0">{notes.join(' ')}</span>
    </div>
  );
}
