// The spec's row field lists, transcribed by hand: the oracle the db read suite
// and the HTTP route suite both hold their key sets against. Hand-written on
// purpose — deriving these from `read.ts` would make the comparison circular.
// Sorted, because the db suite compares them with `toEqual`.

/** `spec/data-model-v2.md:271-286`, minus `live` (server-stamped, not a column). */
export const SESSION_ROW_KEYS = [
  'id',
  'title',
  'preview',
  'project_path',
  'git_branch',
  'model',
  'harness_version',
  'started_at',
  'last_activity_at',
  'turn_count',
  'tool_call_count',
  'error_count',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
  'agent_count',
  'sub_tool_call_count',
  'sub_error_count',
  'sub_tokens_in',
  'sub_tokens_out',
  'sub_tokens_cache_read',
  'sub_tokens_cache_write',
  'sub_est_cost',
  'rollup_state',
  'has_drift',
].sort();

/** `spec/data-model-v2.md:314-317`. */
export const TURN_ROW_KEYS = [
  'id',
  'seq',
  'kind',
  // Task 5.1: the Agent call a task_notification turn answers.
  'parent_event_id',
  'title',
  'started_at',
  'ended_at',
  'duration_ms',
  'duration_source',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
  'tool_call_count',
  'error_count',
  'first_seq',
  'last_seq',
].sort();

/** `spec/data-model-v2.md:318-328`. */
export const EVENT_ROW_KEYS = [
  'id',
  'turn_id',
  'seq',
  'kind',
  'ts',
  'request_id',
  'block_index',
  'name',
  'status',
  'duration_ms',
  'duration_source',
  'input',
  'input_bytes',
  'input_storage',
  'text',
  'text_bytes',
  'output_storage',
  'spill_path',
  'spill_bytes',
  'model',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
  'child_session_id',
  'agent_type',
  'agent_status',
  'raw_type',
  'raw_subtype',
].sort();

/** `spec/data-model-v2.md:349-354`. */
export const SEARCH_HIT_KEYS = [
  'session_id',
  'session_title',
  'project_path',
  'turn_id',
  'event_id',
  'seq',
  'kind',
  'name',
  'ts',
  'snippet',
].sort();

/** `spill_fts`'s declared columns, hand-listed like the rest. */
export const SPILL_FTS_COLUMNS = ['event_id', 'session_id', 'spill_path', 'text', 'input'];
