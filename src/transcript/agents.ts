// What a background `Agent` call speaks, behind the one door: three harness
// strings on the parent's own lines, plus the `agent-<id>.meta.json` sidecar
// header that names which call started it. Pure: no I/O, no clock, no
// randomness, and no `node:` import at any depth — `src/project/` imports this
// module, and `__tests__/purity.test.ts` bans every `node:` specifier
// transitively from that tree.
//
// ## Why the launch marker matters more than the structured field
//
// 97 of 126 `Agent` calls were async on 2026-08-07; re-measured 2026-08-19 it is
// **218 of 254**. Their `tool_result` text is harness metadata — "Async agent
// launched successfully…" — and NOT the agent's answer, which arrives later in a
// separate `<task-notification>` line. A projector that ships without the join
// below renders that boilerplate as the agent's output on 86% of Agent calls.
//
// The detector is an OR of two signals, and the union is NOT symmetric:
//   - The marker alone catches **218 of 218**. It is the load-bearing signal.
//   - The structured field alone misses one, and it is the shape that matters:
//     an Agent result inside a `subagents/agent-*.jsonl` sidecar, on a line
//     carrying no structured result object at all.
// The field is kept as the guard against a harness string change, not as a
// second detector that catches anything today.
//
// ## `<result>` IS OPTIONAL, and the parse must survive its absence
//
// Measured over 158 notifications: `<result>` opens AT MOST once — 0 nested, 0
// repeated — but **2 open it zero times**. Both carry `<output-file>` instead,
// and both target a `Bash` id. So a single non-greedy capture is the right
// shape, and reading it as `match(...)[1]` unguarded throws on those two.
//
// ## The spill marker is DUPLICATED from `spill.ts`, deliberately
//
// `spill.ts` holds the same literal privately and cannot be shared: it imports
// `node:path`, and the purity ban above is transitive, so `src/project/` cannot
// reach that module at any depth — not even its one pure-shaped export. Two
// copies of one harness string, in one directory, is the cheapest legal shape.
// `__tests__/agents.test.ts` asserts the two copies still agree, over the source
// text, rather than trusting a comment to be read.

import { num, obj, str } from './accessors.js';
import type { ParsedLine } from './line.js';

/**
 * What the harness writes at index 0 of a `tool_result` whose payload it spilled
 * to a sidecar file. All 61 measured claims carry it at index 0.
 */
const PERSISTED_MARKER = '<persisted-output>';

/** What the harness writes at index 0 of an async `Agent` launch result. */
const ASYNC_LAUNCH_MARKER = 'Async agent launched successfully.';

/** The tag `turnKind` already treats as a turn opener, reused as the parse gate. */
const NOTIFICATION_TAG = '<task-notification>';

/**
 * The launched agent's own id, as the marker text spells it. Only reached when
 * the line carries no structured result object — the sidecar shape.
 */
const MARKER_AGENT_ID = /^agentId: (\S+)/m;

/** One inner tag of a notification, non-greedy so the FIRST close ends it. */
function tag(name: string): RegExp {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);
}

const TOOL_CALL_ID = tag('tool-use-id');
const STATUS = tag('status');
const RESULT = tag('result');

/** A background `Agent` launch, and the harness's id for the agent it started. */
export interface AsyncAgentLaunch {
  /** Undefined when neither the structured object nor the marker named one. */
  agentId: string | undefined;
}

/**
 * The agent's real answer, arriving in its own line one or many turns later.
 * Every field is optional because a notification is not a promise about its own
 * contents: 4 of 158 name no call, and 2 carry no payload.
 */
export interface TaskNotification {
  /** The `tool_use` this answers. */
  toolCallId: string | undefined;
  /** `completed` / `failed` / `killed`, verbatim. */
  status: string | undefined;
  /** The payload to publish in place of the launch boilerplate. */
  result: string | undefined;
}

/**
 * The header the harness writes beside every sub-agent transcript, as
 * `agent-<id>.meta.json`.
 *
 * EVERY FIELD IS OPTIONAL, and `toolUseId` most of all: 12 of 269 measured metas
 * are the whole file `{"agentType":"workflow-subagent","spawnDepth":1}` — no
 * join key and no description. A required `toolUseId` would type a join map as
 * `Map<string | undefined, …>` and let `undefined` become a key.
 */
export interface AgentMeta {
  /** `'Explore'`, `'approach-critic'`, … — free, so nothing switches on it. */
  agentType: string | undefined;
  description: string | undefined;
  /** The parent's `Agent` `tool_use.id`. THE join key, and nothing else is. */
  toolUseId: string | undefined;
  /** Recorded, never enforced: recursion has no depth limit by design. */
  spawnDepth: number | undefined;
  parentAgentId: string | undefined;
}

/**
 * A background launch, or nothing. `text` is the result's EXTRACTED text — the
 * only text a projector reads as output — never the raw line.
 */
export function asyncAgentLaunch(line: ParsedLine, text: string): AsyncAgentLaunch | undefined {
  const structured = obj(line.raw.toolUseResult, undefined);
  if (structured?.isAsync === true) {
    return { agentId: str(structured.agentId, undefined) };
  }
  // `startsWith`, NEVER `includes`: 8 `Bash` results quote this marker mid-output
  // as data, and a substring test would blank all 8.
  if (!text.startsWith(ASYNC_LAUNCH_MARKER)) return undefined;
  return { agentId: MARKER_AGENT_ID.exec(text)?.[1] };
}

/**
 * One `<task-notification>` line parsed, or nothing when the text is not one.
 * The gate is `startsWith`, matching what `turnKind` already tests, so a line
 * that merely quotes the tag is not read as a notification.
 */
export function taskNotification(text: string): TaskNotification | undefined {
  if (!text.startsWith(NOTIFICATION_TAG)) return undefined;
  return {
    toolCallId: TOOL_CALL_ID.exec(text)?.[1],
    status: STATUS.exec(text)?.[1],
    result: RESULT.exec(text)?.[1],
  };
}

/**
 * One `agent-<id>.meta.json` read, or nothing when it was not a JSON object.
 * Every field goes through the accessors, so a harness that changes a value's
 * type drops that field rather than poisoning the row.
 */
export function parseAgentMeta(json: unknown): AgentMeta | undefined {
  const meta = obj(json, undefined);
  if (meta === undefined) return undefined;
  return {
    agentType: str(meta.agentType, undefined),
    description: str(meta.description, undefined),
    toolUseId: str(meta.toolUseId, undefined),
    spawnDepth: num(meta.spawnDepth, undefined),
    parentAgentId: str(meta.parentAgentId, undefined),
  };
}

/**
 * True when this result's text claims a spilled payload. The whole predicate:
 * resolving the pointer needs the filesystem and belongs to the writer, and all
 * 61 measured claims sit far under the inline cap, so the size rule alone would
 * publish the marker string as if it were the tool's output.
 */
export function claimsPersistedOutput(text: string): boolean {
  return text.startsWith(PERSISTED_MARKER);
}
