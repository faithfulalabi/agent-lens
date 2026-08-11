// `agent-lens doctor`. A report, never a repair: it states the retention setting
// and never writes the user's `settings.json`. The installer was deliberately
// deleted, and a doctor that silently "fixed" retention would resurrect exactly
// the surface Phase 8 removed. Exits 0 always — a non-zero contract on integrity
// failure needs `main` to propagate a code, which is its own decision.

import {
  buildDoctorReport,
  type DoctorReport,
  type RetentionSetting,
} from '../../archive/index.js';
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

function formatRetention(retention: RetentionSetting): string {
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

export function formatDoctorReport(report: DoctorReport): string {
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
    '',
    COVERAGE_GAP_STATEMENT,
    DURABILITY_STATEMENT,
  );

  return lines.join('\n');
}

export async function doctor(args: string[] = []): Promise<void> {
  const report = buildDoctorReport({
    dataDir: parseStringFlag(args, 'dataDir'),
    transcriptRoot: parseStringFlag(args, 'transcriptRoot'),
    settingsPath: parseStringFlag(args, 'settingsPath'),
    verify: args.includes('--verify'),
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify(report));
  } else {
    console.log(formatDoctorReport(report));
  }
}
