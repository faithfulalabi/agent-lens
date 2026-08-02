// The normalizer: pure hook-policy that projects one harness envelope onto the
// canonical session/trace/span model. SQL lives in `src/db/` — this module only
// decides WHAT to write and calls the row-level upsert helpers. Driven inside the
// per-envelope transaction opened by `ingestEnvelope`, so a partial projection
// never commits. Every branch is upsert-shaped (idempotent on replay), and the
// `default` case degrades to a generic span rather than throwing: an unknown hook
// must never wedge ingest.
//
// Trace identity is `{session_id}:{turn_seq}` (data-model); the harness
// `prompt_id` is a correlator bridged to that identity via `prompt_trace_map` so
// Pre/Post tool spans attach to the turn that opened them.

import type { DatabaseSync } from 'node:sqlite';
import type { Envelope } from '../shared/index.js';
import type { SpanStatus, TraceTrigger } from '../shared/index.js';
import { canonicalJson } from '../shared/index.js';
import { mergeTranscriptLine } from './merge.js';
import {
  insertSessionIfAbsent,
  setCaptureMode,
  upsertSession,
  upsertTrace,
  upsertSpan,
  insertPayload,
  getTraceIdByPromptId,
  mapPromptToTrace,
  latestOpenTraceId,
  lastSessionStartSource,
  liveTracesForSession,
  closeRunningSpans,
  reviveSession,
  spanExists,
  maxTurnSeq,
} from '../db/index.js';

/** Loose view of a hook payload: an object of harness-supplied fields. */
type HookPayload = Record<string, unknown>;

/**
 * The normalizer's verdict on one envelope. `degraded` means the projection
 * survived but lost fidelity (an unrecognized hook), which the caller records on
 * the archive row so the drift counter surfaces it. Extra *fields* on a KNOWN
 * hook are not degradation — they are stashed in `spans.attrs` and stay
 * `processed` ("keep known fields, stash the rest").
 */
export interface NormalizeResult {
  degraded: boolean;
  reason?: string;
  /**
   * Traces this envelope touched, so Task 2.4's caller can recompute exactly
   * those rollups before committing. Plural because `SessionEnd` finalizes every
   * still-live turn at once. Absent/empty when no trace changed (`SessionStart`).
   */
  traceIds?: string[];
}

/**
 * Which spans one envelope wrote, collected by mutation rather than returned
 * (Task 6.1). The live-tail publisher needs span identity; every handler here
 * returns a TRACE id, span ids are function-locals, `touched()` hands back a
 * frozen singleton it cannot decorate, and `normalize`'s switch has a dozen early
 * returns — so widening the return type would mean restructuring all of them.
 *
 * **Spans only, deliberately.** There is no `traces` field because there would be
 * no reader for one: trace and session deltas are staged from the batch's
 * existing `DirtySet` after the rollup flush (`ingest.ts`), not from here. A
 * field that is written and never read invites a future author to trust it.
 */
export interface Touched {
  /** span id -> true iff THIS envelope created the row (drives `span_opened`). */
  spans: Map<string, boolean>;
}

/** Record a span this envelope wrote. No-op when nobody is collecting. */
export function markSpan(t: Touched | undefined, id: string, created: boolean): void {
  if (t === undefined) return;
  // First writer wins on `created`: an envelope that opens AND closes a span in
  // one pass (a synthetic close) is still that span's first appearance.
  if (!t.spans.has(id)) t.spans.set(id, created);
}

/** Shared no-drift verdict; frozen because every clean branch returns this instance. */
const OK: NormalizeResult = Object.freeze({ degraded: false });

/** Clean verdict naming the traces that changed; `OK` when none did. */
function touched(traceIds: readonly (string | undefined)[]): NormalizeResult {
  const ids = traceIds.filter((id): id is string => id !== undefined);
  return ids.length === 0 ? OK : { degraded: false, traceIds: ids };
}

/** Length cap for the human-readable trace prompt preview. */
const PROMPT_PREVIEW_MAX = 200;

/** Envelope-level fields every hook carries; never drift, never stashed. */
const COMMON_KEYS = [
  'session_id',
  'hook_event_name',
  'transcript_path',
  'cwd',
  'prompt_id',
] as const;

