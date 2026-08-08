// `agent-lens archive` — mirror Claude Code transcripts into the durable archive.
//
// Safe to invoke every minute: the advisory lock, the 0-byte no-op path and the
// quiet-pass-writes-no-log-line rule make a repeat pass free. Exit 0 on
// divergence AND on a held lock (a cron must not page for a normal overlap);
// non-zero only on fatal I/O. `--verify` is the periodic full-integrity audit and
// is explicitly NOT for the per-minute cron.

import { archiveOnce, type ArchiveResult } from '../../archive/index.js';

/**
 * `--flag value` and `--flag=value`, matching `start.ts:4-27`.
 *
 * NOTE: a value beginning with `-` must be accepted. Every one of the 12 real
 * project slugs starts with `-` (`-Users-faithful-Desktop-agent-lens`), so a
 * "looks like a flag" guard would reject legitimate paths. `start.ts`'s
 * `parseHostValue` only rejects `''`, and that is the pattern followed here.
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

/** Human-readable pass summary. */
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
