// HTTP server (Hono): the ten read routes, the corpus sweep, static UI serving.

export { startServer } from './start.js';
export type { StartOptions, ServerHandle } from './start.js';
export { buildApiApp } from './app.js';
export type { ApiAppDeps } from './app.js';
export { registerUi, injectToken } from './static-ui.js';
export { readConfig, writeConfig, clearConfig } from './config.js';
export type { RuntimeConfig } from './config.js';

export const MODULE = 'server';
