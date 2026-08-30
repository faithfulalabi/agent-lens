// `ParsedLine[]` in, `{ header, turns, events, drift }` out. The whole projector,
// and PURE: no filesystem, no database, no clock, no randomness. Purity is what
// makes "reprojecting a whole file is byte-identical to projecting it cold" true,
// which is in turn what makes a live tail safe to splice (RFC §8).
//
// TWO PASSES, AND NO TREE. Pass one reads everything and emits nothing; pass two
// emits, using aggregates pass one computed over the whole array. That is what
// dissolves out-of-order input without a single special case: a turn starts at the
// MIN of its timestamps rather than the first one seen, token totals come from a
// completed group fold rather than a running sum, and no line's parentage is
// consulted at all. Re-measured 2026-08-14, the archive holds 0 late parents and 0
// results preceding their own call — extinct, which is unwitnessed rather than
// impossible, so the guard survives as synthetic fixtures instead.
//
// Then ONE join, after the turns exist. `./tools.ts` folds each `tool_result`
// onto the row its `tool_use` already opened, which is why a tool call is one row
// and not two. It runs last because the async `Agent` back-patch is CROSS-TURN.
//
// Turn boundaries come from ONE variable moving forward. The 128-hop ancestor walk
// this replaces was proved EQUIVALENT, not approximately equivalent — 40,214
// agreements and 0 disagreements — so it is deleted rather than kept as a fallback
// that never fires and outlives its own proof.
//
// Every harness-supplied name is read through `../transcript/`, so this module
// names none of them. `src/__tests__/one-door.test.ts` enforces that.

import { asyncAgentLaunch, taskNotification, type TaskNotification } from '../transcript/agents.js';
import { type Block, contentBlocks } from '../transcript/blocks.js';
import type { DriftCounter } from '../transcript/drift.js';
import { isHumanPrompt, MACHINERY_TAGS } from '../transcript/human.js';
import {
  foldControlLines,
  foldSessionEnvelope,
  type ParsedLine,
  promptGroupId,
  toolDenialKind,
  turnDurationMs,
} from '../transcript/line.js';
import {
  foldRequestGroup,
  type FoldedUsage,
  groupByRequestId,
  requestIdOf,
} from '../transcript/usage.js';
import {
  joinToolCalls,
  NO_INPUT,
  type ProjectedInput,
  toolInput,
  type ToolResult,
} from './tools.js';

/** What opened a turn. Every arm is reachable and each is pinned by a fixture. */
export type TurnKind =
  'human' | 'task_notification' | 'slash_command' | 'compaction' | 'system' | 'unknown';

/** What the UI draws. `unknown` is a real kind, so a new harness shape still renders. */
export type EventKind =
  'prompt' | 'text' | 'thinking' | 'tool_call' | 'error' | 'compaction' | 'unknown';

export type DurationSource = 'turn_duration' | 'derived';

/** The `sessions` row for a file that projected something. */
export interface SessionHeader {
  session_id: string;
  project_path: string | undefined;
  git_branch: string | undefined;
  harness_version: string | undefined;
  model: string | undefined;
  /** The LAST free title the harness wrote, never the first. */
  title: string | undefined;
  /** The first HUMAN prompt, never the first user line. */
  preview: string | undefined;
  started_at: string;
  last_activity_at: string;
}

/** One `turns` row: a prompt group and the event window it owns. */
export interface ProjectedTurn {
  id: string;
  session_id: string;
  seq: number;
  kind: TurnKind;
  /**
   * The `Agent` call this machinery turn answers, or absent. Set only for
   * `task_notification`, and only when the call it names is an `Agent`.
   */
  parent_event_id: string | undefined;
  title: string;
  started_at: string;
  ended_at: string;
  duration_ms: number | undefined;
  duration_source: DurationSource;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tool_call_count: number;
  error_count: number;
  first_seq: number;
  last_seq: number;
}

