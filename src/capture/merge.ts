// The merge policy (Task 3.2): one transcript line in, spans + messages out.
//
// Runs behind the transcript branch of `normalize`, so it inherits the whole
// ingest funnel — per-item savepoint, rollup flush, deferred broadcast — and,
// critically, Task 2.6a's constraint: `ingestOne` returns BEFORE `normalize`
// when the archive row already exists, so a fingerprint-mismatch re-read can
// never re-enter this code. Idempotency is therefore structural, not defended.
//
// **The precedence rule, made mechanical (RFC 001):** hooks own lifecycle and
// timing, the transcript owns content. Nothing here writes `status`,
// `started_at` or `ended_at` onto a span that already exists — a span the merge
// CREATES is a different matter, since then the transcript is the only source
// there is. Payload refs are only ever filled in, never replaced.
//
// **Provenance:** this module writes `source: 'transcript'` on spans it creates
// and leaves `source` alone on spans it merely enriches. It never writes
// `source: 'merged'`. There is no output-content upgrade to justify one — see
// the truncation gate below — and mixed provenance becomes meaningful only when
// Task 3.4 completes a payload from the `tool-results/` sidecar.

import type { DatabaseSync } from 'node:sqlite';
import type { Envelope, MessageRole } from '../shared/index.js';
import { canonicalJson } from '../shared/index.js';
import {
  getTraceIdByPromptId,
  insertMessage,
  insertPayload,
  mapPromptToTrace,
  maxTurnSeq,
  nextMessageSeq,
  recordSpanUsage,
  sessionExists,
  spanPayloadRefs,
  transcriptLineLinks,
  upgradeSpanContent,
  upsertSpan,
  upsertTrace,
} from '../db/index.js';

/** Loose view of a transcript line: an object of harness-supplied fields. */
type Line = Record<string, unknown>;

/** Length cap for the human-readable trace prompt preview (mirrors the hook path). */
const PROMPT_PREVIEW_MAX = 200;

/**
 * Hop limit for the `parentUuid` ancestor walk. The measured worst case over a
 * 5,744-line corpus is 37 hops (median 2); the cap only exists so a cyclic or
 * corrupted chain cannot spin forever.
 */
const MAX_ANCESTOR_HOPS = 128;

/** Marker the harness writes at index 0 of a spilled `tool_result` string. */
const PERSISTED_MARKER = '<persisted-output>';

/**
 * The path inside the marker. Deliberately NOT anchored at `^`: the harness
 * writes `Output too large (100KB). Full output saved to: /abs/path.txt`, so the
 * literal sits mid-line. `.` never crosses a newline, so the capture still stops
 * at the end of that line.
 */
const SAVED_TO = /Full output saved to: (.+)$/m;

/**
 * Byte size at which the harness truncates tool output. A BYTE test, never
 * `.length`: the cap can cut mid-character, so a multibyte truncation stores
 * 30,001 bytes (10,001 chars) ending in U+FFFD and a `=== 30000` or char-count
 * test misses it entirely.
 */
const TRUNCATION_BYTES = 30000;

/** Tag recording that the harness spilled this output to a sidecar file. */
const TRUNCATED_TAG = 'truncated_by_harness';

/** Tag recording that a span exists only because the transcript described it. */
const TRANSCRIPT_ONLY_TAG = 'transcript_only';

/**
 * Project one transcript line onto traces/spans/messages. Returns the trace ids
 * it touched, so the caller's rollup flush recomputes exactly those.
 *
 * Returns `[]` — projecting nothing, throwing nothing — for every line that
 * cannot be attributed: no `uuid`, no session row (the `cwd` gate in 3.1's
 * `ensureTranscriptSession` did not fire), an unprojectable line type
 * (`mode`, `ai-title`, `file-history-*`, `attachment`, `system`), or no
 * resolvable trace. Those stay archive-only, which is the honest outcome; the
 * alternative is an FK violation that dead-letters a perfectly good line.
 */
export function mergeTranscriptLine(
  db: DatabaseSync,
  env: Envelope,
  line: Line,
): string[] {
  const uuid = str(line.uuid);
  const type = str(line.type);
  if (uuid === undefined) return [];
  if (type !== 'assistant' && type !== 'user') return [];
  // Traces/spans/messages all FK-reference a session row. `normalize` calls
  // `ensureTranscriptSession` immediately before us, so a miss here means the
  // line carried no `cwd` and 3.1 deliberately declined to mint a row.
  if (!sessionExists(db, env.session_id)) return [];

  const traceId = resolveTrace(db, env, line);
  if (traceId === undefined) return [];

  const ctx: Ctx = { db, env, traceId, uuid };
  if (type === 'assistant') projectAssistant(ctx, line);
  else projectUser(ctx, line);
  return [traceId];
}

