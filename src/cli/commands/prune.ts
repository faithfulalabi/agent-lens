// `agent-lens prune` — the ONE command in this product that destroys data, and
// the only screen a user sees before an irreversible act.
//
// MANUAL ONLY, NO CAPS (founder ruling, 2026-09-02). No `--older-than`, no
// `--max-size`, no automatic eviction, no soft-delete, no trash. Phase 1
// inverted the durability contract: `rm cache.db` loses nothing while the
// archive is the system of record, so automatic eviction ON THE ARCHIVE is the
// exact failure mode that lost harness 2.1.153. Keep-forever stays the default.
//
// A DECLINED PRUNE EXITS 0. The human was asked and answered; nothing failed.
// It also keeps a non-TTY invocation — which always declines, because stdin
// arrives at EOF — from looking like an error on every pass.
//
// THREE THINGS STAND BETWEEN THIS COMMAND AND `~/.claude/projects`, in order:
//   1. it refuses any argument it does not recognise, so a mistyped `--dataDir`
//      cannot silently retarget the real archive;
//   2. `assertUnderRoot` + `assertNotUnderRoot` run over every path BEFORE the
//      confirm is even printed;
//   3. the confirm prints the RESOLVED archive root, so a wrong target is
//      visible while there is still time to abort.

import { lstatSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { sep } from 'node:path';
import {
  assertNotUnderRoot,
  assertUnderRoot,
  buildDoctorReport,
  DATA_DIR_LABEL,
  discover,
  resolveDataDir,
  resolveTranscriptRoot,
  TRANSCRIPT_ROOT_LABEL,
  type DiscoveredEntry,
  type DoctorReport,
} from '../../archive/index.js';
import { classifyCorpusPath, rowIdOf, sessionDirOf } from '../../corpus/paths.js';
import { EXIT_INCOMPLETE, EXIT_OK, parseStringFlag } from './archive.js';
import { COVERAGE_GAP_STATEMENT, DURABILITY_STATEMENT, formatRetention } from './doctor.js';

const KNOWN_FLAGS = new Set(['--dataDir', '--transcriptRoot', '--settingsPath']);

/** The literal that confirms a whole-archive prune. Nothing else does. */
const WHOLE_ARCHIVE_WORD = 'delete';

export interface PruneOptions {
  /**
   * The one line the human types. Injected so a test drives the other arm,
   * following `WarmQueueOptions.yieldTo` rather than mocking `process.stdin`.
   */
  confirm?: () => Promise<string>;
}

export interface PruneTarget {
  /** What the confirm calls it: `the whole archive`, or `session <id>`. */
  label: string;
  /** The literal a human must type. Anything else declines. */
  confirmWord: string;
  /** Exactly what is removed. Every entry is asserted before any delete. */
  paths: string[];
  files: number;
  bytes: number;
  /** Of `files`, how many have no live source left. */
  archiveOnly: number;
}

export type PruneTargetResult = { ok: true; target: PruneTarget } | { ok: false; message: string };

export type PruneArgsResult = { ok: true; id?: string } | { ok: false; message: string };

/** The physical name: a sealed row lives at its logical path plus `.zst`. */
function diskPathOf(entry: DiscoveredEntry): string {
  return entry.sealed ? `${entry.archivePath}.zst` : entry.archivePath;
}

/** `lstat`, never a following `stat`: a symlinked entry must not be sized by its target. */
function bytesOf(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Every argument this command understands, and a message for everything else.
 * A local guard only: it does not preempt the binary-wide unknown-flag work,
 * but it closes that hole on the one command where being wrong is permanent.
 */
export function parsePruneArgs(args: string[]): PruneArgsResult {
  let id: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!KNOWN_FLAGS.has(name)) {
        return {
          ok: false,
          message:
            `unrecognised option ${arg} — prune takes [session-id] ` +
            '[--dataDir=…] [--transcriptRoot=…] [--settingsPath=…] and nothing else',
        };
      }
      // `--flag value` consumes the next argument, so it is not a positional.
      if (eq === -1) i += 1;
      continue;
    }
    if (id !== undefined) {
      return {
        ok: false,
        message: `unexpected argument ${arg} — prune takes at most one session id`,
      };
    }
    id = arg;
  }
  return id === undefined ? { ok: true } : { ok: true, id };
}

/**
 * What the delete covers, measured. The whole-archive numbers come straight off
 * the report this command already builds; a session's come from `discover`, so
 * neither invents a second idea of what belongs to a session.
 */
