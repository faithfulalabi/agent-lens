import { ChevronDown, ChevronUp, Info } from 'lucide-react';

import { cn } from '@/lib/utils';
import { hrefFor } from '@/lib/route-match';
import {
  costUnknownLabel,
  formatCost,
  formatDuration,
  formatStartedAt,
  formatTokens,
} from '@/lib/format';
import type { SessionListRow } from '@/lib/api';
import {
  COLUMN_LABELS,
  SORT_COLUMNS,
  formatRowCount,
  rowLabel,
  unpricedNotice,
  type SortColumn,
  type SortDirection,
} from '@/lib/session-list';

import { SESSION_STATUS_VISUALS } from './session-visuals';

/*
 * Whole-row anchors retain native link semantics. Header and rows share one
 * nine-column layout, reserving every metric even when its value is zero.
 * Values come from normalized API columns; subagent totals remain separate
 * and are withheld until the sidecar sweep finishes. Cost keeps the shared
 * formatCost / costUnknownLabel distinction between zero and unpriced values.
 */

export interface SessionListViewProps {
  rows: readonly SessionListRow[];
  sort: SortColumn;
  direction: SortDirection;
  onSortChange: (column: SortColumn) => void;
  /** The keyboard cursor's row, or `-1` for "not on a row". */
  cursor: number;
  now: number | Date;
  /**
   * The page these rows came from stopped early, so the count says `N+`.
   * Defaults to `false` — an omitted flag must not overstate certainty.
   */
  pageTruncated?: boolean;
}

