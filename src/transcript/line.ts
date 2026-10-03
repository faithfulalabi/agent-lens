// One harness JSONL line in, one of our kinds out. Nothing is ever dropped: an unknown `type`
// becomes `kind:'unknown'` and is counted, so N lines in is N lines out. Reads go through the
// total accessors in `./accessors.js`, which is why there are no guards here.

import { isoTs, num, obj, str } from './accessors.js';
import type { DriftCounter } from './drift.js';

/** Everything a line needs from its file to be classified. */
export interface LineContext {
  /** ARCHIVE-relative, and in BYTES: a string index desynchronises on the first emoji. */
  byteOffset: number;
  /**
   * Excluding the `\n`. Required, never optional: it feeds the NOT NULL `events.src_len`, where
   * a defaulted `0` is a legal-looking wrong answer rather than a failure.
   */
  byteLength: number;
  /** Counts what this line carried that has never been measured. */
  drift: DriftCounter;
}

/**
 * The declared `system` subtypes, and the source of both the type and the runtime check below.
 * `summary` and `compact_boundary` are NOT top-level types; `compact_boundary` lives only here.
 */
const SYSTEM_SUBTYPES = [
  'turn_duration',
  'stop_hook_summary',
  'away_summary',
  'local_command',
  'compact_boundary',
  'informational',
  'api_error',
] as const;

export type SystemSubtype = (typeof SYSTEM_SUBTYPES)[number];

const SYSTEM_SUBTYPE_SET: ReadonlySet<string> = new Set(SYSTEM_SUBTYPES);

function isSystemSubtype(value: string): value is SystemSubtype {
  return SYSTEM_SUBTYPE_SET.has(value);
}

/** Our name for a harness line. `unknown` is a real kind, not a failure. */
export type ParsedKind = ParsedLine['kind'];

/** Carried by every classified line, whatever its kind. */
interface ParsedBase {
  readonly byte_offset: number;
  /** Bytes of this line, excluding its `\n`. Feeds `events.src_len`. */
  readonly byte_length: number;
  /** Only `assistant`, `user`, `system` and `attachment` carry one. */
  readonly uuid: string | undefined;
  readonly session_id: string | undefined;
  readonly timestamp: string | undefined;
  /** The line's object verbatim, so a projector can read further fields without re-parsing. */
  readonly raw: Readonly<Record<string, unknown>>;
}

interface Classified<K extends string> extends ParsedBase {
  readonly kind: K;
}

/** A line agent-lens cannot name. It still renders; that is the entire point. */
interface UnknownLine extends ParsedBase {
  readonly kind: 'unknown';
  /** The `type` as sent, or a `<label>` when it was not a string. */
  readonly raw_type: string;
  /** The `subtype` as sent. `''` means the line carried none. */
  readonly raw_subtype: string;
}

export type ParsedLine =
  | Classified<'assistant'>
  | Classified<'user'>
  | (Classified<'system'> & { readonly subtype: SystemSubtype })
  | Classified<'attachment'>
  | Classified<'mode'>
  | Classified<'last-prompt'>
  | Classified<'permission-mode'>
  | Classified<'ai-title'>
  | Classified<'file-history-snapshot'>
  | Classified<'file-history-delta'>
  | Classified<'queue-operation'>
  | Classified<'pr-link'>
  | Classified<'started'>
  | Classified<'result'>
  // Uuid-less, so these three project no event. The kind name is the harness `type` VERBATIM,
  // which is what keeps `rawTypeOf` total without a second table.
  | Classified<'atis-latch'>
  | Classified<'cost-state'>
  | Classified<'fork-context-ref'>
  | UnknownLine;

/**
 * Shared by the four uuid-carrying types. A field seen on only ONE type does NOT belong here —
 * it goes in that type's own list below, so drift still catches it on every other type.
 */
