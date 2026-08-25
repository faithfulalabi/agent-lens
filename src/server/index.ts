// HTTP server (Hono): ingest, SSE, static UI serving. Phase-1 tracer bullet
// (Task 1.3); the query API and real UI arrive in later phases.

export { startServer } from './start.js';
export type { StartOptions, ServerHandle } from './start.js';
export { ingestEnvelope, ingestBatch, isValidEnvelopeShape, BATCH_SIZE } from './ingest.js';
export type { IngestResult, IngestBatchItem, IngestBatchOptions } from './ingest.js';
export { Broadcaster } from './sse.js';
export type { Subscriber } from './sse.js';
export { buildApp, buildApiApp } from './app.js';
export type { AppDeps, ApiAppDeps } from './app.js';
export { registerReadApi, jsonNotFound } from './read-api.js';
export {
  DeltaPublisher,
  RingBuffer,
  LIST_SCOPE,
  DELTA_RING_CAPACITY,
  LIST_RING_CAPACITY,
  SCOPE_IDLE_TTL_MS,
} from './deltas.js';
export type { SubscribeOptions, Subscription } from './deltas.js';
export { registerStreamApi, parseFromSeq } from './stream-api.js';
export type { StreamApiDeps } from './stream-api.js';
export type {
  Delta,
  DeltaBody,
  DeltaKind,
  HelloFrame,
  ResumeVerdict,
  StreamEndFrame,
} from '../shared/delta.js';
export { registerUi, injectToken } from './static-ui.js';
export { readConfig, writeConfig, clearConfig } from './config.js';
export type { RuntimeConfig } from './config.js';

export const MODULE = 'server';
