// Reader for the launchd wrapper's own per-pass log — the only artifact that
// answers "did the archive job run". `archive.jsonl` cannot: `isQuiet` in
// `log.ts` suppresses most healthy passes, so days can pass between its lines
// while the job fires every 15 minutes. An mtime cannot either: a quiet source
// leaves the archive untouched while the job runs on schedule. Read-only, per
// the `report.ts` discipline: no write syscall, safe to run beside a live pass.

import { readFileSync } from 'node:fs';
import { lstatSafe, resolveCronLogPath } from './paths.js';

export interface CronLogEntry {
  /** Epoch ms, built by hand from the wrapper's colon-less UTC offset. */
  epochMs: number;
  /** The wrapper's status token: `ok`, `ERR<code>`, `FATAL` or `BUG`. */
  status: string;
  /** The rest of the line — the first line of the pass's own output. */
  summary: string;
}

/**
 * Three states, never a half-filled object, matching `CacheReport`: a log that
 * does not exist and one that holds no parseable pass are different facts.
 * `lastOk` can be `undefined` on `found` — a job that has run but never
 * succeeded, which is a third fact distinct from both.
 */
export type LastPassReport =
  | { state: 'absent'; path: string }
  | { state: 'empty'; path: string }
  | { state: 'found'; path: string; lastEntry: CronLogEntry; lastOk: CronLogEntry | undefined };

/**
 * Anchored on a 4-digit year at line start, so the wrapper's unprefixed
 * continuation lines (e.g. `  61 expired at the source…`) are skipped — they
 * carry no timestamp of their own. Nothing else is worth an error: a malformed
 * line in a log this module does not write is a line to skip, not a throw.
 */
const ENTRY =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2})(\d{2})\s+(\S+)\s*(.*)$/;

/** Pure: text in, entries out, file order preserved. */
export function parseCronLog(text: string): CronLogEntry[] {
  const entries: CronLogEntry[] = [];
  for (const line of text.split('\n')) {
    const match = ENTRY.exec(line);
    if (match === null) continue;
    const [, y, mo, d, h, mi, s, sign, offH, offM, status, summary] = match;
    // `date +%z` emits `-0500`, colon-less — outside what `new Date()` promises
    // to parse — so the epoch comes from Date.UTC minus the offset.
    const offsetMs = (sign === '-' ? -1 : 1) * (Number(offH) * 60 + Number(offM)) * 60_000;
    entries.push({
      epochMs:
        Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetMs,
      status: status!,
      summary: summary?.trim() ?? '',
    });
  }
  return entries;
}

/**
 * Never throws: an unreadable log is a state in the report, not a failed
 * command. The `lstat` gate is the `report.ts` rule — a FIFO or symlink planted
 * at this name must not hang or be followed by a blind `readFileSync`.
 */
export function readCronLogStatus(dataDir?: string): LastPassReport {
  const path = resolveCronLogPath(dataDir);
  if (lstatSafe(path)?.isFile() !== true) return { state: 'absent', path };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // Exists but yielded nothing parseable — `empty` is the truthful bucket.
    return { state: 'empty', path };
  }
  const entries = parseCronLog(text);
  const lastEntry = entries.at(-1);
  if (lastEntry === undefined) return { state: 'empty', path };
  return {
    state: 'found',
    path,
    lastEntry,
    lastOk: entries.findLast((entry) => entry.status === 'ok'),
  };
}
