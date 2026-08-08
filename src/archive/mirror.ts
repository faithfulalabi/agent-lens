// The verbatim, append-only mirror. One synchronous pass, no timers, no DB, no
// state file.
//
// BOOKKEEPING LIVES NOWHERE. The archive is by construction a byte-identical
// PREFIX of its source, so the archive's own bytes are the stored fingerprint:
// `archiveSize = statSync(archivePath).size` and nothing else. There is no offset
// to desynchronise, so there is no offset-commit-ordering problem, and a crash
// costs one re-`stat`. This is the deliberate opposite of `tailer.ts`, whose
// `decideStart` resets to byte 0 on rotation/truncation/rewrite because
// `event_id` dedupe makes re-reading free — here re-copying would be corruption.
//
// DIVERGENCE NEVER DESTROYS. If the source shrank, or its head or seam changed,
// it was rewritten: keep every archived byte, mark `diverged`, copy nothing.
//
// THE ARCHIVE MAY END MID-LINE, in exactly two situations, and both are benign
// because the projector reads whole lines and drops a trailing fragment: (a)
// between a crash and the next pass, and (b) after a settled trailing partial is
// promoted while the writer was merely paused. RFC 002 §6 rule 1 reads as an
// absolute; this is the honest statement of it.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
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
import {
  assertUnderArchiveRoot,
  canonicalizeTranscriptPath,
  ensureDir,
  resolveArchiveRoot,
  resolveDataDir,
  resolveTranscriptRoot,
  statSafe,
  statSafeBig,
} from './paths.js';

/** The fixed head/seam probe window. */
const PROBE_BYTES = 4096;

/** Copy buffer. Reused for the backward scan and the ascending write, so memory is O(1). */
const CHUNK_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export type SourceState = 'present' | 'expired' | 'diverged';
export type ArchiveState = 'hot' | 'sealed';
export type DivergenceReason = 'shrink' | 'head' | 'seam' | 'verify';

/**
 * Shaped to the `sessions` columns fixed by `data-model-v2.md:57,67` so task
 * 3.4's sweep calls this function instead of reconciling a table. This task
 * invents no new enum values; the nuance divergence carries lives in `reason`.
 */
export interface ArchiveFileState {
  source_path: string;
  source_size: number | null;
  source_mtime_ms: number | null;
  source_head_sha256: string | null;
  /**
   * The length actually hashed, `min(4096, sourceSize)`. Load-bearing, not
   * decoration: 156 of 384 in-scope files are under 4096 bytes, so for them the
   * head hash is a MOVING window that changes on every append — the same shape as
   * the `tailer.ts:390-397` bug, recreated in the value handed downstream. With
   * the length beside it a consumer can tell "grew from 100 to 200 bytes" apart
   * from "was rewritten"; a zero-padded fixed window cannot.
   */
  source_head_len: number;
  source_state: SourceState;
  archive_path: string;
  archive_size: number;
  archive_state: ArchiveState;
  reason?: DivergenceReason;
  bytes_copied: number;
}

export interface ArchiveResult {
  files: ArchiveFileState[];
  filesSeen: number;
  bytesCopied: number;
  /** Bytes read from sources this pass. Test 24(c) asserts `--verify` is off by default with it. */
  bytesRead: number;
  lock: LockState;
  errors: { path: string; message: string }[];
  sourceRoot: string;
  archiveRoot: string;
  logged: boolean;
}

export interface ArchiveOptions {
  dataDir?: string;
  transcriptRoot?: string;
  /**
   * Opt-in FULL-FILE prefix compare: `sha256(source[0, archiveSize))` against the
   * whole archive. Deliberately NOT on the hot path — it reads ~180 MB today and
   * grows linearly with the corpus forever, which would turn a 1-minute cron into
   * continuous disk I/O. Handed to task 1.3 (`doctor`) to wire and to schedule.
   */
  verify?: boolean;
  lockIdentity?: LockIdentity;
}

