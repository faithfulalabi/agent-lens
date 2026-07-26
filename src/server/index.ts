// HTTP server (Hono): ingest, SSE, static UI serving. Phase-1 tracer bullet
// (Task 1.3); the query API and real UI arrive in later phases.

export { startServer } from './start.js';
export type { StartOptions, ServerHandle } from './start.js';
export { ingestEnvelope, ingestBatch, isValidEnvelopeShape, BATCH_SIZE } from './ingest.js';
export type { IngestResult, IngestBatchItem } from './ingest.js';
export { Broadcaster } from './sse.js';
export type { Subscriber } from './sse.js';
export { buildApp } from './app.js';
export type { AppDeps } from './app.js';
export { readConfig, writeConfig, clearConfig } from './config.js';
export type { RuntimeConfig } from './config.js';

export const MODULE = 'server';
