// The tool join: a `tool_use` and its `tool_result` become ONE `events` row.
// What was called, when, the input, the output, the status and the duration are
// one row and one render, which is what deletes `spans` and `messages` from the
// old model.
//
// Pure, like the rest of this tree: no filesystem, no clock, no randomness. Every
// harness-supplied name is read through `../transcript/`, so this module names
// none of them.
//
// FOUR RULES DO THE WORK, and each exists because the obvious version is wrong:
//
//   1. **`status` is `error` iff `is_error === true`, and `denied` outranks it.**
//      The flag is ABSENT on 6,096 results, so any `!is_error` reading marks
//      thousands of successful calls as failures. All 8 measured denials also
//      carry `is_error: true`, so a ladder that tests the flag first labels 8 of
//      8 denials wrongly.
//   2. **The spill marker beats the size rule.** All 61 spill claims measure
//      1,480–6,286 bytes, far under the inline cap, so the size rule alone would
//      publish `"<persisted-output>\nOutput too large (59.4KB)…"` as if it were
//      the tool's output — harness metadata rendered as a result.
//   3. **The Agent back-patch is GATED ON THE TOOL NAME.** `<task-notification>`
//      is not Agent-exclusive: 5 of 158 name a `Bash`, `SendMessage` or
//      `Workflow` row, every one of them carrying real output, and both `Bash`
//      targets carry no `<result>` tag at all. A name-blind patch overwrites 290
//      bytes of genuine output with nothing, twice.
//   4. **A negative elapsed clamps to 0.** See `elapsedMs`.
//
// The duration is labelled `elapsed` and the UI must NEVER call it "execution":
// a 61 ms `Bash` reads 8,063 ms elapsed because a human sat on the approval
// dialog. A labelled approximation beats a precise-looking lie (RFC §4).

import type { DriftCounter } from '../transcript/drift.js';
import {
  type AsyncAgentLaunch,
  claimsPersistedOutput,
  type TaskNotification,
} from '../transcript/agents.js';
// `pipeline.ts` imports this module back: the two files are one projector split
// for size, so the dependency is mutual by design. Safe because nothing here
// reads a `pipeline.ts` binding at module-evaluation time — `epochMs` is called
// only from inside a function body. Do not move a call to it to the top level.
import { epochMs, type ProjectedEvent } from './pipeline.js';

/**
 * Byte size at or under which a payload is stored in the row itself. Declared
 * here rather than in `src/config.ts`, which the data model names as its
 * eventual home: that file does not exist and no task in this plan creates it,
 * and this is the only module that reads either constant.
 */
export const INLINE_MAX = 65536;

/** Head kept in the row when a payload is too big to store whole. */
export const PREVIEW_MAX = 8192;

/** What the harness said about one `tool_use`, gathered in the projector's first pass. */
export interface ToolResult {
  /** The result's own text, extracted. Never the raw line. */
  text: string;
  /** Already `=== true` exactly, decided at classification. */
  is_error: boolean;
  /** The refusal reason the RESULT LINE carried, when the call was refused. */
  denial: string | undefined;
  /** Set when this result announces a background launch rather than an answer. */
  launch: AsyncAgentLaunch | undefined;
  /** The result line's own timestamp, for the elapsed subtraction. */
  ts: string;
  /** The RESULT line's byte pair, and the block's index inside that line. */
  result_offset: number;
  result_len: number;
  result_block: number;
}

/** The input columns, which a row carries whether or not it ever joined. */
export interface ProjectedInput {
  input: string | undefined;
  input_bytes: number | undefined;
  /** Undefined on every row that is not a tool call — never `'absent'`. */
  input_storage: 'inline' | 'line_ref' | 'absent' | undefined;
}

/** What a row that is not a tool call carries: "does not apply", not "was empty". */
export const NO_INPUT: ProjectedInput = Object.freeze({
  input: undefined,
  input_bytes: undefined,
  input_storage: undefined,
});

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * A `PREVIEW_MAX`-BYTE head, cut on a character boundary. Slicing by characters
 * would be up to 4x over budget on the emoji this corpus is full of, and cutting
 * the encoded bytes blindly would end the preview in a replacement character.
 */
function headPreview(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= PREVIEW_MAX) return text;

  let cut = PREVIEW_MAX;
  // `0b10xxxxxx` is a continuation byte, so the character before the cut is
  // split: back up until the cut lands on a character start.
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut).toString('utf8');
}

/**
 * The three storage clauses, over a tool call's input. `absent` means the
 * `tool_use` carried no input at all — legal, and unwitnessed in 15,220 blocks.
 *
 * A `line_ref` input needs no coordinate column of its own: the resolver reads
 * `src_offset`/`src_len` and then indexes the row's own `block_index`, both of
 * which a tool call already carries.
 */