export function SessionListView({
  rows,
  sort,
  direction,
  onSortChange,
  cursor,
  now,
  pageTruncated = false,
}: SessionListViewProps) {
  const unpriced = unpricedNotice(rows, pageTruncated);

  return (
    <div data-slot="session-list" className="overflow-hidden rounded-md border border-border">
      {unpriced === null ? null : (
        <div
          data-slot="unpriced-notice"
          role="status"
          className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-2xs text-warning"
        >
          <Info size={12} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0">{unpriced}</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <details className="text-xs text-muted">
          <summary className="cursor-pointer text-foreground">What do these numbers mean?</summary>
          <div className="mt-2 max-w-2xl space-y-1 leading-relaxed">
            <p>
              Last active is the most recent event, in your local time. The day filters use this
              date.
            </p>
            <p>
              Elapsed runs from the first to the last event (or now for live sessions), including
              idle time.
            </p>
            <p>
              Turns counts your prompts. Errors, tokens, and estimated cost cover the main session.
              Tokens are input + output; cache counts are separate and not shown here.
            </p>
            <p>
              Subagents shows the number of agents and their additional input + output tokens. These
              tokens are separate from the main session totals. A dash means no measured cost or an
              unavailable estimate; unavailable estimates include an explanation.
            </p>
          </div>
        </details>
        <span data-slot="session-list-count" className="shrink-0 text-2xs text-muted">
          {formatRowCount(rows.length, pageTruncated)}
        </span>
      </div>

      <p className="px-4 py-2 text-2xs text-muted lg:hidden">Scroll sideways to see all metrics.</p>
      <div className="overflow-x-auto" role="region" aria-label="Session list columns" tabIndex={0}>
        <div
          data-slot="session-list-header"
          className="session-list-grid border-b border-border bg-surface px-4 py-3 text-2xs text-muted"
        >
          {SORT_COLUMNS.map((column) => (
            <button
              key={column}
              type="button"
              aria-pressed={column === sort}
              title={`Sort by ${COLUMN_LABELS[column].toLowerCase()}`}
              onClick={() => {
                onSortChange(column);
              }}
              className={cn(
                'text-left transition-colors',
                column === sort ? 'text-foreground' : 'text-muted',
              )}
            >
              {column === 'project_path' ? 'Session / Project' : COLUMN_LABELS[column]}
              {column === sort ? <SortChevron direction={direction} /> : null}
            </button>
          ))}
          <span>Status</span>
          <span className="text-right">Turns</span>
          <span className="text-right">Subagents</span>
          <span className="text-right">Errors</span>
          <span className="text-right">Elapsed</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Est. cost</span>
        </div>
        {rows.map((row, index) => (
          <SessionRow key={row.id} row={row} now={now} isCursor={index === cursor} />
        ))}
      </div>
    </div>
  );
}

function SortChevron({ direction }: { direction: SortDirection }) {
  const Glyph = direction === 'asc' ? ChevronUp : ChevronDown;
  return <Glyph size={12} aria-hidden="true" className="inline-block" />;
}

function SessionRow({
  row,
  now,
  isCursor,
}: {
  row: SessionListRow;
  now: number | Date;
  isCursor: boolean;
}) {
  const status = SESSION_STATUS_VISUALS[row.live ? 'live' : 'complete'];
  const label = rowLabel(row);
  const active = formatStartedAt(row.last_activity_at, now);
  const pending = row.rollup_state === 'own';
  const unknownCost = costUnknownLabel(row.est_cost, row.model);
  const hasErrors = row.error_count > 0;

  return (
    <a
      href={hrefFor({ name: 'session', sessionId: row.id })}
      data-slot="session-row"
      aria-label={
        `${label}, ${row.project_path}, ${status.label}, ${row.turn_count} turns, ` +
        `active ${active}${pending ? ', sub-agent totals still being summed' : ''}`
      }
      className={cn(
        'session-list-grid min-h-20 border-b border-border px-4 py-4 text-xs text-foreground transition-colors hover:bg-surface last:border-b-0',
        isCursor && 'bg-surface-raised',
      )}
    >
      <span data-column="session" className="min-w-0">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span
          className="mt-1.5 block truncate font-mono text-2xs text-muted"
          title={row.project_path}
        >
          {row.project_path}
        </span>
      </span>
      <time
        data-column="active"
        dateTime={row.last_activity_at}
        title={new Date(row.last_activity_at).toLocaleString()}
        className="text-muted"
      >
        {active}
      </time>

      <span data-column="status" className={cn('flex items-center gap-1', status.badge)}>
        <span aria-hidden="true" className={cn('size-1.5 rounded-md', status.dot)} />
        {status.label}
      </span>

      <span
        data-column="turns"
        data-slot="session-turns"
        className="text-right font-mono text-2xs text-muted"
      >
        {formatTokens(row.turn_count)}
      </span>
      <span data-column="subagents" className="text-right text-2xs text-muted">
        <span className="font-mono">{formatTokens(row.agent_count)}</span>
        {row.agent_count === 0 ? null : pending ? (
          <span
            data-slot="session-subs-pending"
            className="mt-1 block animate-pulse rounded-md bg-surface-raised motion-reduce:animate-none"
          >
            Counting tokens…
          </span>
        ) : (
          <span data-slot="session-subs" className="mt-1 block font-mono">
            {formatTokens(row.sub_tokens_in + row.sub_tokens_out)} tok
          </span>
        )}
      </span>
      <span
        data-column="errors"
        data-slot="session-errors"
        aria-label={`${row.error_count} errors`}
        className={cn('text-right font-mono text-2xs', hasErrors ? 'text-error' : 'text-muted')}
      >
        {formatTokens(row.error_count)}
      </span>
      <span
        data-column="elapsed"
        data-slot="metric-duration"
        className="text-right font-mono text-2xs text-muted"
      >
        {formatDuration(row.started_at, row.live ? undefined : row.last_activity_at, now)}
      </span>
      <span
        data-column="tokens"
        data-slot="metric-tokens"
        className="text-right font-mono text-2xs text-muted"
      >
        {formatTokens(row.tokens_in + row.tokens_out)}
      </span>
      <span
        data-slot="metric-cost"
        title={unknownCost}
        aria-label={unknownCost}
        data-column="cost"
        className={cn(
          'text-right font-mono text-2xs',
          unknownCost === undefined ? 'text-muted' : 'text-faint',
        )}
      >
        {formatCost(row.est_cost)}
      </span>
    </a>
  );
}