/** One `events` row: one thing the UI draws, in file order. */
export interface ProjectedEvent extends ProjectedInput {
  id: string;
  session_id: string;
  turn_id: string;
  seq: number;
  kind: EventKind;
  ts: string;
  request_id: string | undefined;
  block_index: number;
  /** The tool's name, on a `tool_call` row. */
  name: string | undefined;
  /** `running` until the join answers this call — or forever, if none does. */
  status: 'ok' | 'error' | 'denied' | 'running' | undefined;
  /** Wall clock between the two stamps, not the tool's own run time. */
  duration_ms: number | undefined;
  /**
   * Its own enum, NOT `ProjectedTurn`'s: `elapsed` answers "how was this tool
   * call timed", `turn_duration`/`derived` answers "how was this turn timed",
   * and merging the two columns would merge two different questions.
   *
   * `sidecar_span` is the sub-agent's OWN first-to-last stamp, written by
   * `./subagents.ts` over the row this call already owns. It replaces an
   * `elapsed` that measured the launch handshake — 40 ms at its smallest — and
   * never the time the agent worked.
   */
  duration_source: 'elapsed' | 'sidecar_span' | undefined;
  /** The sidecar `sessions` row this `Agent` call started. `./subagents.ts` fills it. */
  child_session_id: string | undefined;
  /** The sub-agent's kind, copied off its own meta header. */
  agent_type: string | undefined;
  /** Prose, reasoning, the image placeholder — or a tool call's output. */
  text: string | undefined;
  /** TRUE bytes of a tool call's output, never the preview's. Nothing sizes prose. */
  text_bytes: number | undefined;
  output_storage: 'inline' | 'line_ref' | 'spill' | 'absent' | undefined;
  /** The writer's to fill: resolving a spill needs the filesystem. */
  spill_path: string | undefined;
  /** The notification's `<status>` for a background `Agent` row. */
  agent_status: string | undefined;
  /** The EMITTING LINE's coordinates, never the block's. See `emit`. */
  src_offset: number;
  src_len: number;
  /** The `tool_result` LINE's pair, and the result block's index inside it. */
  result_offset: number | undefined;
  result_len: number | undefined;
  result_block: number | undefined;
  tokens_in: number | undefined;
  tokens_out: number | undefined;
  tokens_cache_read: number | undefined;
  tokens_cache_write: number | undefined;
  raw_type: string;
  raw_subtype: string | undefined;
  attrs: string;
}

/**
 * The one counter for the file, and the session id to stamp rows with.
 *
 * `drift` is the caller's own instance because `sessions.drift_json` is ONE
 * column and `DriftCounter` has no merge — a second counter could never be joined
 * to the one `classifyLine` already filled during the parse pass.
 */
export interface PipelineContext {
  session_id: string;
  drift: DriftCounter;
}

export interface Projection {
  /** Absent when the file projected nothing: then it is not a session at all. */
  header: SessionHeader | undefined;
  turns: readonly ProjectedTurn[];
  events: readonly ProjectedEvent[];
  /**
   * `sessions.drift_json` AS OF THE END OF THIS CALL — advisory for any caller
   * that goes on mutating the counter it passed in. `db/write.ts` links the
   * sidecars after this returns, so it re-serializes its own live counter rather
   * than shipping this snapshot.
   */
  drift: string;
  /**
   * A tool call's id to the id of the agent its launch named, for the launches
   * that named one. Both halves are read through `../transcript/agents.js`.
   *
   * Returned rather than stamped on the row: every `ProjectedEvent` field maps
   * to a column, and this id would either need one of its own or would pre-fill
   * `child_session_id` with a pointer to a `sessions` row that may not exist.
   * The sidecar linker takes it as a CROSS-CHECK — 41 of 258 measured `Agent`
   * calls are synchronous and appear here not at all.
   */
  launches: ReadonlyMap<string, string>;
}

/** `turns.title` and `sessions.preview` are both capped here. */
const MAX_TITLE_CHARS = 200;

const NO_BLOCKS: readonly Block[] = Object.freeze([]);

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;
const DAYS_PER_ERA = 146_097;
/** Days from 0000-03-01 to 1970-01-01, the era algorithm's shift. */
const DAYS_TO_EPOCH = 719_468;

/**
 * `YYYY-MM-DDTHH:MM:SS.sssZ` to milliseconds since the epoch, by fixed-width
 * slice plus the civil-to-days era algorithm.
 *
 * Hand-rolled because this tree names no clock AT ALL, which is a fact a reader
 * checks at a glance where "only the parser, never the reader" is a judgement that
 * rots — and purity is the whole claim this module makes. Verified against the
 * platform's own parser over all 42,044 archived timestamps and 17 boundary cases
 * (the epoch, year 1, the 1600/1900/2000/2100/2400 century rules, Feb 29, and
 * month, year and millisecond boundaries): 0 mismatches. `| 0` stands in for
 * integer division because the same self-imposed ban covers the arithmetic global;
 * the largest intermediate is ~730,485, three orders below where that truncation
 * would stop being exact.
 *
 * ponytail: CEILING — the 24-character all-`Z` shape, measured 42,044 of 42,044
 * top-level timestamps. A `±HH:MM` zone or a fractional part that is not three
 * digits slices wrongly HERE and orders wrongly in every string compare below, so
 * one assumption carries both. Upgrade path: normalize once inside
 * `../transcript/`, where the harness vocabulary already lives — never by reaching
 * for the platform parser. `__tests__/archive-pipeline.test.ts` reds as a drift
 * alarm the day the shape stops holding, so this is monitored and not merely
 * written down.
 */