export function toolInput(input: Readonly<Record<string, unknown>> | undefined): ProjectedInput {
  if (input === undefined) {
    return { input: undefined, input_bytes: undefined, input_storage: 'absent' };
  }

  const text = JSON.stringify(input);
  const bytes = byteLength(text);
  return bytes > INLINE_MAX
    ? { input: headPreview(text), input_bytes: bytes, input_storage: 'line_ref' }
    : { input: text, input_bytes: bytes, input_storage: 'inline' };
}

/**
 * How long the call took, as measured by two harness stamps.
 *
 * ponytail: CEILING — a result stamped before its own call clamps to 0 rather
 * than publishing a negative elapsed. 0 negatives measured over 15,220 pairs, so
 * this is policy for an unwitnessed case and not a fix for a live one; it is
 * written as a comparison because this tree bans the arithmetic global that
 * would otherwise supply a maximum. Upgrade path: when the harness is shown to
 * emit descending pairs at volume, promote the clamp to a `duration_source` arm
 * of its own and let the UI label it instead of flattening it.
 */
function elapsedMs(call: string, result: string): number {
  const ms = epochMs(result) - epochMs(call);
  return ms < 0 ? 0 : ms;
}

/** The ladder, in order. `denied` before `error`: all 8 denials are errors too. */
function statusOf(result: ToolResult): 'ok' | 'error' | 'denied' {
  if (result.denial !== undefined) return 'denied';
  return result.is_error ? 'error' : 'ok';
}

/** The output clauses, spill first. Writes onto the row the call already owns. */
function storeOutput(event: ProjectedEvent, text: string): void {
  const bytes = byteLength(text);
  event.text_bytes = bytes;

  if (claimsPersistedOutput(text)) {
    // The size never gets a vote: every claim measured sits under the cap, and
    // `text_bytes` sizes the marker block so the writer has a number before it
    // resolves anything. `spill_path` stays undefined — resolving it needs the
    // filesystem, which this tree cannot reach and must not fabricate around.
    event.output_storage = 'spill';
    event.text = undefined;
    return;
  }

  if (bytes > INLINE_MAX) {
    event.output_storage = 'line_ref';
    event.text = headPreview(text);
    return;
  }

  event.output_storage = 'inline';
  event.text = text;
}

/**
 * A background `Agent` row's real answer, copied off the notification that
 * carries it — or a labelled unknown when none did.
 *
 * The row stays `output_storage='inline'` and keeps `result_*` pointing at the
 * RESULT line: those coordinates mean "where this call's `tool_result` lives",
 * which is what the resolver needs, and the notification's own line is already a
 * first-class row of its own. Every measured payload is 50 B – 59,374 B, all
 * under the cap, so `inline` is a measured fact rather than a shortcut.
 */
function backPatch(event: ProjectedEvent, notification: TaskNotification | undefined): void {
  const payload = notification?.result;
  if (payload === undefined) {
    // The launch succeeded and the outcome is unknown. This deliberately
    // OVERRIDES the ladder's `ok`: a labelled state beats a precise-looking lie,
    // and the one thing that must never happen is publishing the launch
    // boilerplate as if it were the agent's answer.
    event.text = undefined;
    event.text_bytes = undefined;
    event.output_storage = 'absent';
    event.status = 'running';
    event.agent_status = 'running';
    return;
  }

  event.text = payload;
  event.text_bytes = byteLength(payload);
  event.output_storage = 'inline';
  event.agent_status = notification?.status;
}

/**
 * Fold every `tool_result` into the row its `tool_use` already opened.
 *
 * Mutates the rows IN PLACE and adds, removes, reorders and re-parents nothing,
 * so every turn window and the whole-file census stay valid untouched. The join
 * key is the id `runPipeline` already mints for a tool call, so this is an index
 * lookup rather than a search.
 *
 * The back-patch is why this cannot happen during emission: an `Agent` launched
 * in turn 3 is answered by a notification in turn 17.
 */
export function joinToolCalls(
  events: readonly ProjectedEvent[],
  results: ReadonlyMap<string, ToolResult>,
  notifications: readonly TaskNotification[],
  drift: DriftCounter,
): void {
  // Last notification wins: the harness states outright that one agent may
  // notify more than once, and the newest answer is the one to publish.
  const answers = new Map(
    notifications.flatMap((entry) =>
      entry.toolCallId === undefined ? [] : [[entry.toolCallId, entry] as const],
    ),
  );

  for (const event of events) {
    if (event.kind !== 'tool_call') continue;

    const result = results.get(event.id);
    if (result === undefined) {
      // The row keeps the in-flight state emission gave it. Counted, because an
      // unjoined call is the one drift that otherwise renders as normal.
      drift.noteUnjoinedToolUse();
      continue;
    }

    event.result_offset = result.result_offset;
    event.result_len = result.result_len;
    event.result_block = result.result_block;
    event.duration_ms = elapsedMs(event.ts, result.ts);
    event.duration_source = 'elapsed';
    event.status = statusOf(result);

    if (event.name === 'Agent' && result.launch !== undefined) {
      backPatch(event, answers.get(event.id));
      continue;
    }
    storeOutput(event, result.text);
  }
}
