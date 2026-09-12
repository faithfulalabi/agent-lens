// `agent-lens doctor`. A report, never a repair: it states the retention setting
// and never writes the user's `settings.json`. The installer was deliberately
// deleted, and a doctor that silently "fixed" retention would resurrect exactly
// the surface Phase 8 removed. Exits 0 always — whether a real integrity
// mismatch should exit non-zero is still undecided (task 1.3). The blocker this
// used to name is gone: `main` propagates a command's code since task 1.9, and
// `commands/archive.ts:1` states the whole code namespace. What is left to
// settle is the mismatch semantics, not the plumbing.

import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  buildDoctorReport,
  readCronLogStatus,
  resolveDataDir,
  type DoctorReport,
  type LastPassReport,
  type RetentionSetting,
} from '../../archive/index.js';
import { CACHE_DB_FILE, openReadOnlyDb } from '../../db/open.js';
import { readDriftRows, readHealthCounts, readMeta } from '../../db/read.js';
// Deep import, never the `server/index.js` barrel: that barrel loads the HTTP
// server, and with it `hono/streaming`, into a command that binds no socket.
import { aggregateDrift } from '../../server/drift-report.js';
import { parseStringFlag } from './archive.js';

/** Long lists are capped so a 30-day-old machine does not print thousands of rows. */
const MAX_LISTED = 20;

/**
 * Printed on every run, never behind a "problems found" branch. A green report is
 * green about the survivors only; neither fact stops being true when nothing is
 * wrong, and a future refactor that hides them should red a test.
 */
export const COVERAGE_GAP_STATEMENT =
  'agent-lens can only archive what exists while it runs — a gap in uptime is a gap in the record.';

export const DURABILITY_STATEMENT =
  'rm cache.db loses nothing. rm -rf ~/.agent-lens/archive loses data permanently.';

function listCapped(items: string[], indent: string): string[] {
  const shown = items.slice(0, MAX_LISTED).map((item) => `${indent}${item}`);
  if (items.length > MAX_LISTED) {
    shown.push(`${indent}… and ${items.length - MAX_LISTED} more (${items.length} in total)`);
  }
  return shown;
}

function files(n: number): string {
  return n === 1 ? '1 file' : `${n} files`;
}

/** What one projected harness version contributes to the census. */
export interface HarnessCensusRow {
  version: string;
  projected: number;
  drifting: number;
}

export interface CacheStats {
  db_bytes: number;
  sessions_indexed: number;
  sessions_projected: number;
  /** `undefined` on a cache no gate has stamped yet. Printed, never repaired. */
  schema_version: string | undefined;
  projector_version: string | undefined;
  /** Sorted by version, so two runs over one cache render identically. */
  harness: HarnessCensusRow[];
}

/**
 * Three states, never a half-filled object: a cache that is absent and one that
 * is unreadable are different facts, and neither is a zeroed `CacheStats`.
 */
export type CacheReport =
  | { state: 'absent'; path: string }
  | { state: 'unreadable'; path: string; message: string }
  | { state: 'ready'; path: string; stats: CacheStats };

/**
 * Reads cache.db WITHOUT taking the single-instance lock, so `doctor` still
 * reports while the server holds it. Never throws: an unreadable cache is a line
 * in the report, not a failed command.
 */
export function readCacheStats(dataDir?: string): CacheReport {
  const dir = resolveDataDir(dataDir);
  const path = join(dir, CACHE_DB_FILE);
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnlyDb(dir);
    if (db === undefined) return { state: 'absent', path };
    const counts = readHealthCounts(db);
    const drift = aggregateDrift(readDriftRows(db));
    const drifting = new Map<string, number>();
    for (const session of drift.sessions_with_drift) {
      const version = session.harness_version ?? 'unknown';
      drifting.set(version, (drifting.get(version) ?? 0) + 1);
    }
    return {
      state: 'ready',
      path,
      stats: {
        db_bytes: counts.db_bytes,
        sessions_indexed: counts.sessions_indexed,
        sessions_projected: counts.sessions_projected,
        schema_version: readMeta(db, 'schema_version'),
        projector_version: readMeta(db, 'projector_version'),
        harness: Object.entries(drift.harness_versions)
          .map(([version, projected]) => ({
            version,
            projected,
            drifting: drifting.get(version) ?? 0,
          }))
          .sort((a, b) => (a.version < b.version ? -1 : 1)),
      },
    };
  } catch (error) {
    return { state: 'unreadable', path, message: String((error as Error).message ?? error) };
  } finally {
    if (db?.isOpen === true) db.close();
  }
}