/**
 * Payload keys each known hook is understood to carry. Anything outside this set
 * is harness drift: preserved verbatim in `spans.attrs` rather than dropped, so a
 * Claude Code release that adds a field loses nothing.
 */
const KNOWN_KEYS: Record<string, readonly string[]> = {
  PreToolUse: ['tool_name', 'tool_input', 'tool_use_id'],
  PostToolUse: [
    'tool_name',
    'tool_input',
    'tool_response',
    'tool_use_id',
    'error',
    'permissionDecision',
    'permission_denied',
  ],
  PostToolUseFailure: [
    'tool_name',
    'tool_input',
    'tool_response',
    'tool_use_id',
    'error',
    'permissionDecision',
    'permission_denied',
  ],
  SubagentStart: ['agent_id', 'agent_type', 'agent_transcript_path'],
  SubagentStop: ['agent_id', 'agent_type', 'agent_transcript_path'],
  PreCompact: ['trigger', 'custom_instructions'],
  PostCompact: ['trigger', 'custom_instructions', 'compact_summary'],
};

/**
 * Project one envelope onto the session/trace/span model. Assumes it runs inside
 * a transaction (opened by the caller). Unknown/malformed hooks fall through to a
 * generic span and never throw; the returned verdict tells the caller whether the
 * archive row should be flagged `degraded`.
 *
 * `collector` is an optional live-tail span collector (Task 6.1); omit it and
 * every branch behaves exactly as before. `reprocess.ts` omits it on purpose —
 * dead-letter healing is a manual triage path, not a live one. It is NOT named
 * `touched` here only because the module-private `touched()` verdict helper below
 * already owns that name, and that helper deliberately stays untouched: it names
 * the traces an envelope moved, which remains `DirtySet`'s concern, not this one.
 */
export function normalize(
  db: DatabaseSync,
  envelope: Envelope,
  collector?: Touched,
): NormalizeResult {
  const payload = asPayload(envelope.raw_payload);
  const hook = envelope.hook_name ?? '';

  // Any event at all proves the session is alive again after an inactivity sweep.
  // Deliberately AHEAD of the transcript branch: a session the sweep marked
  // `interrupted` while its transcript is visibly growing must come back to life.
  reviveSession(db, envelope.session_id);

  if (envelope.source === 'transcript') {
    // A transcript line carries no hook name, so left alone it would fall
    // through to the `default` branch, mint a degraded generic span, and inflate
    // the drift counter for every line of every session. Session presence and
    // liveness stay 3.1's; everything downstream of the row — traces, spans,
    // tokens, messages — is Task 3.2's merge policy, which is why this returns
    // `touched(...)` and not a bare `OK`: without the trace ids the caller's
    // dirty set stays empty and every trace rollup would read 0.
    ensureTranscriptSession(db, envelope, payload);
    return touched(mergeTranscriptLine(db, envelope, payload));
  }

  // A hook landed, so hooks demonstrably work for this session. If the tailer
  // won the race and minted the row `transcript_only`, nothing else could ever
  // correct it — `upsertSession`'s ON CONFLICT list omits `capture_mode`.
  setCaptureMode(db, envelope.session_id, 'full');

  switch (hook) {
    case 'SessionStart':
      openSession(db, envelope, payload);
      return OK;
    case 'SessionEnd':
      return touched(closeSession(db, envelope, 'complete', collector));
    case 'UserPromptSubmit':
      return touched([openTrace(db, envelope, payload, 'user_prompt')]);
    case 'PreToolUse':
      return touched([openToolSpan(db, envelope, payload, collector)]);
    case 'PostToolUse':
      return touched([
        closeToolSpan(db, envelope, payload, mapToolStatus(payload), collector),
      ]);
    case 'PostToolUseFailure':
      return touched([closeToolSpan(db, envelope, payload, 'error', collector)]);
    case 'SubagentStart':
      return touched([openSubagentSpan(db, envelope, payload, collector)]);
    case 'SubagentStop':
      return touched([closeSubagentSpan(db, envelope, payload, collector)]);
    case 'Stop':
      return touched([closeActiveTrace(db, envelope, collector)]);
    case 'PreCompact':
    case 'PostCompact':
      return touched([compactSpan(db, envelope, payload, hook, collector)]);
    default:
      // Unknown hook: record a generic span on the active turn, never throw.
      return {
        degraded: true,
        reason: `unknown hook ${hook || '(none)'}`,
        traceIds: [genericSpan(db, envelope, hook || 'unknown', payload, collector)],
      };
  }
}

