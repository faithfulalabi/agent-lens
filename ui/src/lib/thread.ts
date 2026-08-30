/*
 * The pure thread model (Task 5.4): the same `EventRow[]` the tree groups by
 * `turn_id`, read straight through by `seq` instead.
 *
 * ===========================================================================
 * ONE ARRAY, TWO READERS, NO SECOND REQUEST.
 * ===========================================================================
 * `GET /api/sessions/:id` already answers every event with its content on the
 * wire, so the reading surface costs nothing the scanning surface has not
 * already paid for. `buildTurnGroups` takes the map; this takes the flat array
 * `session-data.ts` carries beside it. Neither calls the other.
 *
 * ===========================================================================
 * EVERY EVENT REACHES EXACTLY ONE ROW. NOTHING IS DROPPED.
 * ===========================================================================
 * All seven `EventKind`s are handled, and the four that are prose — `prompt`,
 * `text`, `error`, `compaction` — share one arm rather than being filtered out.
 * A `kind='unknown'` record draws a labelled row carrying its `raw_type` and
 * `raw_subtype` verbatim, which is how transcript format drift shows up in the
 * product on the first session opened after a harness update, instead of as a
 * silent hole found three months later.
 *
 * ===========================================================================
 * THE REASONING MARKER IS KEYED ON THE TEXT, NEVER ON THE KIND.
 * ===========================================================================
 * MEASURED: 8,047 of 8,047 `thinking` blocks were empty in the raw transcript
 * and `src/transcript/blocks.ts` already elided each to
 * {@link REASONING_NOT_RECORDED} at ingest — 1 distinct value on the wire, 0
 * null, 0 empty. So there are no blank rows to fold, and no fold key reduces the
 * count: the maximum number of `thinking` events per `request_id` is 1, and a
 * `thinking` event immediately following another one by `seq` happens 0 times
 * corpus-wide. A run fold would fold nothing, so none is shipped.
 *
 * What is NOT dead is the text key. The moment a harness records real reasoning
 * the projector will emit it, and a kind-keyed design would then print "not
 * recorded" over prose that WAS recorded — a lie the reader cannot detect.
 */

import type { EventRow } from './api.js';
import { PREVIEW_CHARS, previewOf } from './format.js';
import { eventKindOf, eventStatusOf, type EventKind, type EventStatus } from './turn-tree.js';

/** Which surface the session is being read on. */
export type SessionViewMode = 'tree' | 'thread';

/** Both surfaces, in the order their controls render. */
export const SESSION_VIEW_MODES: readonly SessionViewMode[] = ['tree', 'thread'];

/**
 * What `src/transcript/blocks.ts` writes in place of reasoning the harness kept
 * to itself. Spelled here rather than imported: the projector is server code and
 * the browser only ever sees the string on the wire.
 */
export const REASONING_NOT_RECORDED = 'reasoning not recorded (signature only)';

/**
 * How much of a tool payload the thread shows — deliberately MORE than the
 * tree's {@link PREVIEW_CHARS}.
 *
 * `tool_call` is 16,075 of 30,286 events, so clamping both surfaces at 96 would
 * make the reading surface render identically to the scanning surface on half
 * the corpus. Five times the budget is roughly five wrapped lines at the 14px
 * reading step: enough to read a command and its answer, short of pasting a
 * 64 KB body into a list with no window.
 */
export const THREAD_PREVIEW_CHARS = PREVIEW_CHARS * 5;

/** Which row renderer draws this event. Rendered as `data-thread-kind`. */
export type ThreadKind = 'message' | 'tool' | 'thinking' | 'unknown';

interface ThreadRowBase {
  /** The wire row this came from. Every row keeps its own source. */
  readonly event: EventRow;
  readonly kind: ThreadKind;
}

/** Prose at the reading step: a prompt, a reply, an error or a compaction. */
export interface ThreadMessageRow extends ThreadRowBase {
  readonly kind: 'message';
  /** The narrowed wire kind, so the row can name what it is showing. */
  readonly eventKind: EventKind;
  /** Verbatim and unclamped — this is the surface the reader came for. */
  readonly text: string | null;
}