/**
 * The cache block. Both degraded arms still name the path and say the cache is
 * disposable, because the state a user reaches this line in is the one where
 * "did I just lose something?" is the live question.
 */
export function formatCacheSection(cache: CacheReport): string[] {
  if (cache.state === 'absent') {
    return ['', `cache: ${cache.path} — not created yet; \`agent-lens start\` builds it`];
  }
  if (cache.state === 'unreadable') {
    return [
      '',
      `cache: ${cache.path} — stats unavailable: ${cache.message}`,
      '  nothing is lost either way — `agent-lens rebuild` recreates the whole file',
    ];
  }

  const { stats } = cache;
  const lines = [
    '',
    `cache: ${cache.path}`,
    `  ${stats.db_bytes} bytes`,
    `  ${stats.sessions_indexed} sessions indexed, ${stats.sessions_projected} projected`,
    `  schema_version ${stats.schema_version ?? 'unstamped'}, ` +
      `projector_version ${stats.projector_version ?? 'unstamped'}`,
  ];
  if (stats.harness.length === 0) {
    lines.push('  no projected session carries a harness version yet');
    return lines;
  }
  lines.push('  drift by harness version (the census counts clean rows too):');
  for (const row of stats.harness) {
    lines.push(`    ${row.version}: ${row.projected} projected, ${row.drifting} drifting`);
  }
  return lines;
}

/**
 * `Nm ago` / `Nh Nm ago` / `Nd Nh ago`. Written here rather than imported from
 * `ui/src/lib/format.ts` — same wording convention, but that file belongs to
 * the Vite/React package and this is the Node CLI.
 */
