import type { Session } from '@shared/entities.ts';

import { cn } from '@/lib/utils';
import { formatCost, formatDuration, formatTokens } from '@/lib/format';

import { MetricChip } from './MetricChip';
import { SESSION_STATUS_VISUALS } from './session-visuals';
import { SPAN_VISUALS } from './span-visuals';

/*
 * The session's own line above the tree (Task 5.3b), props-in.
 *
 * ===========================================================================
 * EVERY NUMBER IS READ OFF THE SESSION. NONE IS SUMMED FROM WHAT LOADED.
 * ===========================================================================
 * `Session` carries `total_tokens`, `est_cost`, `error_count` and
 * `trace_count`, all written by the server's rollup in the same transaction as
 * the rows they describe. The client sees at most a capped page of spans, so a
 * client-side sum would disagree with the stored total on exactly the sessions
 * where it matters — and the disagreement would widen as the reader scrolled.
 *
 * The render test hands this component a session whose stored totals
 * deliberately contradict the spans on the page. Reading wins; recomputing
 * fails.
 *
 * The clock is a parameter, so a live session's elapsed time is assertable
 * rather than whatever the machine happened to think when the test ran.
 */

export interface SessionHeaderProps {
  session: Session;
  now: number | Date;
}

export function SessionHeader({ session, now }: SessionHeaderProps) {
  const status = SESSION_STATUS_VISUALS[session.status];

  return (
    <header
      data-slot="session-header"
      className="flex h-12 items-center gap-3 border-b border-border px-3 text-sm text-foreground"
    >
      <h1 data-slot="session-project" className="min-w-0 flex-1 truncate font-medium">
        {session.project_path}
      </h1>

      <span className={cn('flex shrink-0 items-center gap-1 text-xs', status.badge)}>
        <span aria-hidden="true" className={cn('size-1.5 rounded-md', status.dot)} />
        {status.label}
      </span>

      <span data-slot="session-turns" className="shrink-0 font-mono text-2xs text-muted">
        {formatTokens(session.trace_count)} turns
      </span>

      {session.error_count > 0 ? (
        <span data-slot="session-errors" className={SPAN_VISUALS.errorChip}>
          {session.error_count} err
        </span>
      ) : null}

      <MetricChip
        className="shrink-0"
        duration={formatDuration(session.started_at, session.ended_at, now)}
        tokens={`${formatTokens(session.total_tokens)} tok`}
        cost={formatCost(session.est_cost)}
      />
    </header>
  );
}
