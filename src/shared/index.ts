// The schema contract module: entity types, the bundled pricing table, and the
// local auth-token helper. Imported by the server (types also by the UI). Zero
// runtime dependencies — Node builtins only.
//
// The envelope and event-id halves went with the hook path in Task 4.5: v2 reads
// transcripts, so there is no envelope to shape and no id to derive.

export type {
  Session,
  SessionStatus,
  CaptureMode,
  Trace,
  TraceTrigger,
  TraceStatus,
  Span,
  SpanType,
  SpanStatus,
  SpanSource,
  Payload,
  Message,
  MessageRole,
  RawEvent,
  RawEventSource,
  RawEventStatus,
  TailerOffset,
} from './entities.js';

export type { ModelPrice, TokenUsage } from './pricing.js';
export {
  PRICING_TABLE,
  PRICING_TABLE_DATE,
  PRICING_VERSION,
  estimateCost,
  normalizeModelKey,
} from './pricing.js';

export { readOrCreateToken, readToken, TOKEN_HEADER } from './token.js';