export function resolvePruneTarget(report: DoctorReport, id?: string): PruneTargetResult {
  if (id === undefined) {
    return {
      ok: true,
      target: {
        label: 'the whole archive',
        confirmWord: WHOLE_ARCHIVE_WORD,
        paths: [report.archiveRoot],
        files: report.bytes.hotFiles + report.bytes.sealedFiles,
        bytes: report.bytes.totalBytes,
        archiveOnly: report.coverage.archiveOnly,
      },
    };
  }

  const entries = discover(report.sourceRoot, report.archiveRoot);
  const kindOf = (entry: DiscoveredEntry): string => classifyCorpusPath(entry.relPath);
  const match = entries.find((e) => kindOf(e) === 'session' && rowIdOf(e.relPath) === id);

  if (match === undefined) {
    const sidecar = entries.find((e) => kindOf(e) === 'sidecar' && rowIdOf(e.relPath) === id);
    if (sidecar !== undefined) {
      // The parent by the same slice `foldArchive` takes, never a second walk.
      const parent = entries.find(
        (e) =>
          kindOf(e) === 'session' &&
          sidecar.archivePath.startsWith(sessionDirOf(e.archivePath) + sep),
      );
      const named =
        parent === undefined ? 'its parent session' : `session ${rowIdOf(parent.relPath)}`;
      return {
        ok: false,
        message: `${id} is a sub-agent transcript — prune ${named}, which removes it too`,
      };
    }
    return { ok: false, message: `no archived session ${id} under ${report.archiveRoot}` };
  }

  const dir = sessionDirOf(match.archivePath);
  const owned = entries.filter(
    (e) =>
      e.presence !== 'source-only' &&
      (e.archivePath === match.archivePath || e.archivePath.startsWith(dir + sep)),
  );
  return {
    ok: true,
    target: {
      label: `session ${id}`,
      confirmWord: id,
      paths: [diskPathOf(match), dir],
      files: owned.length,
      bytes: owned.reduce((sum, e) => sum + bytesOf(diskPathOf(e)), 0),
      archiveOnly: owned.filter((e) => e.presence === 'archive-only').length,
    },
  };
}

/**
 * The last screen before an irreversible act. Every number is measured on THIS
 * machine and the two closing sentences are imported, never retyped, so the
 * wording cannot drift away from `doctor`'s.
 *
 * NO HARDCODED RETENTION NUMBER. The window is whatever this machine's
 * `settings.json` says, rendered by `doctor`'s own formatter; a figure baked in
 * here would be wrong within a release and unfalsifiable on the screen that can
 * least afford it.
 */
export function formatPruneConfirm(report: DoctorReport, target: PruneTarget): string {
  const lines = [
    'agent-lens prune — permanent, immediate, and there is no undo.',
    '',
    `  archive     ${report.archiveRoot}`,
    `  deleting    ${target.label} — ${target.files} files, ${target.bytes} bytes`,
  ];
  for (const path of target.paths) lines.push(`                ${path}`);
  lines.push(
    `  of those    ${target.archiveOnly} have no live source left — the archive is the only copy left`,
    '',
    DURABILITY_STATEMENT,
    COVERAGE_GAP_STATEMENT,
    '',
    'Claude Code deletes its own transcripts on a rolling window and agent-lens does not',
    `control it: ${formatRetention(report.retention)}. Everything past that window exists`,
    'only here. No soft-delete, no trash, no recovery.',
    '',
    `Type \`${target.confirmWord}\` to confirm; anything else aborts.`,
  );
  return lines.join('\n');
}

/** One line off stdin. EOF — a pipe, a cron, a closed terminal — reads as `''`. */
async function readConfirmLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    const { value, done } = await rl[Symbol.asyncIterator]().next();
    return done === true ? '' : value;
  } finally {
    rl.close();
    process.stdin.pause();
  }
}

export async function prune(args: string[] = [], options: PruneOptions = {}): Promise<number> {
  try {
    const parsed = parsePruneArgs(args);
    if (!parsed.ok) {
      console.error(`agent-lens prune: ${parsed.message}`);
      return EXIT_INCOMPLETE;
    }

    const dataDirFlag = parseStringFlag(args, 'dataDir');
    const transcriptRootFlag = parseStringFlag(args, 'transcriptRoot');
    const report = buildDoctorReport({
      dataDir: dataDirFlag,
      transcriptRoot: transcriptRootFlag,
      settingsPath: parseStringFlag(args, 'settingsPath'),
    });

    const resolved = resolvePruneTarget(report, parsed.id);
    if (!resolved.ok) {
      console.error(`agent-lens prune: ${resolved.message}`);
      return EXIT_INCOMPLETE;
    }
    const { target } = resolved;

    // BEFORE the confirm, not merely before the delete: a target that escapes is
    // refused rather than offered to a human who might type the word.
    const dataDir = resolveDataDir(dataDirFlag);
    const transcriptRoot = resolveTranscriptRoot(transcriptRootFlag);
    for (const path of target.paths) {
      assertUnderRoot(path, dataDir, DATA_DIR_LABEL);
      assertNotUnderRoot(path, transcriptRoot, TRANSCRIPT_ROOT_LABEL);
    }

    console.log(formatPruneConfirm(report, target));
    const answer = await (options.confirm ?? readConfirmLine)();
    // EXACT, and never trimmed: `delete ` is not `delete`. A near-miss is a
    // person who is not sure, and the safe reading of "not sure" is no.
    if (answer !== target.confirmWord) {
      console.log('agent-lens prune: declined — nothing was deleted');
      return EXIT_OK;
    }

    // ONE call site over a loop, so the write manifest reviews one entry.
    for (const path of target.paths) rmSync(path, { recursive: true, force: true });

    console.log(
      `agent-lens prune: deleted ${target.label} — ${target.files} files, ${target.bytes} bytes`,
    );
    console.log('  cache.db is untouched — `agent-lens rebuild` clears what is now gone');
    return EXIT_OK;
  } catch (error) {
    console.error(`agent-lens prune: ${String((error as Error).message ?? error)}`);
    return EXIT_INCOMPLETE;
  }
}
