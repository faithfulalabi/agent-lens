import { TriangleAlert, X } from 'lucide-react';

import { useNoticeDismissal } from '@/lib/use-notice-dismissal';
import { driftNotice, type DriftFacts } from '@/lib/session-data';

/*
 * The durability alarm (Task 7.3), props-in on `TruncationNotice`'s shape.
 *
 * ===========================================================================
 * NOTHING TO SAY MEANS NOTHING ON SCREEN.
 * ===========================================================================
 * A session the projector understood whole draws no strip at all. This exists
 * for the one session where the transcript format moved under us, and a
 * permanent "no drift" line would train the reader straight past it — the same
 * rule the truncation strip next door follows.
 *
 * `role="alert"` where that strip carries `role="status"`. A withheld page is a
 * note; a session whose records this build could not name is louder, because
 * the reader may be looking at an incomplete account of their own work.
 *
 * No link. It used to point at `/api/drift`, but a plain browser navigation
 * carries no API token, so it always landed on a 401 page (task 0.16).
 *
 * The wording lives in `@/lib/session-data` beside `truncationNotes`, on the
 * same rule: copy in a pure function is copy a test can pin.
 */

export type DriftBannerProps = DriftFacts & { sessionId: string };

export function DriftBanner(facts: DriftBannerProps) {
  const notice = driftNotice(facts);
  const { dismissed, dismiss } = useNoticeDismissal(`drift:${facts.sessionId}`);
  if (notice === null || dismissed) return null;

  return (
    <div
      data-slot="drift-banner"
      role="alert"
      className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-2xs text-error"
    >
      <TriangleAlert size={12} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0">{notice}</span>
      <button
        type="button"
        aria-label="Dismiss unrecognized records notice"
        title="Dismiss until reload"
        onClick={dismiss}
        className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-raised hover:text-foreground"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
