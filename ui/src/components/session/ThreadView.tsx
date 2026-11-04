import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowDown,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  CircleX,
  Copy,
  List,
  Terminal,
  User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatEventTime } from '@/lib/format';
import { eventChips } from '@/lib/turn-tree';
import {
  activitySummary,
  errorClipboardText,
  groupThread,
  isFailedCall,
  type ThreadRow,
  type ThreadMessageRow,
  type ThreadToolRow,
} from '@/lib/thread';
import type { ApiClient, ContentField, EventContentBody, EventRow } from '@/lib/api';
import { contentStateOf } from '@/lib/event-content';
import { hrefFor } from '@/lib/route-match';
import { useEventImages } from '@/lib/use-event-images';
import { EventImages } from './EventImages';
import { RowChips } from './SpanRow';
import { SPAN_VISUALS } from './span-visuals';
import { MessageContent } from './MessageContent';

const OUTLINE_KEY = 'agent-lens:thread-outline';
const WASH = 'animate-[row-arrive_1.5s_ease-in]';
// Attachment subtypes whose text is code, so it must not be read as markdown.
const VERBATIM_RECORDS = new Set(['edited_text_file', 'file']);

function storedOutlineOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(OUTLINE_KEY) !== 'collapsed';
  } catch {
    return true;
  }
}

export interface ThreadViewProps {
  rows: readonly ThreadRow[];
  startedAt: string;
  api?: ApiClient;
  /** The header's error count, so a page cut short can say how many it is missing. */
  errorCount?: number;
}

