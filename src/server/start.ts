// Boot the collector: resolve the data dir, ensure token, open the DB, build
// the app, bind (with default-port auto-increment), persist the bound port to
// config.json, and return a handle. `dataDir` + `port:0` make it hermetic for
// tests; production uses the default dir and port 4470.

import { serve, type ServerType } from '@hono/node-server';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { readOrCreateToken } from '../shared/index.js';
import { openDb } from '../db/index.js';
import { buildApp } from './app.js';
import { Broadcaster } from './sse.js';
import { DeltaPublisher } from './deltas.js';
import { readSession, readSpan, readTrace } from '../db/index.js';
import type { DeltaBody } from '../shared/delta.js';
import { clearConfig, writeConfig } from './config.js';
import { replaySpool } from '../capture/replay.js';
import {
  sweepInactive,
  DEFAULT_SWEEP_INTERVAL_MS,
  type SweepResult,
} from '../capture/inactivity.js';
import {
  tailOnce,
  DEFAULT_TAIL_INTERVAL_MS,
  type TailResult,
} from '../capture/tailer.js';

/** Options for `startServer`. */
export interface StartOptions {
  /** Explicit port: bound verbatim, fails loudly on collision (no increment). */
  port?: number;
  /** Data dir override; defaults to $AGENT_LENS_DIR then ~/.agent-lens. */
  dataDir?: string;
  /** Bind host; defaults to loopback. A non-loopback value exposes the server. */
  host?: string;
  /** Inactivity-sweep period in ms; `0` disables the sweep entirely. */
  sweepIntervalMs?: number;
  /**
   * Silence threshold the sweep applies, in ms; defaults to `DEFAULT_TIMEOUT_MS`
   * (30 min). Injectable so a test can make a session go stale on demand.
   */
  sweepTimeoutMs?: number;
  /** Called with each sweep's result — observability hook (and test seam). */
  onSweep?: (result: SweepResult) => void;
  /** SSE heartbeat period in ms; defaults to 15s. Injectable for tests. */
  heartbeatMs?: number;
  /** `ui/dist` override; defaults to `resolveUiDir()`. Tests inject a fake bundle. */
  uiDir?: string;
  /**
   * Transcript root; defaults to $AGENT_LENS_TRANSCRIPT_ROOT then
   * ~/.claude/projects. Setting it also confines sessions-derived transcript
   * paths to that subtree, which is what makes a test boot hermetic.
   */
  transcriptRoot?: string;
  /**
   * Transcript-tail period in ms; `0` disables the tailer entirely — the timer
   * AND the boot catch-up pass, so it is a real off switch rather than a quiet
   * one-scan-then-stop.
   */
  tailIntervalMs?: number;
  /** Called with each tail pass's result — observability hook (and test seam). */
  onTail?: (result: TailResult) => void;
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
 * One tail pass, from the boot catch-up or the interval. Housekeeping: a tailer
 * failure must never take the collector down, nor throw inside a timer callback
 * where nothing can catch it.
 *
 * `deltas` is passed by the INTERVAL and withheld by the boot catch-up — see the
 * two call sites in `startServer`. Without it on the interval, live tail is dead
 * for every transcript-sourced fact in the product (Task 6.1a).
 */
function runTailPass(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  options: StartOptions,
  deltas?: DeltaPublisher,
): void {
  try {
    // Bind the result FIRST. `options.onTail?.(tailOnce(...))` short-circuits
    // the WHOLE expression — argument included — whenever no callback is
    // supplied, so the tailer would only ever run for tests that observe it.
    const result = tailOnce(db, broadcaster, {
      transcriptRoot: options.transcriptRoot,
      deltas,
    });
    options.onTail?.(result);
  } catch (err) {
    console.warn('agent-lens: transcript tail failed:', err);
  }
}

/**
 * Publish what the inactivity sweep just changed (Task 6.1).
 *
 * The sweep writes OUTSIDE ingest, so without this a client watching a session
 * that simply goes quiet would never learn it was interrupted — a stale view
 * presenting as live, which is the one thing live tail must not do. Re-reads go
 * through the same `readSession`/`readTrace`/`readSpan` path ingest uses, so
 * sweep-origin and ingest-origin deltas are one code path.
 *
 * Note the sweep only ever produces `interrupted`, never `complete`, so this can
 * never end a stream — `reviveSession` can undo every state it writes, and a
 * later revive arrives on the same connection.
 */
function publishSweep(
  db: DatabaseSync,
  deltas: DeltaPublisher,
  result: SweepResult,
): void {
  const bodies: DeltaBody[] = [];
  for (const id of result.spanIds) {
    const span = readSpan(db, id);
    if (span !== undefined) {
      const trace = readTrace(db, span.trace_id);
      if (trace !== undefined) {
        bodies.push({ kind: 'span_closed', session_id: trace.session_id, span });
      }
    }
  }
  for (const id of result.traceIds) {
    const trace = readTrace(db, id);
    if (trace !== undefined) {
      bodies.push({ kind: 'trace_updated', session_id: trace.session_id, trace });
    }
  }
  for (const id of result.sessionIds) {
    const session = readSession(db, id);
    if (session !== undefined) {
      bodies.push({ kind: 'session_updated', session_id: id, session });
    }
  }
  deltas.publishAll(bodies);
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
  const deltas = new DeltaPublisher();

  // Recover anything the adapter spooled while the collector was down, before
  // we accept new connections. Idempotent (upsert-by-event_id), so a replay
  // that overlaps a prior run costs nothing.
  replaySpool(db, broadcaster, dataDir);

  // Catch-up for transcripts that grew while we were down, in the same
  // before-bind slot and for the same reason. `tailIntervalMs: 0` skips it too:
  // an off switch that still performs one full scan is not an off switch.
  const tailIntervalMs = options.tailIntervalMs ?? DEFAULT_TAIL_INTERVAL_MS;
  if (tailIntervalMs > 0) {
    runTailPass(db, broadcaster, options);
  }

  // `replaySpool` and the tail catch-up above are deliberately given no
  // publisher: both run before the socket binds, with no client attached, so
  // pushing a historical spool through a ring would evict it for nobody.
  //
  // **This is the ONLY thing pinning that divergence, and no test can replace
  // it.** The `tailTimer` below passes `deltas`; the catch-up above does not,
  // and after Task 6.1a the two calls read like an oversight. They are not — but
  // neither would "fixing" it go red: the publisher is constructed above, the
  // catch-up runs before `bind()`, so no scope can exist yet and `publishTo`
  // drops on its lazy-allocation guard whether or not `deltas` is passed. A test
  // asserting "the catch-up emitted nothing" would pass under the implementation
  // AND under its negation. Defending it by machinery would take an injected
  // clock or an `onCatchUp` observer, not an assertion.
  const app = buildApp({
    db,
    token,
    broadcaster,
    host,
    uiDir: options.uiDir,
    deltas,
    heartbeatMs: options.heartbeatMs,
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

  // Start the inactivity sweep only once the socket is bound: every failure path
  // above closes the DB, and a surviving timer that fires against a closed handle
  // throws inside a timer callback where nothing can catch it.
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const sweepTimer =
    sweepIntervalMs > 0
      ? setInterval(() => {
          try {
            // Same short-circuit hazard as `runTailPass`: with the call written
            // as `options.onSweep?.(sweepInactive(db))` the sweep NEVER RAN in
            // production, where no callback is passed. Bind the result first.
            const result = sweepInactive(db, { timeoutMs: options.sweepTimeoutMs });
            publishSweep(db, deltas, result);
            // Same interval, no timer of its own — see `DeltaPublisher.reap`.
            deltas.reap();
            options.onSweep?.(result);
          } catch (err) {
            // A sweep is housekeeping; never let it take the collector down.
            console.warn('agent-lens: inactivity sweep failed:', err);
          }
        }, sweepIntervalMs)
      : undefined;

  // `deltas` HERE and not on the catch-up above. This one argument is the whole
  // of live tail for tokens, cost, thinking blocks and hookless tool completions
  // — drop it and the feature is silently dead again (Task 6.1a).
  const tailTimer =
    tailIntervalMs > 0
      ? setInterval(() => runTailPass(db, broadcaster, options, deltas), tailIntervalMs)
      : undefined;

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
        // Clear the timers FIRST: `server.close` is async, and a timer that
        // fires after `db.close()` throws where no caller can catch it.
        if (sweepTimer !== undefined) clearInterval(sweepTimer);
        if (tailTimer !== undefined) clearInterval(tailTimer);
        // Tell every open stream WHY it is ending and let it close, before
        // `server.close` waits on connections that would otherwise sit open.
        deltas.shutdown();
        server.close(() => {
          db.close();
          clearConfig(dataDir);
          resolve();
        });
      }),
  };
}
