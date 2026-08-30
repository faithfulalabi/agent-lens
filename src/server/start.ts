// Boot the collector: resolve the data dir, ensure token, open cache.db under
// its single-instance lock, start the corpus sweep, build the app, bind (with
// default-port auto-increment), persist the bound port to config.json, and
// return a handle. `dataDir` + `port:0` make it hermetic for tests; production
// uses the default dir and port 4470.
//
// ★ ONE `ArchiveReader` FOR THE WHOLE PROCESS. The sweep, the projection env and
// the content resolver all read the same archive, and the reader caches decoded
// sealed frames — give each its own and one sealed session decompresses three
// times per pass instead of once.

import { serve, type ServerType } from '@hono/node-server';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readOrCreateToken } from '../shared/index.js';
import { createArchiveReader } from '../archive/read.js';
import { createContentResolver, createContentEnv } from '../content/resolve.js';
import { createCorpusSweep } from '../corpus/watch.js';
import { createProjectionEnv } from '../corpus/env.js';
import { openDb } from '../db/open.js';
import { readEventArchivePath } from '../db/read.js';
import { buildApiApp } from './app.js';
import { clearConfig, writeConfig } from './config.js';

/** Options for `startServer`. */
export interface StartOptions {
  /** Explicit port: bound verbatim, fails loudly on collision (no increment). */
  port?: number;
  /** Data dir override; defaults to $AGENT_LENS_DIR then ~/.agent-lens. */
  dataDir?: string;
  /** Bind host; defaults to loopback. A non-loopback value exposes the server. */
  host?: string;
  /** `ui/dist` override; defaults to `resolveUiDir()`. Tests inject a fake bundle. */
  uiDir?: string;
  /**
   * Transcript root; defaults to $AGENT_LENS_TRANSCRIPT_ROOT then
   * ~/.claude/projects. Setting it also confines the sweep to that subtree,
   * which is what makes a test boot hermetic.
   */
  transcriptRoot?: string;
  /**
   * Corpus-sweep period in ms; `0` disables the sweep entirely — the timer AND
   * the boot pass, so it is a real off switch rather than a quiet
   * one-scan-then-stop.
   */
  sweepIntervalMs?: number;
}

/** A running server handle. */
export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

/** Default bind port; auto-increments on collision up to this many tries. */
const DEFAULT_PORT = 4470;
const MAX_PORT_TRIES = 20;
const DEFAULT_HOSTNAME = '127.0.0.1';

/** Loopback bind hosts that need no network-exposure warning. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.AGENT_LENS_DIR ?? join(homedir(), '.agent-lens');
}

/** Loud, multi-line warning printed once for a non-loopback (network-exposed) bind. */
function warnNetworkExposure(host: string, port: number): void {
  console.warn(
    [
      '',
      '  ############################################################',
      '  #  WARNING: agent-lens is binding to a non-loopback host.  #',
      `  #  Listening on ${host}:${port} — reachable over the network.`,
      '  #  Your traces contain source code and secrets. The token  #',
      '  #  is the ONLY thing guarding them. Do this on trusted LANs #',
      '  #  only, and never on a public/untrusted network.          #',
      '  ############################################################',
      '',
    ].join('\n'),
  );
}

/** Bind `@hono/node-server` on `host`:`port`, resolving once listening or rejecting on error. */
function bind(
  fetch: (request: Request) => Response | Promise<Response>,
  host: string,
  port: number,
): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, hostname: host, port }, () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

/**
 * Boot the server. Explicit `port` is used verbatim (throws on EADDRINUSE).
 * `port === 0` binds an ephemeral port (tests). Otherwise the default port
 * auto-increments on EADDRINUSE, printing the chosen port.
 */
export async function startServer(options: StartOptions = {}): Promise<ServerHandle> {
  const dataDir = resolveDataDir(options.dataDir);
  mkdirSync(dataDir, { recursive: true });

  const host = options.host ?? DEFAULT_HOSTNAME;
  const token = readOrCreateToken(dataDir);
  const opened = openDb({ dataDir, port: options.port });
  const db = opened.db;

  const reader = createArchiveReader();
  const sweep = createCorpusSweep({
    db,
    dataDir,
    transcriptRoot: options.transcriptRoot,
    reader,
    ...(options.sweepIntervalMs !== undefined && { intervalMs: options.sweepIntervalMs }),
  });

  const app = buildApiApp({
    db,
    token,
    host,
    uiDir: options.uiDir,
    env: createProjectionEnv(reader),
    sweep,
    resolveContent: createContentResolver(
      (id) => readEventArchivePath(db, id)?.archive_path,
      createContentEnv(reader),
    ),
  });
  const fetch = app.fetch;

  const explicit = options.port !== undefined;
  const startPort = explicit ? options.port! : DEFAULT_PORT;

  let server: ServerType | undefined;
  let boundPort = startPort;

  for (let attempt = 0; attempt < (explicit ? 1 : MAX_PORT_TRIES); attempt++) {
    const candidate = startPort + attempt;
    try {
      server = await bind(fetch, host, candidate);
      boundPort = candidate;
      break;
    } catch (err) {
      if (
        !explicit &&
        (err as NodeJS.ErrnoException).code === 'EADDRINUSE' &&
        attempt < MAX_PORT_TRIES - 1
      ) {
        continue;
      }
      opened.close();
      throw err;
    }
  }

  if (server === undefined) {
    opened.close();
    throw new Error(`unable to bind a port starting at ${startPort}`);
  }

  // `port:0` yields an ephemeral port — resolve the actual bound value.
  if (startPort === 0) {
    const address = server.address();
    if (address !== null && typeof address === 'object') {
      boundPort = address.port;
    }
  }

  // The sweep starts only once the socket is bound: every failure path above
  // closes the DB, and a surviving timer that fires against a closed handle
  // throws inside a timer callback where nothing can catch it. The first tick is
  // synchronous, so `startServer` returns holding a readable index rather than an
  // empty one — and `sweepIntervalMs: 0` skips it too, because an off switch that
  // still performs one full scan is not an off switch.
  if (options.sweepIntervalMs !== 0) {
    sweep.tick();
    sweep.bind();
  }

  writeConfig(dataDir, {
    port: boundPort,
    pid: process.pid,
    started_at: new Date().toISOString(),
  });

  if (!explicit && boundPort !== DEFAULT_PORT) {
    console.log(`agent-lens: port ${DEFAULT_PORT} in use, listening on ${boundPort}`);
  }

  // A non-loopback bind exposes traces (source + secrets) to the network; the
  // token is the only guard. Warn loudly — auth stays fully enforced.
  if (!LOOPBACK_HOSTS.has(host)) {
    warnNetworkExposure(host, boundPort);
  }

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        // The sweep's timer FIRST: `server.close` is async, and a tick that fires
        // after the handle is closed throws where no caller can catch it.
        sweep.close();
        // ponytail: CEILING — `/api/stream` (`api.ts:514`) holds its response body
        // open forever, and `server.close()` waits on every open connection, so
        // without this `agent-lens start` hangs on SIGTERM with one SSE client
        // attached. This is the blunt instrument: it kills in-flight non-stream
        // requests too. Upgrade path: Task 6.1 owns the real stream and needs
        // per-client bookkeeping regardless, so the registry that drains only
        // streams belongs there, on a shutdown surface `ApiDeps` does not have.
        // `ServerType` is a union that includes `Http2Server`, which has no such
        // method; `serve()` is called with no http2 option, so this is always the
        // `http.Server` limb.
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close(() => {
          opened.close();
          clearConfig(dataDir);
          resolve();
        });
      }),
  };
}
