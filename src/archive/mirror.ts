// The verbatim, append-only mirror. The archive is a byte-identical prefix of
// its source, so its own size is the only bookkeeping. A rewritten source keeps
// its archived bytes and is marked `diverged` rather than overwritten.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { dirname } from 'node:path';
import { discover, type DiscoveredEntry } from './discover.js';
import { acquireLock, type LockIdentity, type LockState } from './lock.js';
import { appendArchiveLog, type ArchiveLogRecord, type DivergedLogEntry } from './log.js';
import { sealArchiveFile } from './seal.js';
import {
  canonicalizeTranscriptPath,
  ensureDir,
  ensureDirUnder,
  refuseSymlinkedLeaf,
  resolveArchiveLogPath,
  resolveArchiveRoot,
  resolveDataDir,
  resolveTranscriptRoot,
  statSafe,
  statSafeBig,
} from './paths.js';

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR, O_WRONLY } = constants;

/** The fixed head/seam probe window. */
const PROBE_BYTES = 4096;

const CHUNK_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export type SourceState = 'present' | 'expired' | 'diverged';
export type ArchiveState = 'hot' | 'sealed';
export type DivergenceReason = 'shrink' | 'head' | 'seam' | 'verify';

export interface ArchiveFileState {
  source_path: string;
  source_size: number | null;
  source_mtime_ms: number | null;
  source_head_sha256: string | null;
  /** Below the probe size the hashed window moves on every append, so only this
   * tells "grew" apart from "was rewritten". */
  source_head_len: number;
  source_state: SourceState;
  archive_path: string;
  /**
   * Compressed size on disk once `archive_state` is `sealed`, so this field
   * means the same thing on every pass. Deliberately NOT the logical length —
   * that is what `ArchiveReader.size()` returns.
   */
  archive_size: number;
  archive_state: ArchiveState;
  reason?: DivergenceReason;
  bytes_copied: number;
  /** Set only on the pass that seals. Also durable, in the `.zst.sha256` sidecar. */
  archive_sha256?: string;
  /** Set only on the pass that seals. An output of the seal, never an input. */
  sealed_at?: string;
}

export interface ArchiveResult {
  files: ArchiveFileState[];
  filesSeen: number;
  bytesCopied: number;
  bytesRead: number;
  lock: LockState;
  errors: { path: string; message: string }[];
  sourceRoot: string;
  archiveRoot: string;
  logged: boolean;
  /**
   * Logical archive paths sealed on THIS pass. Not derivable from
   * `files.filter(f => f.archive_state === 'sealed')`, which also holds every
   * file sealed on an earlier pass — and `isQuiet` needs the difference.
   */
  sealed: string[];
}

export interface ArchiveOptions {
  dataDir?: string;
  transcriptRoot?: string;
  /** Opt-in full-file prefix compare. Reads the whole corpus, so not for the cron. */
  verify?: boolean;
  lockIdentity?: LockIdentity;
}

/**
 * Where this pass stops copying: the whole delta when `settled`, else through
 * the last complete newline, else nothing. Uniform across file kinds rather than
 * per-suffix, so a newline-free `.txt` is still copied once it settles.
 */
export function decideCopyEnd(input: {
  archiveSize: number;
  sourceSize: number;
  lastNewlineOffset: number | undefined;
  settled: boolean;
}): number {
  const { archiveSize, sourceSize, lastNewlineOffset, settled } = input;
  if (sourceSize <= archiveSize) return archiveSize;
  if (settled) return sourceSize;
  return lastNewlineOffset === undefined ? archiveSize : lastNewlineOffset + 1;
}

/**
 * Whether this pass compresses the archived file. The source is gone, therefore
 * the file can never grow again, therefore it can be sealed — that is the whole
 * rule and there is no second trigger.
 *
 * The signature is the guarantee: three inputs, none of them a clock, so there
 * is no parameter through which an elapsed-time value could reach the decision.
 *
 * `alreadySealed` is load-bearing rather than a nicety. Every source-less entry
 * now flows through here, including a `.zst` planted with no source at all —
 * the mirror's own "never append to a sealed archive" guard sits after the
 * source open and is unreachable when there is no source. What actually holds
 * those cases is this term, fed by `discover`'s sticky `sealed` merge.
 */
