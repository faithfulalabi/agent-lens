// `agent-lens archive`. Exits 0 on divergence and on a held lock, since a cron
// must not page for a normal overlap; non-zero only on fatal I/O.

import { archiveOnce, type ArchiveResult } from '../../archive/index.js';

/**
 * `--flag value` and `--flag=value`. A value beginning with `-` must be
 * accepted: project slugs are path-derived and start with one.
 */
export function parseStringFlag(args: string[], name: string): string | undefined {
  const long = `--${name}`;
  const prefix = `${long}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === long) {
      const value = args[i + 1];
      if (value === undefined || value === '') throw new Error(`${long} requires a value`);
      return value;
    }
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      if (value === '') throw new Error(`${long} requires a value`);
      return value;
    }
  }
  return undefined;
}

export function formatSummary(result: ArchiveResult): string {
  const diverged = result.files.filter((f) => f.source_state === 'diverged');
  const expired = result.files.filter((f) => f.source_state === 'expired');
  const lines = [
    result.lock.state === 'held'
      ? `agent-lens archive: another pass holds the lock (pid ${result.lock.holder_pid ?? '?'}) — copied nothing`
      : `agent-lens archive: ${result.filesSeen} files, ${result.bytesCopied} bytes copied`,
  ];
  if (result.lock.state === 'reclaimed') {
    lines.push(`  reclaimed a stale lock (${result.lock.reclaim_reason})`);
  }
  if (diverged.length > 0) {
    lines.push(`  ${diverged.length} diverged (archived bytes kept, nothing overwritten):`);
    for (const file of diverged) lines.push(`    ${file.reason}  ${file.source_path}`);
  }
  if (expired.length > 0) {
    lines.push(`  ${expired.length} expired at the source — the archive is now the only copy`);
  }
  for (const error of result.errors) lines.push(`  error  ${error.path}: ${error.message}`);
  return lines.join('\n');
}

export async function archive(args: string[] = []): Promise<void> {
  const result = archiveOnce({
    dataDir: parseStringFlag(args, 'dataDir'),
    transcriptRoot: parseStringFlag(args, 'transcriptRoot'),
    verify: args.includes('--verify'),
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result));
  } else {
    console.log(formatSummary(result));
  }
}
