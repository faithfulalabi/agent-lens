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
import { startLiveTick, type LiveTick } from './live.js';
import { createStreamHub } from './stream.js';

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

  // UNCONDITIONAL, and outside the sweep gate below on purpose: the hub owns the
  // 15 s heartbeat, and a boot with `sweepIntervalMs: 0` still serves
  // `/api/stream` and still has to beat on it.
  const hub = createStreamHub();

  const app = buildApiApp({
    db,
    token,
    host,
    uiDir: options.uiDir,
    env: createProjectionEnv(reader),
    sweep,
    hub,
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
  //
  // The LIVE TICK replaces `sweep.bind()` and owns the interval from here on: it
  // needs the two waves separately, because measuring one session's reprojection
  // is what the per-session backoff is built on and wave 2's shared deadline
  // cannot give that number back.
  let tick: LiveTick | undefined;
  if (options.sweepIntervalMs !== 0) {
    sweep.tick();
    tick = startLiveTick({
      db,
      env: createProjectionEnv(reader),
      sweep,
      hub,
      ...(options.sweepIntervalMs !== undefined && { intervalMs: options.sweepIntervalMs }),
    });
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
    close: async () => {
      // Every timer FIRST: `server.close` is async, and a tick or a beat that
      // fires after the handle is closed throws where no caller can catch it.
      // `tick` is undefined on a `sweepIntervalMs: 0` boot; the hub never is.
      tick?.close();
      sweep.close();

      // ★ THE CEILING `closeAllConnections` STOOD IN FOR IS DISCHARGED HERE.
      // `/api/stream` holds its response body open until something ends it, and
      // `server.close()` waits on every open connection — so before Task 6.1
      // `agent-lens start` hung on SIGTERM with one SSE client attached, and the
      // blunt fix was to kill every connection, in-flight non-stream requests
      // included. The hub now owns a client registry, so `drain()` ends exactly
      // the stream bodies and nothing else.
      //
      // `closeAllConnections()` STAYS as belt-and-braces for the requests the hub
      // does not know about — a slow-loris on a read route would otherwise hang
      // shutdown for a reason the drain cannot see. `ServerType` is a union that
      // includes `Http2Server`, which has no such method; `serve()` is called with
      // no http2 option, so this is always the `http.Server` limb.
      await hub.drain();

      return new Promise<void>((resolve) => {
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close(() => {
          opened.close();
          clearConfig(dataDir);
          resolve();
        });
      });
    },
  };
}
