// Every harness record shape agent-lens has MEASURED, every field optional and `unknown`-valued.
// A field here means "observed at least once", never "will be there". These interfaces therefore
// discriminate NOTHING — they are mutually assignable; what they buy is a name, an inventory, and
// `unknown` forcing every read through a checked accessor in `./accessors.js`.

/** `type: 'user'` — a human prompt, a tool result, or a compaction summary. */
export interface RawUserLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  /** Snake-cased twin of `sessionId`, present alongside it on the same lines. */
  session_id?: unknown;
  timestamp?: unknown;
  version?: unknown;
  message?: unknown;
  /** `{ kind: 'human' | 'task-notification' }` on newer harness builds; absent on older ones. */
  origin?: unknown;
  /** Structured tool output: `stdout`, `stderr`, `structuredPatch`, `agentId`. */
  toolUseResult?: unknown;
  /** Joins a tool result directly to the assistant line that emitted it. */
  sourceToolAssistantUUID?: unknown;
  promptId?: unknown;
  promptSource?: unknown;
  userType?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  agentId?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  slug?: unknown;
  entrypoint?: unknown;
  permissionMode?: unknown;
  serverClassifierContext?: unknown;
  /** `"human"` / `"sdk"`, stated outright. A corroborator for `origin.kind`, not an authority. */
  turnOrigin?: unknown;
  queueSkipAttachments?: unknown;
  turnPosition?: unknown;
  turnCompanion?: unknown;
}

/** `type: 'assistant'` — one model response, carrying usage and content blocks. */
export interface RawAssistantLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  timestamp?: unknown;
  version?: unknown;
  message?: unknown;
  requestId?: unknown;
  userType?: unknown;
  isSidechain?: unknown;
  agentId?: unknown;
  attributionAgent?: unknown;
  effort?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  slug?: unknown;
  entrypoint?: unknown;
  /** Seen on `assistant` and nothing else. */
  perTurnEffort?: unknown;
  apiBlockIndex?: unknown;
  advisorModel?: unknown;
  serverClassifierRequest?: unknown;
  /** What actually ran. The model's own `tool_use.input` is the REQUEST, and the two differ. */
  wireToolInputs?: unknown;
  wireIngestContext?: unknown;
  /** On a quota or outage refusal, beside `isApiErrorMessage`. */
  apiErrorStatus?: unknown;
  quotaLimits?: unknown;
}

/** `type: 'system'` — hooks, turn timings, compaction bookkeeping, notices. */
export interface RawSystemLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  timestamp?: unknown;
  version?: unknown;
  subtype?: unknown;
  content?: unknown;
  level?: unknown;
  /** On `subtype: 'turn_duration'`: the authoritative per-turn wall clock. */
  durationMs?: unknown;
  messageCount?: unknown;
  stopReason?: unknown;
  preventedContinuation?: unknown;
  compactMetadata?: unknown;
  logicalParentUuid?: unknown;
  toolUseID?: unknown;
  hasOutput?: unknown;
  hookCount?: unknown;
  hookErrors?: unknown;
  hookInfos?: unknown;
  hookAdditionalContext?: unknown;
  userType?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  slug?: unknown;
  entrypoint?: unknown;
}

/** `type: 'attachment'` — out-of-band content pinned to a turn. */
export interface RawAttachmentLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  timestamp?: unknown;
  version?: unknown;
  attachment?: unknown;
  userType?: unknown;
  isSidechain?: unknown;
  agentId?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  slug?: unknown;
  entrypoint?: unknown;
  /**
   * A ONE-ELEMENT ARRAY of {@link RawRenderedBlock}, never a string. `message.content` is
   * absent on this type, so this is the only text the harness renders for these lines — and
   * it is absent itself on 1,953 of 6,134, which is why `attachment.type` carries the
   * fallback.
   */
  rendered?: unknown;
  /** The same shape, holding a DIFFERENT rendering of the same payload. Read by nothing. */
  renderedInHumanTurn?: unknown;
}

