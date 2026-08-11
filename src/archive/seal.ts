// Compressing an archived file whose source is gone. The trigger is `shouldSeal`
// in mirror.ts and it has exactly one firing condition: the source disappeared,
// so the file can never grow again. There is no clock input anywhere in this
// module — `sealed_at` is an output stamp, never an input to the decision.

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  assertUnderArchiveRoot,
  canonicalizeTranscriptPath,
  refuseSymlinkedLeaf,
} from './paths.js';
import { serializeSidecar, sidecarPath, SIDECAR_VERSION } from './sidecar.js';

const { O_NOFOLLOW, O_RDONLY } = constants;

const SEALED_SUFFIX = '.zst';

/**
 * Pinned in one place because `zstdCompressSync` is still `@experimental`.
 *
 * - `ZSTD_c_compressionLevel: 3` is also today's `ZSTD_CLEVEL_DEFAULT`, but a
 *   Node default can move and the ratio criterion must not be hostage to it.
 *   The `params` form is the only one that works: `{ level: N }` is ignored at
 *   runtime (and rejected at compile time by `@types/node`'s `ZstdOptions`).
 * - `ZSTD_c_contentSizeFlag` puts the uncompressed length in the frame header.
 *   That is what `read.ts` compares against, and it is the only read-side
 *   truncation defence there is.
 * - `ZSTD_c_checksumFlag` costs 4 bytes per file and catches bit rot. It
 *   provably does NOT catch truncation — see `read.ts`.
 */
const ZSTD_PARAMS: Record<number, number> = {
  [zlibConstants.ZSTD_c_compressionLevel]: 3,
  [zlibConstants.ZSTD_c_checksumFlag]: 1,
  [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
};

/**
 * What a seal computes. Every field is returned AND persisted, in the
 * `<archivePath>.zst.sha256` sidecar published beside the frame, so the record
 * that certifies these bytes lives and dies with them. `doctor` is what reads
 * the record back, re-hashing the frame against it under `--verify`.
 */
export interface SealResult {
  /** sha256 over the pre-seal bytes, and the round-trip verify's expectation. */
  archive_sha256: string;
  /** ISO-8601. An OUTPUT of the seal. */
  sealed_at: string;
  /** The `.zst`'s size on disk; becomes `ArchiveFileState.archive_size`. */
  sealed_size: number;
  /** The pre-seal length, which the round-trip verify asserts against. */
  hot_size: number;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Compress `archivePath` to `<archivePath>.zst` and remove the original. Throws
 * rather than half-sealing; `archiveOnce`'s per-entry catch routes the message
 * into `result.errors`.
 */
export function sealArchiveFile(archivePath: string, archiveRoot: string): SealResult {
  // One inode: length, hash and bytes all come from this fd, never from a
  // re-resolved path. `O_NOFOLLOW` for the same reason the divergence read has
  // it (task 1.4): a symlinked leaf here would read a live transcript through
  // the link, compress it into the archive, and then unlink the link.
  const fd = refuseSymlinkedLeaf(archivePath, () => openSync(archivePath, O_RDONLY | O_NOFOLLOW));
  let bytes: Buffer;
  let hotSize: number;
  try {
    hotSize = fstatSync(fd).size;
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  if (bytes.length !== hotSize) {
    throw new Error(
      `refusing to seal ${archivePath}: it holds ${bytes.length} bytes but stat said ${hotSize}`,
    );
  }

  const archiveSha256 = sha256(bytes);
  const compressed = zstdCompressSync(bytes, { params: ZSTD_PARAMS });

  // Round-trip BEFORE anything irreversible. The frame checksum does not cover
  // truncation, so this is the only thing between a compressor fault and the
  // unlink below — after which the archive is the only copy of these bytes.
  const roundTrip = zstdDecompressSync(compressed);
  if (roundTrip.length !== hotSize || sha256(roundTrip) !== archiveSha256) {
    throw new Error(
      `seal round-trip verify failed for ${archivePath}: ${roundTrip.length} bytes back from ${hotSize}`,
    );
  }

  // Same guard, same call order as the mirror's own write path.
  assertUnderArchiveRoot(canonicalizeTranscriptPath(dirname(archivePath)), archiveRoot);

  // `discover` cannot see this name: `stripSealedSuffix` leaves the `.tmp.<pid>`
  // on, so the allowed-suffix test fails and a crashed temp leaks disk without
  // ever entering the union as archived bytes.
  const temp = `${archivePath}${SEALED_SUFFIX}.tmp.${process.pid}`;
  const tempFd = refuseSymlinkedLeaf(temp, () => openSync(temp, 'wx', 0o600));
  try {
    fchmodSync(tempFd, 0o600); // umask can mask the create-mode; fd-based, no re-resolve
    writeSync(tempFd, compressed, 0, compressed.length, 0);
  } finally {
    closeSync(tempFd);
  }

  const sealedAt = new Date().toISOString();

  // The sidecar is published FIRST, by its own temp+rename, which is what makes
  // "a `.zst` at its final name always has a sidecar" an invariant rather than a
  // hope (files sealed before this landed excepted — there is no honest hash to
  // backfill for them, since their pre-seal bytes are gone). Crashing between
  // the two renames leaves a sidecar with no `.zst`: inert, invisible to
  // `discover`, and overwritten by the next pass, which re-seals the still
  // intact hot file. `doctor` is the reader on the other end of this record.
  const sealedPath = `${archivePath}${SEALED_SUFFIX}`;
  const sidecar = sidecarPath(sealedPath);
  const sidecarTemp = `${sidecar}.tmp.${process.pid}`;
  const sidecarBytes = Buffer.from(
    serializeSidecar({
      v: SIDECAR_VERSION,
      file: basename(archivePath),
      sha256: archiveSha256,
      hot_size: hotSize,
      sealed_size: compressed.length,
      sealed_at: sealedAt,
    }),
    'utf8',
  );
  const sidecarFd = refuseSymlinkedLeaf(sidecarTemp, () => openSync(sidecarTemp, 'wx', 0o600));
  try {
    fchmodSync(sidecarFd, 0o600); // as for the frame's temp: umask can mask the create-mode
    writeSync(sidecarFd, sidecarBytes, 0, sidecarBytes.length, 0);
  } finally {
    closeSync(sidecarFd);
  }
  renameSync(sidecarTemp, sidecar);

  // Rename before unlink, never the reverse: at every instant either the hot
  // file alone is authoritative, or both exist with the `.zst` already verified
  // against the bytes it came from. There is no instant at which only a partial
  // frame exists at the final name.
  renameSync(temp, sealedPath);
  unlinkSync(archivePath);

  return {
    archive_sha256: archiveSha256,
    sealed_at: sealedAt,
    sealed_size: compressed.length,
    hot_size: hotSize,
  };
}