/**
 * Everything the per-block writers share. Threaded as one value because all four
 * are fixed for the whole line and every deterministic id derives from
 * `{session}:{kind}:{uuid}` — passing them separately made five-argument
 * signatures out of two-argument work.
 */
interface Ctx {
  db: DatabaseSync;
  env: Envelope;
  /** The turn this line resolved to; every row it writes hangs off this. */
  traceId: string;
  /** The line's `uuid` — the id prefix that makes a re-merge a no-op. */
  uuid: string;
}

// --- Trace resolution ------------------------------------------------------

/**
 * Which turn does this line belong to? Deterministic, and deliberately NOT
 * `latestOpenTraceId` — a lookup-based resolution is what made `closeActiveTrace`
 * non-idempotent (Task 2.6a), and it would attach a late line to whichever turn
 * happens to be open rather than the one that owns it.
 *
 * `promptId` first (measured on 1,184 of 1,226 `user` lines, byte-identical to
 * the hook's `prompt_id`), else the `parentUuid` chain — which is the branch
 * real data ALWAYS takes for assistant lines, since 0 of 2,041 carry a
 * `promptId` of their own.
 */
function resolveTrace(db: DatabaseSync, env: Envelope, line: Line): string | undefined {
  const direct = str(line.promptId);
  if (direct !== undefined) return traceForPrompt(db, env, line, direct);

  const parentUuid = str(line.parentUuid);
  if (parentUuid === undefined) return undefined;
  const inherited = promptIdViaAncestors(db, env.session_id, parentUuid);
  if (inherited === undefined) return undefined;
  return traceForPrompt(db, env, line, inherited);
}

/** The turn a `promptId` names, opening it if the hook path never did. */
function traceForPrompt(
  db: DatabaseSync,
  env: Envelope,
  line: Line,
  promptId: string,
): string {
  const existing = getTraceIdByPromptId(db, env.session_id, promptId);
  return existing ?? openTranscriptTurn(db, env, line, promptId);
}

/**
 * Open a turn from transcript evidence alone — the hook-less (or
 * hooks-installed-mid-session) case.
 *
 * Reuses `openTrace`'s id/seq shape but NOT `openTrace` itself, twice over: it
 * reads `prompt_id` (snake_case) rather than the transcript's `promptId`, so
 * `mapPromptToTrace` would never fire; and it calls `upsertSession`, whose
 * conflict clause sets `status = excluded.status` and mints `capture_mode:
 * 'full'` — reintroducing exactly the session-resurrection hazard
 * `insertSessionIfAbsent` exists to prevent. The session row is guaranteed
 * present by the caller's `sessionExists` gate, so no session write is needed
 * here at all.
 */
function openTranscriptTurn(
  db: DatabaseSync,
  env: Envelope,
  line: Line,
  promptId: string,
): string {
  const turnSeq = maxTurnSeq(db, env.session_id) + 1;
  const traceId = `${env.session_id}:${turnSeq}`;
  upsertTrace(db, {
    id: traceId,
    session_id: env.session_id,
    turn_seq: turnSeq,
    trigger: 'user_prompt',
    prompt_preview: promptPreview(line),
    started_at: env.ts,
    status: 'live',
  });
  mapPromptToTrace(db, env.session_id, promptId, traceId);
  return traceId;
}

/**
 * Walk `parentUuid` to the first ancestor carrying a `promptId`, reading the raw
 * archive rather than a side table.
 *
 * The archive write precedes the projection inside the same transaction, so
 * every ancestor is a primary-key lookup away — including the `attachment` and
 * `system` lines that project nothing themselves. A side table populated only by
 * lines that PROJECT would miss those, and ~10% of assistant lines parent onto
 * one; they would resolve to no trace and lose their tokens, cost and messages
 * with no `degraded` signal at all.
 */
function promptIdViaAncestors(
  db: DatabaseSync,
  sessionId: string,
  startUuid: string,
): string | undefined {
  let uuid: string | undefined = startUuid;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS && uuid !== undefined; hop++) {
    const links = transcriptLineLinks(db, sessionId, uuid);
    if (links === undefined) return undefined;
    if (links.promptId !== undefined) return links.promptId;
    uuid = links.parentUuid;
  }
  return undefined;
}