// --- Hook handlers ---------------------------------------------------------

function openSession(db: DatabaseSync, env: Envelope, p: HookPayload): void {
  ensureSession(db, env, p);
}

/** Closes the session; returns every trace it finalized (their rollups moved). */
function closeSession(
  db: DatabaseSync,
  env: Envelope,
  status: 'complete' | 'interrupted',
  c?: Touched,
): string[] {
  // Session over: anything still running never reported a close, so finalize it
  // honestly as `unknown` rather than leaving a span running forever.
  const finalized = liveTracesForSession(db, env.session_id);
  for (const traceId of finalized) {
    // These spans will never be reported on again, so this is the only chance a
    // live view has to learn they stopped running.
    for (const id of closeRunningSpans(db, traceId, env.ts)) markSpan(c, id, false);
  }
  // Upsert-by-id: if SessionEnd arrives before SessionStart (out-of-order,
  // Q6), still materialize the row so nothing is lost.
  upsertSession(db, {
    id: env.session_id,
    harness: env.harness,
    project_path: 'unknown',
    started_at: env.ts,
    status,
    capture_mode: 'full',
    ended_at: env.ts,
  });
  return finalized;
}

function openTrace(
  db: DatabaseSync,
  env: Envelope,
  p: HookPayload,
  trigger: TraceTrigger,
): string {
  const promptId = str(p.prompt_id);
  const existing = promptId
    ? getTraceIdByPromptId(db, env.session_id, promptId)
    : undefined;
  if (existing) return existing;

  // Traces FK-reference sessions; if the SessionStart hasn't been processed yet
  // (out-of-order arrival, Q6), synthesize a placeholder session so the trace
  // write never violates the constraint. SessionStart later upserts real fields.
  ensureSession(db, env, p);

  const turnSeq = maxTurnSeq(db, env.session_id) + 1;
  const traceId = `${env.session_id}:${turnSeq}`;
  const promptText = str(p.prompt) ?? str(p.user_prompt) ?? '';

  upsertTrace(db, {
    id: traceId,
    session_id: env.session_id,
    turn_seq: turnSeq,
    trigger,
    prompt_preview: promptText.slice(0, PROMPT_PREVIEW_MAX),
    started_at: env.ts,
    status: 'live',
  });
  if (promptId) mapPromptToTrace(db, env.session_id, promptId, traceId);
  return traceId;
}

function openToolSpan(
  db: DatabaseSync,
  env: Envelope,
  p: HookPayload,
  c?: Touched,
): string {
  const traceId = resolveTrace(db, env, p);
  const spanId = str(p.tool_use_id) ?? env.event_id;
  const inputId = p.tool_input !== undefined
    ? insertPayload(db, canonicalJson(p.tool_input))
    : undefined;
  // Asked BEFORE the upsert, or the answer is always "it exists".
  markSpan(c, spanId, !spanExists(db, spanId));

  upsertSpan(db, {
    id: spanId,
    trace_id: traceId,
    span_type: 'tool_call',
    name: str(p.tool_name) ?? 'tool',
    status: 'running',
    started_at: env.ts,
    input_payload_id: inputId,
    source: 'hook',
    attrs: overflowAttrs(p, 'PreToolUse'),
  });
  return traceId;
}

