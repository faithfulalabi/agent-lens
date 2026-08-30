import { cn } from '@/lib/utils';
import { formatEventTime } from '@/lib/format';
import { eventChips } from '@/lib/turn-tree';
import type {
  ThreadMessageRow,
  ThreadRow,
  ThreadThinkingRow,
  ThreadToolRow,
  ThreadUnknownRow,
} from '@/lib/thread';

import { RowChips } from './SpanRow';
import { SPAN_VISUALS, VISUAL_OF_KIND } from './span-visuals';

/*
 * The reading surface (Task 5.4), props-in — the session top to bottom in `seq`
 * order, against the tree's scanning surface.
 *
 * ===========================================================================
 * IT DECIDES NOTHING. `lib/thread.ts` DOES.
 * ===========================================================================
 * Which of the four row shapes an event becomes, what the reasoning marker says,
 * how an unrecognized record is labelled and how far a payload is clamped are
 * all settled before this file sees a row. The `ui` project runs under
 * `environment: 'node'`, so a decision made here would have nowhere to be
 * asserted — the same rule `EventDetail.tsx` and `lib/session-data.ts` state.
 *
 * ===========================================================================
 * NATIVE LIST ELEMENTS, AND NO VIRTUALIZER.
 * ===========================================================================
 * An `<ol>` of `<li>` needs no `role`: `role="list"` only counts when every
 * child sets `role="listitem"`, which would bind all four row renderers for
 * nothing a browser does not already do. And windowing would make the gate's
 * rendered-row count vacuous — fewer markers on screen than events would prove
 * the window, not the model. The largest measured session is 624 events
 * carrying roughly 220 KB of text once payloads are clamped, so every row is in
 * the document.
 *
 * ===========================================================================
 * TWO ATTRIBUTES PER ROW ARE PRODUCTION REQUIREMENTS.
 * ===========================================================================
 * `data-thread-kind` and `data-event-id` are how the render gate reads a THREAD
 * row. The pre-existing payload cross-check selects `data-event-kind`, which
 * `SpanRow` renders and nothing here does — so without these, AC-R1 would pass
 * with no thread row ever read.
 *
 * The type step is the spec's 14px reading step at line-height 1.45; chrome and
 * chips stay at 13px and 11px, and the quiet gray on the reasoning marker is the
 * span-thinking token the manifest already ships. No token is invented here.
 */

export interface ThreadViewProps {
  rows: readonly ThreadRow[];
  /**
   * The session's first timestamp. A row whose day differs from it is qualified
   * with that day: 11 of 293 sessions cross a calendar day, and on those a bare
   * wall clock reads as though the session ran backwards.
   */
  startedAt: string;
}

export function ThreadView({ rows, startedAt }: ThreadViewProps) {
  return (
    <ol
      data-slot="thread-view"
      className="min-h-0 flex-1 overflow-y-auto px-4 py-2 text-base text-foreground"
    >
      {rows.map((row) => (
        <li
          key={row.event.id}
          data-thread-kind={row.kind}
          data-event-id={row.event.id}
          className="border-b border-border py-3 last:border-b-0"
        >
          <Row row={row} startedAt={startedAt} />
        </li>
      ))}
    </ol>
  );
}

function Row({ row, startedAt }: { row: ThreadRow; startedAt: string }) {
  switch (row.kind) {
    case 'tool':
      return <ToolRow row={row} startedAt={startedAt} />;
    case 'thinking':
      return <ThinkingRow row={row} startedAt={startedAt} />;
    case 'unknown':
      return <UnknownRow row={row} startedAt={startedAt} />;
    default:
      return <MessageRow row={row} startedAt={startedAt} />;
  }
}

/**
 * When the event happened, as a real `<time>`.
 *
 * `formatStartedAt` cannot serve here: it answers `Nm ago` for anything inside
 * 24 hours, so every row of a same-day session would carry the identical string.
 */
function RowTime({ ts, startedAt }: { ts: string; startedAt: string }) {
  return (
    <time dateTime={ts} className="shrink-0 font-mono text-2xs text-faint">
      {formatEventTime(ts, startedAt)}
    </time>
  );
}