const ENVELOPE: readonly string[] = [
  'type',
  'uuid',
  'parentUuid',
  'sessionId',
  'session_id',
  'timestamp',
  'version',
  'userType',
  'isSidechain',
  'isMeta',
  'agentId',
  'cwd',
  'gitBranch',
  'slug',
  'entrypoint',
];

function fields(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flat());
}

interface LineType {
  readonly kind: Exclude<ParsedKind, 'unknown'>;
  readonly knownFields: ReadonlySet<string>;
}

/**
 * Harness `type` -> our kind, plus its measured field inventory. ONE table serves both the
 * classifier and the drift allowlist on purpose; two lists would diverge. A `Map`, not an object
 * literal: a transcript controls the key, and `LINE_TYPES['toString']` would answer a function.
 */
const LINE_TYPES = new Map<string, LineType>([
  [
    'assistant',
    {
      kind: 'assistant',
      knownFields: fields(ENVELOPE, [
        'message',
        'requestId',
        'effort',
        'attributionAgent',
        'attributionSkill',
        'attributionPlugin',
        'isApiErrorMessage',
        'error',
        // Seen on `assistant` only, which is why they are here and not in `ENVELOPE`.
        'perTurnEffort',
        'apiBlockIndex',
        'advisorModel',
        'serverClassifierRequest',
        'wireToolInputs',
        'wireIngestContext',
        'apiErrorStatus',
        'quotaLimits',
      ]),
    },
  ],
  [
    'user',
    {
      kind: 'user',
      knownFields: fields(ENVELOPE, [
        'message',
        'origin',
        'toolUseResult',
        'sourceToolAssistantUUID',
        'sourceToolUseID',
        'promptId',
        'promptSource',
        'permissionMode',
        'isCompactSummary',
        'isVisibleInTranscriptOnly',
        'classifierMetaLines',
        'toolEndsTurn',
        'toolDenialKind',
        'imagePasteIds',
        // Seen on `user` only.
        'serverClassifierContext',
        'turnOrigin',
        'queueSkipAttachments',
        'turnPosition',
        'turnCompanion',
      ]),
    },
  ],
  [
    'system',
    {
      kind: 'system',
      knownFields: fields(ENVELOPE, [
        'subtype',
        'content',
        'level',
        'durationMs',
        'messageCount',
        'stopReason',
        'preventedContinuation',
        'compactMetadata',
        'logicalParentUuid',
        'toolUseID',
        'hasOutput',
        'hookCount',
        'hookErrors',
        'hookInfos',
        'hookAdditionalContext',
        'pendingBackgroundAgentCount',
        'pendingWorkflowCount',
      ]),
    },
  ],
  [
    'attachment',
    {
      kind: 'attachment',
      knownFields: fields(ENVELOPE, [
        'attachment',
        // Seen on `attachment` only.
        'rendered',
        'renderedInHumanTurn',
      ]),
    },
  ],
  ['mode', { kind: 'mode', knownFields: fields(['type', 'mode', 'sessionId']) }],
  [
    'last-prompt',
    {
      kind: 'last-prompt',
      knownFields: fields(['type', 'lastPrompt', 'leafUuid', 'sessionId', 'explicit']),
    },
  ],
  [
    'permission-mode',
    {
      kind: 'permission-mode',
      knownFields: fields(['type', 'permissionMode', 'sessionId']),
    },
  ],
  ['ai-title', { kind: 'ai-title', knownFields: fields(['type', 'aiTitle', 'sessionId']) }],
  [
    'file-history-snapshot',
    {
      kind: 'file-history-snapshot',
      knownFields: fields(['type', 'messageId', 'snapshot', 'isSnapshotUpdate']),
    },
  ],
  [
    'file-history-delta',
    {
      kind: 'file-history-delta',
      knownFields: fields([
        'type',
        'messageId',
        'snapshotMessageId',
        'trackingPath',
        'backup',
        'timestamp',
      ]),
    },
  ],
  [
    'queue-operation',
    {
      kind: 'queue-operation',
      knownFields: fields(['type', 'operation', 'content', 'timestamp', 'sessionId', 'reason']),
    },
  ],
  [
    'pr-link',
    {
      kind: 'pr-link',
      knownFields: fields(['type', 'sessionId', 'prNumber', 'prUrl', 'prRepository', 'timestamp']),
    },
  ],
  // Sidecar-only — a workflow span pair, from `subagents/workflows/wf_*/journal.jsonl`.
  ['started', { kind: 'started', knownFields: fields(['type', 'key', 'agentId']) }],
  ['result', { kind: 'result', knownFields: fields(['type', 'key', 'agentId', 'result']) }],
  // These three are uuid-less, so none unions `ENVELOPE` and none projects an event.
  ['atis-latch', { kind: 'atis-latch', knownFields: fields(['type', 'atis', 'sessionId']) }],
  // NOT a pricing source: pricing comes from `message.usage` x `shared/pricing.ts`.
  [
    'cost-state',
    {
      kind: 'cost-state',
      knownFields: fields([
        'type',
        'sessionId',
        'startTime',
        'totalCostUSD',
        'totalDuration',
        'totalAPIDuration',
        'totalAPIDurationWithoutRetries',
        'totalToolDuration',
        'totalLinesAdded',
        'totalLinesRemoved',
        'modelUsage',
        'hasUnknownModelCost',
      ]),
    },
  ],
  // Lineage, but `project/subagents.ts` already owns that.
  [
    'fork-context-ref',
    {
      kind: 'fork-context-ref',
      knownFields: fields([
        'type',
        'agentId',
        'parentSessionId',
        'parentLastUuid',
        'contextLength',
      ]),
    },
  ],
]);

