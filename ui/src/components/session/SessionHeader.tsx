import { ChevronLeft, GitBranch, MessageSquare, Search } from 'lucide-react';

import type { SessionListRow } from '@/lib/api';

import { rowLabel } from '@/lib/session-list';
import { cn } from '@/lib/utils';
import { SESSION_VIEW_MODES, type SessionViewMode } from '@/lib/thread';
import { hrefFor } from '@/lib/route-match';
import { costUnknownLabel, formatCost, formatDuration, formatTokens } from '@/lib/format';

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
 * ⚠️ `est_cost` GOES TO `formatCost` UNTOUCHED. A `?? 0` stood here until Task
 * 0.8 and it destroyed the only signal that says "no rate for this model",
 * one hop before the formatter that knows what to do with it. Both absences
 * still spell the em dash; `costUnknownLabel` is what separates them.
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
  session: SessionListRow & { agent_description?: string };
  parentSessionId?: string;
  now: number | Date;
  /** Omit both this and `onViewChange` and no toggle renders at all. */
  view?: SessionViewMode;
  onViewChange?: (view: SessionViewMode) => void;
}

export function SessionHeader({
  session,
  now,
  view,
  onViewChange,
  parentSessionId,
}: SessionHeaderProps) {
  const title = session.agent_description?.trim() || rowLabel(session);
  const status = SESSION_STATUS_VISUALS[session.live ? 'live' : 'complete'];
  const totalTokens = session.tokens_in + session.tokens_out;
  const endedAt = session.live ? undefined : session.last_activity_at;
  // Read ONCE, so the spelling and the reason it is absent cannot disagree —
  // and so a `?? 0` reinstated here has exactly one place to hide.
  const cost = session.est_cost;

  return (
    <header
      data-slot="session-header"
      className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-3 border-b border-border bg-surface/50 px-5 py-4 text-sm text-foreground"
    >
      <a
        href={
          parentSessionId
            ? hrefFor({ name: 'session', sessionId: parentSessionId })
            : hrefFor({ name: 'sessions' })
        }
        data-slot="back-to-sessions"
        aria-label={parentSessionId ? 'Back to parent session' : 'Back to sessions'}
        className="flex shrink-0 items-center gap-1 text-2xs uppercase tracking-widest text-muted transition-colors hover:text-foreground"
      >
        <ChevronLeft size={12} aria-hidden="true" />
        {parentSessionId ? 'Parent session' : 'Sessions'}
      </a>

      <div className="min-w-0 flex-1 basis-60">
        <h1 className="truncate text-lg font-semibold" title={title}>
          {title}
        </h1>
        <p
          data-slot="session-project"
          className="mt-1 truncate font-mono text-2xs text-muted"
          title={session.project_path}
        >
          {session.project_path}
        </p>
      </div>

      <a
        href={hrefFor({ name: 'search', sessionId: session.id })}
        data-slot="in-session-search"
        className="shrink-0 text-2xs uppercase tracking-widest text-muted transition-colors hover:text-foreground"
      >
        <Search size={14} className="mr-1 inline-block" aria-hidden="true" /> Search
      </a>

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
        cost={formatCost(cost)}
        costUnknown={costUnknownLabel(cost, session.model)}
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
            'flex items-center gap-1.5 rounded-md px-3 py-2 text-xs transition-colors',
            mode === view ? 'bg-surface-raised text-foreground' : 'text-muted',
          )}
        >
          {mode === 'thread' ? (
            <MessageSquare size={13} aria-hidden="true" />
          ) : (
            <GitBranch size={13} aria-hidden="true" />
          )}
          {mode === 'thread' ? 'Thread' : 'Tree'}
        </button>
      ))}
    </div>
  );
}
