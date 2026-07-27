// The schema contract module: envelope + entity types, deterministic event-ID
// derivation, and the local auth-token helper. Imported identically by adapter,
// tailer, and server (types also by the UI). Zero runtime dependencies — Node
// builtins only.

export type {
  Envelope,
  EnvelopeSource,
  MakeEnvelopeInput,
} from './envelope.js';
export { makeEnvelope } from './envelope.js';

export type {
  EventIdInput,
  HookEventIdInput,
  TranscriptEventIdInput,
  GenericEventIdInput,
} from './event-id.js';
export { deriveEventId, canonicalJson } from './event-id.js';

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