/**
 * Where this pass stops copying. The whole §4 rule, pure and filesystem-free:
 *
 *   settled            -> the entire delta, trailing partial included
 *   unsettled + `\n`   -> through the last complete newline (a record boundary)
 *   unsettled + no `\n`-> nothing at all
 *
 * "Settled" means a re-`stat` after reading the WHOLE delta found the same size
 * and the same `mtimeNs` — literally "nothing landed across my read window". It
 * is clock-free (two stats of one file, no `Date.now()`, no cross-clock
 * subtraction) and granularity-free (`size` catches any nonzero append,
 * `mtimeNs` catches a same-size in-place rewrite that float `mtimeMs` could
 * round away). The wall-clock quiesce window it replaces was unsound in both
 * directions: a backward NTP step or a future-dated mtime starves every
 * whole-file kind silently and forever, and the measured max birth->mtime spread
 * on `tool-results/*.txt` is 2388.9 ms — already larger than the 2000 ms window
 * that was proposed.
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

/** Read exactly `length` bytes at `position` into `buf` (short at EOF). */
function readInto(fd: number, buf: Buffer, position: number, length: number): number {
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read;
}

/** Read exactly `length` bytes at `position` into a fresh buffer (short at EOF). */
function readRange(fd: number, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  const read = readInto(fd, buf, position, length);
  return read === length ? buf : buf.subarray(0, read);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** `sha256` of `[0, length)` streamed through the shared buffer — O(1) memory. */
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
 * Read `[from, to)` in DESCENDING chunks, reporting the last `\n` in it.
 *
 * The mirror image of `tailer.ts`'s `scanForNewline` (chunked forward scan for
 * the FIRST newline), with the direction inverted. Every chunk is read even after
 * a newline is found, and that is the point: `settled` is only meaningful if the
 * re-`stat` that follows covers every byte this pass will go on to write.
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
 * THE ONLY PLACE THIS MODULE OPENS A FILE FOR WRITING. Every byte the archive
 * ever gains passes through here, past one containment assertion.
 *
 * INVARIANT W — every write lands at exactly the current EOF. A sparse hole
 * requires writing BEYOND EOF, so if the first chunk goes to exactly
 * `archiveSize` and each subsequent chunk to exactly the previous chunk's end,
 * the file grows contiguously and a hole is structurally impossible. The
 * `fstatSync` before each write enforces that rather than merely commenting it,
 * converting a lock bug from silent corruption into a loud, greppable throw.
 * (~463 `fstat` calls on the 180.7 MB cold start. Free.)
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
  ensureDir(dir);
  // Realpath the directory, not the file: the file may not exist yet, and a
  // symlinked ancestor is exactly what this guard is for.
  assertUnderArchiveRoot(canonicalizeTranscriptPath(dir), archiveRoot);

  const fd = openSync(archivePath, archiveExists ? 'r+' : 'wx', 0o600);
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
 * The three divergence limbs, in order. `w = min(4096, archiveSize)`,
 * `seamStart = max(0, archiveSize - 4096)`.
 *
 * HONEST SCOPE. Head plus seam covers 1,890,190 of 180,664,278 in-scope bytes =
 * 1.05%, and 228 of 384 files carry a blind band between the two windows that
 * neither limb ever reads. This is NOT a full integrity check and must not be
 * described as one. What the seam DOES guarantee is the failure that corrupts
 * during a copy: an append welding generation-2 bytes onto a generation-1 prefix
 * at the exact offset we are about to extend from. That narrow claim is true and
 * worth its two 4 KB reads. The full answer is the opt-in `--verify` prefix hash,
 * which has no blind band at all.
 *
 * The seam also does double duty as the repair-before-extend step: a NUL hole
 * left by an out-of-order write lands in the archive's trailing bytes, so the
 * compare fires and the file is marked `diverged` instead of being compounded.
 */
