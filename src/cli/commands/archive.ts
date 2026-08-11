// `agent-lens archive`, and the single authoritative statement of this binary's
// exit codes. Three, and only three:
//
//   0  a pass ran and the archive write path held. Divergence, a held lock and a
//      source the archiver cannot read are all 0 — a cron must not page for a
//      normal overlap, nor nightly forever for a coverage gap, which is
//      `doctor`'s report to make. A permanently red cron is a muted one, and
//      muting it would mute the hijack signal below with it.
//   1  the command did not complete: unknown command, unknown flag, crash. No
//      pass ran, so nothing at all is being said about the archive.
//   3  a pass ran and reported at least one ARCHIVE-side error — something on the
//      path that holds the bytes failed. For a keep-everything-forever store
//      that is the failure worth waking someone for. `ArchiveError.origin`
//      (`archive/mirror.ts`) is the discriminator; it is classified once, at the
//      per-entry catch, and never re-derived from a message.
//
// 2 is RESERVED protocol-wide and must never be emitted by any subcommand: exit
// 2 from a Claude Code hook blocks the session, which `src/cli/hook.ts:3` makes
// an invariant of the whole binary.

import { archiveOnce, type ArchiveResult } from '../../archive/index.js';

/** A pass ran and nothing on the archive write path failed. */
export const EXIT_OK = 0;
/**
 * The command did not complete. Produced by `main`'s unknown-command path, not
 * here; named here because this file states the namespace those codes live in.
 */
export const EXIT_INCOMPLETE = 1;
/** A pass ran and at least one error came off the archive write path. */
export const EXIT_ARCHIVE_ERRORS = 3;

/**
 * The rule, in one expression, so no `if` about exit codes exists anywhere else.
 */
export function exitCodeFor(result: ArchiveResult): number {
  return result.errors.some((e) => e.origin === 'archive') ? EXIT_ARCHIVE_ERRORS : EXIT_OK;
}

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
  const leader =
    result.lock.state === 'held'
      ? `another pass holds the lock (pid ${result.lock.holder_pid ?? '?'}) — copied nothing`
      : `${result.filesSeen} files, ${result.bytesCopied} bytes copied`;
  // The error count belongs in the LEADER, not only in the detail lines below:
  // a source- or log-side failure exits 0 and `doctor` still reports a fully
  // green archive, so this line is the only channel carrying that signal to a
  // human. Without it `head -1` of a hijacked run reads as a clean pass.
  const count = result.errors.length;
  const errorSuffix = count === 0 ? '' : `, ${count} error${count === 1 ? '' : 's'}`;
  const lines = [`agent-lens archive: ${leader}${errorSuffix}`];
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

export async function archive(args: string[] = []): Promise<number> {
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

  return exitCodeFor(result);
}
