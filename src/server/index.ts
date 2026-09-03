// HTTP server (Hono): the ten read routes, the corpus sweep, static UI serving.

export { startServer } from './start.js';
export type { StartOptions, ServerHandle } from './start.js';
export { buildApiApp } from './app.js';
export type { ApiAppDeps } from './app.js';
export { createStreamHub, STREAM_EVENTS, HEARTBEAT_MS } from './stream.js';
export type { StreamHub, StreamHubOptions, StreamEventName } from './stream.js';
export { startLiveTick } from './live.js';
export type { LiveTick, LiveTickOptions } from './live.js';
export { createWarmQueue } from './warm.js';
export type { WarmQueue, WarmQueueOptions } from './warm.js';
export { aggregateDrift } from './drift-report.js';
export type { DriftReport, DriftSession, RawDrift } from './drift-report.js';
export { registerUi, injectToken } from './static-ui.js';
export { readConfig, writeConfig, clearConfig } from './config.js';
export type { RuntimeConfig } from './config.js';

export const MODULE = 'server';
