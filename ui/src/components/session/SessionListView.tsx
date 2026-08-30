import { ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@/lib/utils';
import { hrefFor } from '@/lib/route-match';
import { formatCost, formatDuration, formatStartedAt, formatTokens } from '@/lib/format';
import type { SessionListRow } from '@/lib/api';
import {
  COLUMN_LABELS,
  SORT_COLUMNS,
  formatRowCount,
  rowLabel,
  type SortColumn,
  type SortDirection,
} from '@/lib/session-list';

import { MetricChip } from './MetricChip';
import { SESSION_STATUS_VISUALS } from './session-visuals';

/*
 * The session list itself (Task 5.2b, rebuilt on the v2 wire by Task 5.1) —
 * Flow 3's entry screen.
 *
 * ===========================================================================
 * ONE ANCHOR PER ROW. NO ARIA GRID ROLES.
 * ===========================================================================
 * The obvious markup for something called a session table is `role="row"` on
 * each row, and it is wrong twice over. `row` is only valid when owned by a
 * `table`/`grid`/`treegrid`/`rowgroup` AND owning `cell`-family children, and
 * putting it on an anchor OVERRIDES the anchor's implicit `link` role — so the
 * row stops being announced as a link, against the accessibility baseline's own
 * rule. `design-system.md` asks for a "full-row click target", which needs no
 * row semantics whatsoever.
 *
 * So each row is one real anchor at the href the router already knows how to
 * make. That gives every row a deep link for Task 5.5, gives `enter` something
 * honest to navigate to, and lets the header strip be real sort buttons rather
 * than fake column headers. The tests assert on `href`.
 *
 * ===========================================================================
 * THE ROW READS THE WIRE. IT ADAPTS NOTHING AND RECOMPUTES NOTHING.
 * ===========================================================================
 * Task 4.5 shipped an adapter that dressed a v2 row up as a plan-001 `Session`,
 * inventing a capture mode and a status the wire does not carry. Task 5.1
 * deleted it, so every value below is a stored column: `turn_count` is the
 * projector's human-prompt count, and the label goes through `rowLabel`, which
 * refuses a stored title that is harness markup rather than prose.
 *
 * `rollup_state === 'own'` means the sub-agent sweep has not folded the
 * sidecars in yet. Those totals then run 2–6x low, so the row shows a skeleton
 * instead of a number that is wrong — `design-system.md` Loading states, with
 * the reduced-motion fallback its Motion section requires.
 *
 * ===========================================================================
 * COST GOES THROUGH `formatCost`. ALWAYS.
 * ===========================================================================
 * `MetricChip` takes pre-spelled strings, so `String(row.est_cost)` type
 * checks and renders `0` — a session that cost nothing measurable reading as a
 * priced one, which is the mapping `design-system.md` calls out by name. The
 * row test seeds a zero-cost session into its fixture and asserts the markup
 * carries the em dash and no `$0` anywhere.
 *
 * Every value is spelled against an injected `now`, never an ambient clock: a
 * live session's elapsed time is the whole reason that parameter exists.
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
  return (
    <div data-slot="session-list">
      <div
        data-slot="session-list-header"
        className="flex items-center gap-2 border-b border-border px-3 py-1"
      >
        {SORT_COLUMNS.map((column) => (
          <button
            key={column}
            type="button"
            aria-pressed={column === sort}
            onClick={() => {
              onSortChange(column);
            }}
            className={cn(
              'text-2xs uppercase tracking-widest transition-colors',
              column === sort ? 'text-foreground' : 'text-faint',
            )}
          >
            {COLUMN_LABELS[column]}
            {/* One chevron, per the design system's sort-indicator rule. */}
            {column === sort ? <SortChevron direction={direction} /> : null}
          </button>
        ))}

        {/*
         * The list states its own size. Pushed to the far end of the strip so
         * it reads as a summary of the rows rather than a third sort control.
         */}
        <span data-slot="session-list-count" className="ml-auto text-2xs text-muted">
          {formatRowCount(rows.length, pageTruncated)}
        </span>
      </div>

      {rows.map((row, index) => (
        <SessionRow key={row.id} row={row} now={now} isCursor={index === cursor} />
      ))}
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

  return (
    <a
      href={hrefFor({ name: 'session', sessionId: row.id })}
      data-slot="session-row"
      aria-label={
        `${label}, ${row.project_path}, ${status.label}, ${row.turn_count} turns, ` +
        `active ${active}${pending ? ', sub-agent totals still being summed' : ''}`
      }
      className={cn(
        'flex h-9 items-center gap-3 border-b border-border px-3 text-xs text-foreground',
        isCursor && 'bg-surface-raised',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="w-40 shrink-0 truncate text-muted">{row.project_path}</span>
      <span className="w-24 shrink-0 text-muted">{active}</span>

      <span className={cn('flex w-20 shrink-0 items-center gap-1', status.badge)}>
        <span aria-hidden="true" className={cn('size-1.5 rounded-md', status.dot)} />
        {status.label}
      </span>

      {/* Right-aligned mono numerics, per the design system's table rules. */}
      <span
        data-slot="session-turns"
        className="w-16 shrink-0 text-right font-mono text-2xs text-muted"
      >
        {formatTokens(row.turn_count)} turns
      </span>

      {row.agent_count === 0 ? null : pending ? (
        <span
          data-slot="session-subs-pending"
          aria-hidden="true"
          className="h-3 w-16 shrink-0 animate-pulse rounded-md bg-surface-raised motion-reduce:animate-none"
        />
      ) : (
        <span
          data-slot="session-subs"
          className="w-16 shrink-0 text-right font-mono text-2xs text-muted"
        >
          +{formatTokens(row.sub_tokens_in + row.sub_tokens_out)}
        </span>
      )}

      {row.error_count > 0 ? (
        <span data-slot="session-errors" className="font-mono text-2xs text-error">
          {row.error_count} err
        </span>
      ) : null}

      <MetricChip
        className="shrink-0"
        duration={formatDuration(row.started_at, row.live ? undefined : row.last_activity_at, now)}
        tokens={`${formatTokens(row.tokens_in + row.tokens_out)} tok`}
        cost={formatCost(row.est_cost)}
      />
    </a>
  );
}
