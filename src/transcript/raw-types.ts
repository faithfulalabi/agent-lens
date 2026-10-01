// Every harness record shape agent-lens has MEASURED, declared with every field
// optional and `unknown`-valued. Type-only, like `src/shared/entities.ts` and
// `src/shared/api.ts`: this module emits zero runtime JavaScript, and
// `__tests__/module-shape.test.ts` asserts that mechanically rather than on
// trust.
//
// It asserts NOTHING about what the harness will send. It records what was seen:
// 25,609 lines across 27 session transcripts and three Claude Code versions
// (2.1.153 / 2.1.197 / 2.1.212), re-measured against the committed fixtures on
// 2026-08-12. The transcript format is officially unstable and the corpus
// already disagrees with itself — `origin` is present on 2.1.197+ and absent on
// 2.1.153 (0 of 42 user-text lines) — so a field appearing here means "observed
// at least once", never "will be there".
//
// Extended 2026-09-30 from the LIVE corpus, 10,637 lines across 48 session
// transcripts on 2.1.277-2.1.284: three new record types and 16 new field names,
// every one measured on exactly one owning type. `queue-operation`'s new `reason`
// has no home here because that type never had an interface — pre-existing debt,
// deliberately not paid in this diff, and `src/transcript/line.ts` is where its
// inventory is actually enforced.
//
// ## What these types do NOT do, stated plainly because a reviewer will assume
// ## otherwise
//
// Every field is optional and `unknown`, so all of these interfaces are
// STRUCTURALLY IDENTICAL and mutually assignable, and `{}` satisfies every one
// of them. TypeScript will not catch passing a `RawUserLine` where a
// `RawAssistantLine` is expected. There is no discrimination here and no union
// to switch on — adding one would advertise a safety that does not exist.
//
// What they give is a NAME and a measured field inventory: documentation that
// compiles. The enforcement power is elsewhere and comes from one thing —
// `message` is `unknown`, so `line.message.usage` does not compile, and every
// read is forced through a checked accessor in `./accessors.js`. That is the
// whole mechanism.

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
  /** `{ kind: 'human' | 'task-notification' }` on 2.1.197+; absent on 2.1.153. */
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
  /** The harness's own classifier context. Measured 2026-09-30 on 2.1.277+. */
  serverClassifierContext?: unknown;
  /** `"human"` / `"sdk"`, stated outright. A corroborator for `origin.kind`. */
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
  /** Measured 2026-09-30 on 2.1.277-2.1.284, on `assistant` and nothing else. */
  perTurnEffort?: unknown;
  apiBlockIndex?: unknown;
  advisorModel?: unknown;
  serverClassifierRequest?: unknown;
  /**
   * The wire form of this line's tool calls: "what ran". 918 of 1,487 measured
   * lines differ from the model's own `tool_use.input`, always by an injected
   * `cd <cwd> && ` prefix — so the rendered input is the REQUEST, not the command.
   */
  wireToolInputs?: unknown;
  wireIngestContext?: unknown;
  /** On a quota or outage refusal, beside the already-known `isApiErrorMessage`. */
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
   * The ONLY readable text an attachment line carries, measured 2026-09-30 on
   * 2,581 lines. `message.content` is absent on this type, so the projected event
   * has no text at all; this field is where that text actually is.
   */
  rendered?: unknown;
  renderedInHumanTurn?: unknown;
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
  /** Measured 2026-09-30: 1 occurrence on 2.1.277-2.1.284, on this type only. */
  explicit?: unknown;
}

/**
 * `type: 'atis-latch'` — harness bookkeeping. 213 lines in 9 of 48 files on
 * 2026-09-30, and absent from the 2.1.153-2.1.212 archive. No uuid, no timestamp,
 * and `atis` is an opaque token: nothing renderable.
 */
export interface RawAtisLatchLine {
  type?: unknown;
  atis?: unknown;
  sessionId?: unknown;
}

/**
 * `type: 'cost-state'` — the harness's own running cost tally. 14 lines in 7 of
 * 48 files on 2026-09-30.
 *
 * Real content, and deliberately NOT a pricing source: agent-lens prices from
 * `message.usage` x `src/shared/pricing.ts`, and this line carries no uuid to
 * hang an event on.
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

/**
 * `type: 'fork-context-ref'` — where a forked session was cut from. 4 lines in 4
 * of 48 files on 2026-09-30.
 *
 * Genuine lineage, and a second source for it beside `src/project/subagents.ts`,
 * which is why reading it is a feature rather than a classification.
 */
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
   * A BARE STRING on 529 measured lines, including real human prompts, and a
   * block array elsewhere. This is why the accessors take a required fallback:
   * an absent `content` and a present-but-empty one must not collapse.
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

/** `origin` on a user line — the human-vs-machinery discriminator on 2.1.197+. */
export interface RawOrigin {
  /** `'human'` or `'task-notification'` in the measured corpus. */
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