function detectDivergence(params: {
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

  // When `archiveSize <= 4096` the seam window IS the head window; the head check
  // already stands alone and the extra read would be redundant.
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
  /**
   * Injected so a test can produce `settled === false` deterministically, by
   * handing back a doctored pre-read stat, instead of racing a real writer.
   */
  statFile: (path: string) => BigIntStats | undefined;
  /** Mutable pass accumulator: bytes read from SOURCES, so `--verify`'s cost is observable. */
  bytesRead: number;
}

/** A pass context with the real filesystem wired in. */
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
  };
}

/** One file, start to finish. Never throws for an expected condition. */
export function mirrorFile(entry: DiscoveredEntry, ctx: MirrorContext): ArchiveFileState {
  const archiveDiskPath = entry.sealed ? `${entry.archivePath}.zst` : entry.archivePath;
  const archiveStat = statSafe(archiveDiskPath);
  // For a sealed entry this is the COMPRESSED size on disk, not the logical
  // archived length — task 1.2 owns that distinction along with the `.zst`.
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
    // Both the between-passes case (archive-only in the union) and the same-pass
    // readdir->stat race land here, so task 1.2 has ONE seal contract regardless
    // of when the deletion happened.
    return { ...base, source_state: 'expired' };
  }

  const sourceSize = Number(s0.size);
  base.source_size = sourceSize;
  base.source_mtime_ms = Number(s0.mtimeMs);

  // 'r' ONLY. Never any other flag, anywhere, for a source path.
  let sourceFd: number;
  try {
    sourceFd = openSync(entry.sourcePath, 'r');
  } catch (error) {
    // The stat->open leg of the same expiry race the stat above covers. Expiry
    // is the NORMAL case for this corpus, so it must report `expired` rather
    // than surface as a pass error.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...base, source_state: 'expired' };
    }
    throw error;
  }

  try {
    // The head hash REPORTED is over `min(4096, sourceSize)`; the head hash
    // COMPARED (below) uses the matched window `min(4096, archiveSize)`. Those are
    // two different values whenever `archiveSize < 4096` and must not be conflated.
    const headLen = Math.min(PROBE_BYTES, sourceSize);
    const head = readRange(sourceFd, 0, headLen);
    base.source_head_len = head.length;
    base.source_head_sha256 = sha256(head);
    ctx.bytesRead += head.length;

    // A sealed archive belongs to task 1.2. Never append to it, and above all
    // never write a second, unsealed generation of the same logical file beside it.
    if (entry.sealed) return base;

    if (archiveSize > 0 && archiveStat !== undefined) {
      const archiveFd = openSync(archiveDiskPath, 'r');
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

    // Step 2: read the ENTIRE delta before the second stat, so `settled` means
    // what it says. The earlier read/write/stat/read/write split validated a
    // window that did not contain the bytes its second phase went on to copy.
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

    // LAZY CREATION. A zero-byte copy must leave NO archive file behind: a 0-byte
    // entry would join the archive-walk keyspace, survive the source's expiry, and
    // hand task 1.2 an empty file to seal as the archived truth.
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

/**
 * One pass. Copies ZERO bytes when the lock cannot be acquired — see `lock.ts`
 * for why that is a correctness precondition and not a convenience.
 */
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
          // Only the within-pass race counts as "newly": an entry the source walk
          // found and the stat then lost. See `log.ts` for why.
          if (state.source_state === 'expired' && entry.presence !== 'archive-only') {
            newlyExpired.push(state.source_path);
          }
        } catch (error) {
          // One file's failure is recorded and the pass continues — one unreadable
          // project must not stop the other eleven from being protected.
          result.errors.push({ path: entry.sourcePath, message: String(error) });
        }
      }
      result.bytesRead = ctx.bytesRead;
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
  };
  result.logged = appendArchiveLog(dataDir, record);

  return result;
}
