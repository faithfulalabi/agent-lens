// One harness JSONL line in, one of OUR kinds out. This is the single place that
// knows what Claude Code calls things, so everything downstream can stop knowing.
//
// Pure: no I/O, no clock, no randomness. Every field is read through
// `./accessors.js`, which is total, so this module declares no guards and no
// `try`/`catch` of its own — that is Task 2.1's contract and duplicating it here
// would just create a second place for the rules to disagree.
//
// **Nothing is ever dropped.** An unrecognised `type` becomes `kind:'unknown'`
// carrying `raw_type`, `raw_subtype` and its byte offset, so a Claude Code format
// change shows up in the product on the first session opened after the update,
// instead of as a silent hole discovered three months later. N lines in is always
// N lines out.
//
// Measured against the frozen archive on 2026-08-13: 14 top-level types over
// 41,911 lines, harness 2.1.197 and 2.1.212. Two shapes a reader will expect and
// not find:
//   - `summary` is NOT a top-level type. Zero occurrences. The `"type":"summary"`
//     hits in the corpus are all nested inside other payloads, which a top-level
//     classifier never sees, so there is deliberately no branch for it.
//   - `compact_boundary` is NOT a top-level type either. It is a `system` SUBTYPE
//     with 3 occurrences, and anything that greps for it at the top level finds
//     nothing and silently drops compaction.
//
// `api_error` is the opposite case: 9 occurrences on 2026-08-07 and 0 today, lost
// to transcript expiry rather than removed from the harness. Its branch stays,
// pinned by a synthetic fixture.

import { isoTs, num, obj, str } from './accessors.js';
import type { DriftCounter } from './drift.js';

/** Everything a line needs from its file to be classified. */
export interface LineContext {
  /**
   * Byte offset of this line's first byte, ARCHIVE-relative (RFC §6 rule 5).
   * The caller computes it with `Buffer.byteLength`; a source-relative offset
   * breaks the moment Claude Code expires the file, and a string index
   * desynchronises the rest of the file on the first emoji in a prompt.
   */
  byteOffset: number;
  /**
   * Byte length of this line, EXCLUDING its `\n`, so that reading
   * `[byteOffset, byteOffset + byteLength)` returns exactly this line's JSON.
   *
   * Required, never optional: it feeds `events.src_len`, which is NOT NULL, and
   * `0` is a legal-looking length, so an absent value read through `?? 0` would
   * fill the column with silent zeros instead of failing. Classification is
   * handed a parsed object rather than text, so this is the only moment the
   * length is knowable.
   */
  byteLength: number;
  /**
   * Counts what this line carried that agent-lens has never measured.
   * Classification is the only moment an unmeasured field is still visible.
   */
  drift: DriftCounter;
}

/**
 * The 7 declared `system` subtypes, measured 2026-08-13: `turn_duration` 255,
 * `stop_hook_summary` 247, `away_summary` 63, `local_command` 15,
 * `compact_boundary` 3, `informational` 1 — and `api_error`, now extinct at 0.
 *
 * The list is the single source of both the type and the runtime check below, so
 * they cannot fall out of step.
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
  /**
   * The line's object verbatim, so a projector can read further fields through
   * the accessors without re-parsing. A line that was not a JSON object at all
   * gets a shared frozen empty record.
   */
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
  | UnknownLine;

