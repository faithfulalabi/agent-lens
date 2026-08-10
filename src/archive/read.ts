// One accessor over both storage states. Callers pass the LOGICAL archive path —
// never a `.zst` — because `events.line_ref` offsets are archive-relative and a
// ref recorded while a file was hot must still resolve after it is sealed.
// Which state served the bytes is not observable from the outside.

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { readRange } from './mirror.js';

const SEALED_SUFFIX = '.zst';

/** Little-endian `0xFD2FB528` at bytes 0-3 of every zstd frame. */
const ZSTD_MAGIC = 0xfd2fb528;

const DEFAULT_MAX_ENTRIES = 4;

/** 64 MB. Doubles as the decompression bound — see `loadSealed`. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface ArchiveReaderStats {
  hits: number;
  misses: number;
  evictions: number;
  entries: number;
  bytes: number;
}

export interface ArchiveReader {
  /** Short at EOF, empty past it — the same clamp a hot positional read gives. */
  read(archivePath: string, offset: number, length: number): Buffer;
  /** The LOGICAL length in both states: decompressed, not compressed-on-disk. */
  size(archivePath: string): number;
  /** Counters describe the sealed path only; a hot read is never cached. */
  stats(): ArchiveReaderStats;
}

/**
 * The uncompressed length the frame header declares.
 *
 * This is the whole read-side truncation defence, and it has to be, because
 * `zstdDecompressSync` returns a SHORT buffer on a truncated frame without
 * throwing — at any size, with or without the checksum flag. 100 bytes off a
 * 6.15 MB frame yields 6,029,312 bytes silently; 5 bytes off a 5 KB frame
 * yields 0, so a naive "did we get anything back" check would miss it too.
 */
export function declaredContentSize(frame: Buffer, label: string): number {
  if (frame.length < 5 || frame.readUInt32LE(0) !== ZSTD_MAGIC) {
    throw new Error(`not a zstd frame: ${label}`);
  }
  const descriptor = frame[4]!;
  const contentSizeFlag = descriptor >> 6; // bits 7-6, the field's width code
  const singleSegment = (descriptor >> 5) & 1; // bit 5; a Window_Descriptor follows only when 0
  const dictionaryIdFlag = descriptor & 0b11; // bits 1-0

  const offset = 5 + (singleSegment === 1 ? 0 : 1) + [0, 1, 2, 4][dictionaryIdFlag]!;
  // Width 0 means the frame declares nothing. Unreachable for frames `seal.ts`
  // writes, which pin ZSTD_c_contentSizeFlag, but a frame from elsewhere can.
  const width =
    contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag]!;
  if (width === 0) {
    throw new Error(`sealed archive declares no content size: ${label}`);
  }
  if (offset + width > frame.length) {
    throw new Error(`truncated zstd frame header: ${label}`);
  }
  switch (width) {
    case 1:
      return frame.readUInt8(offset);
    case 2:
      return frame.readUInt16LE(offset) + 256; // the 2-byte form is stored biased
    case 4:
      return frame.readUInt32LE(offset);
    default:
      return Number(frame.readBigUInt64LE(offset));
  }
}

export function createArchiveReader(
  options: { maxEntries?: number; maxBytes?: number } = {},
): ArchiveReader {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  // Insertion-ordered, so the first key is always the least recently used.
  const cache = new Map<string, Buffer>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let cachedBytes = 0;

  /**
   * Dispatch without a TOCTOU stat: try hot, fall back to sealed on ENOENT.
   * Safe because the transition is MONOTONIC — the mirror never appends to a
   * sealed archive and nothing un-seals, so a file cannot go sealed -> hot
   * underneath the fallback.
   */
  const openLogical = (archivePath: string): { fd: number; sealed: boolean } => {
    try {
      return { fd: openSync(archivePath, 'r'), sealed: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      return { fd: openSync(`${archivePath}${SEALED_SUFFIX}`, 'r'), sealed: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new Error(`no archived bytes for ${archivePath}`);
    }
  };

  const loadSealed = (fd: number, archivePath: string): Buffer => {
    // Keyed on the `.zst`'s own inode identity, so a re-sealed or replaced file
    // can never be served from a stale entry.
    const stat = fstatSync(fd, { bigint: true });
    const key = `${archivePath}|${stat.ino}:${stat.mtimeNs}:${stat.size}`;

    const cached = cache.get(key);
    if (cached !== undefined) {
      hits += 1;
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    misses += 1;

    const label = `${archivePath}${SEALED_SUFFIX}`;
    const frame = readFileSync(fd);
    // The header parse runs first, so an over-large frame is refused before any
    // allocation and a non-frame fails with our message rather than the codec's.
    const declared = declaredContentSize(frame, label);
    if (declared > maxBytes) {
      throw new Error(
        `sealed archive ${label} declares ${declared} bytes, over the ${maxBytes}-byte bound`,
      );
    }
    const buf = zstdDecompressSync(frame, { maxOutputLength: maxBytes });
    if (buf.length !== declared) {
      throw new Error(
        `truncated sealed archive ${label}: the frame declares ${declared} bytes but ${buf.length} decompressed`,
      );
    }

    // Only a verified buffer enters the cache, so a second read of a truncated
    // frame throws again instead of being served the short buffer.
    cache.set(key, buf);
    cachedBytes += buf.length;
    while (cache.size > maxEntries || cachedBytes > maxBytes) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cachedBytes -= cache.get(oldest.value)!.length;
      cache.delete(oldest.value);
      evictions += 1;
    }
    return buf;
  };

  return {
    read(archivePath: string, offset: number, length: number): Buffer {
      const { fd, sealed } = openLogical(archivePath);
      try {
        if (!sealed) return readRange(fd, offset, length);
        if (length <= 0) return Buffer.alloc(0);
        const buf = loadSealed(fd, archivePath);
        // Copied, not a view: the caller must not be able to reach into the
        // cached buffer, and a hot read hands back a fresh buffer too.
        return Buffer.from(buf.subarray(offset, Math.min(offset + length, buf.length)));
      } finally {
        closeSync(fd);
      }
    },

    size(archivePath: string): number {
      const { fd, sealed } = openLogical(archivePath);
      try {
        return sealed ? loadSealed(fd, archivePath).length : fstatSync(fd).size;
      } finally {
        closeSync(fd);
      }
    },

    stats(): ArchiveReaderStats {
      return { hits, misses, evictions, entries: cache.size, bytes: cachedBytes };
    },
  };
}
