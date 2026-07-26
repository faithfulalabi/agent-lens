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
import {
  upsertSession,
  upsertTrace,
  upsertSpan,
  insertPayload,
  getTraceIdByPromptId,
  mapPromptToTrace,
  latestTraceId,
  maxTurnSeq,
} from '../db/index.js';

/** Loose view of a hook payload: an object of harness-supplied fields. */
type HookPayload = Record<string, unknown>;

/** Length cap for the human-readable trace prompt preview. */
const PROMPT_PREVIEW_MAX = 200;

/**
 * Project one envelope onto the session/trace/span model. Assumes it runs inside
 * a transaction (opened by the caller). Unknown/malformed hooks fall through to a
 * generic span and never throw.
 */
export function normalize(db: DatabaseSync, envelope: Envelope): void {
  const payload = asPayload(envelope.raw_payload);
  const hook = envelope.hook_name ?? '';

  switch (hook) {
    case 'SessionStart':
      openSession(db, envelope, payload);
      return;
    case 'SessionEnd':
      closeSession(db, envelope, 'complete');
      return;
    case 'UserPromptSubmit':
      openTrace(db, envelope, payload, 'user_prompt');
      return;
    case 'PreToolUse':
      openToolSpan(db, envelope, payload);
      return;
    case 'PostToolUse':
      closeToolSpan(db, envelope, payload, mapToolStatus(payload));
      return;
    case 'PostToolUseFailure':
      closeToolSpan(db, envelope, payload, 'error');
      return;
    case 'SubagentStart':
      openSubagentSpan(db, envelope, payload);
      return;
    case 'SubagentStop':
      closeSubagentSpan(db, envelope, payload);
      return;
    case 'Stop':
      closeActiveTrace(db, envelope);
      return;
    case 'PreCompact':
    case 'PostCompact':
      compactSpan(db, envelope, payload, hook);
      return;
    default:
      // Unknown hook: record a generic span on the active turn, never throw.
      genericSpan(db, envelope, hook || 'unknown');
      return;
  }
}

// --- Hook handlers ---------------------------------------------------------

function openSession(db: DatabaseSync, env: Envelope, p: HookPayload): void {
  ensureSession(db, env, p);
}

function closeSession(
  db: DatabaseSync,
  env: Envelope,
  status: 'complete' | 'interrupted',
): void {
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

function openToolSpan(db: DatabaseSync, env: Envelope, p: HookPayload): void {
  const traceId = resolveTrace(db, env, p);
  const spanId = str(p.tool_use_id) ?? env.event_id;
  const inputId = p.tool_input !== undefined
    ? insertPayload(db, canonicalJson(p.tool_input))
    : undefined;

  upsertSpan(db, {
    id: spanId,
    trace_id: traceId,
    span_type: 'tool_call',
    name: str(p.tool_name) ?? 'tool',
    status: 'running',
    started_at: env.ts,
    input_payload_id: inputId,
    source: 'hook',
  });
}

function closeToolSpan(
  db: DatabaseSync,
  env: Envelope,
  p: HookPayload,
  status: SpanStatus,
): void {
  const traceId = resolveTrace(db, env, p);
  const spanId = str(p.tool_use_id) ?? env.event_id;
  // Task 1.6: the PostToolUse output field is `tool_response` (OBJECT), NOT
  // `tool_output`. Missing on PreToolUse; present here.
  const outputId = p.tool_response !== undefined
    ? insertPayload(db, canonicalJson(p.tool_response))
    : undefined;

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
  });
}

function openSubagentSpan(db: DatabaseSync, env: Envelope, p: HookPayload): void {
  const traceId = resolveTrace(db, env, p);
  const spanId = str(p.agent_id) ?? env.event_id;
  upsertSpan(db, {
    id: spanId,
    trace_id: traceId,
    span_type: 'subagent',
    name: str(p.agent_type) ?? 'subagent',
    status: 'running',
    started_at: env.ts,
    source: 'hook',
  });
}

function closeSubagentSpan(db: DatabaseSync, env: Envelope, p: HookPayload): void {
  const traceId = resolveTrace(db, env, p);
  const spanId = str(p.agent_id) ?? env.event_id;
  upsertSpan(db, {
    id: spanId,
    trace_id: traceId,
    span_type: 'subagent',
    name: str(p.agent_type) ?? 'subagent',
    status: 'ok',
    started_at: env.ts,
    ended_at: env.ts,
    source: 'hook',
  });
}

function closeActiveTrace(db: DatabaseSync, env: Envelope): void {
  const traceId = latestTraceId(db, env.session_id);
  if (!traceId) return;
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
}

function compactSpan(
  db: DatabaseSync,
  env: Envelope,
  p: HookPayload,
  hook: string,
): void {
  const traceId = resolveTrace(db, env, p);
  upsertSpan(db, {
    id: env.event_id,
    trace_id: traceId,
    span_type: 'generic',
    name: hook,
    status: 'ok',
    started_at: env.ts,
    ended_at: env.ts,
    source: 'hook',
  });
}

function genericSpan(db: DatabaseSync, env: Envelope, name: string): void {
  const traceId = resolveTrace(db, env, {});
  upsertSpan(db, {
    id: env.event_id,
    trace_id: traceId,
    span_type: 'generic',
    name,
    status: 'unknown',
    started_at: env.ts,
    ended_at: env.ts,
    source: 'hook',
  });
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
 * Find the trace a tool/subagent/compact span belongs to: prefer the
 * `prompt_id`→trace bridge, then the latest open trace, else synthesize an
 * orphan trace so the span always has a parent (activity before any prompt).
 */
function resolveTrace(db: DatabaseSync, env: Envelope, p: HookPayload): string {
  const promptId = str(p.prompt_id);
  if (promptId) {
    const mapped = getTraceIdByPromptId(db, env.session_id, promptId);
    if (mapped) return mapped;
  }
  const latest = latestTraceId(db, env.session_id);
  if (latest) return latest;
  // No trace yet — synthesize one so orphan activity is still attributable.
  return openTrace(db, env, p, 'unknown');
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