export function shouldSeal(input: {
  sourceState: SourceState;
  alreadySealed: boolean;
  archiveSize: number;
}): boolean {
  const { sourceState, alreadySealed, archiveSize } = input;
  return sourceState === 'expired' && !alreadySealed && archiveSize > 0;
}

/** Reads short only at EOF. */
function readInto(fd: number, buf: Buffer, position: number, length: number): number {
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read;
}

/** Exported for `read.ts`: the hot half of the accessor must clamp identically. */
export function readRange(fd: number, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  const read = readInto(fd, buf, position, length);
  return read === length ? buf : buf.subarray(0, read);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function hashPrefix(fd: number, length: number, buf: Buffer): { hash: string; bytesRead: number } {
  const hash = createHash('sha256');
  let pos = 0;
  let bytesRead = 0;
  while (pos < length) {
    const want = Math.min(buf.length, length - pos);
    const got = readInto(fd, buf, pos, want);
    if (got === 0) break;
    hash.update(buf.subarray(0, got));
    pos += got;
    bytesRead += got;
  }
  return { hash: hash.digest('hex'), bytesRead };
}

/**
 * Read `[from, to)` in descending chunks, reporting the last `\n`. Every chunk is
 * read even after it is found, so the re-stat covers every byte we may write.
 */
function scanDeltaBackward(
  fd: number,
  from: number,
  to: number,
  buf: Buffer,
): { lastNewlineOffset: number | undefined; bytesRead: number } {
  let lastNewlineOffset: number | undefined;
  let bytesRead = 0;
  let end = to;
  while (end > from) {
    const start = Math.max(from, end - buf.length);
    const want = end - start;
    const got = readInto(fd, buf, start, want);
    if (got === 0) break;
    bytesRead += got;
    if (lastNewlineOffset === undefined) {
      const idx = buf.subarray(0, got).lastIndexOf(NEWLINE);
      if (idx !== -1) lastNewlineOffset = start + idx;
    }
    end = start;
  }
  return { lastNewlineOffset, bytesRead };
}

/**
 * Invariant W: each chunk must land at exactly the current EOF, because a
 * positional write past EOF leaves a sparse NUL hole that `size` counts as real
 * content. The `fstatSync` below enforces it rather than assuming it.
 */
function writeArchiveBytes(params: {
  archiveRoot: string;
  archivePath: string;
  archiveExists: boolean;
  sourceFd: number;
  from: number;
  to: number;
  buffer: Buffer;
}): { bytesWritten: number; bytesRead: number } {
  const { archiveRoot, archivePath, archiveExists, sourceFd, from, to, buffer } = params;
  const dir = dirname(archivePath);
  // Asserts, creates, asserts again — so a pre-planted LIVE symlinked ancestor
  // is refused before any directory is made through it, which the old
  // create-then-assert order could not do. See `ensureDirUnder` for the two
  // things it does NOT buy: the concurrent-plant window (not closable in Node at
  // all) and a dangling ancestor (indistinguishable from an absent one, stopped
  // by the kernel's ENOENT rather than by the guard).
  ensureDirUnder(dir, archiveRoot);

  const fd = refuseSymlinkedLeaf(archivePath, () =>
    // The refusal lives in the open, not in an lstat before it: a leaf symlink
    // planted between an lstat and the open would defeat a check-then-open guard
    // (TOCTOU). Scope: FINAL COMPONENT ONLY. The directory chain above is still
    // check-then-act — `ensureDirUnder` asserts around the `mkdirSync`, this open
    // comes after both.
    // The create branch needs no O_NOFOLLOW: O_CREAT|O_EXCL refuses a final
    // symlink by POSIX rule, live or dangling, asserted in Test 21 rather than
    // assumed. 'r+' was exactly O_RDWR; 'wx' also carried O_TRUNC, which is inert
    // under O_EXCL because nothing can exist to truncate.
    openSync(archivePath, archiveExists ? O_RDWR | O_NOFOLLOW : O_WRONLY | O_CREAT | O_EXCL, 0o600),
  );
  try {
    if (!archiveExists) chmodSync(archivePath, 0o600); // umask can mask the create-mode
    let pos = from;
    let bytesRead = 0;
    while (pos < to) {
      const want = Math.min(buffer.length, to - pos);
      const got = readInto(sourceFd, buffer, pos, want);
      if (got === 0) break; // source shrank mid-copy; stop at a true prefix
      bytesRead += got;
      const size = fstatSync(fd).size;
      if (size !== pos) {
        throw new Error(
          `Invariant W violated for ${archivePath}: EOF is ${size} but the next write is at ${pos}`,
        );
      }
      writeSync(fd, buffer, 0, got, pos);
      pos += got;
    }
    return { bytesWritten: pos - from, bytesRead };
  } finally {
    closeSync(fd);
  }
}

/**
 * Head plus seam is a sampling check, not a full one — the band between the
 * windows is unread until `--verify`. The seam catches a rewrite at the exact
 * offset we are about to extend from.
 */
export function detectDivergence(params: {
  sourceFd: number;
  archiveFd: number;
  sourceSize: number;
  archiveSize: number;
  verify: boolean;
  buffer: Buffer;
}): { reason: DivergenceReason | undefined; bytesRead: number } {
  const { sourceFd, archiveFd, sourceSize, archiveSize, verify, buffer } = params;
  if (archiveSize === 0) return { reason: undefined, bytesRead: 0 };
  if (sourceSize < archiveSize) return { reason: 'shrink', bytesRead: 0 };

  let bytesRead = 0;
  const w = Math.min(PROBE_BYTES, archiveSize);
  const sourceHead = readRange(sourceFd, 0, w);
  bytesRead += sourceHead.length;
  const archiveHead = readRange(archiveFd, 0, w);
  if (!sourceHead.equals(archiveHead)) return { reason: 'head', bytesRead };

  // At or below the probe size the seam window is the head window, already checked.
  if (archiveSize > PROBE_BYTES) {
    const seamStart = archiveSize - PROBE_BYTES;
    const sourceSeam = readRange(sourceFd, seamStart, PROBE_BYTES);
    bytesRead += sourceSeam.length;
    const archiveSeam = readRange(archiveFd, seamStart, PROBE_BYTES);
    if (!sourceSeam.equals(archiveSeam)) return { reason: 'seam', bytesRead };
  }

  if (verify) {
    const sourcePrefix = hashPrefix(sourceFd, archiveSize, buffer);
    bytesRead += sourcePrefix.bytesRead;
    const archivePrefix = hashPrefix(archiveFd, archiveSize, buffer);
    if (sourcePrefix.hash !== archivePrefix.hash) return { reason: 'verify', bytesRead };
  }

  return { reason: undefined, bytesRead };
}

export interface MirrorContext {
  archiveRoot: string;
  verify: boolean;
  buffer: Buffer;
  /** Injected so a test can force `settled === false` without racing a real writer. */
  statFile: (path: string) => BigIntStats | undefined;
  bytesRead: number;
  /** Logical archive paths sealed during this pass, in visit order. */
  sealed: string[];
}

export function createMirrorContext(params: {
  archiveRoot: string;
  verify?: boolean;
  statFile?: (path: string) => BigIntStats | undefined;
}): MirrorContext {
  return {
    archiveRoot: params.archiveRoot,
    verify: params.verify === true,
    buffer: Buffer.allocUnsafe(CHUNK_BYTES),
    statFile: params.statFile ?? statSafeBig,
    bytesRead: 0,
    sealed: [],
  };
}

/**
 * The expired return, taken by both paths that discover a missing source. The
 * seal is wired here rather than at a single later point because the second
 * path returns straight out of the failed source open.
 */
function expire(
  entry: DiscoveredEntry,
  base: ArchiveFileState,
  ctx: MirrorContext,
): ArchiveFileState {
  const expired: ArchiveFileState = { ...base, source_state: 'expired' };
  if (
    !shouldSeal({
      sourceState: 'expired',
      alreadySealed: entry.sealed,
      archiveSize: base.archive_size,
    })
  ) {
    return expired;
  }
  const sealed = sealArchiveFile(base.archive_path, ctx.archiveRoot);
  ctx.sealed.push(base.archive_path);
  return {
    ...expired,
    // Both together, or `archive_size` would report the pre-seal hot size while
    // `archive_state` already read `sealed` — on exactly one pass per file.
    archive_size: sealed.sealed_size,
    archive_state: 'sealed',
    archive_sha256: sealed.archive_sha256,
    sealed_at: sealed.sealed_at,
  };
}

/** One file, start to finish. Never throws for an expected condition. */
export function mirrorFile(entry: DiscoveredEntry, ctx: MirrorContext): ArchiveFileState {
  const archiveDiskPath = entry.sealed ? `${entry.archivePath}.zst` : entry.archivePath;
  const archiveStat = statSafe(archiveDiskPath);
  // For a sealed entry this is the compressed size on disk, not the logical length.
  const archiveSize = archiveStat?.size ?? 0;
  const archiveState: ArchiveState = entry.sealed ? 'sealed' : 'hot';

  const base: ArchiveFileState = {
    source_path: entry.sourcePath,
    source_size: null,
    source_mtime_ms: null,
    source_head_sha256: null,
    source_head_len: 0,
    source_state: 'present',
    archive_path: entry.archivePath,
    archive_size: archiveSize,
    archive_state: archiveState,
    bytes_copied: 0,
  };

  const s0 = ctx.statFile(entry.sourcePath);
  if (s0 === undefined || !s0.isFile()) {
    return expire(entry, base, ctx);
  }

  const sourceSize = Number(s0.size);
  base.source_size = sourceSize;
  base.source_mtime_ms = Number(s0.mtimeMs);

  // 'r' only. Never any other flag, anywhere, for a source path.
  let sourceFd: number;
  try {
    sourceFd = openSync(entry.sourcePath, 'r');
  } catch (error) {
    // Expiry is normal here, so the stat->open race is not a pass error.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return expire(entry, base, ctx);
    }
    throw error;
  }

  try {
    // Spans `min(4096, sourceSize)`; `detectDivergence` compares over
    // `min(4096, archiveSize)`. Not the same value.
    const headLen = Math.min(PROBE_BYTES, sourceSize);
    const head = readRange(sourceFd, 0, headLen);
    base.source_head_len = head.length;
    base.source_head_sha256 = sha256(head);
    ctx.bytesRead += head.length;

    // Never append to a sealed archive, nor write a second generation beside it.
    if (entry.sealed) return base;

    if (archiveSize > 0 && archiveStat !== undefined) {
      // Read-only, but O_NOFOLLOW all the same: `archiveStat` came from a
      // following `statSafe`, so without it a symlinked leaf is read as if it
      // were the mirror and can fabricate a `diverged` row about a file the
      // archive never wrote.
      const archiveFd = refuseSymlinkedLeaf(archiveDiskPath, () =>
        openSync(archiveDiskPath, O_RDONLY | O_NOFOLLOW),
      );
      let reason: DivergenceReason | undefined;
      try {
        const detected = detectDivergence({
          sourceFd,
          archiveFd,
          sourceSize,
          archiveSize,
          verify: ctx.verify,
          buffer: ctx.buffer,
        });
        reason = detected.reason;
        ctx.bytesRead += detected.bytesRead;
      } finally {
        closeSync(archiveFd);
      }
      if (reason !== undefined) return { ...base, source_state: 'diverged', reason };
    }

    if (sourceSize <= archiveSize) return base;

    // Read the whole delta before the second stat, so `settled` covers it all.
    const scan = scanDeltaBackward(sourceFd, archiveSize, sourceSize, ctx.buffer);
    ctx.bytesRead += scan.bytesRead;

    const s1 = ctx.statFile(entry.sourcePath);
    const settled = s1 !== undefined && s1.size === s0.size && s1.mtimeNs === s0.mtimeNs;

    const end = decideCopyEnd({
      archiveSize,
      sourceSize,
      lastNewlineOffset: scan.lastNewlineOffset,
      settled,
    });

    // Create lazily: a 0-byte file would outlive its source as the archived truth.
    if (end <= archiveSize) return base;

    const written = writeArchiveBytes({
      archiveRoot: ctx.archiveRoot,
      archivePath: entry.archivePath,
      archiveExists: archiveStat !== undefined,
      sourceFd,
      from: archiveSize,
      to: end,
      buffer: ctx.buffer,
    });
    ctx.bytesRead += written.bytesRead;
    return {
      ...base,
      archive_size: archiveSize + written.bytesWritten,
      bytes_copied: written.bytesWritten,
    };
  } finally {
    closeSync(sourceFd);
  }
}