/** Stands in for a line that was not a JSON object, so `raw` is always readable. */
const EMPTY_RECORD: Readonly<Record<string, unknown>> = Object.freeze({});

/** A string `type` as sent; anything else becomes a `<label>`, so the cases stay separate rows. */
function rawTypeKey(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === null ? '<null>' : `<${typeof value}>`;
}

/** Classify one parsed JSONL line, counting whatever it carried that we cannot name. */
export function classifyLine(json: unknown, ctx: LineContext): ParsedLine {
  const raw = obj(json, EMPTY_RECORD);
  const base = {
    byte_offset: ctx.byteOffset,
    byte_length: ctx.byteLength,
    uuid: str(raw.uuid, undefined),
    session_id: str(raw.sessionId, undefined),
    timestamp: isoTs(raw.timestamp, undefined),
    raw,
  };

  const entry = LINE_TYPES.get(str(raw.type, ''));
  if (entry === undefined) {
    // The type only, not its fields: a new type would otherwise flood the field report.
    const raw_type = rawTypeKey(raw.type);
    ctx.drift.noteUnknownType(raw_type);
    return { ...base, kind: 'unknown', raw_type, raw_subtype: str(raw.subtype, '') };
  }

  ctx.drift.noteLine(raw, entry.knownFields);

  if (entry.kind === 'system') {
    const subtype = str(raw.subtype, '');
    if (!isSystemSubtype(subtype)) {
      // NOT a generic `system` row: a new subtype must surface, not join an existing bucket.
      ctx.drift.noteUnknownType(`system.${subtype}`);
      return { ...base, kind: 'unknown', raw_type: 'system', raw_subtype: subtype };
    }
    return { ...base, kind: 'system', subtype };
  }

  return { ...base, kind: entry.kind };
}

/** What the uuid-less control lines contribute to a session. Almost nothing. */
export interface ControlProjection {
  /** The free session title. */
  ai_title: string | undefined;
  /** The text of the resume bookmark. */
  last_prompt: string | undefined;
  /** The leaf uuid that same bookmark points at. */
  last_prompt_leaf_uuid: string | undefined;
}

/**
 * Fold the control lines into the only two things they project to. LAST occurrence wins: a
 * session carries many `ai-title` lines, so a first-wins fold serves a stale title.
 */