/** The user prompt text, when this line is one — insert-only trace filler. */
function promptPreview(line: Line): string {
  const content = obj(line.message)?.content;
  return typeof content === 'string' ? content.slice(0, PROMPT_PREVIEW_MAX) : '';
}

// --- Assistant lines -------------------------------------------------------

/**
 * One `llm_call` span per assistant line (carrying that call's token usage),
 * plus a span per `thinking` block, plus the tool spans its `tool_use` blocks
 * name, plus one message row per block.
 */
function projectAssistant(ctx: Ctx, line: Line): void {
  const { db, env } = ctx;
  const message = obj(line.message) ?? {};
  const model = str(message.model);
  const llmSpanId = `${env.session_id}:llm:${ctx.uuid}`;

  // No hook produces an `llm_call` span, so this one is transcript-owned by
  // construction and always carries the tag. Re-asserting it on a re-merge is a
  // no-op: `upsertSpan` UNIONs tags rather than assigning them.
  upsertSpan(db, {
    id: llmSpanId,
    trace_id: ctx.traceId,
    span_type: 'llm_call',
    name: model ?? 'assistant',
    status: 'ok',
    started_at: env.ts,
    ended_at: env.ts,
    source: 'transcript',
    model,
    tags: [TRANSCRIPT_ONLY_TAG],
  });

  // 100% of real assistant lines carry `message.usage`, and it is the ONLY
  // token source in the pipeline — hook payloads carry none. `recordSpanUsage`
  // writes a full snapshot rather than a delta, so re-merging converges.
  const usage = obj(message.usage);
  if (usage !== undefined) {
    recordSpanUsage(db, llmSpanId, {
      tokens_in: num(usage.input_tokens),
      tokens_out: num(usage.output_tokens),
      cache_read: num(usage.cache_read_input_tokens),
      cache_write: num(usage.cache_creation_input_tokens),
      model,
    });
  }

  blocksOf(message).forEach((block, index) => {
    const kind = str(block.type);
    if (kind === 'thinking') {
      projectThinking(ctx, block, index, llmSpanId);
    } else if (kind === 'text') {
      addMessage(ctx, index, 'assistant', llmSpanId, payloadOf(db, block.text));
    } else if (kind === 'tool_use') {
      projectToolUse(ctx, block, index, llmSpanId);
    }
  });
}

/** A `thinking` block becomes both a span (parented at the call) and a message. */
function projectThinking(ctx: Ctx, block: Line, index: number, llmSpanId: string): void {
  const { db, env } = ctx;
  const spanId = `${env.session_id}:think:${ctx.uuid}:${index}`;
  const payloadId = payloadOf(db, block.thinking);
  upsertSpan(db, {
    id: spanId,
    trace_id: ctx.traceId,
    span_type: 'thinking',
    name: 'thinking',
    status: 'ok',
    started_at: env.ts,
    ended_at: env.ts,
    source: 'transcript',
    parent_span_id: llmSpanId,
    input_payload_id: payloadId,
    tags: [TRANSCRIPT_ONLY_TAG],
    attrs: withoutNulls({ signature: block.signature }),
  });
  addMessage(ctx, index, 'thinking', spanId, payloadId);
}

/**
 * A `tool_use` block IS the span: the transcript's `block.id` and the hook's
 * `tool_use_id` are the same string, which is `spans.id`. So this either
 * enriches the hook's span with the call's input, or creates the span outright
 * when hooks never saw the call.
 */
function projectToolUse(ctx: Ctx, block: Line, index: number, llmSpanId: string): void {
  const { db, env } = ctx;
  const spanId = str(block.id);
  if (spanId === undefined) return;
  const refs = spanPayloadRefs(db, spanId);

  // Reuse whatever the hook already stored rather than inserting a second,
  // flatter copy of the same call — for the span AND for the message.
  const payloadId = refs?.input_payload_id ?? payloadOf(db, block.input);

  if (refs === undefined) {
    upsertSpan(db, {
      id: spanId,
      trace_id: ctx.traceId,
      span_type: 'tool_call',
      name: str(block.name) ?? 'tool',
      // The transcript records a call that was issued and answered, so `ok` is
      // the honest default (the same one `mapToolStatus` returns absent an error
      // signal). A hook landing later corrects it: `upsertSpan` lets a terminal
      // status overwrite this one, and refuses to demote it back to `running`.
      status: 'ok',
      started_at: env.ts,
      ended_at: env.ts,
      source: 'transcript',
      parent_span_id: llmSpanId,
      input_payload_id: payloadId,
      tags: [TRANSCRIPT_ONLY_TAG],
    });
  } else {
    // Content only — never `status`/`started_at`/`ended_at` on a span that
    // already exists. `upgradeSpanContent` cannot express those at all.
    upgradeSpanContent(db, { span_id: spanId, input_payload_id: payloadId });
  }
  addMessage(ctx, index, 'tool_use', spanId, payloadId);
}

