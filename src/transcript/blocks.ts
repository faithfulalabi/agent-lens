// One line's `message.content` in, one row per content block out. Pure and
// STATELESS: no accumulator, no grouping key, no clock, no I/O. Every field is
// read through `./accessors.js`, which is total, so this module declares no
// guards and no `try`/`catch` of its own — Task 2.1 owns that contract.
//
// Three traps this module exists to close, all measured against
// `~/.agent-lens/archive` on 2026-08-13 (262 files, 43,108 lines):
//
//   - **`message.content` is a BARE STRING on 549 lines**, every one of them a
//     `user` line, and several of them real human prompts. `normalizeContent`
//     turns the string into one `text` block once, at the top, so no call site
//     downstream has to remember the case. A projector that assumes an array
//     drops all 549 and re-ships plan 001's empty-session defect.
//   - **Every `thinking` block in the corpus is empty and signed — 6,698 of
//     6,698, no exceptions.** A naive projector renders 6,698 blank rows.
//     One `thinking_elided` marker per block instead: never a blank row, and
//     never zero, because dropping them hides that the model reasoned at all.
//   - **Images are the largest payloads in the corpus** (65.0 KB to 477.1 KB
//     decoded, 40 blocks). The base64 is read for its `.length` and dropped at
//     this boundary; it is never bound to anything that outlives the call.
//
// Nothing is ever dropped. An unrecognised block type becomes `unknown_block`
// carrying the type verbatim, so a harness change shows up in the product on the
// first session opened after the update.

import { arr, obj, str } from './accessors.js';
import type { ParsedLine } from './line.js';

/**
 * A `type: 'image'` content block. Declared HERE and not in `raw-types.ts`:
 * two hand-maintained inventories one file apart diverge on the first harness
 * update, and `raw-types.ts` never measured this shape.
 */
export interface RawImageBlock {
  type?: unknown;
  source?: unknown;
}

/** `image.source` — the measured keys are exactly these three. No size field. */
export interface RawImageSource {
  type?: unknown;
  media_type?: unknown;
  /** Base64. Read for its length only; it never crosses this boundary. */
  data?: unknown;
}

/** A `type: 'tool_reference'` block. Only ever inside a `tool_result` array. */
export interface RawToolReferenceBlock {
  type?: unknown;
  tool_name?: unknown;
}

/** Where a block was found. Position decides which kinds can exist at all. */
export type BlockPosition = 'top' | 'in_tool_result';

/** What an empty `thinking` block renders as. 100% of the corpus, today. */
export const THINKING_ELIDED_MARKER = 'reasoning not recorded (signature only)';

interface TextBlock {
  readonly kind: 'text';
  readonly text: string;
}

/** Reasoning the harness actually recorded. Zero occurrences so far. */
interface ThinkingBlock {
  readonly kind: 'thinking';
  readonly text: string;
}

/** Reasoning the harness withheld, keeping only the ~1 KB opaque signature. */
interface ThinkingElidedBlock {
  readonly kind: 'thinking_elided';
  readonly text: typeof THINKING_ELIDED_MARKER;
}

interface ToolUseBlock {
  readonly kind: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>> | undefined;
}

interface ToolResultBlock {
  readonly kind: 'tool_result';
  /**
   * The `tool_use` block this result answers. OUR name for it, deliberately not
   * the harness's: `src/__tests__/one-door.test.ts` greps for the harness string
   * outside this directory, so a consumer in `src/project/` reading a field of
   * that name would be born red for reading OUR type. It is our vocabulary
   * anyway — the joined row is `events.kind = 'tool_call'`.
   */
  readonly tool_call_id: string;
  readonly is_error: boolean;
  /**
   * The result's own blocks, hanging off the parent rather than sitting beside
   * it. That is what keeps blocks-in == rows-out exact at 1:1.
   */
  readonly children: readonly Block[];
}

/** The payload is gone by construction: a placeholder and a length, nothing else. */
interface ImageBlock {
  readonly kind: 'image';
  readonly media_type: string;
  readonly byte_length: number;
  readonly placeholder: string;
}

interface ToolReferenceBlock {
  readonly kind: 'tool_reference';
  readonly name: string;
}

/** A block agent-lens cannot name. It still renders; that is the entire point. */
interface UnknownBlock {
  readonly kind: 'unknown_block';
  /** The `type` as sent. `''` means the block carried none. */
  readonly raw_type: string;
}

export type Block =
  | TextBlock
  | ThinkingBlock
  | ThinkingElidedBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | ToolReferenceBlock
  | UnknownBlock;