function closeToolSpan(
  db: DatabaseSync,
  env: Envelope,
  p: HookPayload,
  status: SpanStatus,
  c?: Touched,
): string {
  const traceId = resolveTrace(db, env, p);
  const spanId = str(p.tool_use_id) ?? env.event_id;
  // Task 1.6: the PostToolUse output field is `tool_response` (OBJECT), NOT
  // `tool_output`. Missing on PreToolUse; present here.
  const outputId = p.tool_response !== undefined
    ? insertPayload(db, canonicalJson(p.tool_response))
    : undefined;
  // A close with no matching open means the Pre was lost (or never fired). Record
  // the span anyway and mark it, so `started_at` is visibly a guess, not data.
  const synthetic = !spanExists(db, spanId);
  // Doubles as the delta's created flag — this branch already had the pre-check
  // the other five span writers had to grow.
  markSpan(c, spanId, synthetic);

  upsertSpan(db, {
    id: spanId,
    trace_id: traceId,
    span_type: 'tool_call',
    name: str(p.tool_name) ?? 'tool',
    status,
    // started_at only used if the Post arrives with no prior Pre (out-of-order);
    // COALESCE in the helper keeps the real open time when Pre landed first.
    started_at: env.ts,
    ended_at: env.ts,
    output_payload_id: outputId,
    source: 'hook',
    tags: synthetic ? ['synthetic_open'] : [],
    attrs: overflowAttrs(p, env.hook_name ?? 'PostToolUse'),
  });
  return traceId;
}

function openSubagentSpan(
  db: DatabaseSync,
  env: Envelope,
  p: HookPayload,
  c?: Touched,
): string {
  const traceId = resolveTrace(db, env, p);
  const spanId = str(p.agent_id) ?? env.event_id;
  markSpan(c, spanId, !spanExists(db, spanId));
  upsertSpan(db, {
    id: spanId,
    trace_id: traceId,
    span_type: 'subagent',
    name: str(p.agent_type) ?? 'subagent',
    status: 'running',
    started_at: env.ts,
    source: 'hook',
    attrs: overflowAttrs(p, 'SubagentStart'),
  });
  return traceId;
}

function closeSubagentSpan(
  db: DatabaseSync,
  env: Envelope,
  p: HookPayload,
  c?: Touched,
): string {
  const traceId = resolveTrace(db, env, p);
  const spanId = str(p.agent_id) ?? env.event_id;
  markSpan(c, spanId, !spanExists(db, spanId));
  upsertSpan(db, {
    id: spanId,
    trace_id: traceId,
    span_type: 'subagent',
    name: str(p.agent_type) ?? 'subagent',
    status: 'ok',
    started_at: env.ts,
    ended_at: env.ts,
    source: 'hook',
    attrs: overflowAttrs(p, 'SubagentStop'),
  });
  return traceId;
}

/**
 * Stop finalizes the open turn. Only a `live` trace is closed — a Stop with no
 * open turn is a no-op rather than a retroactive edit of an already-complete one.
 * `trigger`/`prompt_preview` here are insert-only filler: the upsert's conflict
 * clause advances just `status`/`ended_at`, so a synthesized `system_resume` or
 * `compaction` trace keeps its real trigger.
 */
function closeActiveTrace(
  db: DatabaseSync,
  env: Envelope,
  c?: Touched,
): string | undefined {
  const traceId = latestOpenTraceId(db, env.session_id);
  if (!traceId) return undefined;
  // Turn over: any span still running never reported a close.
  for (const id of closeRunningSpans(db, traceId, env.ts)) markSpan(c, id, false);
  const turnSeq = Number(traceId.slice(traceId.lastIndexOf(':') + 1));
  upsertTrace(db, {
    id: traceId,
    session_id: env.session_id,
    turn_seq: turnSeq,
    trigger: 'user_prompt',
    prompt_preview: '',
    started_at: env.ts,
    ended_at: env.ts,
    status: 'complete',
  });
  return traceId;
}

function compactSpan(
  db: DatabaseSync,
  env: Envelope,
  p: HookPayload,
  hook: string,
  c?: Touched,
): string {
  const traceId = resolveTrace(db, env, p);
  markSpan(c, env.event_id, !spanExists(db, env.event_id));
  upsertSpan(db, {
    id: env.event_id,
    trace_id: traceId,
    span_type: 'generic',
    name: hook,
    status: 'ok',
    started_at: env.ts,
    ended_at: env.ts,
    source: 'hook',
    attrs: overflowAttrs(p, hook),
  });
  return traceId;
}