/** An element of `rendered` / `renderedInHumanTurn`. The measured keys are exactly this one. */
export interface RawRenderedBlock {
  content?: unknown;
}

/** `type: 'mode'` — a mode switch. Carries no uuid and no timestamp. */
export interface RawModeLine {
  type?: unknown;
  mode?: unknown;
  sessionId?: unknown;
}

/** `type: 'permission-mode'` — a permission-mode switch. No uuid, no timestamp. */
export interface RawPermissionModeLine {
  type?: unknown;
  permissionMode?: unknown;
  sessionId?: unknown;
}

/** `type: 'file-history-snapshot'` — editor state. Carries no `sessionId`. */
export interface RawFileHistorySnapshotLine {
  type?: unknown;
  messageId?: unknown;
  snapshot?: unknown;
  isSnapshotUpdate?: unknown;
}

/** `type: 'ai-title'` — a free session title. The LAST occurrence wins. */
export interface RawAiTitleLine {
  type?: unknown;
  aiTitle?: unknown;
  sessionId?: unknown;
}

/** `type: 'last-prompt'` — resume bookkeeping pointing at a leaf uuid. */
export interface RawLastPromptLine {
  type?: unknown;
  lastPrompt?: unknown;
  leafUuid?: unknown;
  sessionId?: unknown;
  explicit?: unknown;
}

/** `type: 'atis-latch'` — harness bookkeeping. No uuid, and `atis` is an opaque token. */
export interface RawAtisLatchLine {
  type?: unknown;
  atis?: unknown;
  sessionId?: unknown;
}

/**
 * `type: 'cost-state'` — the harness's own cost tally, and NOT a pricing source: agent-lens
 * prices from `message.usage` x `src/shared/pricing.ts`. No uuid to hang an event on.
 */
export interface RawCostStateLine {
  type?: unknown;
  sessionId?: unknown;
  startTime?: unknown;
  totalCostUSD?: unknown;
  totalDuration?: unknown;
  totalAPIDuration?: unknown;
  totalAPIDurationWithoutRetries?: unknown;
  totalToolDuration?: unknown;
  totalLinesAdded?: unknown;
  totalLinesRemoved?: unknown;
  modelUsage?: unknown;
  hasUnknownModelCost?: unknown;
}

/** `type: 'fork-context-ref'` — where a fork was cut from. `src/project/subagents.ts` owns that. */
export interface RawForkContextRefLine {
  type?: unknown;
  agentId?: unknown;
  parentSessionId?: unknown;
  parentLastUuid?: unknown;
  contextLength?: unknown;
}

/** `message` on a user or assistant line. `content` is a string OR a block array. */
export interface RawMessage {
  id?: unknown;
  type?: unknown;
  role?: unknown;
  /**
   * A BARE STRING on some lines, a block array on others. Why the accessors take a required
   * fallback: an absent `content` and a present-but-empty one must not collapse.
   */
  content?: unknown;
  model?: unknown;
  usage?: unknown;
  stop_reason?: unknown;
  stop_sequence?: unknown;
  stop_details?: unknown;
  diagnostics?: unknown;
}

/** `message.usage` on an assistant line — the per-call token counts. */
export interface RawUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation?: unknown;
  server_tool_use?: unknown;
  service_tier?: unknown;
  inference_geo?: unknown;
  iterations?: unknown;
  speed?: unknown;
}

/** `origin` on a user line — the human-vs-machinery discriminator. */
export interface RawOrigin {
  /** `'human'` or `'task-notification'`. */
  kind?: unknown;
}

/** A `type: 'text'` content block. */
export interface RawTextBlock {
  type?: unknown;
  text?: unknown;
}

/** A `type: 'thinking'` content block. */
export interface RawThinkingBlock {
  type?: unknown;
  thinking?: unknown;
  signature?: unknown;
}

/** A `type: 'tool_use'` content block — `id` joins it to its result. */
export interface RawToolUseBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  caller?: unknown;
}

/** A `type: 'tool_result'` content block. `is_error` is the only error signal. */
export interface RawToolResultBlock {
  type?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}
