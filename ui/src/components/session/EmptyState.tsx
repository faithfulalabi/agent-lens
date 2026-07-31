import { Inbox, SearchX, Clock } from 'lucide-react';

import { emptyStateCopy, type EmptyStateShown } from '@/lib/session-list';

/*
 * The empty pane that is never blank (Task 5.2b).
 *
 * `design-system.md`'s Empty states pattern, literally: a 24px Lucide icon in
 * the faintest token, one sentence, one action hint. "Never illustrations;
 * never blank panes" is the rule this component exists to keep, and the fourth
 * state — a project narrowing that empties a range which is not itself empty —
 * exists because the two specced states could only have described it falsely.
 *
 * The words come from `@/lib/session-list`, which composes them and is pinned
 * against the spec documents. Nothing here invents copy, so nothing here can
 * drift away from what was ruled.
 */

const ICONS = {
  never_captured: Inbox,
  outside_range: Clock,
  no_match_for_project: SearchX,
} as const;

export function EmptyState({ state }: { state: EmptyStateShown }) {
  const { sentence, hint } = emptyStateCopy(state);
  const Icon = ICONS[state.kind];

  return (
    <div
      data-slot="empty-state"
      data-empty-kind={state.kind}
      className="flex flex-col items-center gap-2 px-8 py-16 text-center"
    >
      <Icon size={24} aria-hidden="true" className="text-faint" />
      <p className="text-sm text-foreground">{sentence}</p>
      <p className="text-xs text-muted">{hint}</p>
    </div>
  );
}