export function epochMs(ts: string): number {
  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(5, 7));
  const day = Number(ts.slice(8, 10));

  const shifted = year - (month <= 2 ? 1 : 0);
  const era = ((shifted >= 0 ? shifted : shifted - 399) / 400) | 0;
  const yearOfEra = shifted - era * 400;
  const dayOfYear = (((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) | 0) + day - 1;
  const dayOfEra = yearOfEra * 365 + ((yearOfEra / 4) | 0) - ((yearOfEra / 100) | 0) + dayOfYear;
  const days = era * DAYS_PER_ERA + dayOfEra - DAYS_TO_EPOCH;

  return (
    days * MS_PER_DAY +
    Number(ts.slice(11, 13)) * MS_PER_HOUR +
    Number(ts.slice(14, 16)) * MS_PER_MINUTE +
    Number(ts.slice(17, 19)) * MS_PER_SECOND +
    Number(ts.slice(20, 23))
  );
}

/** A line's top-level prose, joined. The one text source for titles and previews. */
function prose(blocks: readonly Block[]): string {
  return blocks
    .flatMap((block) => (block.kind === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

/**
 * A tool result's own text, from the blocks hanging off it. Joined but NEVER
 * trimmed, unlike `prose`: both marker predicates test index 0 and `text_bytes`
 * is a size, so a stripped leading space would change all three answers.
 */
function resultText(children: readonly Block[]): string {
  return children.flatMap((child) => (child.kind === 'text' ? [child.text] : [])).join('\n');
}

/** What a block renders as. A tool call's output is the join's, never a block's. */
function blockText(block: Block | undefined): string | undefined {
  switch (block?.kind) {
    case 'text':
    case 'thinking':
    case 'thinking_elided':
      return block.text;
    case 'image':
      // The placeholder IS the renderable content; the base64 never leaves blocks.ts.
      return block.placeholder;
    default:
      return undefined;
  }
}

/**
 * A block's kind, then the line's own. Anything unnamed falls through to
 * `unknown` carrying the harness's verbatim type, which is why a future harness
 * shape renders without a code change and why no literal type name appears here.
 */
function eventKind(line: ParsedLine, block: Block | undefined, human: boolean): EventKind {
  switch (block?.kind) {
    case 'text':
      return human ? 'prompt' : 'text';
    case 'thinking':
    case 'thinking_elided':
      return 'thinking';
    case 'tool_use':
      return 'tool_call';
    case 'image':
      return 'text';
  }

  if (line.kind === 'system') {
    if (line.subtype === 'compact_boundary') return 'compaction';
    if (line.subtype === 'api_error') return 'error';
  }
  return 'unknown';
}

/** The harness's own `type`, verbatim. The 1:1 kind table makes this total. */
function rawTypeOf(line: ParsedLine): string {
  return line.kind === 'unknown' ? line.raw_type : line.kind;
}

function rawSubtypeOf(line: ParsedLine): string | undefined {
  if (line.kind === 'unknown') return line.raw_subtype;
  return line.kind === 'system' ? line.subtype : undefined;
}

/** The ladder, in order. `MACHINERY_TAGS` decides the middle two, not a second regex. */
function turnKind(lead: ParsedLine, human: boolean, text: string, compacted: boolean): TurnKind {
  if (human) return 'human';

  const tag = MACHINERY_TAGS.find((candidate) => text.startsWith(candidate));
  if (tag === '<task-notification>') return 'task_notification';
  if (tag === '<command-name>' || tag === '<command-message>') return 'slash_command';

  if (compacted) return 'compaction';
  return lead.kind === 'system' ? 'system' : 'unknown';
}

/**
 * Project one file's classified lines.
 *
 * ★ PRECONDITION: `lines` arrives in `byte_offset` order, which is how task 4.1's
 * corpus walker builds it. `seq` is array position, so it is byte-derived exactly
 * under that precondition and under no other. It is stated here rather than
 * re-checked at runtime, because a second guard is a second place for the rule to
 * live; the observable consequence — a non-decreasing emitted `byte_offset` — is
 * what the tests assert instead.
 *
 * `lines` and every line in it are left unmutated. `ctx.drift` is the one argument
 * this call writes to, by design.
 */
export function runPipeline(lines: readonly ParsedLine[], ctx: PipelineContext): Projection {
  // ---- pass one: read everything, emit nothing -----------------------------

  const segmentOf: number[] = [];
  const blocksAt: (readonly Block[])[] = [];
  const humanAt: boolean[] = [];
  const assistantAt: number[] = [];
  const leadOf = new Map<number, number>();
  const compactedSegments = new Set<number>();
  const reportedDuration = new Map<number, number>();
  const errorsOf = new Map<number, number>();
  const titleOf = new Map<number, string>();
  const toolResults = new Map<string, ToolResult>();
  const notifications: TaskNotification[] = [];
  // The turn -> call direction. `joinToolCalls` walks events and never needed
  // it; the fold does, because a turn cannot otherwise reach its own
  // notification's call id.
  const calledBy = new Map<number, string>();
  let previewText: string | undefined;

  let segment = 0;
  let currentGroup: string | undefined;

  for (const [index, line] of lines.entries()) {
    // ★ TURN SEGMENTATION, ENTIRE. One variable, moving forward: when the line
    // declares a prompt group and it CHANGED, a new segment opens. Lines before
    // the first one land in a synthetic leading segment, so no line is
    // unassigned. No parent map, no tree, no fallback walker.
    const group = promptGroupId(line);
    if (group !== undefined && group !== currentGroup) {
      currentGroup = group;
      segment += 1;
    }
    segmentOf.push(segment);

    const blocks = line.uuid === undefined ? NO_BLOCKS : contentBlocks(line);
    blocksAt.push(blocks);
    humanAt.push(isHumanPrompt(line).human);
    if (line.kind === 'assistant') assistantAt.push(index);

    if (line.uuid !== undefined && !leadOf.has(segment)) leadOf.set(segment, index);
    if (line.kind === 'system' && line.subtype === 'compact_boundary') {
      compactedSegments.add(segment);
    }

    const reported = turnDurationMs(line);
    if (reported !== undefined && !reportedDuration.has(segment)) {
      reportedDuration.set(segment, reported);
    }

    // `is_error === true` exactly: the flag is absent on thousands of successful
    // results, so any `!is_error` reading marks all of them as failures.
    const failures = blocks.filter(
      (block) => block.kind === 'tool_result' && block.is_error,
    ).length;
    if (failures > 0) errorsOf.set(segment, (errorsOf.get(segment) ?? 0) + failures);

    // The OUTPUT HALF of every call, recorded here and folded onto the call's own
    // row once the turns exist. First result wins, the same way this pass already
    // resolves a repeated title or a repeated reported duration.
    for (const [blockIndex, block] of blocks.entries()) {
      if (block.kind !== 'tool_result' || toolResults.has(block.tool_call_id)) continue;
      const output = resultText(block.children);
      toolResults.set(block.tool_call_id, {
        text: output,
        is_error: block.is_error,
        denial: toolDenialKind(line),
        launch: asyncAgentLaunch(line, output),
        ts: line.timestamp ?? '',
        result_offset: line.byte_offset,
        result_len: line.byte_length,
        result_block: blockIndex,
      });
    }

    // `turns.title` is ONE rule for all six kinds, not a human-only rule: the
    // segment's leading prose, or `''`. Four of the six routinely carry none, and
    // the column is NOT NULL, so `''` is the only non-fabricated value for them.
    const text = prose(blocks);

    // Read off the same string `turnKind` classifies on, so a line is a
    // notification here exactly when it opens a `task_notification` turn there.
    const notification = taskNotification(text);
    if (notification !== undefined) {
      notifications.push(notification);
      const called = notification.toolCallId;
      if (called !== undefined && !calledBy.has(segment)) calledBy.set(segment, called);
    }

    if (text === '') continue;
    if (!titleOf.has(segment)) titleOf.set(segment, text);
    if (humanAt[index] === true && previewText === undefined) previewText = text;
  }

  // Tokens are folded per contiguous request group and stamped on the group's
  // FIRST unit only. Summing every line's copy runs 1.51x high; reading only the
  // first runs 2.6x low.
  const usageAt = new Map<number, FoldedUsage>();
  let member = 0;
  for (const group of groupByRequestId(assistantAt.map((index) => lines[index]!.raw))) {
    usageAt.set(assistantAt[member]!, foldRequestGroup(group));
    member += group.length;
  }

  // ---- pass two: emit, reading only what pass one computed ------------------

  const events: ProjectedEvent[] = [];
  const ownerOfEvent: number[] = [];

  for (const [index, line] of lines.entries()) {
    const uuid = line.uuid;
    if (uuid === undefined) continue;

    const blocks = blocksAt[index]!;
    const human = humanAt[index]!;
    const usage = usageAt.get(index);
    let stamped = false;

    const emit = (block: Block | undefined, blockIndex: number): void => {
      if (block?.kind === 'unknown_block') ctx.drift.noteUnknownBlock(block.raw_type);

      const kind = eventKind(line, block, human);
      const id = block?.kind === 'tool_use' && block.id !== '' ? block.id : `${uuid}:${blockIndex}`;
      const tokens = stamped ? undefined : usage;
      stamped = true;

      events.push({
        id,
        session_id: ctx.session_id,
        // Patched below, once the segments that actually emitted are known.
        turn_id: '',
        seq: events.length,
        kind,
        // ponytail: CEILING — an empty `ts` is a VISIBLE SENTINEL, never an
        // invented time; a pure function may not fabricate one. Measured, all
        // 40,943 uuid-carrying lines carry a timestamp, so this is unreached
        // today. Upgrade path: make `ts` nullable in the projection and let task
        // 3.5 decide whether to write the row or skip it.
        ts: line.timestamp ?? '',
        request_id: requestIdOf(line.raw),
        block_index: blockIndex,
        name: block?.kind === 'tool_use' ? block.name : undefined,
        // The in-flight state, and everything the join overwrites when it finds
        // this call's result. A call that never gets one keeps exactly this.
        status: kind === 'tool_call' ? 'running' : undefined,
        duration_ms: undefined,
        duration_source: undefined,
        // Both are the sidecar linker's, and it runs outside this function
        // because it needs a filesystem `runPipeline` must never take.
        child_session_id: undefined,
        agent_type: undefined,
        // The input is the CALL's half, so it is known here and never moves.
        ...(block?.kind === 'tool_use' ? toolInput(block.input) : NO_INPUT),
        text: kind === 'tool_call' ? undefined : blockText(block),
        text_bytes: undefined,
        output_storage: kind === 'tool_call' ? 'absent' : undefined,
        spill_path: undefined,
        agent_status: undefined,
        // The EMITTING LINE's pair, never the block's: the resolver preads it,
        // re-parses that one line, and only then indexes `block[block_index]`.
        src_offset: line.byte_offset,
        src_len: line.byte_length,
        result_offset: undefined,
        result_len: undefined,
        result_block: undefined,
        tokens_in: tokens?.input_tokens,
        tokens_out: tokens?.output_tokens,
        tokens_cache_read: tokens?.cache_read_input_tokens,
        tokens_cache_write: tokens?.cache_creation_input_tokens,
        raw_type: rawTypeOf(line),
        raw_subtype: rawSubtypeOf(line),
        attrs: '{}',
      });
      ownerOfEvent.push(segmentOf[index]!);
    };

    if (blocks.length === 0) {
      // A uuid line carrying no blocks is still a row — 1,592 measured. Nothing
      // is ever dropped.
      emit(undefined, 0);
      continue;
    }

    for (const [blockIndex, block] of blocks.entries()) {
      // A result block is the OUTPUT HALF of its call's row, not a row of its
      // own — `joinToolCalls` below folds it onto that row. This is what keeps
      // blocks-in minus results equal to rows-out.
      if (block.kind !== 'tool_result') emit(block, blockIndex);
    }
  }

  // ---- turns: one per segment that actually emitted -------------------------

  // A segment earns a turn by EMITTING, not merely by existing: a segment whose
  // only uuid line carried nothing but result blocks would otherwise be a turn
  // owning an empty event window. This is what keeps `turns` empty exactly when
  // `events` is empty.
  const eventsOf = new Map<number, ProjectedEvent[]>();
  for (const [index, event] of events.entries()) {
    const owner = ownerOfEvent[index]!;
    const own = eventsOf.get(owner);
    if (own === undefined) eventsOf.set(owner, [event]);
    else own.push(event);
  }

  // A call's `events.id` IS the id its notification names, so one index over the
  // finished array answers the fold across turns: an `Agent` started in turn 3
  // and answered in turn 17.
  const nameOfEvent = new Map<string, string>();
  for (const event of events) {
    if (event.name !== undefined) nameOfEvent.set(event.id, event.name);
  }

  const turns: ProjectedTurn[] = [];
  for (const [owner, own] of eventsOf) {
    const seq = turns.length;
    for (const event of own) event.turn_id = `${ctx.session_id}:${seq}`;

    // MIN and MAX, never first and last: 301 adjacent pairs in the archive run
    // backwards, and a first/last reading reports a negative turn on each.
    const stamps = own.map((event) => event.ts).filter((ts) => ts !== '');
    const started_at = stamps.reduce((a, b) => (a < b ? a : b), stamps[0] ?? '');
    const ended_at = stamps.reduce((a, b) => (a > b ? a : b), stamps[0] ?? '');
    const reported = reportedDuration.get(owner);
    const lead = leadOf.get(owner)!;
    const kind = turnKind(
      lines[lead]!,
      humanAt[lead]!,
      prose(blocksAt[lead]!),
      compactedSegments.has(owner),
    );

    // Gated on the name, per `tools.ts` rule 3: a notification names a `Bash` or
    // a `SendMessage` on 7 of the 161 that resolve, and folding those away would
    // hide real work. Gated on the kind too, because that is the column's
    // written contract (`db/schema.ts`).
    const called = kind === 'task_notification' ? calledBy.get(owner) : undefined;

    turns.push({
      id: `${ctx.session_id}:${seq}`,
      session_id: ctx.session_id,
      seq,
      kind,
      parent_event_id:
        called !== undefined && nameOfEvent.get(called) === 'Agent' ? called : undefined,
      title: (titleOf.get(owner) ?? '').slice(0, MAX_TITLE_CHARS),
      started_at,
      ended_at,
      duration_ms:
        reported ?? (stamps.length === 0 ? undefined : epochMs(ended_at) - epochMs(started_at)),
      duration_source: reported === undefined ? 'derived' : 'turn_duration',
      tokens_in: sum(own, (event) => event.tokens_in),
      tokens_out: sum(own, (event) => event.tokens_out),
      tokens_cache_read: sum(own, (event) => event.tokens_cache_read),
      tokens_cache_write: sum(own, (event) => event.tokens_cache_write),
      tool_call_count: own.filter((event) => event.kind === 'tool_call').length,
      error_count: errorsOf.get(owner) ?? 0,
      first_seq: own[0]!.seq,
      last_seq: own[own.length - 1]!.seq,
    });
  }

  // ---- the join: each call's result folded onto the call's own row ----------

  // After the turns, never during emission: the back-patch is CROSS-TURN, and an
  // `Agent` launched in turn 3 is answered by a notification in turn 17. No row
  // is added, removed, reordered or re-parented, so every window above stands.
  joinToolCalls(events, toolResults, notifications, ctx.drift);

  // The launched agent ids, harvested from the SAME map the join reads. The join
  // only tests that a launch happened; the id it carries has no column, so it
  // leaves through the projection instead of on a row.
  const launches = new Map<string, string>();
  for (const [callId, result] of toolResults) {
    const agentId = result.launch?.agentId;
    if (agentId !== undefined) launches.set(callId, agentId);
  }

  // ---- header: a file that emitted nothing is not a session -----------------

  // No rows means no `sessions` row at all, which is what makes `started_at` and
  // `last_activity_at` plain strings here: both columns are NOT NULL, and every
  // emitting line carries a timestamp, so neither is ever fabricated.
  const envelope = foldSessionEnvelope(lines);
  const { started_at, last_activity_at } = envelope;

  const header =
    events.length === 0 || started_at === undefined || last_activity_at === undefined
      ? undefined
      : {
          session_id: ctx.session_id,
          project_path: envelope.project_path,
          git_branch: envelope.git_branch,
          harness_version: envelope.harness_version,
          model: envelope.model,
          title: foldControlLines(lines).ai_title,
          preview: previewText?.slice(0, MAX_TITLE_CHARS),
          started_at,
          last_activity_at,
        };

  return { header, turns, events, drift: ctx.drift.serialize(), launches };
}

function sum(
  events: readonly ProjectedEvent[],
  of: (event: ProjectedEvent) => number | undefined,
): number {
  return events.reduce((total, event) => total + (of(event) ?? 0), 0);
}