// --- User lines ------------------------------------------------------------

/** A user line is either the prompt text itself or the tool results it carries. */
function projectUser(ctx: Ctx, line: Line): void {
  const message = obj(line.message) ?? {};
  const content = message.content;
  if (typeof content === 'string') {
    addMessage(ctx, 0, 'user', undefined, payloadOf(ctx.db, content));
    return;
  }
  blocksOf(message).forEach((block, index) => {
    const kind = str(block.type);
    if (kind === 'tool_result') {
      projectToolResult(ctx, line, block, index);
    } else if (kind === 'text') {
      addMessage(ctx, index, 'user', undefined, payloadOf(ctx.db, block.text));
    }
  });
}

/**
 * The output side. `message.content[].tool_result` is the SOLE output-content
 * source; `toolUseResult` is archive-only for content (it is byte-identical to
 * the hook's `tool_response` on 7/7 measured paired calls, so reading it could
 * only ever produce a tie) but IS the truncation-signal and sidecar-pointer
 * source.
 */
function projectToolResult(ctx: Ctx, line: Line, block: Line, index: number): void {
  const { db, env } = ctx;
  const spanId = str(block.tool_use_id);
  if (spanId === undefined) return;

  const signal = truncationSignal(line.toolUseResult, str(block.content));
  const attrs = withoutNulls({
    persisted_output_path: signal.path,
    persisted_output_size: signal.size,
  });
  const refs = spanPayloadRefs(db, spanId);

  // **AC1's never-downgrade half, and it is a decision not to write at all.**
  // When a hook already stored this call's output, the transcript block is not
  // inserted: it is a preview (2,278 bytes against a 30,000-byte hook prefix on
  // a spilled call) or a flatter rendering of identical bytes. The message
  // points at the hook's blob for the same reason — showing the reader less than
  // we hold would break "nothing hidden" in the thread view.
  const payloadId = refs?.output_payload_id ?? payloadOf(db, block.content);

  if (refs === undefined) {
    upsertSpan(db, {
      id: spanId,
      trace_id: ctx.traceId,
      span_type: 'tool_call',
      name: 'tool',
      status: block.is_error === true ? 'error' : 'ok',
      started_at: env.ts,
      ended_at: env.ts,
      source: 'transcript',
      output_payload_id: payloadId,
      tags: signal.truncated ? [TRANSCRIPT_ONLY_TAG, TRUNCATED_TAG] : [TRANSCRIPT_ONLY_TAG],
      attrs,
    });
  } else {
    // The tag and the pointer are recorded UNCONDITIONALLY and BEFORE any
    // content decision — the block that carries the path to the complete output
    // is exactly the block a size comparison throws away.
    upgradeSpanContent(db, {
      span_id: spanId,
      output_payload_id: payloadId,
      tags: signal.truncated ? [TRUNCATED_TAG] : [],
      attrs,
    });
  }
  addMessage(ctx, index, 'tool_result', spanId, payloadId);
}

// --- The truncation-signal gate --------------------------------------------

/** Whether the harness spilled this output, and where it put it. */
interface Truncation {
  truncated: boolean;
  /** Verbatim ABSOLUTE sidecar path — never a basename. Task 3.4 needs the path. */
  path?: string;
  /** Exact byte count of the spilled output, when the harness stated one. */
  size?: number;
}

const NOT_TRUNCATED: Truncation = Object.freeze({ truncated: false });

/**
 * Was this tool output truncated? A POSITIVE signal from fields the harness
 * already emits, deliberately not a size comparison between the two surfaces.
 *
 * A comparison is unsound here in both directions: JSON escaping alone makes a
 * byte-identical transcript string "larger" than the hook object it came from,
 * Read renders the same file as a structured object on one side and a `cat -n`
 * string on the other, and for a genuinely spilled call the transcript holds a
 * ~2,278-byte preview against a 30,000-byte hook prefix — so it says "no
 * upgrade, no tag" exactly where the tag matters most.
 *
 * Everything below reads the TRANSCRIPT LINE ONLY. `tur` is this line's
 * `toolUseResult`, which is byte-identical to the hook's `tool_response`, so
 * naming the hook as "where the harness puts the field" costs no second read
 * path. Clause order is load-bearing.
 */
