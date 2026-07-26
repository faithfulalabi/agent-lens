// Boot the collector: resolve the data dir, ensure token, open the DB, build
// the app, bind (with default-port auto-increment), persist the bound port to
// config.json, and return a handle. `dataDir` + `port:0` make it hermetic for
// tests; production uses the default dir and port 4470.

import { serve, type ServerType } from '@hono/node-server';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readOrCreateToken } from '../shared/index.js';
import { openDb } from '../db/index.js';
import { buildApp } from './app.js';
import { Broadcaster } from './sse.js';
import { clearConfig, writeConfig } from './config.js';
import { replaySpool } from '../capture/replay.js';

/** Options for `startServer`. */
export interface StartOptions {
  /** Explicit port: bound verbatim, fails loudly on collision (no increment). */
  port?: number;
  /** Data dir override; defaults to $AGENT_LENS_DIR then ~/.agent-lens. */
  dataDir?: string;
  /** Bind host; defaults to loopback. A non-loopback value exposes the server. */
  host?: string;
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
export async function startServer(
  options: StartOptions = {},
): Promise<ServerHandle> {
  const dataDir = resolveDataDir(options.dataDir);
  mkdirSync(dataDir, { recursive: true });

  const host = options.host ?? DEFAULT_HOSTNAME;
  const token = readOrCreateToken(dataDir);
  const db = openDb(dataDir);
  const broadcaster = new Broadcaster();

  // Recover anything the adapter spooled while the collector was down, before
  // we accept new connections. Idempotent (upsert-by-event_id), so a replay
  // that overlaps a prior run costs nothing.
  replaySpool(db, broadcaster, dataDir);

  const app = buildApp({ db, token, broadcaster, host });
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
      db.close();
      throw err;
    }
  }

  if (server === undefined) {
    db.close();
    throw new Error(`unable to bind a port starting at ${startPort}`);
  }

  // `port:0` yields an ephemeral port — resolve the actual bound value.
  if (startPort === 0) {
    const address = server.address();
    if (address !== null && typeof address === 'object') {
      boundPort = address.port;
    }
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
        server.close(() => {
          db.close();
          clearConfig(dataDir);
          resolve();
        });
      }),
  };
}