/** Our name for a content block. `unknown_block` is a real kind, not a failure. */
export type BlockKind = Block['kind'];

/** Stands in for a block that was not an object, so every field is readable. */
const EMPTY_RECORD: Readonly<Record<string, unknown>> = Object.freeze({});

const NO_BLOCKS: readonly unknown[] = Object.freeze([]);

/** Decimal units, as a file manager reads a size. 1,000 KB is where MB starts. */
const BYTES_PER_KB = 1000;
const BYTES_PER_MB = 1_000_000;

/**
 * Content as an array of blocks, whatever shape it arrived in. A bare string
 * becomes one `text` block; anything that is neither string nor array becomes
 * no blocks at all.
 *
 * The third branch is defensive: `message.content` is only ever absent, a string
 * or an array across 43,108 measured lines.
 */
export function normalizeContent(content: unknown): readonly unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return arr(content, NO_BLOCKS);
}

/** The reference is a name only — the tool's own blocks are elsewhere on the line. */
function toolReferenceBlock(raw: RawToolReferenceBlock): ToolReferenceBlock {
  return { kind: 'tool_reference', name: str(raw.tool_name, '') };
}

/** `[image image/jpeg, 477.1 KB]` — one decimal, KB below 1,000 KB and MB above. */
function imagePlaceholder(mediaType: string, byteLength: number): string {
  const size =
    byteLength < BYTES_PER_MB
      ? `${(byteLength / BYTES_PER_KB).toFixed(1)} KB`
      : `${(byteLength / BYTES_PER_MB).toFixed(1)} MB`;
  return `[image ${mediaType}, ${size}]`;
}

/**
 * Decoded byte length from the base64 length, at 3/4. No size field exists in
 * the corpus, and the raw base64 length overstates a user-visible number by 33%.
 */
function imageBlock(raw: RawImageBlock): ImageBlock {
  const source: RawImageSource = obj(raw.source, EMPTY_RECORD);
  const media_type = str(source.media_type, '');
  const byte_length = (str(source.data, '').length * 3) / 4;
  return {
    kind: 'image',
    media_type,
    byte_length,
    placeholder: imagePlaceholder(media_type, byte_length),
  };
}

/**
 * Classify one content block. `position` is load-bearing in both directions:
 * `tool_reference` exists ONLY inside a `tool_result` (13 occurrences, 0 at top
 * level), and `tool_result` only at the top. The second half is what bounds
 * recursion at exactly one level without a depth counter — a nested
 * `tool_result` surfaces as `unknown_block` rather than being silently emptied.
 */
export function classifyBlock(raw: unknown, position: BlockPosition): Block {
  const block = obj(raw, EMPTY_RECORD);
  const type = str(block.type, '');

  switch (type) {
    case 'text':
      return { kind: 'text', text: str(block.text, '') };
    case 'thinking': {
      const text = str(block.thinking, '');
      return text === ''
        ? { kind: 'thinking_elided', text: THINKING_ELIDED_MARKER }
        : { kind: 'thinking', text };
    }
    case 'tool_use':
      return {
        kind: 'tool_use',
        id: str(block.id, ''),
        name: str(block.name, ''),
        input: obj(block.input, undefined),
      };
    case 'tool_result':
      if (position === 'top') {
        return {
          kind: 'tool_result',
          tool_call_id: str(block.tool_use_id, ''),
          is_error: block.is_error === true,
          // Through the same normaliser, so a bare-string content — 13,144 of
          // the 13,393 tool results — yields exactly one nested `text` child.
          children: normalizeContent(block.content).map((child) =>
            classifyBlock(child, 'in_tool_result'),
          ),
        };
      }
      break;
    case 'image':
      return imageBlock(block);
    case 'tool_reference':
      if (position === 'in_tool_result') return toolReferenceBlock(block);
      break;
  }

  return { kind: 'unknown_block', raw_type: type };
}

/** One row per top-level block of `content`. N blocks in is always N rows out. */
export function classifyContent(content: unknown): readonly Block[] {
  return normalizeContent(content).map((block) => classifyBlock(block, 'top'));
}

/**
 * A classified line's own top-level blocks. Empty for every line that carries
 * no message at all — 1,592 uuid-carrying lines measured, which still project a
 * row each, so an empty answer here is data and never an error.
 *
 * The one place the message payload is reached, so no caller outside this
 * directory has to name it.
 */
export function contentBlocks(line: ParsedLine): readonly Block[] {
  return classifyContent(obj(line.raw.message, undefined)?.content);
}
