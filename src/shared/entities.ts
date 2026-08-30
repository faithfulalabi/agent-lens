// Type-only entity definitions mirroring `spec/data-model.md` §Entities verbatim.
// Type-only (interfaces + string-literal unions) so importing from the browser
// (ui/) costs nothing at runtime and leaks no Node builtins into the bundle.
//
// SEVEN TYPES WENT IN TASK 5.1: Payload, MessageRole, Message, RawEventSource,
// RawEventStatus, RawEvent and TailerOffset. Nothing constructed any of them
// after the v2 cutover — the hook path, the payload store and the tailer
// offsets all went with plan 001 — and the last importer was one compile-only
// assertion. `Span` and `Trace` STAY: seven UI files still import them, and
// Task 5.2 deletes them with the tree that renders them.

/** Session lifecycle status (data-model §Session). */
export type SessionStatus = 'live' | 'complete' | 'interrupted';

/** How much of a session was captured (data-model §Session). */
export type CaptureMode = 'full' | 'transcript_only';

/** One Claude Code session — the thread that groups traces in order. */
export interface Session {
  id: string;
  harness: string;
  project_path: string;
  git_branch?: string;
  model?: string;
  started_at: string;
  ended_at?: string;
  status: SessionStatus;
  capture_mode: CaptureMode;
  transcript_path?: string;
  total_tokens: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  est_cost: number;
  tool_call_count: number;
  error_count: number;
  trace_count: number;
}

/** What kicked off a turn (data-model §Trace). */
export type TraceTrigger =
  | 'user_prompt'
  | 'system_resume'
  | 'compaction'
  | 'unknown';

/** Trace/turn lifecycle status (data-model §Trace). */
export type TraceStatus = 'live' | 'complete' | 'interrupted';

/** One user-turn: prompt -> agent activity -> stop. */
export interface Trace {
  /** `{session_id}:{turn_seq}` */
  id: string;
  session_id: string;
  turn_seq: number;
  trigger: TraceTrigger;
  prompt_preview: string;
  started_at: string;
  ended_at?: string;
  status: TraceStatus;
  total_tokens: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  est_cost: number;
  duration_ms: number;
  tool_call_count: number;
  error_count: number;
}

/** Kind of agent activity a span represents (data-model §Span). */
export type SpanType =
  | 'llm_call'
  | 'tool_call'
  | 'thinking'
  | 'subagent'
  | 'generic';

/** Span outcome; `denied` = permission-blocked (data-model §Span). */
export type SpanStatus = 'running' | 'ok' | 'error' | 'denied' | 'unknown';

/** Provenance of a span's data (data-model §Span). */
export type SpanSource = 'hook' | 'transcript' | 'merged';

/** One unit of agent activity — the workhorse tree row. No blobs (payload refs only). */
export interface Span {
  /** `tool_use_id` where available, else derived from the opening raw event. */
  id: string;
  trace_id: string;
  /** self-FK; null/absent = direct child of the trace root. */
  parent_span_id?: string;
  span_type: SpanType;
  name: string;
  status: SpanStatus;
  started_at: string;
  ended_at?: string;
  input_payload_id?: string;
  output_payload_id?: string;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  est_cost?: number;
  source: SpanSource;
  /** e.g. `synthetic_open`, `transcript_only`, `degraded`, `unattributed`. */
  tags: string[];
  /** harness-specific overflow (JSON object). */
  attrs: Record<string, unknown>;
}
