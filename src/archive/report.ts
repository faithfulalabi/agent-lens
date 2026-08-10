// The read-only half of the archive: everything `agent-lens doctor` reports.
// This module performs no write syscall. It opens with 'r' only, reads
// `settings.json` with `readFileSync`, and never creates a directory. That is
// load-bearing twice over: a reporting command that took the pass lock would
// make a concurrent cron pass report `held`, and one that created the data dir
// would leave evidence on a machine that has never archived.
//
// One read here is deliberately non-following: the archive-side stat is an
// `lstat`, so a symlink planted at an archive leaf is reported as unmirrored
// rather than counted as a mirror whose target's bytes belong to the archive.

import { closeSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discover } from './discover.js';
import { detectDivergence, type DivergenceReason } from './mirror.js';
import {
  canonicalizeTranscriptPath,
  lstatSafe,
  resolveArchiveRoot,
  resolveDataDir,
  resolveTranscriptRoot,
  statSafe,
} from './paths.js';

const CHUNK_BYTES = 1024 * 1024;

const SEALED_SUFFIX = '.zst';

/**
 * Why a file cannot be integrity-checked. Both strings say the same thing on
 * purpose: no reference hash is persisted anywhere. `ArchiveLogRecord` stores
 * none, `source_head_sha256` never leaves memory, and neither does the hash a
 * seal computes — so there is nothing durable to compare against here either.
 * Never soften these into a claim that something was checked.
 */
export const NO_LIVE_SOURCE_REASON = 'no live source — no stored hash exists';
export const SEALED_REASON = 'sealed — no integrity check available (no stored hash exists)';

export interface CoverageStats {
  /** Source files that exist right now. The denominator is the survivors only. */
  found: number;
  /** Of `found`, how many have archived bytes on disk. */
  mirrored: number;
  /** The `found` files with no archived bytes yet, by relative path. */
  unmirrored: string[];
  /** Archived files whose source is already gone — the archive is the only copy. */
  archiveOnly: number;
}

export interface ArchiveBytes {
  hotFiles: number;
  hotBytes: number;
  sealedFiles: number;
  sealedBytes: number;
  totalBytes: number;
}

export interface UnverifiableFile {
  relPath: string;
  archivePath: string;
  reason: string;
}

export interface DivergedFile {
  relPath: string;
  sourcePath: string;
  archivePath: string;
  reason: DivergenceReason;
}

export interface IntegrityResults {
  /** True when the full-prefix hash limb ran, i.e. `--verify` was passed. */
  verify: boolean;
  /** Source bytes read by the check, so the `--verify` boundary is observable. */
  bytesRead: number;
  /** Every file with archived bytes on disk — the denominator the three lists sum to. */
  archivedFileCount: number;
  verified: string[];
  /**
   * Prefix mismatches: exactly the population a pass labels
   * `source_state='diverged'`. The check cannot tell "the source was rewritten"
   * from "the archived bytes were corrupted" — both readings fit, and the report
   * says so rather than picking one.
   */
  diverged: DivergedFile[];
  /** Files with no reference hash to check against. Named, never counted as verified. */
  unverifiable: UnverifiableFile[];
}

export type RetentionSetting =
  | { state: 'set'; days: number }
  | { state: 'unset' }
  | { state: 'absent' }
  | { state: 'unreadable'; message: string };

export interface DoctorReport {
  dataDir: string;
  sourceRoot: string;
  archiveRoot: string;
  settingsPath: string;
  coverage: CoverageStats;
  bytes: ArchiveBytes;
  integrity: IntegrityResults;
  retention: RetentionSetting;
}

export interface DoctorReportOptions {
  dataDir?: string;
  transcriptRoot?: string;
  /** The user-level `settings.json`. Resolved independently of `transcriptRoot`. */
  settingsPath?: string;
  /** Opt-in full-prefix hash compare. Reads the whole corpus, so not for a cron. */
  verify?: boolean;
}

/**
 * Kept out of `paths.ts` deliberately: that module owns every archive write, and
 * the settings read must not borrow its authority. Resolved independently of the
 * transcript root so a sandboxed root cannot drag the settings path with it.
 */
export function resolveClaudeSettingsPath(path?: string): string {
  return (
    path ?? process.env.AGENT_LENS_CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json')
  );
}

/** Reports the retention setting. Never repairs it — see the deleted installer. */
export function readRetentionSetting(path: string): RetentionSetting {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', message: String((error as Error).message ?? error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { state: 'unreadable', message: String((error as Error).message ?? error) };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'unreadable', message: 'settings.json is not a JSON object' };
  }

  const days = (parsed as Record<string, unknown>).cleanupPeriodDays;
  if (typeof days !== 'number' || !Number.isFinite(days)) return { state: 'unset' };
  return { state: 'set', days };
}

/** The path the archived bytes actually occupy: sealed files carry the suffix. */
function archiveDiskPath(archivePath: string, sealed: boolean): string {
  return sealed ? `${archivePath}${SEALED_SUFFIX}` : archivePath;
}

/**
 * Compares the archived prefix against its live source. Both opens are quoted
 * 'r' literals at the call site: the static write-site scan reads flags
 * syntactically, so a flags variable would register as a write.
 */