export function foldControlLines(lines: readonly ParsedLine[]): ControlProjection {
  const projection: ControlProjection = {
    ai_title: undefined,
    last_prompt: undefined,
    last_prompt_leaf_uuid: undefined,
  };
  for (const line of lines) {
    if (line.kind === 'ai-title') {
      projection.ai_title = str(line.raw.aiTitle, undefined);
    } else if (line.kind === 'last-prompt') {
      projection.last_prompt = str(line.raw.lastPrompt, undefined);
      projection.last_prompt_leaf_uuid = str(line.raw.leafUuid, undefined);
    }
  }
  return projection;
}

/** The prompt group this line declares, if any. `user` lines only; says nothing about neighbours. */
export function promptGroupId(line: ParsedLine): string | undefined {
  return str(line.raw.promptId, undefined);
}

/**
 * Why the harness refused a tool call. Every denial ALSO carries `is_error: true`, so a status
 * ladder must consult this before the error flag or it labels every denial an error.
 */
export function toolDenialKind(line: ParsedLine): string | undefined {
  return str(line.raw.toolDenialKind, undefined);
}

/** The turn duration a `system`/`turn_duration` line reports, when it reports one. */
export function turnDurationMs(line: ParsedLine): number | undefined {
  return line.kind === 'system' && line.subtype === 'turn_duration'
    ? num(line.raw.durationMs, undefined)
    : undefined;
}

/** The harness's placeholder on a line it manufactured. It names no model. */
const SYNTHETIC_MODEL = '<synthetic>';

/** What a whole file projects to before any turn or event exists. */
export interface SessionEnvelope {
  /** `cwd`. The session list groups and filters on it. */
  project_path: string | undefined;
  git_branch: string | undefined;
  /** The harness's own version string; it groups the drift report. */
  harness_version: string | undefined;
  /**
   * The model named on the most LINES — NOT the most recent, which is what the fields above
   * take; last-wins would price the whole token total under a trailing line. `<synthetic>` names
   * no model, so it is dropped before the tally and a file naming nothing else folds to
   * `undefined`. Ties break to the model seen FIRST, deliberately.
   */
  model: string | undefined;
  /** First and last TOP-LEVEL timestamps — never a nested one. */
  started_at: string | undefined;
  last_activity_at: string | undefined;
}

/**
 * Fold every line into the session-wide values a file carries. The timestamps are the MIN and
 * MAX, not the first and last seen: adjacent pairs run backwards, and a first/last reading
 * reports a negative duration on every one of them.
 */
export function foldSessionEnvelope(lines: readonly ParsedLine[]): SessionEnvelope {
  const envelope: SessionEnvelope = {
    project_path: undefined,
    git_branch: undefined,
    harness_version: undefined,
    model: undefined,
    started_at: undefined,
    last_activity_at: undefined,
  };

  // `model` is tallied rather than read last-wins like the three fields beside it.
  const linesPerModel = new Map<string, number>();

  for (const line of lines) {
    envelope.project_path = str(line.raw.cwd, envelope.project_path);
    envelope.git_branch = str(line.raw.gitBranch, envelope.git_branch);
    envelope.harness_version = str(line.raw.version, envelope.harness_version);

    const model = str(obj(line.raw.message, undefined)?.model, undefined);
    if (model !== undefined && model !== SYNTHETIC_MODEL) {
      linesPerModel.set(model, (linesPerModel.get(model) ?? 0) + 1);
    }

    const at = line.timestamp;
    if (at === undefined) continue;
    if (envelope.started_at === undefined || at < envelope.started_at) envelope.started_at = at;
    if (envelope.last_activity_at === undefined || at > envelope.last_activity_at) {
      envelope.last_activity_at = at;
    }
  }

  // Strict `>` over an insertion-ordered map keeps the FIRST model seen on a tie.
  let mostLines = 0;
  for (const [model, count] of linesPerModel) {
    if (count > mostLines) {
      envelope.model = model;
      mostLines = count;
    }
  }

  return envelope;
}
