import { ChevronDown, ChevronUp } from 'lucide-react';

import type { Session } from '@shared/entities.ts';

import { cn } from '@/lib/utils';
import { hrefFor } from '@/lib/route-match';
import { formatCost, formatDuration, formatStartedAt, formatTokens } from '@/lib/format';
import { SORT_COLUMNS, type SortColumn, type SortDirection } from '@/lib/session-list';

import { MetricChip } from './MetricChip';
import { CAPTURE_MODE_VISUALS, SESSION_STATUS_VISUALS } from './session-visuals';

/*
 * The session list itself (Task 5.2b) — Flow 3's entry screen.
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
 * COST GOES THROUGH `formatCost`. ALWAYS.
 * ===========================================================================
 * `MetricChip` takes pre-spelled strings, so `String(session.est_cost)` type
 * checks and renders `0` — a session that cost nothing measurable reading as a
 * priced one, which is the mapping `design-system.md` calls out by name. The
 * row test seeds a zero-cost session into its fixture and asserts the markup
 * carries the em dash and no `$0` anywhere.
 *
 * Every value is spelled against an injected `now`, never an ambient clock: a
 * live session's elapsed time is the whole reason that parameter exists.
 */

const COLUMN_LABELS: Record<SortColumn, string> = {
  started_at: 'Started',
  project_path: 'Project',
  total_tokens: 'Tokens',
  est_cost: 'Cost',
};

export interface SessionListViewProps {
  rows: readonly Session[];
  sort: SortColumn;
  direction: SortDirection;
  onSortChange: (column: SortColumn) => void;
  /** The keyboard cursor's row, or `-1` for "not on a row". */
  cursor: number;
  now: number | Date;
}

export function SessionListView({
  rows,
  sort,
  direction,
  onSortChange,
  cursor,
  now,
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
      </div>

      {rows.map((session, index) => (
        <SessionRow key={session.id} session={session} now={now} isCursor={index === cursor} />
      ))}
    </div>
  );
}

function SortChevron({ direction }: { direction: SortDirection }) {
  const Glyph = direction === 'asc' ? ChevronUp : ChevronDown;
  return <Glyph size={12} aria-hidden="true" className="inline-block" />;
}

function SessionRow({
  session,
  now,
  isCursor,
}: {
  session: Session;
  now: number | Date;
  isCursor: boolean;
}) {
  const status = SESSION_STATUS_VISUALS[session.status];
  const degraded = CAPTURE_MODE_VISUALS[session.capture_mode];

  return (
    <a
      href={hrefFor({ name: 'session', sessionId: session.id })}
      data-slot="session-row"
      aria-label={`${session.project_path}, ${status.label}, started ${formatStartedAt(session.started_at, now)}`}
      className={cn(
        'flex h-9 items-center gap-3 border-b border-border px-3 text-xs text-foreground',
        isCursor && 'bg-surface-raised',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{session.project_path}</span>
      <span className="w-24 shrink-0 text-muted">{formatStartedAt(session.started_at, now)}</span>

      <span className={cn('flex w-24 shrink-0 items-center gap-1', status.badge)}>
        <span aria-hidden="true" className={cn('size-1.5 rounded-md', status.dot)} />
        {status.label}
      </span>

      {degraded === null ? null : (
        <span data-slot="degraded-chip" className={degraded.chip}>
          {degraded.label}
        </span>
      )}

      {session.error_count > 0 ? (
        <span data-slot="session-errors" className="font-mono text-2xs text-error">
          {session.error_count} err
        </span>
      ) : null}

      <MetricChip
        className="shrink-0"
        duration={formatDuration(session.started_at, session.ended_at, now)}
        tokens={`${formatTokens(session.total_tokens)} tok`}
        cost={formatCost(session.est_cost)}
      />
    </a>
  );
}
