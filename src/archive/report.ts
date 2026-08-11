// The read-only half of the archive: everything `agent-lens doctor` reports.
// This module performs no write syscall. It opens with 'r' only, reads
// `settings.json`, a sealed frame and that frame's sidecar with `readFileSync`,
// and never creates a directory. That is load-bearing twice over: a reporting
// command that took the pass lock would make a concurrent cron pass report
// `held`, and one that created the data dir would leave evidence on a machine
// that has never archived.
//
// Two stats here are deliberately non-following. The archive-side one is an
// `lstat`, so a symlink planted at an archive leaf is reported as unmirrored
// rather than counted as a mirror whose target's bytes belong to the archive.
// The sidecar gets the same treatment before it is opened, because `readSidecar`
// is a bare path-based read with no bound: a FIFO planted at that name would
// block a plain `doctor` indefinitely, on the one command meant to be safe to
// run from a cron.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
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
import { DEFAULT_MAX_BYTES, declaredContentSize } from './read.js';
import { readSidecar, sidecarPath } from './sidecar.js';

const CHUNK_BYTES = 1024 * 1024;

const SEALED_SUFFIX = '.zst';

/**
 * Why a file was not integrity-checked here. Three populations, three different
 * truths, and none of them may be softened into a claim that something was
 * checked.
 *
 * `NO_LIVE_SOURCE_REASON` stays literally true: it is pushed only after the
 * sealed branch has already `continue`d, so its files are unsealed, and only a
 * `.zst` ever acquires a sidecar. `ArchiveLogRecord` stores no hash and
 * `source_head_sha256` never leaves memory, so for those files nothing durable
 * exists at all.
 *
 * `SEALED_LEGACY_REASON` is a `.zst` with no usable record beside it: absent,
 * unparseable, of a version this build does not know, or not a regular file.
 * Its pre-seal bytes are gone, so there is nothing honest to backfill and it
 * stays unverifiable forever — never `verified`, and never decompressed.
 *
 * `SEALED_UNCHECKED_REASON` is the cost boundary made visible. The record is
 * there and its O(1) limbs already ran; only the re-hash is deferred, because
 * that one is an O(file-size) read the default path must not do.
 */
export const NO_LIVE_SOURCE_REASON = 'no live source — no stored hash exists';
export const SEALED_LEGACY_REASON =
  'sealed — no stored hash on disk: sealed before sidecars existed, and there is nothing honest to backfill';
export const SEALED_UNCHECKED_REASON =
  'sealed — stored hash present but not read: pass --verify to re-hash the archived bytes';

/**
 * How a sealed file failed against its own stored record. Deliberately NOT
 * added to `DivergenceReason` in `mirror.ts`: `detectDivergence` compares an
 * archive against a live source and can never return one of these.
 *
 * All four render verbatim in `doctor`'s output, so each one has a test that
 * produces it.
 */
export type SealedDivergenceReason =
  'sealed-attribution' | 'sealed-size' | 'sealed-frame' | 'sealed-hash';

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
  /**
   * The live source the archived prefix was compared against. Absent on a
   * sealed row: that population has no source left, which is why it is checked
   * against a stored hash at all, and there is no honest value to put here.
   */
  sourcePath?: string;
  archivePath: string;
  reason: DivergenceReason | SealedDivergenceReason;
}