/**
 * Fallback for a hook this build does not know. The span is tagged `degraded` and
 * the entire payload is stashed in `attrs`, so a future Claude Code release is
 * visible-but-lossless rather than silently dropped. The real payload is handed
 * to `resolveTrace` (it may carry `prompt_id` or a resume `source`) — passing an
 * empty object here would blind every downstream heuristic.
 */
function genericSpan(
  db: DatabaseSync,
  env: Envelope,
  name: string,
  p: HookPayload,
  c?: Touched,
): string {
  const traceId = resolveTrace(db, env, p);
  markSpan(c, env.event_id, !spanExists(db, env.event_id));
  upsertSpan(db, {
    id: env.event_id,
    trace_id: traceId,
    span_type: 'generic',
    name,
    status: 'unknown',
    started_at: env.ts,
    ended_at: env.ts,
    source: 'hook',
    tags: ['degraded'],
    attrs: overflowAttrs(p, name),
  });
  return traceId;
}

// --- Status mapping --------------------------------------------------------

/**
 * Map a PostToolUse payload to a span status. `error` and `denied` are the
 * non-ok outcomes; everything else is `ok`.
 *
 * TODO(task-1.7): the exact `denied` (permission-blocked) field is not yet
 * frozen — it needs a real denied fixture from Task 1.7 (HITL, pending). This is
 * a best-guess marker (`permissionDecision === 'deny'` or an explicit
 * `permission_denied` flag). `denied` is scoped OUT of Task 2.2's definition of
 * done; it ships here behind a synthetic unit test only.
 */
export function mapToolStatus(p: HookPayload): SpanStatus {
  if (isDenied(p)) return 'denied';
  if (p.error !== undefined && p.error !== null) return 'error';
  const response = p.tool_response;
  if (isObject(response) && response.interrupted === true) return 'error';
  return 'ok';
}

/** Best-guess deny detection — see TODO(task-1.7). */
function isDenied(p: HookPayload): boolean {
  if (p.permissionDecision === 'deny') return true;
  if (p.permission_denied === true) return true;
  const response = p.tool_response;
  if (isObject(response) && response.permissionDecision === 'deny') return true;
  return false;
}

// --- Helpers ---------------------------------------------------------------

/**
 * Find the trace a tool/subagent/compact span belongs to.
 *
 * **Precedence is `prompt_id`-wins, deliberately (Task 2.3 ruling).** When the
 * harness gives us a `prompt_id` that maps to a turn, that turn owns the span
 * *regardless of its status* — the correlator is authoritative, so a late
 * `PostToolUse` for turn 1 genuinely belongs to turn 1 even though `Stop` already
 * completed it. A status filter here would only split a Pre/Post pair across two
 * traces, since `upsertSpan` never rewrites `trace_id`. Consequence for rollup
 * consumers: **a `complete` trace can still gain a span after close**, so rollups
 * must not be treated as computed-once-at-`Stop`.
 *
 * Without a `prompt_id` the fallback is the latest *open* trace — never a closed
 * one — so promptless post-`Stop` activity synthesizes a fresh trace instead of
 * gluing onto the finished turn (RFC 001).
 */
function resolveTrace(db: DatabaseSync, env: Envelope, p: HookPayload): string {
  const promptId = str(p.prompt_id);
  if (promptId) {
    const mapped = getTraceIdByPromptId(db, env.session_id, promptId);
    if (mapped) return mapped;
  }
  const open = latestOpenTraceId(db, env.session_id);
  if (open) return open;
  // No open turn — synthesize one so orphan activity is still attributable, and
  // label WHY it appeared so the UI can say "resumed" rather than "unknown".
  return openTrace(db, env, p, triggerFor(db, env, env.hook_name ?? '', p));
}

