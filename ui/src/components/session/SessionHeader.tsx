import { ChevronLeft } from 'lucide-react';

import type { SessionListRow } from '@/lib/api';

import { cn } from '@/lib/utils';
import { SESSION_VIEW_MODES, type SessionViewMode } from '@/lib/thread';
import { hrefFor } from '@/lib/route-match';
import { formatCost, formatDuration, formatTokens } from '@/lib/format';

import { MetricChip } from './MetricChip';
import { SESSION_STATUS_VISUALS } from './session-visuals';
import { SPAN_VISUALS } from './span-visuals';

/*
 * The session's own line above the tree (Task 5.3b), props-in.
 *
 * ===========================================================================
 * EVERY NUMBER IS READ OFF THE SESSION ROW. NONE IS SUMMED FROM WHAT LOADED.
 * ===========================================================================
 * The wire row carries `tokens_in`, `tokens_out`, `est_cost`, `error_count` and
 * `turn_count`, all written by the server's rollup in the same transaction as
 * the rows they describe. The client sees at most one page of events, so a
 * client-side sum would disagree with the stored total on exactly the sessions
 * where it matters — and the disagreement would widen as the reader scrolled.
 *
 * The render test hands this component a session whose stored totals
 * deliberately contradict the events on the page. Reading wins; recomputing
 * fails.
 *
 * ===========================================================================
 * FOUR FIELDS ARE DERIVED HERE, AND THAT IS THE WHOLE ADAPTER.
 * ===========================================================================
 * `GET /api/sessions/:id` sends `SessionListRow` plus `cwd`, four optional
 * sidecar fields and `projection` — it carries no `status`, no `ended_at` and
 * no `total_tokens`. Task 5.2 deleted the module that used to invent them, so
 * they are derived HERE, in the props-in component a static render can pin,
 * rather than in a new adapter that would undo that deletion:
 *
 *   `live`                     -> `live` or `complete`
 *   `tokens_in + tokens_out`   -> the token total
 *   `last_activity_at`         -> the end of a session that is not live
 *   `turn_count`               -> the turn count on screen
 *
 * `interrupted` stays reachable in `SessionStatus` and unproduced in practice,
 * which is exactly its status on the wire.
 *
 * The clock is a parameter, so a live session's elapsed time is assertable
 * rather than whatever the machine happened to think when the test ran.
 *
 * ===========================================================================
 * THE WAY BACK IS AN ANCHOR, NOT A HISTORY CALL.
 * ===========================================================================
 * Task 5.1 added it: before that there was no return control on this screen at
 * all. `history.back()` would send a reader who arrived by deep link wherever
 * they were before agent-lens, so the control is a real link at the list's own
 * href — right on a middle-click, right on a fresh tab, and reachable by the
 * keyboard for free.
 *
 * ===========================================================================
 * THE VIEW TOGGLE IS OPTIONAL, AND IT IS TWO BUTTONS.
 * ===========================================================================
 * Task 5.4 hung the tree/thread switch here rather than on a route: a route
 * would mean editing `route-match.ts`, which is under a standing do-not-touch
 * rule and which reserves query state for Task 7.2. Both props are optional so
 * every existing caller and every existing render assertion stays true, and the
 * pair is `aria-pressed` buttons — the same shape `RangeControl` uses on the
 * session list, not a new component.
 */

export interface SessionHeaderProps {
  session: SessionListRow;
  now: number | Date;
  /** Omit both this and `onViewChange` and no toggle renders at all. */
  view?: SessionViewMode;
  onViewChange?: (view: SessionViewMode) => void;
}

export function SessionHeader({ session, now, view, onViewChange }: SessionHeaderProps) {
  const status = SESSION_STATUS_VISUALS[session.live ? 'live' : 'complete'];
  const totalTokens = session.tokens_in + session.tokens_out;
  const endedAt = session.live ? undefined : session.last_activity_at;

  return (
    <header
      data-slot="session-header"
      className="flex h-12 items-center gap-3 border-b border-border px-3 text-sm text-foreground"
    >
      <a
        href={hrefFor({ name: 'sessions' })}
        data-slot="back-to-sessions"
        aria-label="Back to sessions"
        className="flex shrink-0 items-center gap-1 text-2xs uppercase tracking-widest text-muted transition-colors hover:text-foreground"
      >
        <ChevronLeft size={12} aria-hidden="true" />
        Sessions
      </a>

      <h1 data-slot="session-project" className="min-w-0 flex-1 truncate font-medium">
        {session.project_path}
      </h1>

      {view === undefined || onViewChange === undefined ? null : (
        <ViewToggle view={view} onViewChange={onViewChange} />
      )}

      <span className={cn('flex shrink-0 items-center gap-1 text-xs', status.badge)}>
        <span aria-hidden="true" className={cn('size-1.5 rounded-md', status.dot)} />
        {status.label}
      </span>

      <span data-slot="session-turns" className="shrink-0 font-mono text-2xs text-muted">
        {formatTokens(session.turn_count)} turns
      </span>

      {session.error_count > 0 ? (
        <span data-slot="session-errors" className={SPAN_VISUALS.errorChip}>
          {session.error_count} err
        </span>
      ) : null}

      <MetricChip
        className="shrink-0"
        duration={formatDuration(session.started_at, endedAt, now)}
        tokens={`${formatTokens(totalTokens)} tok`}
        cost={formatCost(session.est_cost ?? 0)}
      />
    </header>
  );
}

/**
 * Which surface the session reads on — `RangeControl`'s segmented shape again.
 *
 * Only the thread button carries a `data-slot`: the gate clicks that one, and a
 * `SELECTORS` entry no drive uses is the vacuity the gate's own guard exists to
 * catch. The conditional attribute is spread the way `EventDetail.tsx` spreads
 * `data-event-id`, so both class literals stay in one `className={cn(…)}`
 * position where `retokenized.test.ts` can still read them.
 */
function ViewToggle({
  view,
  onViewChange,
}: {
  view: SessionViewMode;
  onViewChange: (view: SessionViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Session view"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-surface p-0.5"
    >
      {SESSION_VIEW_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          {...(mode === 'thread' ? { 'data-slot': 'thread-toggle' } : {})}
          aria-pressed={mode === view}
          onClick={() => {
            onViewChange(mode);
          }}
          className={cn(
            'rounded-md px-2 py-1 text-2xs transition-colors',
            mode === view ? 'bg-surface-raised text-foreground' : 'text-muted',
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}