function truncationSignal(tur: unknown, resultText: string | undefined): Truncation {
  // `toolUseResult` is a plain STRING on some tool calls (measured 1 of 8 in the
  // capture), so every read below has to go through the object narrowing.
  const field = (key: string): unknown => obj(tur)?.[key];

  // 1. Structured pointer — the primary detector, present 3/3 on real spills.
  const path = str(field('persistedOutputPath'));
  if (path !== undefined) {
    const size = field('persistedOutputSize');
    return {
      truncated: true,
      path,
      size: typeof size === 'number' && Number.isInteger(size) ? size : undefined,
    };
  }

  // 2. The text marker, for harness builds that emit no structured pointer.
  //    `startsWith`, NEVER `includes`: the same literal shows up mid-string in
  //    assistant prose and in `Stop.last_assistant_message`, and a substring test
  //    would tag the model talking ABOUT truncation. Measured at index 0, 3/3.
  if (resultText !== undefined && resultText.startsWith(PERSISTED_MARKER)) {
    return { truncated: true, path: SAVED_TO.exec(resultText)?.[1] };
  }

  // 3. Last resort: a prefix sitting exactly on the cap. Scoped to
  //    `toolUseResult.stdout` and nothing else — applied to the transcript's own
  //    `tool_result` string it would tag any large output as spilled, which is
  //    backwards, and a Read response has no `stdout` key to test at all. This is
  //    a deliberate conservative OVER-tag at exactly 30,000 bytes, the largest
  //    size the harness still passes through whole.
  const stdout = str(field('stdout'));
  if (stdout !== undefined && Buffer.byteLength(stdout, 'utf8') >= TRUNCATION_BYTES) {
    return { truncated: true };
  }

  return NOT_TRUNCATED;
}

// --- Shared writes ---------------------------------------------------------

/**
 * Content-address one block's payload, or `undefined` when the block carries no
 * content field at all.
 *
 * The guard is not defensive decoration: `canonicalJson(undefined)` returns the
 * JS value `undefined` rather than a string, which would throw inside the hash
 * and dead-letter an otherwise good line. The transcript format is officially
 * unstable, so a block missing the field this build expects must degrade to "no
 * message row" — the line is still archived verbatim either way.
 */
function payloadOf(db: DatabaseSync, value: unknown): string | undefined {
  return value === undefined ? undefined : insertPayload(db, canonicalJson(value));
}

/**
 * One thread-view row. The id is derived from `{session}:msg:{uuid}:{block}` so
 * `insertMessage`'s `ON CONFLICT DO NOTHING` makes a re-merge a genuine no-op —
 * including `seq`, which is recomputed but then discarded by the conflict.
 *
 * `seq` is a per-trace `MAX+1`, not the line's byte offset: the normalizer never
 * sees the offset (it is an event-id input only, not carried on the envelope).
 * Ordering is still correct because the tailer emits lines in byte-offset order.
 *
 * **No payload means no row.** `messages.payload_id` is `NOT NULL REFERENCES
 * payloads(id)`, so a block whose content field this build cannot find has
 * nothing to point at. Swallowing that here rather than at four call sites keeps
 * the invariant in one place: the line is archived verbatim either way.
 */
function addMessage(
  ctx: Ctx,
  index: number,
  role: MessageRole,
  spanId: string | undefined,
  payloadId: string | undefined,
): void {
  if (payloadId === undefined) return;
  insertMessage(ctx.db, {
    id: `${ctx.env.session_id}:msg:${ctx.uuid}:${index}`,
    trace_id: ctx.traceId,
    span_id: spanId,
    seq: nextMessageSeq(ctx.db, ctx.traceId),
    role,
    payload_id: payloadId,
  });
}

// --- Helpers ---------------------------------------------------------------

/** The content blocks of a harness `message`, or `[]` for string/absent content. */
function blocksOf(message: Line): Line[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Line => obj(block) !== undefined);
}

/**
 * Drop null/undefined-valued keys. `attrs` merges with `json_patch` (RFC 7386),
 * where an explicit `null` DELETES the key — so writing one could erase
 * `pricing_version` or a drift field the hook path stashed.
 */
function withoutNulls(source: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue;
    kept[key] = value;
  }
  return kept;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a string field, coercing absent/non-string to undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Read a finite number field, coercing anything else to undefined. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
