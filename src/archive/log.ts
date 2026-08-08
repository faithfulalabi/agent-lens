// The archive's append-only event log: `~/.agent-lens/logs/archive.jsonl`.
//
// WHY IT EXISTS. Divergence is recomputed from the two trees every pass, never
// remembered, so once a diverged source finally expires the FACT that it diverged
// is gone (the bytes are not). This log is the durable record of that fact, and
// it is what makes deferring Open Question 1 defensible rather than silent.
//
// WHAT IT IS NOT. It is not a state store. Nothing in the pass ever reads it, and
// deleting it changes no decision — which is exactly why deriving everything else
// from `statSync` is safe. It follows that `newly_expired` can only carry what is
// derivable WITHIN a pass: a source the walk enumerated whose `statSync` then
// threw. A file that expired between two passes is durably re-derivable forever
// from the archive-only side of the union (`discover.ts`), so it needs no log
// line — and logging it every pass would make the log grow with pass count rather
// than with real events, which is the one property it must have.
//
// One line PER PASS, not per file per pass, and a fully quiet pass writes no line
// at all — so a 1-minute cron over an idle machine appends nothing.

import { dirname } from 'node:path';
import { appendOwnedLine, resolveArchiveLogPath } from './paths.js';
import type { LockState } from './lock.js';

export interface DivergedLogEntry {
  source_path: string;
  reason: string;
  archive_size: number;
  source_size: number | null;
}

export interface ArchiveLogRecord {
  ts: string;
  files_seen: number;
  bytes_copied: number;
  lock: LockState;
  diverged: DivergedLogEntry[];
  newly_expired: string[];
  errors: { path: string; message: string }[];
}

/** A pass worth no line: nothing copied, nothing diverged, nothing expired, no trouble. */
export function isQuiet(record: ArchiveLogRecord): boolean {
  return (
    record.bytes_copied === 0 &&
    record.diverged.length === 0 &&
    record.newly_expired.length === 0 &&
    record.errors.length === 0 &&
    record.lock.state === 'acquired'
  );
}

/** Append one NDJSON line, unless the pass was quiet. Returns whether it wrote. */
export function appendArchiveLog(dataDir: string, record: ArchiveLogRecord): boolean {
  if (isQuiet(record)) return false;
  const path = resolveArchiveLogPath(dataDir);
  appendOwnedLine(path, `${JSON.stringify(record)}\n`, dirname(path));
  return true;
}
