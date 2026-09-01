import { TriangleAlert } from 'lucide-react';

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
 * The link goes to `/api/drift`, the aggregate itself. No phase-7 task builds a
 * screen for the report, so the JSON is the honest destination — and it costs
 * no entry in `route-match.ts`, which is under a standing do-not-touch rule.
 *
 * The wording lives in `@/lib/session-data` beside `truncationNotes`, on the
 * same rule: copy in a pure function is copy a test can pin.
 */

export type DriftBannerProps = DriftFacts;

export function DriftBanner(facts: DriftBannerProps) {
  const notice = driftNotice(facts);
  if (notice === null) return null;

  return (
    <div
      data-slot="drift-banner"
      role="alert"
      className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-2xs text-error"
    >
      <TriangleAlert size={12} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0">{notice}</span>
      <a
        href="/api/drift"
        className="ml-auto shrink-0 uppercase tracking-widest text-muted transition-colors hover:text-foreground"
      >
        Drift report
      </a>
    </div>
  );
}
