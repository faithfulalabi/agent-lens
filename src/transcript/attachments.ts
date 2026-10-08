// One `attachment` line in, the two things it projects out: a subtype and a line
// of text. Pure and total — every field is read through `./accessors.js`, so this
// module declares no guards and no `try`/`catch` of its own.
//
// Three shapes measured against `~/.agent-lens/archive` (64 files, 6,134
// attachment lines, harness 2.1.277-2.1.284):
//
//   - **`rendered` is a ONE-ELEMENT ARRAY of `{ content: string }`, never a
//     string** — 4,181 of 4,181 occurrences, zero strings, every version in the
//     band. A reader that takes it for text answers the fallback on all of them.
//   - **`rendered` is ABSENT on 1,953 of 6,134 lines**, concentrated in
//     `deferred_tools_record`. So it cannot be the only text source: a third of
//     these lines would still project nothing to read.
//   - **`attachment.type` is present on 6,134 of 6,134.** It is the only
//     universal field, which is what makes a non-empty answer possible for every
//     line. It is passed through VERBATIM: 23 values live in the archive and two
//     more appear only in `fixtures/scrubbed/`, so the vocabulary is open and a
//     harness addition must render rather than be mapped to a default.
//
// `renderedInHumanTurn` is deliberately NOT READ. It is a second, different
// rendering of the same payload rather than a pointer to a turn — 69 of 69
// occurrences differ from the line's own `rendered`, 0 are identical — and which
// of the two the harness actually injected is undecidable from the line.

import { arr, obj, str } from './accessors.js';
import type { ParsedLine } from './line.js';

/** What an attachment line contributes to the one event it projects. */
export interface AttachmentRecord {
  /** `attachment.type` as sent. `''` means the line carried none. */
  readonly subtype: string;
  /** The harness's own rendering, or a placeholder naming the subtype. */
  readonly text: string;
}

const NO_ELEMENTS: readonly unknown[] = Object.freeze([]);

/**
 * `[attachment total_tokens_reminder]` — the honest stand-in when the harness
 * rendered nothing, on `imagePlaceholder`'s precedent in `./blocks.ts`. Degrades
 * to `[attachment]` rather than naming an empty subtype.
 */
function placeholder(subtype: string): string {
  return subtype === '' ? '[attachment]' : `[attachment ${subtype}]`;
}

/**
 * The subtype and text of one attachment line, or `undefined` for every other
 * kind. `text` is never empty, which is the whole point: an attachment line
 * carries no `message.content`, so without this the event it projects has
 * nothing to draw.
 */
export function attachmentRecord(line: ParsedLine): AttachmentRecord | undefined {
  if (line.kind !== 'attachment') return undefined;

  const subtype = str(obj(line.raw.attachment, undefined)?.type, '');
  const first = arr(line.raw.rendered, NO_ELEMENTS)[0];
  const rendered = str(obj(first, undefined)?.content, undefined);

  return { subtype, text: rendered ?? placeholder(subtype) };
}
