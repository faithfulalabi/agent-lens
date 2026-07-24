// The spool: the adapter's never-lose-data net. When a POST to the collector
// fails (down, timeout, refused) the envelope is appended line-oriented to
// `<dataDir>/spool/<session_id>.jsonl`. Line-oriented so a torn tail line on a
// crash costs at most one event (replay dead-letters unparseable lines).
// `AGENT_LENS_DIR` overrides the data dir for hermetic tests.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A spool line: an envelope plus an optional dead-letter marker. */
export interface SpoolLine {
  /** the serialized envelope object. */
  envelope: unknown;
  /** present only for dead-lettered (unparseable) input. */
  status?: 'dead_letter';
}

const SPOOL_DIR = 'spool';

/** Resolve the data dir: explicit arg -> $AGENT_LENS_DIR -> ~/.agent-lens. */
export function resolveDataDir(dir?: string): string {
  return dir ?? process.env.AGENT_LENS_DIR ?? join(homedir(), '.agent-lens');
}

/** Absolute path to the spool directory inside the data dir. */
export function spoolDir(dataDir?: string): string {
  return join(resolveDataDir(dataDir), SPOOL_DIR);
}

/** Absolute path to a session's spool file. */
export function spoolFile(sessionId: string, dataDir?: string): string {
  return join(spoolDir(dataDir), `${sessionId}.jsonl`);
}

/**
 * Append one JSON line to a session's spool file, creating the spool dir (0700)
 * on demand and the file with 0600. Throws on genuine I/O failure (disk full,
 * unwritable dir) — the caller (adapter) must catch and still exit 0.
 */
export function appendSpool(
  sessionId: string,
  line: SpoolLine,
  dataDir?: string,
): void {
  const dir = spoolDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = line.status
    ? { ...(line.envelope as object), status: line.status }
    : line.envelope;
  appendFileSync(spoolFile(sessionId, dataDir), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}