export interface IntegrityResults {
  /** True when the full-prefix hash limb ran, i.e. `--verify` was passed. */
  verify: boolean;
  /**
   * Content bytes this pass actually read: the source prefix a live compare
   * consumed, plus everything a sealed frame decompressed to under `--verify`.
   * Not total I/O — a sidecar is ~150 bytes and is not counted. What the number
   * defends is the boundary itself: no O(file-size) read on the default path.
   */
  bytesRead: number;
  /** Every file with archived bytes on disk — the denominator the three lists sum to. */
  archivedFileCount: number;
  verified: string[];
  /**
   * The archived bytes no longer match their reference. For a file with a live
   * source the reference is that source, and the check cannot tell "the source
   * was rewritten" from "the archived bytes were corrupted" — both readings fit,
   * and the report says so rather than picking one. For a sealed file the
   * reference is the hash the seal recorded, no source survives, and only the
   * one reading is left.
   */
  diverged: DivergedFile[];
  /** Files this pass did not check, each saying why. Named, never counted as verified. */
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

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

type SealedVerdict =
  | { state: 'verified' }
  | { state: 'diverged'; reason: SealedDivergenceReason }
  | { state: 'unverifiable'; reason: string };

/**
 * The decompressed frame, or a refusal — returned rather than thrown, because
 * `maxOutputLength` alone raises an errno-less `RangeError` that the classifier
 * below would have to pattern-match back out of a message. `loadSealed` in
 * `read.ts` keeps its throw; this is a second, separate reader.
 */
type SealedFrame =
  { state: 'loaded'; buf: Buffer; declared: number } | { state: 'over-bound'; declared: number };

/**
 * Reads `diskPath` DIRECTLY, never through `createArchiveReader`. That accessor
 * takes a LOGICAL path and dispatches hot-first, so in the crash-window state —
 * hot file and `.zst` both present, source gone — it serves the hot file's bytes
 * and the frame is never opened. A garbage `.zst` would then be reported
 * `verified` on the strength of a file the sidecar does not describe, and the
 * populations partition would not notice: the count is right, only the label
 * lies. An `existsSync` guard is not a fix either; it still hands a logical path
 * to a component entitled to reinterpret it.
 */
function loadSealedFrame(diskPath: string): SealedFrame {
  const frame = readFileSync(diskPath);
  // Header first, so an over-large frame is refused before any allocation and a
  // non-frame fails with our message rather than the codec's.
  const declared = declaredContentSize(frame, diskPath);
  if (declared > DEFAULT_MAX_BYTES) return { state: 'over-bound', declared };
  const buf = zstdDecompressSync(frame, { maxOutputLength: DEFAULT_MAX_BYTES });
  return { state: 'loaded', buf, declared };
}

/**
 * Classify by EXCLUSION, never by an allowlist of codec errors. A failure that
 * carries a bare errno is an I/O failure — the file could not be read, which
 * says nothing about its contents — and anything else is the frame refusing to
 * be what the record says it is. The codec's own codes cannot be enumerated —
 * `seal.test.ts` documents why, by SEARCHING for a corruption zstd fails to
 * catch rather than naming one — and `declaredContentSize` throws plain
 * `Error`s carrying no code at all.
 *
 * The ground for calling a format error a divergence, stated once: the sidecar
 * records what was published here; these bytes are not it.
 */
function classifySealedThrow(error: unknown): SealedVerdict {
  const code = (error as NodeJS.ErrnoException).code;
  // Bare errnos only. Node's own `ERR_*` codes carry underscores and fall to the
  // divergence side, which is where `ERR_BUFFER_TOO_LARGE` belongs: with the
  // pre-allocation bound above already passed, `maxOutputLength` can only fire
  // when the header under-declares what the frame actually holds.
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) {
    return {
      state: 'unverifiable',
      reason: `unreadable — ${String((error as Error).message ?? error)}`,
    };
  }
  return { state: 'diverged', reason: 'sealed-frame' };
}

/**
 * The sealed ladder. Every rung before the last is O(1) and runs on the default
 * path; only the re-hash waits for `--verify`.
 *
 * `bytesRead` is returned on every branch below the decompressor, not only on
 * the verified one. A sealed file that decompresses megabytes and then diverges
 * really did read those bytes, and a counter that only moved on success would
 * make the cost boundary green because it is dead rather than because the path
 * is cheap.
 */
