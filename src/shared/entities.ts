// Type-only entity definitions mirroring `spec/data-model.md` §Entities verbatim.
// Type-only (interfaces + string-literal unions) so importing from the browser
// (ui/) costs nothing at runtime and leaks no Node builtins into the bundle.

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

/** Content-addressed blob store (data-model §Payload). */
export interface Payload {
  /** `sha256(content)` */
  id: string;
  content: Uint8Array;
  byte_size: number;
  mime_hint?: string;
}

/** Message role in the thread-view projection (data-model §Message). */
export type MessageRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'thinking';

/** Materialized thread-view projection row, rebuildable from raw. */
export interface Message {
  id: string;
  trace_id: string;
  span_id?: string;
  seq: number;
  role: MessageRole;
  payload_id: string;
}

/** Where a raw event originated (data-model §RawEvent). */
export type RawEventSource = 'hook' | 'transcript' | 'backfill' | 'spool_replay';

/** Processing outcome for an archived envelope (data-model §RawEvent). */
export type RawEventStatus = 'processed' | 'degraded' | 'dead_letter';

/** Every envelope that ever arrived, verbatim — the archive + dead-letter queue. */
export interface RawEvent {
  /** the envelope `event_id` (idempotency key). */
  id: string;
  session_id: string;
  source: RawEventSource;
  hook_name?: string;
  received_at: string;
  status: RawEventStatus;
  error?: string;
  raw: Uint8Array;
}

/** Tailer resume point per transcript file (data-model §TailerOffset). */
export interface TailerOffset {
  transcript_path: string;
  session_id: string;
  committed_offset: number;
  /** inode/size + head-hash fingerprint — detects rotation and in-place rewrites. */
  file_identity?: string;
}
