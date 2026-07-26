// The hook adapter: `agent-lens hook`. Claude Code exec's this once per hook
// with the hook payload on stdin. Two invariants govern every line here
// (Flow 2): NEVER harm the session (always exit 0, never emit exit 2) and
// NEVER lose data (POST-or-spool). It is a pure client — it holds no
// per-session state, so the event_id fallback is 1.2's stateless content hash.

import { performance } from 'node:perf_hooks';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { makeEnvelope, readToken, TOKEN_HEADER } from '../shared/index.js';
import type { Envelope } from '../shared/index.js';
import { appendSpool, resolveDataDir } from '../capture/spool.js';
import { join } from 'node:path';

/** Default collector port when `config.json` is absent (mirrors server DEFAULT_PORT). */
const DEFAULT_PORT = 4470;

/** Tight defense-in-depth deadline for stdin + POST; `async:true` is the real guard. */
const DEFAULT_TIMEOUT_MS = 250;

/** Options for `runHook`; all optional so the CLI wires defaults from argv/env. */
export interface RunHookOptions {
  /** The hook payload source (defaults to `process.stdin`). */
  stdin: Readable;
  /** Data dir override (else $AGENT_LENS_DIR then ~/.agent-lens). */
  dataDir?: string;
  /** Explicit port; else config.json, else env, else 4470. */
  port?: number;
  /** POST + stdin deadline in ms. */
  timeoutMs?: number;
}

/** What the adapter did — surfaced for tests; the CLI ignores it. */
export interface RunHookResult {
  /** 'posted' when the collector accepted it, 'spooled' otherwise. */
  outcome: 'posted' | 'spooled';
  /** true when input was unparseable and dead-lettered. */
  deadLetter: boolean;
}

/** Discover the collector port: explicit -> config.json -> $AGENT_LENS_PORT -> 4470. */
function resolvePort(dataDir: string, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const fromConfig = readConfigPort(dataDir);
  if (fromConfig !== null) return fromConfig;
  const fromEnv = process.env.AGENT_LENS_PORT;
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Number(fromEnv);
    if (Number.isInteger(parsed)) return parsed;
  }
  return DEFAULT_PORT;
}

/** Read the bound port from `<dataDir>/config.json`, or null if unavailable. */
function readConfigPort(dataDir: string): number | null {
  try {
    // Lazy require avoids a hard dep on the server module from the client path.
    const raw = readFileSyncSafe(join(dataDir, 'config.json'));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { port?: unknown };
    return typeof parsed.port === 'number' ? parsed.port : null;
  } catch {
    return null;
  }
}

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Best-effort extraction of a session_id from unparseable raw input. */
function bestEffortSessionId(raw: string): string {
  const match = raw.match(/"session_id"\s*:\s*"([^"]+)"/);
  return match ? match[1]! : 'unknown';
}

/** Append a timing record when AGENT_LENS_TIMING=1; never throws. */
function recordTiming(dataDir: string, startedAt: number, outcome: string): void {
  if (process.env.AGENT_LENS_TIMING !== '1') return;
  try {
    const logsDir = join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const record = {
      ts: new Date().toISOString(),
      duration_ms: performance.now() - startedAt,
      outcome,
    };
    appendFileSync(join(logsDir, 'adapter-timing.jsonl'), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Timing is diagnostics only — never let it affect the exit path.
  }
}

/** Best-effort error log to `<dataDir>/logs/adapter.log`; never throws. */
function logError(dataDir: string, message: string): void {
  try {
    const logsDir = join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(logsDir, 'adapter.log'),
      `${new Date().toISOString()} ${message}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Logging the failure to log is not worth crashing over.
  }
}

/**
 * Run the adapter end to end. Reads stdin, wraps in an envelope, POSTs to the
 * collector with a tight timeout, and on ANY failure spools the envelope.
 * Malformed stdin is dead-lettered (spooled raw, no POST). This function never
 * throws and never sets a nonzero exit code — that is its whole contract.
 */
export async function runHook(options: RunHookOptions): Promise<RunHookResult> {
  const startedAt = performance.now();
  const dataDir = resolveDataDir(options.dataDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let outcome: RunHookResult['outcome'] = 'spooled';
  let deadLetter = false;

  try {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);

    const raw = await text(options.stdin);

    let payload: Record<string, unknown> | undefined;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Unparseable: dead-letter it. Never POST, never crash, never drop.
      clearTimeout(deadline);
      deadLetter = true;
      const sessionId = bestEffortSessionId(raw);
      const envelope = makeEnvelope({
        source: 'hook',
        session_id: sessionId,
        hook_name: 'unknown',
        raw_payload: raw,
        ts: new Date().toISOString(),
      });
      trySpool(dataDir, sessionId, { envelope, status: 'dead_letter' });
      recordTiming(dataDir, startedAt, 'dead_letter');
      process.exitCode = 0;
      return { outcome: 'spooled', deadLetter };
    }

    const sessionId =
      typeof payload.session_id === 'string' ? payload.session_id : 'unknown';
    const hookName =
      typeof payload.hook_event_name === 'string'
        ? payload.hook_event_name
        : 'unknown';
    const toolUseId =
      typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined;
    const promptId =
      typeof payload.prompt_id === 'string' ? payload.prompt_id : undefined;

    const envelope = makeEnvelope({
      source: 'hook',
      session_id: sessionId,
      hook_name: hookName,
      tool_use_id: toolUseId,
      prompt_id: promptId,
      raw_payload: payload,
      ts: new Date().toISOString(),
    });

    const posted = await tryPost(dataDir, envelope, options.port, controller);
    clearTimeout(deadline);

    if (posted) {
      outcome = 'posted';
    } else {
      trySpool(dataDir, sessionId, { envelope });
    }
    recordTiming(dataDir, startedAt, outcome);
  } catch (err) {
    // Last-resort catch: nothing above may escape and produce a nonzero exit.
    logError(dataDir, `unexpected: ${(err as Error).message}`);
    recordTiming(dataDir, startedAt, 'error');
  }

  process.exitCode = 0;
  return { outcome, deadLetter };
}

/** POST the envelope; return true only on a 2xx. Any error/non-2xx -> false. */
async function tryPost(
  dataDir: string,
  envelope: Envelope,
  explicitPort: number | undefined,
  controller: AbortController,
): Promise<boolean> {
  try {
    const port = resolvePort(dataDir, explicitPort);
    const token = readToken(dataDir);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== null) {
      // Authenticate the adapter against the collector's token file.
      headers[TOKEN_HEADER] = token;
    } else {
      // Token file missing (collector never booted / wrong dir): post anyway so
      // the never-lose-data contract holds. The collector 401s an unauthenticated
      // POST, `res.ok` is false, and the envelope funnels to the spool for replay.
      logError(dataDir, 'token file missing; posting unauthenticated (will spool on 401)');
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // AbortError / ECONNREFUSED / socket errors all funnel to the spool.
    return false;
  }
}

/** Spool an envelope; a spool-write failure is logged/counted, never fatal. */
function trySpool(
  dataDir: string,
  sessionId: string,
  line: { envelope: Envelope; status?: 'dead_letter' },
): void {
  try {
    appendSpool(sessionId, line, dataDir);
  } catch (err) {
    // The single documented data-loss point (disk full / unwritable spool):
    // log + count, but still exit 0. The session must never be harmed.
    logError(dataDir, `spool-write-failed session=${sessionId}: ${(err as Error).message}`);
  }
}
