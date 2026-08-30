/*
 * What the detail pane shows for one half of one event (Task 5.3, AC3).
 *
 * Pure, and that is the whole reason it exists. `ui/vitest.config.ts` runs the
 * UI project under `environment: 'node'`, so effects never fire and a refetch
 * can never be observed by a render test. Every decision the pane makes
 * therefore lives here as a three-argument function, and the pane itself is
 * props-in — the same split `lib/session-data.ts` and `lib/turn-tree.ts` state.
 *
 * ===========================================================================
 * THE BYTES CHECK RUNS BEFORE THE STORAGE CHECK, AND THAT ORDER IS THE POINT.
 * ===========================================================================
 * MEASURED over 30,286 `events` rows: `output_storage` is `inline` on 15,951,
 * NULL on 14,211, `absent` on 67, `spill` on 55, `missing` on 2 and `line_ref`
 * on none. A dispatch on the storage value ALONE gets two things wrong:
 *
 *   * Four values send NULL and `absent` to a default arm and blank 14,278 rows
 *     — 47.1% of the corpus, the exact defect this pane was written to remove.
 *   * Six values fix that and still blank 1,596: `src/content/resolve.ts:276`
 *     resolves NULL storage to `inline`, but 1,579 NULL rows hold no body at
 *     all and 17 `inline` rows carry the zero-length string. Every one of them
 *     would print a blank body under a confident label.
 *
 * So the first question is whether the column HOLDS BYTES. Only three storage
 * values explain their own emptiness by pointing somewhere else — `spill`,
 * `line_ref` and `missing` — and they keep their arms. Everything else with no
 * bytes is the `empty` arm.
 *
 * ===========================================================================
 * SIX ARMS. `absent` IS NOT ONE OF THEM.
 * ===========================================================================
 * Ruled at the 2026-08-30 gate. All 67 `absent` rows carry a null `text`, and
 * `src/content/resolve.ts:255-257` already merges NULL and `absent` into one
 * answer on the input half. Once the no-body sentence stops naming `raw_type`,
 * nothing is left to tell an `absent` column from an empty one — so `storageOf`
 * does not recognise `absent`, and it lands in the unclassified family with
 * NULL and with any value the schema gains later.
 */

import type { ContentField, EventContentBody, EventRow } from './api.js';

/**
 * `input_storage` / `output_storage`, narrowed the way `eventStatusOf` narrows
 * a status: a closed list, and one total fallback arm.
 *
 * `absent` is deliberately off the list — see the header. NULL is off it too,
 * because a projector that never classified a row and a projector that wrote a
 * word this build does not know are the same fact to a reader.
 */
export type ContentStorage = 'inline' | 'line_ref' | 'spill' | 'missing' | 'unclassified';

const CONTENT_STORAGES: readonly ContentStorage[] = ['inline', 'line_ref', 'spill', 'missing'];

/** The wire's storage word, narrowed. NULL, `absent` and the unknown all merge. */
export function storageOf(value: string | null): ContentStorage {
  return CONTENT_STORAGES.find((known) => known === value) ?? 'unclassified';
}

/**
 * What the pane draws. Six arms, and none of them is a loading or an error
 * state: the async matrix was cut from this task, so a failed refetch leaves
 * the preview standing and prints nothing new.
 */
export type ContentStateKind = ContentStorage | 'empty';

/**
 * `kind` doubles as the label the pane prints, so there is no second copy of
 * the vocabulary to drift: AC-R1 greps the rendered pane for the word naming
 * the row's `output_storage`, and this is that word.
 */
export interface ContentState {
  readonly kind: ContentStateKind;
  /** Why there is no body, or what the body is short of. Null when neither. */
  readonly note: string | null;
  /** The bytes to render, or null when the arm has none. */
  readonly body: string | null;
  /** True when `body` is a head preview rather than the whole field. */
  readonly truncated: boolean;
  /** True when `GET /api/events/:id/content` can still produce more. */
  readonly canRefetch: boolean;
}

/**
 * One sentence for every no-body case, and it names no `raw_type`.
 *
 * Ruled at the 2026-08-30 gate. The arm fires on the input half of all 14,211
 * rows whose `input` is null, and `raw_type` is `assistant` on 12,008 of them —
 * so 76% of the time the qualifier would print a word that tells a reader
 * nothing, and `attachment` and `system` are projector vocabulary rather than
 * anything the product ever taught the reader to expect.
 */
const NO_BODY = 'Nothing was recorded for this half.';

/**
 * A normal state, not a failure. Two rows of 30,286 reach it, and both
 * `src/content/resolve.ts:14-19` and `src/server/api.ts:460-467` answer 200 for
 * them — so the pane spends no error colour and no error glyph here.
 */
const GONE = 'Full output no longer on disk.';

const HEAD_PREVIEW = 'Showing the stored head of a larger body.';

const IN_FILE = 'The body was written to a file beside the transcript.';

/**
 * The state of one half of `event`, folding in a completed refetch.
 *
 * `fetched` is ignored unless it names this event AND this field, so a stale
 * body from the previously selected row can never be painted under the new one.
 */
export function contentStateOf(
  event: EventRow,
  field: ContentField,
  fetched: EventContentBody | null,
): ContentState {
  const folded = foldedBody(event, field, fetched);
  const value = folded === null ? columnOf(event, field) : folded.content;
  const storage = storageOf(folded === null ? columnStorageOf(event, field) : folded.storage);
  const hasBytes = value !== null && value !== '';

  switch (storage) {
    case 'missing':
      return state('missing', GONE, hasBytes ? value : null, false, false);

    case 'spill':
      // `src/project/tools.ts:160-162` nulls the column when it writes the file,
      // so a spill row has nothing to preview until the route reads it back.
      return state('spill', hasBytes ? null : IN_FILE, hasBytes ? value : null, false, !hasBytes);

    case 'line_ref': {
      // The stored 8 KB head (`src/project/tools.ts:53`). A refetch replaces it
      // whole, so the control retires the moment the full body is in hand.
      const short = folded === null || folded.truncated;
      return state('line_ref', short ? HEAD_PREVIEW : null, value, short, short);
    }

    default:
      // `inline` and `unclassified`: the column is the only source either has.
      return hasBytes
        ? state(storage, null, value, false, false)
        : state('empty', NO_BODY, null, false, false);
  }
}

function state(
  kind: ContentStateKind,
  note: string | null,
  body: string | null,
  truncated: boolean,
  canRefetch: boolean,
): ContentState {
  return { kind, note, body, truncated, canRefetch };
}

/** The refetched body, when it is about this event and this field. Else null. */
function foldedBody(
  event: EventRow,
  field: ContentField,
  fetched: EventContentBody | null,
): EventContentBody | null {
  if (fetched === null) return null;
  return fetched.id === event.id && fetched.field === field ? fetched : null;
}

function columnOf(event: EventRow, field: ContentField): string | null {
  return field === 'input' ? event.input : event.text;
}

function columnStorageOf(event: EventRow, field: ContentField): string | null {
  return field === 'input' ? event.input_storage : event.output_storage;
}
