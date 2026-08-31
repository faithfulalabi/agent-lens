import type { ContentField, EventContentBody, EventRow } from '@/lib/api';
import { contentStateOf, type ContentState } from '@/lib/event-content';

/*
 * The right-hand pane for the selected event (Task 5.3), props-in.
 *
 * It answers the four questions the re-architecture exists for — what was
 * called, when, what went in, what came out — and it answers the fourth one
 * even when the answer is "nothing", because a pane that renders silence is the
 * same defect as the placeholder it replaces.
 *
 * ===========================================================================
 * IT DECIDES NOTHING. `lib/event-content.ts` DOES.
 * ===========================================================================
 * Which of the six states applies, whether a second request could produce more,
 * and what the preview shows meanwhile are all one pure function away. This
 * file calls it twice and turns the answer into JSX. The rule is the one
 * `lib/session-data.ts` states: the UI project has no DOM, so a decision that
 * lived here would have nowhere to be tested.
 *
 * ===========================================================================
 * TWO ATTRIBUTES ON THE ROOT ARE PRODUCTION REQUIREMENTS, NOT TEST AIDS.
 * ===========================================================================
 * `data-slot="span-detail"` is the render gate's `SELECTORS.spanDetail`, and
 * `src/render-gate/__tests__/render-gate.test.ts` greps `ui/src` for it — the
 * value moved here from the placeholder aside this task deleted, so three
 * detail assertions depend on this element carrying it.
 *
 * `data-event-id` is what lets the gate wait for the pane to CATCH UP with a
 * new selection. Without it the probe would read the pane on a bare timeout and
 * assert the previous event's body under the new event's row.
 *
 * The disclosure is a native `<details>`: closed by default, rendered
 * statically, and it adds no component to the library. The section headings say
 * INPUT and OUTPUT in the spec's dense-chip size, and every technical value —
 * the body, the storage word, the raw record — is mono, per the typography rule
 * that mono carries IDs, paths, JSON and code.
 */

/** Reads on the row that has no event. Must match neither dead placeholder. */
const NOTHING_SELECTED = 'No event is selected.';

export interface EventDetailProps {
  event: EventRow | null;
  /** A completed refetch, or null. Folded in by `contentStateOf`, not here. */
  fetched: EventContentBody | null;
  onShowFull?: (id: string, field: ContentField) => void;
}

export function EventDetail({ event, fetched, onShowFull }: EventDetailProps) {
  return (
    <aside
      data-slot="span-detail"
      {...(event === null ? {} : { 'data-event-id': event.id })}
      className="w-96 shrink-0 overflow-y-auto p-3 text-xs text-foreground"
    >
      {event === null ? (
        <p className="text-faint">{NOTHING_SELECTED}</p>
      ) : (
        <>
          <EventHeading event={event} />
          <ContentSection
            event={event}
            field="input"
            title="INPUT"
            fetched={fetched}
            onShowFull={onShowFull}
          />
          <ContentSection
            event={event}
            field="text"
            title="OUTPUT"
            fetched={fetched}
            onShowFull={onShowFull}
          />
          <RawRecord event={event} />
        </>
      )}
    </aside>
  );
}

function EventHeading({ event }: { event: EventRow }) {
  return (
    <header data-slot="detail-heading" className="border-b border-border pb-2">
      <p className="truncate font-mono text-sm">{event.name ?? event.kind}</p>
      <p className="truncate font-mono text-2xs text-faint">{event.ts}</p>
    </header>
  );
}

function ContentSection({
  event,
  field,
  title,
  fetched,
  onShowFull,
}: {
  event: EventRow;
  field: ContentField;
  title: string;
  fetched: EventContentBody | null;
  onShowFull?: (id: string, field: ContentField) => void;
}) {
  const content = contentStateOf(event, field, fetched);

  return (
    <section data-slot={`detail-${field}`} data-content-state={content.kind} className="pt-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-2xs tracking-widest text-muted">{title}</h2>
        <StorageLabel content={content} />
      </div>
      <Body content={content} />
      {content.canRefetch && onShowFull !== undefined ? (
        <button
          type="button"
          data-slot="detail-show-full"
          onClick={() => onShowFull(event.id, field)}
          className="mt-1 font-mono text-2xs text-accent"
        >
          Show full
        </button>
      ) : null}
    </section>
  );
}

/**
 * The storage word, printed verbatim rather than translated.
 *
 * AC-R1 greps the rendered pane for the word naming the row's `output_storage`,
 * so a friendlier synonym here would fail the gate — and the word is the honest
 * answer to "where did this come from" in any case.
 */
function StorageLabel({ content }: { content: ContentState }) {
  return (
    <span
      data-slot="detail-storage"
      className="rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-muted"
    >
      {content.kind}
    </span>
  );
}

function Body({ content }: { content: ContentState }) {
  return (
    <>
      {content.note === null ? null : (
        <p data-slot="detail-note" className="pt-1 text-2xs text-faint">
          {content.note}
        </p>
      )}
      {content.body === null ? null : (
        <pre
          data-slot="detail-body"
          className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-foreground"
        >
          {content.body}
        </pre>
      )}
    </>
  );
}

/**
 * The stored record, verbatim and closed.
 *
 * `JSON.stringify` over the whole row rather than a chosen subset: the point of
 * a raw disclosure is that it shows what the pane above it decided to summarise,
 * and a curated one would hide exactly the field somebody opened it to find.
 *
 * ponytail: the row is serialised on every render, even while the disclosure is
 * closed, so a p99 body is written into the DOM twice. Measured at 36 KiB that
 * costs nothing worth code. Move it behind the `open` state if a body ever
 * arrives that makes selection feel slow.
 */
function RawRecord({ event }: { event: EventRow }) {
  return (
    <details data-slot="detail-raw" className="mt-3 border-t border-border pt-2">
      <summary className="cursor-pointer text-2xs text-muted">Raw record</summary>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-muted">
        {JSON.stringify(event, null, 2)}
      </pre>
    </details>
  );
}