/**
 * Why did orphan activity appear with no open turn? Resolved in order:
 * compaction hooks, an explicit resume `source` on this payload, a `Notification`
 * hook, then the session's most recent `SessionStart` having been a resume.
 *
 * That last clause is the one that makes `SessionStart`-driven resume work at
 * all: `SessionStart` opens no trace (it must not burn a `turn_seq`), so the
 * signal has to be recovered from the raw archive when the first real activity
 * lands. It is a stateless lookback — no side table, replay-safe, and visible
 * in-transaction because the archive write precedes the projection.
 *
 * TODO(task-1.7): `Notification` → `system_resume` and `source === 'resume'` are
 * best guesses; no captured resume fixture exists yet. Task 1.7's golden fixtures
 * confirm or correct them (same containment Task 2.2 used for `denied`).
 */
function triggerFor(
  db: DatabaseSync,
  env: Envelope,
  hook: string,
  p: HookPayload,
): TraceTrigger {
  if (hook === 'PreCompact' || hook === 'PostCompact') return 'compaction';
  if (str(p.source) === 'resume') return 'system_resume';
  if (hook === 'Notification') return 'system_resume';
  if (lastSessionStartSource(db, env.session_id) === 'resume') {
    return 'system_resume';
  }
  return 'unknown';
}

/**
 * Harness drift, preserved: every payload key this build does not recognize,
 * verbatim, for `spans.attrs`. Keeping known fields and stashing the rest is what
 * lets a Claude Code release add fields without losing them.
 *
 * `null`-valued keys are omitted on purpose: `attrs` merges with `json_patch`
 * (RFC 7386), where an explicit `null` DELETES the key — so passing one through
 * could erase a value stashed by an earlier event. The verbatim `raw_events.raw`
 * archive remains the record of record for them.
 */
function overflowAttrs(p: HookPayload, hook: string): Record<string, unknown> {
  const known = new Set<string>([...COMMON_KEYS, ...(KNOWN_KEYS[hook] ?? [])]);
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) {
    if (known.has(key) || value === null) continue;
    attrs[key] = value;
  }
  return attrs;
}

/**
 * Guarantee a session row exists for this envelope so FK-referencing traces can
 * be written even when the SessionStart hook hasn't been processed yet. Uses the
 * same upsert as `openSession` (COALESCE-guarded), so a real SessionStart landing
 * later fills in `project_path`/`model`/`transcript_path` without clobbering.
 */
function ensureSession(db: DatabaseSync, env: Envelope, p: HookPayload): void {
  upsertSession(db, {
    id: env.session_id,
    harness: env.harness,
    project_path: str(p.cwd) ?? 'unknown',
    started_at: env.ts,
    status: 'live',
    capture_mode: 'full',
    model: str(p.model),
    transcript_path: str(p.transcript_path),
  });
}

/**
 * Materialize the session a transcript line belongs to, so Task 3.3 has a row to
 * tag and the read API can show the session at all.
 *
 * **Insert-if-absent, never `upsertSession`**, whose conflict clause sets
 * `status = excluded.status` unconditionally — a late transcript line would
 * resurrect a `complete` session to `live`.
 *
 * **Gated on the line carrying a `cwd`** (67% of real lines do, and every real
 * session emits some). `upsertSession` updates neither `project_path` nor
 * `capture_mode` on conflict, so a row created with `project_path:'unknown'`
 * could never be repaired by a later `SessionStart`. Gating avoids widening that
 * pre-existing hazard and needs no change to the hook path: a transcript with no
 * cwd-carrying line yet simply has no session row, which is Task 3.3's detection
 * window rather than 3.1's problem.
 *
 * `capture_mode: 'transcript_only'` is the honest label at creation time — we
 * have seen zero hooks for this session. It is not a ratchet: the first hook to
 * arrive corrects it via `setCaptureMode` at the top of `normalize`.
 */
function ensureTranscriptSession(
  db: DatabaseSync,
  env: Envelope,
  p: HookPayload,
): void {
  const cwd = str(p.cwd);
  if (cwd === undefined || cwd === '') return;
  insertSessionIfAbsent(db, {
    id: env.session_id,
    harness: env.harness,
    project_path: cwd,
    started_at: env.ts,
    status: 'live',
    capture_mode: 'transcript_only',
  });
}

function asPayload(raw: unknown): HookPayload {
  return isObject(raw) ? raw : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a string field, coercing absent/non-string to undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