function compareToSource(params: {
  sourcePath: string;
  diskPath: string;
  sourceSize: number;
  archiveSize: number;
  verify: boolean;
  buffer: Buffer;
}): { reason: DivergenceReason | undefined; bytesRead: number } {
  const sourceFd = openSync(params.sourcePath, 'r');
  try {
    const archiveFd = openSync(params.diskPath, 'r');
    try {
      return detectDivergence({
        sourceFd,
        archiveFd,
        sourceSize: params.sourceSize,
        archiveSize: params.archiveSize,
        verify: params.verify,
        buffer: params.buffer,
      });
    } finally {
      closeSync(archiveFd);
    }
  } finally {
    closeSync(sourceFd);
  }
}

/** One read-only pass over both trees. Never throws for an expected condition. */
export function buildDoctorReport(options: DoctorReportOptions = {}): DoctorReport {
  const dataDir = resolveDataDir(options.dataDir);
  const sourceRoot = canonicalizeTranscriptPath(resolveTranscriptRoot(options.transcriptRoot));
  const archiveRoot = canonicalizeTranscriptPath(resolveArchiveRoot(dataDir));
  const settingsPath = resolveClaudeSettingsPath(options.settingsPath);
  const verify = options.verify === true;

  const coverage: CoverageStats = { found: 0, mirrored: 0, unmirrored: [], archiveOnly: 0 };
  const bytes: ArchiveBytes = {
    hotFiles: 0,
    hotBytes: 0,
    sealedFiles: 0,
    sealedBytes: 0,
    totalBytes: 0,
  };
  const integrity: IntegrityResults = {
    verify,
    bytesRead: 0,
    archivedFileCount: 0,
    verified: [],
    diverged: [],
    unverifiable: [],
  };

  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);

  for (const entry of discover(sourceRoot, archiveRoot)) {
    const diskPath = archiveDiskPath(entry.archivePath, entry.sealed);
    // `lstatSafe`, never a following `statSafe`: a path-based `statSync` resolves
    // a symlinked leaf, so a link planted in the archive was reported as a mirror
    // and its TARGET's bytes — which may sit inside the transcript root — were
    // attributed to the archive. Only a regular file is archived bytes.
    const archiveStat = lstatSafe(diskPath);
    // A 0-byte archive file is not a mirror either: `mirrorFile` creates lazily
    // so that an empty file never outlives its source as the archived truth.
    const archiveSize = archiveStat?.isFile() === true ? archiveStat.size : 0;
    const archived = archiveSize > 0;

    if (entry.presence === 'archive-only') {
      coverage.archiveOnly += 1;
    } else {
      coverage.found += 1;
      if (archived) coverage.mirrored += 1;
      else coverage.unmirrored.push(entry.relPath);
    }

    if (!archived) continue;

    if (entry.sealed) {
      bytes.sealedFiles += 1;
      bytes.sealedBytes += archiveSize;
    } else {
      bytes.hotFiles += 1;
      bytes.hotBytes += archiveSize;
    }
    bytes.totalBytes += archiveSize;

    integrity.archivedFileCount += 1;

    // Sealed first: the bytes on disk are compressed, so even a live source is
    // no reference for them until a stored hash exists.
    if (entry.sealed) {
      integrity.unverifiable.push({
        relPath: entry.relPath,
        archivePath: diskPath,
        reason: SEALED_REASON,
      });
      continue;
    }

    // `statSafe` rather than `presence`, so the walk->stat race lands here too.
    const sourceStat = entry.presence === 'both' ? statSafe(entry.sourcePath) : undefined;
    if (sourceStat === undefined || !sourceStat.isFile()) {
      integrity.unverifiable.push({
        relPath: entry.relPath,
        archivePath: diskPath,
        reason: NO_LIVE_SOURCE_REASON,
      });
      continue;
    }

    // One unreadable file must not stop the report, and must never be counted as
    // verified. ENOENT here is the ordinary stat->open expiry race, the same one
    // `mirrorFile` absorbs; anything else (EACCES, EISDIR) is named as it is.
    let compared: { reason: DivergenceReason | undefined; bytesRead: number };
    try {
      compared = compareToSource({
        sourcePath: entry.sourcePath,
        diskPath,
        sourceSize: sourceStat.size,
        archiveSize,
        verify,
        buffer,
      });
    } catch (error) {
      integrity.unverifiable.push({
        relPath: entry.relPath,
        archivePath: diskPath,
        reason:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? NO_LIVE_SOURCE_REASON
            : `unreadable — ${String((error as Error).message ?? error)}`,
      });
      continue;
    }
    integrity.bytesRead += compared.bytesRead;

    if (compared.reason === undefined) {
      integrity.verified.push(entry.relPath);
    } else {
      integrity.diverged.push({
        relPath: entry.relPath,
        sourcePath: entry.sourcePath,
        archivePath: diskPath,
        reason: compared.reason,
      });
    }
  }

  assertPopulationsPartition(integrity);

  return {
    dataDir,
    sourceRoot,
    archiveRoot,
    settingsPath,
    coverage,
    bytes,
    integrity,
    retention: readRetentionSetting(settingsPath),
  };
}

/**
 * The three lists must partition the archived files exactly once each. Enforced
 * here, not just in tests: the failure this guards against is a future branch
 * that counts a file it could not check as verified, which is the one lie the
 * report exists to not tell.
 */
function assertPopulationsPartition(integrity: IntegrityResults): void {
  const counted =
    integrity.verified.length + integrity.diverged.length + integrity.unverifiable.length;
  if (counted !== integrity.archivedFileCount) {
    throw new Error(
      `doctor integrity accounting is broken: ${counted} classified but ` +
        `${integrity.archivedFileCount} archived files exist`,
    );
  }
}