/**
 * The envelope the four uuid-carrying types share — the union measured across
 * `assistant`, `user`, `system` and `attachment`, not the intersection. Listing a
 * name here only means "do not report this as drift", so the union costs a little
 * sensitivity and buys one list instead of four near-copies.
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
 * Harness `type` -> our kind, plus the field inventory measured for it. ONE table
 * rather than a 14-arm `if` chain, so adding a harness type is a one-line diff and
 * the drift allowlist cannot fall out of step with the classifier: two
 * hand-maintained lists would diverge on the first harness update.
 *
 * A `Map`, not an object literal: a transcript controls the lookup key, and
 * `LINE_TYPES['toString']` on an object would answer a function.
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
        // Still sent, though every `subtype: 'api_error'` system line has expired.
        'isApiErrorMessage',
        'error',
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
  ['attachment', { kind: 'attachment', knownFields: fields(ENVELOPE, ['attachment']) }],
  ['mode', { kind: 'mode', knownFields: fields(['type', 'mode', 'sessionId']) }],
  [
    'last-prompt',
    {
      kind: 'last-prompt',
      knownFields: fields(['type', 'lastPrompt', 'leafUuid', 'sessionId']),
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
      knownFields: fields(['type', 'operation', 'content', 'timestamp', 'sessionId']),
    },
  ],
  [
    'pr-link',
    {
      kind: 'pr-link',
      knownFields: fields(['type', 'sessionId', 'prNumber', 'prUrl', 'prRepository', 'timestamp']),
    },
  ],
  // Sidecar-only, and only in `subagents/workflows/wf_*/journal.jsonl`: a workflow
  // span pair, 12 each, paired 1:1.
  ['started', { kind: 'started', knownFields: fields(['type', 'key', 'agentId']) }],
  ['result', { kind: 'result', knownFields: fields(['type', 'key', 'agentId', 'result']) }],
]);

/** Stands in for a line that was not a JSON object, so `raw` is always readable. */
const EMPTY_RECORD: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * A non-empty drift key naming what arrived. A string `type` is used as sent;
 * anything else becomes a `<label>`, so "absent", "a number" and "null" stay three
 * rows in the report rather than merging into one. A line that was not an object
 * at all has no readable `type` and lands on `<undefined>` with the type-less
 * objects — both mean the same thing to a reader: a line we cannot name.
 */
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
    // Only the type is counted, not its fields: a whole new type would otherwise
    // flood the field report with its entire legitimate inventory.
    const raw_type = rawTypeKey(raw.type);
    ctx.drift.noteUnknownType(raw_type);
    return { ...base, kind: 'unknown', raw_type, raw_subtype: str(raw.subtype, '') };
  }

  ctx.drift.noteLine(raw, entry.knownFields);

  if (entry.kind === 'system') {
    const subtype = str(raw.subtype, '');
    if (!isSystemSubtype(subtype)) {
      // Deliberately NOT a generic `system` row: a new subtype must surface, not
      // disappear into an existing bucket.
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
 * Fold the control lines into the only two things they project to.
 *
 * `classifyLine` is per-line and structurally cannot know it is looking at the
 * LAST `ai-title`, so last-wins has to happen here. A single forward pass that
 * OVERWRITES on every hit makes it true by construction: there is no `if (!seen)`
 * for a later editor to "optimize", and a first-wins version gives a stale title
 * on every long session — 19 of 26 archived session files carry more than one
 * `ai-title`, one of them 66.
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

/**
 * The id of the prompt group this line belongs to, when it declares one.
 *
 * Measured 2026-08-14: declared on `user` lines only, 14,396 of them, every one
 * also carrying a uuid. A projector segments turns by watching this value change
 * as it walks forward, which is why the reader answers only what the line itself
 * declares and never anything about its neighbours.
 */
export function promptGroupId(line: ParsedLine): string | undefined {
  return str(line.raw.promptId, undefined);
}

/**
 * Why the harness refused a tool call, when it refused one.
 *
 * Measured 2026-08-19: 8 occurrences, `permission-rule` 7 and `user-rejected` 1,
 * and ALL 8 also carry `is_error: true`. A projector that reads the error flag
 * first therefore labels every denial in the corpus an error, which is why the
 * status ladder consults this reader before it consults the flag.
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
   * The model named on the most LINES, `<synthetic>` excluded — NOT the most
   * recent one, which is what the three fields above take.
   *
   * The divergence is deliberate. `cwd`, `gitBranch` and `version` describe
   * where a session ENDED UP, so last-wins answers them. A session runs many
   * model calls and the last is not authoritative, merely last: one trailing
   * line used to overwrite the model that did the work, and
   * `recomputeSessionRollups` then priced the session's WHOLE token total under
   * it. `<synthetic>` is the harness's own marker for a line it manufactured on
   * an auth expiry, a connect failure or a 529, so it names no model at all: it
   * is dropped before the tally, and a file naming nothing else folds to
   * `undefined` — an honestly unpriced session — rather than to the marker.
   *
   * Ties break to the model seen FIRST. That is a semantic choice, not a `Map`
   * ordering accident: on a one-line-against-one-line tie it IS "first real
   * model wins", which is wrong on a session that switched deliberately. It is
   * taken because it is deterministic and because no measured session ties —
   * 666 transcript files, none running two real models.
   *
   * `db/sidecars.ts` folds a head+tail byte window rather than a whole file, so
   * no whole-file rule can hold there. It reads only `project_path`,
   * `started_at` and `last_activity_at`, which is why this field is meaningless
   * in that call rather than wrong.
   */
  model: string | undefined;
  /** First and last TOP-LEVEL timestamps — never a nested one. */
  started_at: string | undefined;
  last_activity_at: string | undefined;
}

/**
 * Fold every line into the six session-wide values a file carries, in one pass.
 *
 * Sibling to `foldControlLines`, and here for the same reason: these are
 * whole-file answers that a per-line classifier structurally cannot give. The
 * timestamps are the MIN and MAX rather than the first and last seen, because
 * 301 adjacent pairs in the archive run backwards and a first/last reading
 * reports a negative session on every one of them.
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

  // `model` is lifted out of the `str()` block below because it alone is NOT
  // last-wins — see `SessionEnvelope.model` for why the four fields diverge.
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

  // Strict `>` over an insertion-ordered map keeps the FIRST model seen on a
  // tie, which the field's own doc comment argues for rather than assumes.
  let mostLines = 0;
  for (const [model, count] of linesPerModel) {
    if (count > mostLines) {
      envelope.model = model;
      mostLines = count;
    }
  }

  return envelope;
}