function checkSealed(params: {
  diskPath: string;
  logicalName: string;
  archiveSize: number;
  verify: boolean;
}): { verdict: SealedVerdict; bytesRead: number } {
  const legacy: { verdict: SealedVerdict; bytesRead: number } = {
    verdict: { state: 'unverifiable', reason: SEALED_LEGACY_REASON },
    bytesRead: 0,
  };

  // Rung 1 — a usable record beside the frame, or nothing to check against.
  // The `lstat` is the gate, not a formality: `readSidecar` reads by path with
  // no bound, so a FIFO or a symlink to one planted at this name would hang the
  // default path. Non-regular reads as legacy, exactly like absent.
  const sidecar = sidecarPath(params.diskPath);
  if (lstatSafe(sidecar)?.isFile() !== true) return legacy;
  const record = readSidecar(sidecar);
  // `readSidecar` collapses absent, unreadable, truncated, malformed and
  // unknown-version to `undefined` and never throws, so this one check covers
  // every way a record can fail to be one.
  if (record === undefined) return legacy;

  // Rung 2 — attribution. `record.file` is the LOGICAL basename the seal wrote
  // (`sess-1.jsonl`), never the sealed one (`sess-1.jsonl.zst`).
  if (record.file !== params.logicalName) {
    return { verdict: { state: 'diverged', reason: 'sealed-attribution' }, bytesRead: 0 };
  }

  // Rung 3 — the O(1) size limb, free from the stat already taken. It fires
  // before the decompressor for every plain truncation, because truncating a
  // `.zst` changes the size on disk.
  if (record.sealed_size !== params.archiveSize) {
    return { verdict: { state: 'diverged', reason: 'sealed-size' }, bytesRead: 0 };
  }

  // Rung 4 — the boundary. Re-hashing is the only O(file-size) limb, so the
  // default path stops here and says which of the two sealed cases it is in.
  if (!params.verify) {
    return {
      verdict: { state: 'unverifiable', reason: SEALED_UNCHECKED_REASON },
      bytesRead: 0,
    };
  }

  let frame: SealedFrame;
  try {
    frame = loadSealedFrame(params.diskPath);
  } catch (error) {
    return { verdict: classifySealedThrow(error), bytesRead: 0 };
  }
  if (frame.state === 'over-bound') {
    return {
      verdict: {
        state: 'unverifiable',
        reason: `unreadable — ${params.diskPath} declares ${frame.declared} bytes, over the ${DEFAULT_MAX_BYTES}-byte bound`,
      },
      bytesRead: 0,
    };
  }

  const bytesRead = frame.buf.length;

  // The frame's own header, which a truncated frame contradicts without ever
  // throwing — see `declaredContentSize`.
  if (frame.buf.length !== frame.declared) {
    return { verdict: { state: 'diverged', reason: 'sealed-frame' }, bytesRead };
  }
  // The only limb that catches a whole-frame substitution: a validly compressed,
  // correctly checksummed frame of the same length holding different content
  // passes every structural check above and fails only here.
  if (sha256(frame.buf) !== record.sha256) {
    return { verdict: { state: 'diverged', reason: 'sealed-hash' }, bytesRead };
  }
  return { verdict: { state: 'verified' }, bytesRead };
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

    // Sealed first, and never against the source: the bytes on disk are
    // compressed, so a live source is no reference for them. The stored hash is,
    // and it is the only check in the system that can catch a whole-frame
    // substitution — the frame checksum and the declared content size both
    // compare a frame against itself.
    if (entry.sealed) {
      const sealed = checkSealed({
        diskPath,
        logicalName: basename(entry.archivePath),
        archiveSize,
        verify,
      });
      integrity.bytesRead += sealed.bytesRead;
      if (sealed.verdict.state === 'verified') {
        integrity.verified.push(entry.relPath);
      } else if (sealed.verdict.state === 'diverged') {
        // No `sourcePath`: there is no source, and inventing one here is how a
        // report starts describing a file that does not exist.
        integrity.diverged.push({
          relPath: entry.relPath,
          archivePath: diskPath,
          reason: sealed.verdict.reason,
        });
      } else {
        integrity.unverifiable.push({
          relPath: entry.relPath,
          archivePath: diskPath,
          reason: sealed.verdict.reason,
        });
      }
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
