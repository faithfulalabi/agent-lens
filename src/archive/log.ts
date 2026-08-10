// The archive's append-only event log. Not a state store — nothing in a pass
// reads it. It is the only durable record that a source ever diverged, since
// divergence is recomputed each pass and never remembered.

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
  /** Logical archive paths sealed on this pass. */
  sealed: string[];
}

/** A pass worth no line: nothing copied, sealed, diverged, expired, or failed. */
export function isQuiet(record: ArchiveLogRecord): boolean {
  return (
    record.bytes_copied === 0 &&
    record.diverged.length === 0 &&
    record.newly_expired.length === 0 &&
    record.errors.length === 0 &&
    record.lock.state === 'acquired' &&
    // Without this term a pass whose only work was sealing forty files copies
    // zero bytes, expires nothing new, and is therefore logged as nothing at all.
    record.sealed.length === 0
  );
}

/** Returns whether it wrote. */
export function appendArchiveLog(dataDir: string, record: ArchiveLogRecord): boolean {
  if (isQuiet(record)) return false;
  const path = resolveArchiveLogPath(dataDir);
  appendOwnedLine(path, `${JSON.stringify(record)}\n`, dirname(path));
  return true;
}