/** The prose arm: a prompt, a reply, an error or a compaction, unclamped. */
function MessageRow({ row, startedAt }: { row: ThreadMessageRow; startedAt: string }) {
  const visual = VISUAL_OF_KIND[row.eventKind];
  return (
    <>
      <div className="flex items-center gap-2">
        <span className={cn('shrink-0', visual.tint)}>
          <visual.Icon size={12} aria-hidden="true" />
        </span>
        {/* The wire's own word for the record, not a friendlier synonym. */}
        <span className="min-w-0 flex-1 truncate text-2xs tracking-widest text-muted">
          {row.eventKind}
        </span>
        <RowTime ts={row.event.ts} startedAt={startedAt} />
      </div>
      {row.text === null ? null : (
        <p data-slot="thread-message" className="mt-1 whitespace-pre-wrap break-words">
          {row.text}
        </p>
      )}
    </>
  );
}

/**
 * AC2's row: what was called, when it was called, what went in, what came out.
 *
 * The status word rides beside its tint because `design-system.md`'s baseline
 * forbids conveying status by colour alone, and the chips are `RowChips` — the
 * same atom the tree row and the turn header use, so one event cannot spell its
 * numbers two ways on two screens.
 */
function ToolRow({ row, startedAt }: { row: ThreadToolRow; startedAt: string }) {
  const type = SPAN_VISUALS.type.tool_call;
  const status = SPAN_VISUALS.status[row.status];
  return (
    <>
      <div className="flex items-center gap-2">
        <span className={cn('shrink-0', type.tint)}>
          <type.Icon size={12} aria-hidden="true" />
        </span>
        <span data-slot="thread-tool" className="min-w-0 flex-1 truncate font-mono text-sm">
          {row.name}
        </span>
        <span className={cn('shrink-0 text-2xs', status.tint)}>{status.label}</span>
        <RowTime ts={row.event.ts} startedAt={startedAt} />
        <span className="shrink-0">
          <RowChips values={eventChips(row.event)} showErrors={false} />
        </span>
      </div>
      <Payload slot="thread-input" title="INPUT" body={row.input} />
      <Payload slot="thread-output" title="OUTPUT" body={row.output} />
    </>
  );
}

function Payload({ slot, title, body }: { slot: string; title: string; body: string | null }) {
  if (body === null) return null;
  return (
    <div data-slot={slot} className="mt-2">
      <span className="text-2xs tracking-widest text-muted">{title}</span>
      <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-xs text-muted">
        {body}
      </pre>
    </div>
  );
}

/**
 * One `thinking` event, and the marker is terminal.
 *
 * There is nothing to open: the harness kept only an opaque signature, and no
 * column on the wire carries it. A disclosure here would promise a reader
 * something this build cannot produce.
 */
function ThinkingRow({ row, startedAt }: { row: ThreadThinkingRow; startedAt: string }) {
  const type = SPAN_VISUALS.type.thinking;
  return (
    <div className="flex items-center gap-2">
      <span className={cn('shrink-0', type.tint)}>
        <type.Icon size={12} aria-hidden="true" />
      </span>
      <p
        data-slot="thread-thinking"
        className={cn(
          'min-w-0 flex-1 break-words text-sm',
          row.recorded ? 'text-foreground' : 'text-span-thinking',
        )}
      >
        {row.text}
      </p>
      <RowTime ts={row.event.ts} startedAt={startedAt} />
    </div>
  );
}

/**
 * The drift alarm.
 *
 * A record this build does not recognise draws a labelled row naming its
 * `raw_type` and `raw_subtype`, so a transcript format change shows up in the
 * product on the first session opened after a harness update. The disclosure is
 * the wire row's own scalars: MEASURED, all 1,577 such rows carry no text, no
 * name and no input, so there is no payload to offer and no refetch to make.
 */
function UnknownRow({ row, startedAt }: { row: ThreadUnknownRow; startedAt: string }) {
  const type = SPAN_VISUALS.type.generic;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className={cn('shrink-0', type.tint)}>
          <type.Icon size={12} aria-hidden="true" />
        </span>
        <span data-slot="thread-unknown" className="min-w-0 flex-1 truncate text-sm text-muted">
          {row.label}
        </span>
        <RowTime ts={row.event.ts} startedAt={startedAt} />
      </div>
      <details data-slot="thread-raw" className="mt-1">
        <summary className="cursor-pointer text-2xs text-muted">Raw record</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-muted">
          {row.record}
        </pre>
      </details>
    </>
  );
}
