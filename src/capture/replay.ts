// Spool replay: the recovery half of the never-lose-data invariant. On server
// start (before "ready"), every `<dataDir>/spool/*.jsonl` file the adapter left
// behind is read line by line, re-stamped `source:"spool_replay"`, and funneled
// through the SAME `ingestEnvelope` pipeline the HTTP handler uses. Idempotency
// comes for free from upsert-by-event_id: replaying twice yields identical DB
// state. A file is deleted only after it is fully replayed and committed.

import type { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Broadcaster } from '../server/sse.js';
import { ingestEnvelope, isValidEnvelopeShape } from '../server/ingest.js';
import type { Envelope } from '../shared/index.js';
import { makeEnvelope } from '../shared/index.js';
import { spoolDir } from './spool.js';

/** Aggregate outcome of a replay pass — surfaced for logging and tests. */
export interface ReplayResult {
  files: number;
  replayed: number;
  deadLettered: number;
}

/**
 * Replay all spool files under the data dir. Returns counts. Never throws on a
 * single malformed line — the line is dead-lettered and replay continues, so a
 * torn tail line from a crash can never wedge startup.
 */
export function replaySpool(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  dataDir?: string,
): ReplayResult {
  const dir = spoolDir(dataDir);
  const result: ReplayResult = { files: 0, replayed: 0, deadLettered: 0 };

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    // No spool dir yet -> nothing to replay.
    return result;
  }

  for (const name of entries) {
    const path = join(dir, name);
    const contents = readFileSync(path, 'utf8');
    replayFile(db, broadcaster, contents, result);
    result.files += 1;
    // Delete only after the whole file is replayed + committed.
    rmSync(path, { force: true });
  }

  return result;
}

/** Replay every line of one spool file's contents into the ingest pipeline. */
function replayFile(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  contents: string,
  result: ReplayResult,
): void {
  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;

    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      deadLetterLine(db, broadcaster, line, result);
      continue;
    }

    const status = parsed.status === 'dead_letter' ? 'dead_letter' : 'processed';
    // The `status` marker is a spool-only sidecar, not part of the envelope.
    delete parsed.status;

    if (!isValidEnvelopeShape(parsed)) {
      deadLetterLine(db, broadcaster, line, result);
      continue;
    }

    const restamped: Envelope = { ...(parsed as Envelope), source: 'spool_replay' };
    const outcome = ingestEnvelope(db, broadcaster, restamped, status);
    // A line can parse cleanly and still fail projection — count what ingest
    // actually did, not what the spool sidecar predicted, or the counters lie.
    if (status === 'dead_letter' || outcome.deadLettered) result.deadLettered += 1;
    else result.replayed += 1;
  }
}

/** Wrap an unparseable spool line in a dead-letter envelope and archive it. */
function deadLetterLine(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  line: string,
  result: ReplayResult,
): void {
  const envelope = makeEnvelope({
    source: 'spool_replay',
    session_id: 'unknown',
    raw_payload: line,
    ts: new Date().toISOString(),
  });
  ingestEnvelope(db, broadcaster, envelope, 'dead_letter');
  result.deadLettered += 1;
}
