import { ChevronDown, ChevronUp, Info, X } from 'lucide-react';

import { useNoticeDismissal } from '@/lib/use-notice-dismissal';
import { cn } from '@/lib/utils';
import { hrefFor } from '@/lib/route-match';
import {
  costUnknownLabel,
  formatCost,
  formatDuration,
  formatStartedAt,
  formatTokens,
  modelCell,
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

const METRIC_HEADERS = [
  'Status',
  'Model',
  'Turns',
  'Subagents',
  'Errors',
  'Elapsed',
  'Tokens',
  'Est. cost',
] as const;

const MAIN_SESSION_SCOPE = 'Errors, tokens, and estimated cost cover the main session.';

const COLUMN_TIPS: Partial<Record<string, string>> = {
  'Last active':
    'Last active is the most recent event, in your local time. The day filters use this date.',
  Elapsed:
    'Elapsed runs from the first to the last event (or now for live sessions), including idle time.',
  Turns: 'Turns counts your prompts.',
  Errors: MAIN_SESSION_SCOPE,
  Tokens: `${MAIN_SESSION_SCOPE} Tokens are input + output; cache counts are separate and not shown here.`,
  'Est. cost': `${MAIN_SESSION_SCOPE} A dash means no measured cost or an unavailable estimate; unavailable estimates include an explanation.`,
  Subagents:
    'Subagents shows the number of agents and their additional input + output tokens. These tokens are separate from the main session totals.',
  Model:
    'Model shows the main session’s most-used model first; +N counts other models, including sub-agents’. Hover for full ids.',
};

const tipId = (label: string) => `tip-${label.replace(/\W/g, '')}`;

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
  const { dismissed, dismiss } = useNoticeDismissal('cost-unknown');

  return (
    <div data-slot="session-list" className="overflow-hidden rounded-md border border-border">
      {unpriced === null || dismissed ? null : (
        <div
          data-slot="unpriced-notice"
          role="status"
          className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-2xs text-warning"
        >
          <Info size={12} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0">{unpriced}</span>
          <button
            type="button"
            aria-label="Dismiss cost notice"
            title="Dismiss until reload"
            onClick={dismiss}
            className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-raised hover:text-foreground"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="flex justify-end border-b border-border px-4 py-3">
        <span data-slot="session-list-count" className="text-2xs text-muted">
          {`${formatRowCount(rows.length, pageTruncated)} shown`}
        </span>
      </div>

      <p className="px-4 py-2 text-2xs text-muted lg:hidden">Scroll sideways to see all metrics.</p>
      <div className="overflow-x-auto" role="region" aria-label="Session list columns" tabIndex={0}>
        <div
          data-slot="session-list-header"
          className="session-list-grid border-b border-border bg-surface px-4 py-3 text-2xs text-muted"
        >
          {SORT_COLUMNS.map((column) => {
            const label = column === 'project_path' ? 'Session / Project' : COLUMN_LABELS[column];
            const tip = COLUMN_TIPS[label];
            return (
              <button
                key={column}
                type="button"
                aria-pressed={column === sort}
                aria-describedby={tip === undefined ? undefined : tipId(label)}
                title={
                  tip === undefined ? `Sort by ${COLUMN_LABELS[column].toLowerCase()}` : undefined
                }
                onClick={() => {
                  onSortChange(column);
                }}
                className={cn(
                  'group relative text-left transition-colors',
                  column === sort ? 'text-foreground' : 'text-muted',
                )}
              >
                <ColumnTip label={label} />
                {label}
                {column === sort ? <SortChevron direction={direction} /> : null}
              </button>
            );
          })}
          {METRIC_HEADERS.map((label) => {
            const right = label !== 'Status' && label !== 'Model';
            const tip = COLUMN_TIPS[label];
            return (
              <span
                key={label}
                tabIndex={tip === undefined ? undefined : 0}
                aria-describedby={tip === undefined ? undefined : tipId(label)}
                className={cn('group relative', right && 'text-right')}
              >
                <ColumnTip label={label} right={right} />
                {label}
              </span>
            );
          })}
        </div>
        {rows.map((row, index) => (
          <SessionRow key={row.id} row={row} now={now} isCursor={index === cursor} />
        ))}
      </div>
    </div>
  );
}

function ColumnTip({ label, right = false }: { label: string; right?: boolean }) {
  const tip = COLUMN_TIPS[label];
  if (tip === undefined) return null;
  return (
    <span
      id={tipId(label)}
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute top-full z-10 mt-1 hidden w-64 rounded-lg bg-surface-raised p-2 text-left text-2xs leading-relaxed text-foreground shadow-float group-hover:block group-focus-visible:block',
        right ? 'right-0' : 'left-0',
      )}
    >
      {tip}
    </span>
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
  const model = modelCell(row.models, row.sub_models);
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
        data-column="model"
        data-slot="session-model"
        title={model.title}
        className="min-w-0 truncate font-mono text-2xs text-muted"
      >
        {model.text}
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