/** One pass. Copies zero bytes when the lock cannot be acquired (see `lock.ts`). */
export function archiveOnce(options: ArchiveOptions = {}): ArchiveResult {
  const sourceRoot = canonicalizeTranscriptPath(resolveTranscriptRoot(options.transcriptRoot));
  const dataDir = resolveDataDir(options.dataDir);
  ensureDir(resolveArchiveRoot(dataDir));
  const archiveRoot = canonicalizeTranscriptPath(resolveArchiveRoot(dataDir));

  const lock = acquireLock(dataDir, options.lockIdentity);
  const result: ArchiveResult = {
    files: [],
    filesSeen: 0,
    bytesCopied: 0,
    bytesRead: 0,
    lock: lock.state,
    errors: [],
    sourceRoot,
    archiveRoot,
    logged: false,
    sealed: [],
  };

  const diverged: DivergedLogEntry[] = [];
  const newlyExpired: string[] = [];

  try {
    if (lock.state.state !== 'held') {
      const entries = discover(sourceRoot, archiveRoot);
      result.filesSeen = entries.length;
      const ctx = createMirrorContext({ archiveRoot, verify: options.verify });
      for (const entry of entries) {
        try {
          const state = mirrorFile(entry, ctx);
          result.files.push(state);
          result.bytesCopied += state.bytes_copied;
          if (state.source_state === 'diverged') {
            diverged.push({
              source_path: state.source_path,
              reason: state.reason ?? 'shrink',
              archive_size: state.archive_size,
              source_size: state.source_size,
            });
          }
          // Only the within-pass race is "newly": found by the walk, lost by the stat.
          if (state.source_state === 'expired' && entry.presence !== 'archive-only') {
            newlyExpired.push(state.source_path);
          }
        } catch (error) {
          // One unreadable file must not stop the rest of the pass.
          result.errors.push({ path: entry.sourcePath, message: String(error) });
        }
      }
      result.bytesRead = ctx.bytesRead;
      result.sealed = ctx.sealed;
    }
  } finally {
    lock.release();
  }

  const record: ArchiveLogRecord = {
    ts: new Date().toISOString(),
    files_seen: result.filesSeen,
    bytes_copied: result.bytesCopied,
    lock: result.lock,
    diverged,
    newly_expired: newlyExpired,
    errors: result.errors,
    sealed: result.sealed,
  };
  // CONTRACT: `archiveOnce` RETURNS a result carrying a log-write failure rather
  // than throwing one at a caller that asked for a result. The log leaf can now
  // refuse — a symlink at <dataDir>/logs/archive.jsonl is not followed — and this
  // call sits outside the per-entry catch above, so without this the whole pass
  // would come back as an exception. Same shape as that catch, deliberately: the
  // archive gains no second failure idiom. `logged` stays false, and the message
  // is printed by `formatSummary`, so nothing is swallowed. The mirrored bytes
  // are the system of record and this log explicitly is not (see log.ts), so a
  // hijacked event log must not cost the pass what it already copied.
  try {
    result.logged = appendArchiveLog(dataDir, record);
  } catch (error) {
    result.errors.push({ path: resolveArchiveLogPath(dataDir), message: String(error) });
  }

  return result;
}
