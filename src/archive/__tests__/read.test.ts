// The accessor: one surface over both storage states (AC3), a bounded LRU with
// honest counters (AC4), and the frame content-size check that is the whole
// read-side defence against a truncated `.zst`.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, truncateSync } from 'node:fs';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { createArchiveReader, declaredContentSize } from '../read.js';
import { sealArchiveFile } from '../seal.js';
import { canonicalizeTranscriptPath } from '../paths.js';
import {
  cleanup,
  makeSandbox,
  readBytes,
  SLUG,
  transcriptLines,
  writeArchive,
  type Sandbox,
} from './fixtures.js';

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

/** Plant a hot archive file and return its logical path. */
function plant(rel: string, body: string): string {
  return writeArchive(sb(), rel, body);
}

/** Plant, then seal. Returns the LOGICAL path — the only thing callers ever hold. */
function plantSealed(rel: string, body: string): string {
  const logical = plant(rel, body);
  sealArchiveFile(logical, canonicalizeTranscriptPath(sb().archiveRoot));
  return logical;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

describe('AC3 — one accessor, two storage states, byte-identical (Test 6)', () => {
  it('returns the same bytes at every offset before and after sealing', () => {
    const body = transcriptLines(300);
    const logical = plant(`${SLUG}/sess-1.jsonl`, body);
    const len = Buffer.byteLength(body);
    const reader = createArchiveReader();

    const ranges: { name: string; offset: number; length: number }[] = [
      { name: 'from zero', offset: 0, length: 10 },
      { name: 'the whole file', offset: 0, length: len },
      { name: 'mid-file', offset: Math.floor(len / 2), length: 50 },
      { name: 'the last byte', offset: len - 1, length: 1 },
      { name: 'overrunning the last byte', offset: len - 1, length: 10 },
      { name: 'overrunning from zero', offset: 0, length: len + 100 },
      { name: 'starting exactly at EOF', offset: len, length: 10 },
      { name: 'starting past EOF', offset: len + 1, length: 10 },
      { name: 'zero length', offset: Math.floor(len / 2), length: 0 },
    ];

    const hot = ranges.map((r) => reader.read(logical, r.offset, r.length));
    const hotSize = reader.size(logical);
    expect(hotSize).toBe(len);
    // Non-vacuity: the clamped rows must really come back short, or "identical"
    // could be two empty buffers agreeing about nothing.
    expect(hot[4]!.length).toBe(1);
    expect(hot[5]!.length).toBe(len);
    expect(hot[6]!.length).toBe(0);

    sealArchiveFile(logical, canonicalizeTranscriptPath(sb().archiveRoot));
    expect(existsSync(logical)).toBe(false);
    expect(existsSync(`${logical}.zst`)).toBe(true);

    // Same reader, same logical path, no caller-visible change of any kind.
    expect(reader.size(logical)).toBe(hotSize);
    ranges.forEach((r, i) => {
      expect(reader.read(logical, r.offset, r.length).equals(hot[i]!), r.name).toBe(true);
    });
  });

  it('a line_ref recorded while hot resolves to the same line after sealing (Test 7)', () => {
    const body = transcriptLines(300);
    const logical = plant(`${SLUG}/sess-1.jsonl`, body);
    const reader = createArchiveReader();

    // Record the ref the way the tailer would: an archive-relative offset+length.
    const lines = body.split('\n');
    const target = 173;
    const offset = Buffer.byteLength(lines.slice(0, target).join('\n')) + 1;
    const length = Buffer.byteLength(lines[target]!);
    const before = JSON.parse(reader.read(logical, offset, length).toString('utf8')) as {
      uuid: string;
    };
    expect(before.uuid).toContain(`-${String(target).padStart(12, '0')}`);

    sealArchiveFile(logical, canonicalizeTranscriptPath(sb().archiveRoot));

    const after = JSON.parse(reader.read(logical, offset, length).toString('utf8')) as {
      uuid: string;
    };
    expect(after).toEqual(before);
  });

  it('throws a named error when neither a hot nor a sealed file exists', () => {
    const reader = createArchiveReader();
    const missing = `${sb().archiveRoot}/${SLUG}/nope.jsonl`;
    expect(() => reader.read(missing, 0, 1)).toThrow(/no archived bytes for/);
    expect(() => reader.size(missing)).toThrow(/no archived bytes for/);
  });
});

describe('AC4 — the LRU decompresses once and stays bounded (Tests 8 and 9)', () => {
  it('five reads of one sealed file are one miss and four hits', () => {
    const logical = plantSealed(`${SLUG}/sess-1.jsonl`, transcriptLines(200));
    const reader = createArchiveReader({ maxEntries: 2 });

    for (let i = 0; i < 5; i++) reader.read(logical, 0, 64);

    const stats = reader.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(4);
    expect(stats.entries).toBe(1);
    expect(stats.evictions).toBe(0);
  });

  it('a hot file is never cached, so the counters describe the sealed path only', () => {
    const logical = plant(`${SLUG}/sess-2.jsonl`, transcriptLines(200));
    const reader = createArchiveReader({ maxEntries: 2 });

    for (let i = 0; i < 5; i++) reader.read(logical, 0, 64);

    expect(reader.stats()).toEqual({ hits: 0, misses: 0, evictions: 0, entries: 0, bytes: 0 });
  });

  it('evicts rather than grows: a third distinct file pushes the first out', () => {
    const paths = [1, 2, 3].map((n) =>
      plantSealed(`${SLUG}/sess-${n}.jsonl`, transcriptLines(100 + n)),
    );
    const reader = createArchiveReader({ maxEntries: 2 });

    for (const path of paths) {
      reader.read(path, 0, 32);
      expect(reader.stats().entries).toBeLessThanOrEqual(2);
    }
    expect(reader.stats().misses).toBe(3);
    expect(reader.stats().evictions).toBeGreaterThanOrEqual(1);

    // The re-read must be a MISS, or "evicted" would only mean "counted".
    reader.read(paths[0]!, 0, 32);
    expect(reader.stats().misses).toBe(4);
    expect(reader.stats().hits).toBe(0);
    expect(reader.stats().entries).toBeLessThanOrEqual(2);
  });

  it('stays bounded on both terms across ten distinct files', () => {
    const maxBytes = 1024 * 1024;
    const paths = Array.from({ length: 10 }, (_, i) =>
      plantSealed(`${SLUG}/sess-${i}.jsonl`, transcriptLines(50 + i)),
    );
    const reader = createArchiveReader({ maxEntries: 2, maxBytes });

    for (const path of paths) {
      reader.read(path, 0, 16);
      const stats = reader.stats();
      expect(stats.entries).toBeLessThanOrEqual(2);
      expect(stats.bytes).toBeLessThanOrEqual(maxBytes);
    }
    expect(reader.stats().evictions).toBe(8);
  });

  it('refuses a frame that declares more than the bound, before decompressing it', () => {
    const logical = plantSealed(`${SLUG}/sess-1.jsonl`, transcriptLines(2000));
    const reader = createArchiveReader({ maxBytes: 1024 });

    expect(() => reader.read(logical, 0, 16)).toThrow(/over the 1024-byte bound/);
  });
});

describe('the frame header parse itself, across the widths zstd actually emits', () => {
  // Every branch below is reachable with a REAL frame: the descriptor's
  // Frame_Content_Size width narrows with the payload, so a reader that only
  // ever saw the 4-byte form would break on small files. The 8-byte form needs
  // a >4 GB payload and is left to the code.
  const widths: { name: string; bytes: number; params: Record<number, number> }[] = [
    {
      name: '1-byte form (payload under 256 bytes)',
      bytes: 100,
      params: { [zlibConstants.ZSTD_c_contentSizeFlag]: 1 },
    },
    {
      name: '2-byte form, which is stored biased by 256',
      bytes: 1000,
      params: { [zlibConstants.ZSTD_c_contentSizeFlag]: 1 },
    },
    {
      name: '4-byte form',
      bytes: 70000,
      params: { [zlibConstants.ZSTD_c_contentSizeFlag]: 1 },
    },
  ];

  for (const { name, bytes, params } of widths) {
    it(`reads the declared length from the ${name}`, () => {
      const body = Buffer.alloc(bytes, 0x61);
      const frame = zstdCompressSync(body, {
        params: { [zlibConstants.ZSTD_c_compressionLevel]: 3, ...params },
      });
      expect(declaredContentSize(frame, 'fixture')).toBe(bytes);
    });
  }

  it('refuses a frame that declares nothing — the flag off also adds a Window_Descriptor', () => {
    const frame = zstdCompressSync(Buffer.alloc(1000, 0x61), {
      params: {
        [zlibConstants.ZSTD_c_compressionLevel]: 3,
        [zlibConstants.ZSTD_c_contentSizeFlag]: 0,
      },
    });
    expect(() => declaredContentSize(frame, 'fixture')).toThrow(/declares no content size/);
  });

  it('refuses a header truncated before its length field, and a non-frame', () => {
    const frame = zstdCompressSync(Buffer.alloc(70000, 0x61), {
      params: {
        [zlibConstants.ZSTD_c_compressionLevel]: 3,
        [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
      },
    });
    expect(() => declaredContentSize(frame.subarray(0, 6), 'fixture')).toThrow(
      /truncated zstd frame header/,
    );
    expect(() => declaredContentSize(Buffer.from('nope'), 'fixture')).toThrow(/not a zstd frame/);
    expect(() => declaredContentSize(Buffer.alloc(0), 'fixture')).toThrow(/not a zstd frame/);
  });
});

describe('AC3/AC4 — a truncated .zst is caught by the frame header (Test 10)', () => {
  const PARAMS = {
    [zlibConstants.ZSTD_c_compressionLevel]: 3,
    [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
  };

  it('100 bytes off a large frame throws, naming the declared and decompressed lengths', () => {
    const body = transcriptLines(20000);
    const logical = plantSealed(`${SLUG}/sess-1.jsonl`, body);
    const frameSize = readBytes(`${logical}.zst`).length;
    truncateSync(`${logical}.zst`, frameSize - 100);

    const reader = createArchiveReader();
    const len = Buffer.byteLength(body);
    expect(() => reader.read(logical, 0, 10)).toThrow(
      new RegExp(`declares ${len} bytes but \\d+ decompressed`),
    );

    // A second read throws again: the short buffer never entered the cache.
    expect(() => reader.read(logical, 0, 10)).toThrow(/truncated sealed archive/);
    expect(reader.stats().entries).toBe(0);
    expect(reader.stats().misses).toBe(2);
  });

  it('5 bytes off a small frame throws too, where a "did we get anything" check would not', () => {
    const body = transcriptLines(30);
    const logical = plantSealed(`${SLUG}/sess-2.jsonl`, body);
    const frameSize = readBytes(`${logical}.zst`).length;
    truncateSync(`${logical}.zst`, frameSize - 5);

    // The raw decompress returns ZERO bytes here, silently, so a naive
    // `length > 0` guard would have waved this straight through.
    expect(zstdDecompressSync(readBytes(`${logical}.zst`)).length).toBe(0);

    const reader = createArchiveReader();
    expect(() => reader.read(logical, 0, 10)).toThrow(
      new RegExp(`declares ${Buffer.byteLength(body)} bytes but 0 decompressed`),
    );
  });

  it('control — the codec itself returns SHORT without throwing, checksum flag or not', () => {
    // The design turns entirely on this: if `zstdDecompressSync` ever started
    // throwing here, the content-size check would be belt-and-braces instead of
    // the only read-side defence, and this control is what would tell us.
    const body = Buffer.from(transcriptLines(20000));
    for (const checksum of [false, true]) {
      const frame = zstdCompressSync(body, {
        params: checksum ? { ...PARAMS, [zlibConstants.ZSTD_c_checksumFlag]: 1 } : PARAMS,
      });
      const out = zstdDecompressSync(frame.subarray(0, frame.length - 100));
      expect(out.length, `checksum=${checksum}`).toBeLessThan(body.length);
      expect(out.length, `checksum=${checksum}`).toBeGreaterThan(0);
    }
  });

  it('a non-frame fails with our message rather than the codec one, raw probe still red', () => {
    const logical = `${sb().archiveRoot}/${SLUG}/sess-3.jsonl`;
    writeArchive(sb(), `${SLUG}/sess-3.jsonl.zst`, Buffer.from('pretend-zstd-bytes'));

    const reader = createArchiveReader();
    expect(() => reader.read(logical, 0, 10)).toThrow(/not a zstd frame/);

    // Control: the underlying behaviour stays pinned independently of our message.
    expect(codeOf(() => zstdDecompressSync(Buffer.from('pretend-zstd-bytes')))).toBe(
      'ZSTD_error_prefix_unknown',
    );
  });
});