/** One tool call: what was called, when, what went in, what came out. */
export interface ThreadToolRow extends ThreadRowBase {
  readonly kind: 'tool';
  readonly name: string;
  readonly status: EventStatus;
  readonly input: string | null;
  readonly output: string | null;
}

/** One `thinking` event. One row per event — see the header on the fold. */
export interface ThreadThinkingRow extends ThreadRowBase {
  readonly kind: 'thinking';
  /** Never empty: the marker when nothing was recorded, the prose when it was. */
  readonly text: string;
  /** False for the marker. True only once a harness starts recording reasoning. */
  readonly recorded: boolean;
}

/** A record this build does not understand, shown rather than swallowed. */
export interface ThreadUnknownRow extends ThreadRowBase {
  readonly kind: 'unknown';
  /** `unrecognized record (type=system/turn_duration)`. */
  readonly label: string;
  /** The wire row's own scalars as pretty JSON. There is no payload to show. */
  readonly record: string;
}

export type ThreadRow = ThreadMessageRow | ThreadToolRow | ThreadThinkingRow | ThreadUnknownRow;

/**
 * The session as one ordered read.
 *
 * Sorted by `seq` even though `src/db/read.ts` already orders by it: `seq` is
 * the only total order there is, and a belt costs one comparison per row.
 */
export function buildThread(events: readonly EventRow[]): ThreadRow[] {
  return [...events].sort((a, b) => a.seq - b.seq).map(rowFor);
}

function rowFor(event: EventRow): ThreadRow {
  const kind = eventKindOf(event.kind);
  switch (kind) {
    case 'tool_call':
      return {
        kind: 'tool',
        event,
        name: event.name ?? event.kind,
        status: eventStatusOf(event.status),
        input: previewOf(event.input, THREAD_PREVIEW_CHARS),
        output: previewOf(event.text, THREAD_PREVIEW_CHARS),
      };
    case 'thinking':
      return thinkingRow(event);
    case 'unknown':
      return {
        kind: 'unknown',
        event,
        label: `unrecognized record (type=${typeOf(event)})`,
        record: JSON.stringify(scalarsOf(event), null, 2),
      };
    default:
      return { kind: 'message', event, eventKind: kind, text: proseOf(event.text) };
  }
}

/**
 * The marker, or the reasoning itself once one exists.
 *
 * Real reasoning is clamped at the TREE's budget rather than the thread's. The
 * measured p99 of an unelided body is 209 KB, and reasoning nobody asked to see
 * should not be able to push a session's tool calls off the screen.
 */
function thinkingRow(event: EventRow): ThreadThinkingRow {
  const prose = previewOf(event.text);
  if (prose === null || prose === REASONING_NOT_RECORDED) {
    return { kind: 'thinking', event, text: REASONING_NOT_RECORDED, recorded: false };
  }
  return { kind: 'thinking', event, text: prose, recorded: true };
}

/** `system/turn_duration` when there is a sub-label, else the bare type. */
function typeOf(event: EventRow): string {
  const sub = event.raw_subtype;
  return sub === null || sub === '' ? event.raw_type : `${event.raw_type}/${sub}`;
}

/**
 * The wire row's own scalars — the whole disclosure, because there is nothing
 * else. MEASURED: all 1,577 `unknown` rows carry `text`, `name` and `input` null
 * with empty attributes, so the record IS these seven fields. Task 5.3's pane
 * owns payload disclosure; this shows what the row states about itself.
 */
function scalarsOf(event: EventRow): Record<string, string | number | null> {
  return {
    id: event.id,
    seq: event.seq,
    ts: event.ts,
    turn_id: event.turn_id,
    kind: event.kind,
    raw_type: event.raw_type,
    raw_subtype: event.raw_subtype,
  };
}

/** Prose kept whole, with an all-whitespace body reported as absent. */
function proseOf(text: string | null): string | null {
  if (text === null) return null;
  return text.trim() === '' ? null : text;
}