/** A lossless transcript with a quiet default and explicit disclosure of activity. */
export function ThreadView({ rows, startedAt, api, errorCount }: ThreadViewProps) {
  const sections = useMemo(() => groupThread(rows), [rows]);
  // A pasted image is its own prompt row, but the outline lists the message once.
  const prompts = rows.filter(
    (row) => row.kind === 'message' && row.eventKind === 'prompt' && row.event.image_count === 0,
  );
  const scroller = useRef<HTMLDivElement>(null);
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(storedOutlineOpen);
  const hasOutline = prompts.length > 1;
  const failed = rows.filter(isFailedCall);
  const totalErrors = Math.max(errorCount ?? 0, failed.length);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const savedTop = useRef(0);

  function toggleErrors() {
    const el = scroller.current;
    const next = !errorsOnly;
    if (next && el) savedTop.current = el.scrollTop;
    flushSync(() => setErrorsOnly(next));
    // The scroller is scroll-smooth; restoring a position must not animate.
    el?.scrollTo({ top: next ? 0 : savedTop.current, behavior: 'instant' });
  }

  function jump(id: string) {
    flushSync(() => setErrorsOnly(false));
    const target = document.getElementById(`thread-${id}`);
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
    target?.classList.remove(WASH);
    void target?.offsetWidth; // reflow, so re-adding the class restarts the animation
    target?.classList.add(WASH);
    setActivePrompt(id);
  }

  function toggleOutline() {
    const next = !outlineOpen;
    setOutlineOpen(next);
    try {
      globalThis.localStorage?.setItem(OUTLINE_KEY, next ? 'expanded' : 'collapsed');
    } catch {
      // Storage blocked: the choice lasts until reload.
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-smooth">
        <div
          className={cn(
            'mx-auto max-w-3xl px-5 pb-16 pt-8 sm:px-8',
            hasOutline && !outlineOpen && 'lg:max-w-4xl',
          )}
        >
          <div className="sticky top-0 z-10 mb-7 flex items-center justify-between gap-4 bg-background py-2 text-xs text-muted">
            <span>
              Conversation <span className="px-2 text-faint">/</span> {prompts.length} prompts
            </span>
            <span className="flex items-center gap-4">
              {failed.length > 0 ? (
                <button
                  type="button"
                  aria-pressed={errorsOnly}
                  className={cn(
                    'flex items-center gap-1.5 hover:text-foreground',
                    errorsOnly && 'text-error',
                  )}
                  onClick={toggleErrors}
                >
                  <CircleX size={13} aria-hidden="true" />
                  {failed.length < totalErrors
                    ? `${failed.length} of ${totalErrors}`
                    : totalErrors}{' '}
                  {totalErrors === 1 ? 'error' : 'errors'}
                </button>
              ) : null}
              {hasOutline ? (
                <button
                  type="button"
                  aria-expanded={outlineOpen}
                  aria-controls="thread-outline"
                  className="hidden items-center gap-1.5 hover:text-foreground lg:flex"
                  onClick={toggleOutline}
                >
                  <List size={13} aria-hidden="true" /> {outlineOpen ? 'Hide' : 'Show'} outline
                </button>
              ) : null}
              <button
                type="button"
                className="flex items-center gap-1.5 hover:text-foreground"
                onClick={() => {
                  if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
                }}
              >
                <ArrowDown size={13} aria-hidden="true" /> Latest
              </button>
            </span>
          </div>
          {rows.length === 0 ? (
            <p className="py-12 text-center text-muted">No messages recorded yet.</p>
          ) : null}
          {errorsOnly ? <ErrorList rows={failed} startedAt={startedAt} api={api} /> : null}
          <ol
            data-slot="thread-view"
            hidden={errorsOnly}
            className="space-y-5 text-base text-foreground"
          >
            {sections.map((section) =>
              section.kind === 'message' ? (
                <li
                  key={section.id}
                  id={`thread-${section.id}`}
                  tabIndex={-1}
                  data-thread-kind="message"
                  data-event-id={section.id}
                  className="scroll-mt-12 rounded-md"
                >
                  <MessageRow row={section.row} startedAt={startedAt} api={api} />
                </li>
              ) : (
                <li key={section.id}>
                  <ActivityGroup rows={section.rows} startedAt={startedAt} api={api} />
                </li>
              ),
            )}
          </ol>
        </div>
      </div>
      {hasOutline && outlineOpen ? (
        <nav
          id="thread-outline"
          aria-label="Conversation outline"
          className="hidden w-60 shrink-0 overflow-y-auto border-l border-border px-4 py-8 lg:block"
        >
          <p className="mb-5 flex items-center gap-2 text-xs font-medium text-muted">
            <List size={14} aria-hidden="true" /> In this session
          </p>
          <ol className="space-y-1">
            {prompts.map((row, index) => (
              <li key={row.event.id}>
                <button
                  type="button"
                  onClick={() => jump(row.event.id)}
                  aria-current={activePrompt === row.event.id ? 'location' : undefined}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-md px-2 py-3 text-left text-xs transition-colors hover:bg-surface-raised hover:text-foreground',
                    activePrompt === row.event.id
                      ? 'bg-span-turn/10 text-foreground'
                      : 'text-muted',
                  )}
                >
                  <span className="font-mono text-2xs text-span-turn">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="line-clamp-3 break-words">
                    {row.kind === 'message' ? row.text || 'Empty prompt' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <p className="mt-6 border-t border-border pt-4 text-2xs leading-relaxed text-muted">
            Tool calls and reasoning are tucked into activity groups. Open any group to inspect the
            details.
          </p>
        </nav>
      ) : null}
    </div>
  );
}

/** Collapsed by default; its rows fetch their images only while it is open. */
function ActivityGroup({
  rows,
  startedAt,
  api,
}: {
  rows: readonly ThreadRow[];
  startedAt: string;
  api?: ApiClient;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-slot="thread-activity"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-md border border-dashed border-border bg-background"
    >
      <summary className="flex cursor-pointer items-center gap-2.5 px-4 py-3 text-xs text-muted transition-colors hover:text-foreground">
        <ChevronRight size={14} className="disclosure-chevron shrink-0" aria-hidden="true" />
        <Terminal size={14} className="shrink-0 text-span-tool" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium">Activity</span>
          <span className="mt-1 block text-2xs text-muted">{activitySummary(rows)}</span>
        </span>
        {rows.some(isFailedCall) ? <span className="shrink-0 text-error">Errors</span> : null}
        <span className="text-2xs text-faint">View activity</span>
      </summary>
      <ol className="border-t border-border px-4">
        {rows.map((row) => (
          <li
            key={row.event.id}
            data-thread-kind={row.kind}
            data-event-id={row.event.id}
            className="border-b border-border py-3 last:border-b-0"
          >
            <ActivityRow row={row} startedAt={startedAt} api={api} open={open} />
          </li>
        ))}
      </ol>
    </details>
  );
}

function RowTime({ ts, startedAt }: { ts: string; startedAt: string }) {
  return (
    <time dateTime={ts} className="shrink-0 font-mono text-2xs text-muted">
      {formatEventTime(ts, startedAt)}
    </time>
  );
}

function MessageRow({
  row,
  startedAt,
  api,
  open = true,
}: {
  row: ThreadMessageRow;
  startedAt: string;
  api?: ApiClient;
  open?: boolean;
}) {
  const prompt = row.eventKind === 'prompt';
  const isError = row.eventKind === 'error';
  const reply = row.eventKind === 'text';
  const label = prompt
    ? 'You'
    : row.eventKind === 'text'
      ? 'Claude'
      : row.eventKind === 'error'
        ? 'Session error'
        : 'Context compacted';
  const Icon = prompt ? User : Bot;
  return (
    <article
      className={cn(
        'rounded-md border px-5 py-4',
        prompt
          ? 'border-span-turn/30 bg-span-turn/10'
          : reply
            ? 'border-accent/30 bg-accent-muted'
            : 'border-border bg-surface',
        isError && 'border-error',
      )}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <span
          className={cn(
            'flex size-7 items-center justify-center rounded-md',
            prompt ? 'bg-span-turn/15 text-span-turn' : 'bg-accent-muted text-accent',
          )}
        >
          <Icon size={15} aria-hidden="true" />
        </span>
        <span
          className={cn(
            'flex-1 text-sm font-semibold',
            prompt ? 'text-span-turn' : reply ? 'text-accent' : 'text-foreground',
          )}
        >
          {label}
        </span>
        {prompt || reply ? (
          <span className="text-2xs text-muted">{prompt ? 'Prompt' : 'Message'}</span>
        ) : null}
        <RowTime ts={row.event.ts} startedAt={startedAt} />
      </div>
      {row.text === null ? (
        <p className="text-sm text-muted">No message text recorded.</p>
      ) : (
        <div data-slot="thread-message" className="text-base leading-relaxed">
          <MessageContent text={row.text} />
        </div>
      )}
      {open ? <ThreadImages event={row.event} api={api} /> : null}
    </article>
  );
}

export function ActivityRow({
  row,
  startedAt,
  api,
  open,
  expanded,
}: {
  row: ThreadRow;
  startedAt: string;
  api?: ApiClient;
  /** Whether the enclosing Activity group is open; images are fetched only while it is. */
  open: boolean;
  /** Open the tool call and load its full bodies without a click. */
  expanded?: boolean;
}) {
  if (row.kind === 'message')
    return <MessageRow row={row} startedAt={startedAt} api={api} open={open} />;
  if (row.kind === 'unknown')
    return (
      <div>
        <div className="flex items-center gap-3">
          <span
            data-slot="thread-unknown"
            className="min-w-0 flex-1 break-words text-xs text-muted"
          >
            {row.label}
          </span>
          {row.role === null ? null : (
            <span
              data-slot="thread-record-role"
              className="rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-muted"
            >
              {row.role}
            </span>
          )}
          <RowTime ts={row.event.ts} startedAt={startedAt} />
        </div>
        {row.text === null ? null : (
          <div data-slot="thread-record-text" className="mt-1 break-words text-xs text-muted">
            {VERBATIM_RECORDS.has(row.event.raw_subtype ?? '') ? (
              <p className="whitespace-pre-wrap">{row.text}</p>
            ) : (
              <MessageContent text={row.text} />
            )}
          </div>
        )}
        <details data-slot="thread-raw" className="mt-2 text-xs text-muted">
          <summary className="cursor-pointer">Raw record</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-2xs">
            {row.record}
          </pre>
        </details>
      </div>
    );
  if (row.kind === 'thinking')
    return row.recorded ? (
      <details data-slot="thread-reasoning" className="text-xs text-muted">
        <summary className="flex cursor-pointer items-center gap-2">
          <ChevronRight size={13} className="disclosure-chevron" aria-hidden="true" />
          <span className="flex-1">Reasoning</span>
          <RowTime ts={row.event.ts} startedAt={startedAt} />
        </summary>
        <div data-slot="thread-thinking" className="mt-3 text-sm text-foreground">
          <MessageContent text={row.event.text ?? ''} />
        </div>
        <FullPayload event={row.event} field="text" api={api} />
      </details>
    ) : (
      <div className="flex items-center gap-2">
        <p data-slot="thread-thinking" className="flex-1 text-xs text-span-thinking">
          {row.text}
        </p>
        <RowTime ts={row.event.ts} startedAt={startedAt} />
      </div>
    );
  const status = SPAN_VISUALS.status[row.status];
  return (
    <div>
      <details data-slot="thread-tool-detail" open={expanded} className="text-sm">
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-muted hover:text-foreground">
          <ChevronRight size={13} className="disclosure-chevron shrink-0" aria-hidden="true" />
          <span
            data-slot="thread-tool"
            className="min-w-0 flex-1 break-words font-mono text-foreground"
          >
            {row.name}
          </span>
          {row.event.child_session_id ? (
            <span className="text-2xs text-span-subagent">
              {row.event.agent_type || 'Subagent'}
            </span>
          ) : null}
          <span className={cn('text-2xs', status.tint)}>{status.label}</span>
          <RowTime ts={row.event.ts} startedAt={startedAt} />
          <RowChips values={eventChips(row.event)} showErrors={false} />
          {row.input ? (
            <span className="w-full truncate pl-5 font-mono text-2xs text-muted" title={row.input}>
              {row.input}
            </span>
          ) : null}
        </summary>
        <Payload slot="thread-input" title="Input" body={row.input} />
        <FullPayload event={row.event} field="input" api={api} expanded={expanded} />
        <Payload slot="thread-output" title="Output" body={row.output} />
        <FullPayload event={row.event} field="text" api={api} expanded={expanded} />
      </details>
      {open ? <ThreadImages event={row.event} api={api} /> : null}
      {row.event.child_session_id ? (
        <a
          href={hrefFor({ name: 'session', sessionId: row.event.child_session_id })}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent-muted px-3 py-2 text-xs text-accent hover:text-accent-hover"
        >
          <Bot size={14} aria-hidden="true" /> Open subagent thread{' '}
          <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

function ThreadImages({ event, api }: { event: EventRow; api?: ApiClient }) {
  const images = useEventImages(api, event);
  return <EventImages event={event} images={images} />;
}

function Payload({ slot, title, body }: { slot: string; title: string; body: string | null }) {
  if (body === null) return null;
  return (
    <div data-slot={slot} className="mt-3">
      <span className="text-2xs font-medium uppercase tracking-widest text-muted">{title}</span>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs text-muted">
        {body}
      </pre>
    </div>
  );
}

/** Full bodies reuse the content resolver, including explicit missing/error states. */
export function FullPayload({
  event,
  field,
  api,
  expanded,
  initialFetched = null,
}: {
  event: EventRow;
  field: ContentField;
  api?: ApiClient;
  expanded?: boolean;
  initialFetched?: EventContentBody | null;
}) {
  const [fetched, setFetched] = useState(initialFetched);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const content = contentStateOf(event, field, fetched);
  const showBody = fetched !== null || (content.body?.length ?? 0) > 480;

  function load() {
    if (!api) return;
    setPending(true);
    setError(false);
    void api
      .getEventContent(event.id, field)
      .then(setFetched)
      .catch(() => setError(true))
      .finally(() => setPending(false));
  }

  useEffect(() => {
    if (expanded && content.canRefetch) load();
  }, [expanded]);

  if (!content.canRefetch && !showBody && content.note === null) return null;
  if (content.kind === 'empty') return null;
  return (
    <div className="mt-2 text-xs text-muted">
      {content.note ? <p>{content.note}</p> : null}
      {content.canRefetch && api ? (
        <button
          type="button"
          disabled={pending}
          className="mt-2 text-accent disabled:opacity-50"
          onClick={load}
        >
          {pending
            ? 'Loading…'
            : error
              ? 'Retry loading full content'
              : `Load full ${field === 'input' ? 'input' : 'output'}`}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-error">
          Could not load content. Try again.
        </p>
      ) : null}
      {showBody && content.body !== null ? (
        <details open={expanded} className="mt-2">
          <summary className="cursor-pointer text-accent">
            {content.truncated ? 'Stored preview' : 'Full content'}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-3 font-mono text-xs">
            {content.body}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/** Must not carry `data-thread-kind`/`data-event-id`: the render gate counts one per event. */
export function ErrorList({
  rows,
  startedAt,
  api,
}: {
  rows: readonly ThreadToolRow[];
  startedAt: string;
  api?: ApiClient;
}) {
  return (
    <div className="space-y-3">
      <CopyButton label="Copy all errors" getText={() => errorClipboardText(rows, api)} />
      <ol data-slot="thread-errors" className="space-y-3">
        {rows.map((row) => (
          <li key={row.event.id} className="rounded-md border border-border px-4 py-3">
            <ActivityRow row={row} startedAt={startedAt} api={api} open expanded />
            <div className="mt-3">
              <CopyButton label="Copy error" getText={() => errorClipboardText([row], api)} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function CopyButton({ label, getText }: { label: string; getText: () => Promise<string> }) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const failed = result === 'failed';
  function copy() {
    void getText()
      .then((text) => navigator.clipboard.writeText(text))
      .then(
        () => setResult('copied'),
        () => setResult('failed'),
      )
      .finally(() => setTimeout(() => setResult(null), 1500));
  }
  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        'flex items-center gap-1.5 text-xs text-muted hover:text-foreground',
        failed && 'text-error',
      )}
    >
      {result === 'copied' ? (
        <Check size={13} aria-hidden="true" />
      ) : (
        <Copy size={13} aria-hidden="true" />
      )}
      {result === 'copied' ? 'Copied' : failed ? 'Copy failed' : label}
    </button>
  );
}