function formatAgo(elapsedMs: number): string {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

/**
 * The archive-job block, read from the launchd wrapper's cron.log — the only
 * artifact that answers "did it run"; an archive mtime only says the source was
 * quiet. Keyed on the status token, never on bytes copied: a pass that ran and
 * copied nothing is the healthy steady state. `now` is a parameter because an
 * ambient clock makes the output untestable.
 */
export function formatLastPassSection(report: LastPassReport, now: number = Date.now()): string[] {
  if (report.state === 'absent') {
    return ['', `archive job: ${report.path} — no cron.log; the job has never run here`];
  }
  if (report.state === 'empty') {
    return ['', `archive job: ${report.path} — cron.log exists but records no pass`];
  }
  const lines = ['', `archive job: ${report.path}`];
  lines.push(
    report.lastOk === undefined
      ? '  no successful pass on record'
      : `  last successful pass: ${formatAgo(now - report.lastOk.epochMs)}`,
  );
  if (report.lastEntry.status !== 'ok') {
    lines.push(
      `  most recent attempt: ${report.lastEntry.status}, ` +
        `${formatAgo(now - report.lastEntry.epochMs)} — ${report.lastEntry.summary}`,
    );
  }
  return lines;
}

export function formatRetention(retention: RetentionSetting): string {
  switch (retention.state) {
    case 'set':
      return `Claude Code retention (cleanupPeriodDays): ${retention.days} days`;
    case 'unset':
      return 'Claude Code retention (cleanupPeriodDays): unset — default applies';
    case 'absent':
      return 'Claude Code retention: no settings file — unset — default applies';
    case 'unreadable':
      return `Claude Code retention: unreadable — ${retention.message}`;
  }
}

/**
 * `cache` is optional so the whole existing archive report stays reachable with
 * one argument — `--json` round-trips through this, and the pure-formatter tests
 * pass a report alone.
 */
export function formatDoctorReport(
  report: DoctorReport,
  cache?: CacheReport,
  lastPass?: LastPassReport,
): string {
  const { coverage, bytes, integrity, retention } = report;
  const lines = [
    'agent-lens doctor',
    `  transcripts  ${report.sourceRoot}`,
    `  archive      ${report.archiveRoot}`,
    '',
    `coverage: ${coverage.mirrored} of ${coverage.found} source files mirrored`,
  ];

  if (coverage.unmirrored.length > 0) {
    lines.push(`  not yet mirrored (${coverage.unmirrored.length}):`);
    lines.push(...listCapped(coverage.unmirrored, '    '));
  }
  if (coverage.archiveOnly > 0) {
    lines.push(
      `  ${files(coverage.archiveOnly)} with no live source — the archive is the only copy left`,
    );
  }

  lines.push(
    '',
    `archive bytes: ${bytes.totalBytes} total — ${bytes.hotBytes} hot in ${files(bytes.hotFiles)}, ` +
      `${bytes.sealedBytes} sealed in ${files(bytes.sealedFiles)}`,
    '',
    integrity.verify
      ? 'integrity (--verify: full prefix hash over every checkable file):'
      : 'integrity (head+seam probe, roughly 1% of bytes — pass --verify for the full prefix hash):',
    // Side by side and summing to the total, so no unverifiable file can be read
    // as verified.
    `  ${files(integrity.archivedFileCount)} archived = ${integrity.verified.length} verified + ` +
      `${integrity.diverged.length} diverged + ${integrity.unverifiable.length} unverifiable`,
  );

  if (integrity.diverged.length > 0) {
    lines.push(
      `  diverged (${integrity.diverged.length}) — the archived bytes and their reference disagree.`,
      '    Consistent with two readings, and this check cannot tell them apart: the',
      '    source was rewritten, or the archived bytes were corrupted. Nothing was',
      '    overwritten either way.',
    );
    // A sealed row has no source, so the two readings above do not apply to it.
    // The four sealed reasons are the only ones carrying this prefix — the
    // mirror's own reasons are bare words like `shrink` — so no export is needed
    // to tell them apart.
    if (integrity.diverged.some((file) => file.reason.startsWith('sealed-'))) {
      lines.push(
        '    A sealed row is narrower than that: its source is already gone, so it was',
        '    compared against the hash the seal recorded and one reading is left —',
        '    the archived bytes changed.',
      );
    }
    for (const file of integrity.diverged) {
      lines.push(`    ${file.reason}  ${file.archivePath}`);
    }
  }

  if (integrity.unverifiable.length > 0) {
    lines.push(
      `  unverifiable (${integrity.unverifiable.length}) — NOT checked, and NOT verified.`,
      '    Each row names its own reason. Nothing here was compared against anything.',
    );
    // Only offered when it would actually change the answer.
    if (!integrity.verify) {
      lines.push('    Pass --verify to re-hash every sealed file that has a stored hash.');
    }
    lines.push(
      ...listCapped(
        integrity.unverifiable.map((file) => `${file.reason}  ${file.archivePath}`),
        '    ',
      ),
    );
  }

  lines.push(
    '',
    formatRetention(retention),
    `  read from ${report.settingsPath} — reported only; doctor never writes it`,
  );

  // BEFORE the two closing statements and never after them: those two sentences
  // are the last thing on screen by design, and a section appended below would
  // quietly demote them.
  if (cache !== undefined) lines.push(...formatCacheSection(cache));
  if (lastPass !== undefined) lines.push(...formatLastPassSection(lastPass));

  lines.push('', COVERAGE_GAP_STATEMENT, DURABILITY_STATEMENT);

  return lines.join('\n');
}

export async function doctor(args: string[] = []): Promise<void> {
  const dataDir = parseStringFlag(args, 'dataDir');
  const report = buildDoctorReport({
    dataDir,
    transcriptRoot: parseStringFlag(args, 'transcriptRoot'),
    settingsPath: parseStringFlag(args, 'settingsPath'),
    verify: args.includes('--verify'),
  });
  const cache = readCacheStats(dataDir);
  const lastPass = readCronLogStatus(dataDir);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...report, cache, lastPass }));
  } else {
    console.log(formatDoctorReport(report, cache, lastPass));
  }
}
