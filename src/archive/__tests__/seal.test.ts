// Sealing: the trigger (AC1), the ratio (AC2), the crash window, the log line,
// and the forward-contract reword that landed with them. Everything is
// synthesized in temp dirs except the opt-in corpus test, which copies before it
// compresses and never touches a real transcript.

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { archiveOnce } from '../mirror.js';
import { sealArchiveFile } from '../seal.js';
import { canonicalizeTranscriptPath, resolveTranscriptRoot } from '../paths.js';
import {
  archivePath,
  cleanup,
  jsonLines,
  makeSandbox,
  readBytes,
  SLUG,
  snapshotTree,
  sourcePath,
  transcriptLines,
  writeArchive,
  writeSource,
  type Sandbox,
} from './fixtures.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ARCHIVE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const SESSION = `${SLUG}/sess-1.jsonl`;
const OTHER = `${SLUG}/sess-2.jsonl`;

/** RFC 002's "6.15 MB" reference transcript, identified by its exact length. */
const REFERENCE_BYTES = 6_148_090;

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

function pass() {
  const s = sb();
  return archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('AC1 — a file whose source is gone is sealed on the next pass (Test 1)', () => {
  it('writes <name>.zst, removes the hot file, and stamps the seal', () => {
    const s = sb();
    const body = jsonLines(40);
    writeSource(s, SESSION, body);
    pass();

    const logical = archivePath(s, SESSION);
    const hotBytes = readBytes(logical);
    rmSync(sourcePath(s, SESSION));

    const result = pass();
    const file = result.files[0]!;

    expect(existsSync(`${logical}.zst`)).toBe(true);
    expect(existsSync(logical)).toBe(false);
    expect(file.archive_state).toBe('sealed');
    expect(file.source_state).toBe('expired');

    // The size field means the same thing on every pass: compressed on disk,
    // never the pre-seal hot size it would otherwise report on exactly one pass.
    expect(file.archive_size).toBe(statSync(`${logical}.zst`).size);
    expect(file.archive_size).not.toBe(hotBytes.length);

    // The hash is over the PRE-seal bytes — the input the round-trip compared to.
    expect(file.archive_sha256).toBe(sha256(hotBytes));
    expect(new Date(file.sealed_at!).toISOString()).toBe(file.sealed_at);
    expect(result.sealed).toEqual([logical]);
  });

  it('leaves no temp file behind, and the frame decompresses to the original bytes', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(40));
    pass();
    const logical = archivePath(s, SESSION);
    const hotBytes = readBytes(logical);

    rmSync(sourcePath(s, SESSION));
    pass();

    expect(readdirSync(join(s.archiveRoot, SLUG))).toEqual(['sess-1.jsonl.zst']);
    expect(zstdDecompressSync(readBytes(`${logical}.zst`)).equals(hotBytes)).toBe(true);
  });

  it('returns hot_size and sealed_size from the same seal, at the unit level', () => {
    const s = sb();
    const body = transcriptLines(400);
    const logical = writeArchive(s, SESSION, body);

    const sealed = sealArchiveFile(logical, canonicalizeTranscriptPath(s.archiveRoot));

    expect(sealed.hot_size).toBe(body.length);
    expect(sealed.sealed_size).toBe(statSync(`${logical}.zst`).size);
    expect(sealed.sealed_size).toBeLessThan(sealed.hot_size);
    expect(sealed.archive_sha256).toBe(sha256(Buffer.from(body)));
  });
});

describe('AC1 — a live source is never sealed, at any apparent age (Test 2)', () => {
  it('stays hot across five passes with the source back-dated 90 days', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(20));
    pass();

    const logical = archivePath(s, SESSION);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(sourcePath(s, SESSION), ninetyDaysAgo, ninetyDaysAgo);

    for (let i = 0; i < 5; i++) {
      const result = pass();
      const label = `pass ${i + 1}`;
      expect(result.files[0]!.archive_state, label).toBe('hot');
      expect(result.files[0]!.source_state, label).toBe('present');
      expect(result.sealed, label).toEqual([]);
      expect(existsSync(`${logical}.zst`), label).toBe(false);
      expect(existsSync(logical), label).toBe(true);
    }
  });
});

describe('AC2 — zstd through node:zlib, with the level pinned (Test 5)', () => {
  it('adds no package, and seal.ts imports nothing but node: builtins and siblings', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@hono/node-server', 'hono']);

    const source = readFileSync(join(ARCHIVE_SRC, 'seal.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith('node:') || specifier.startsWith('./'), specifier).toBe(true);
    }
    expect(specifiers).toContain('node:zlib');
  });

  it('compresses synthesized JSONL at least 3.5x, hermetically', () => {
    const s = sb();
    const body = transcriptLines(4000);
    const logical = writeArchive(s, SESSION, body);

    const sealed = sealArchiveFile(logical, canonicalizeTranscriptPath(s.archiveRoot));
    const ratio = sealed.hot_size / sealed.sealed_size;

    expect(ratio).toBeGreaterThanOrEqual(3.5);
    expect(zstdDecompressSync(readBytes(`${logical}.zst`)).equals(Buffer.from(body))).toBe(true);
  });

  it('pins the level through params: the default level would compress differently', () => {
    // The guard behind the ratio. `{ level: N }` is silently ignored at runtime
    // (and rejected by @types/node), so `params` is the only form that pins
    // anything — and a dropped pin would leave the ratio at ZSTD_CLEVEL_DEFAULT,
    // a Node default that can move.
    const body = Buffer.from(transcriptLines(4000));
    const pinned = zstdCompressSync(body, {
      params: {
        [zlibConstants.ZSTD_c_compressionLevel]: 3,
        [zlibConstants.ZSTD_c_checksumFlag]: 1,
        [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
      },
    });
    const atNineteen = zstdCompressSync(body, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 },
    });
    expect(atNineteen.length).toBeLessThan(pinned.length);

    const s = sb();
    const logical = writeArchive(s, SESSION, body);
    const sealed = sealArchiveFile(logical, canonicalizeTranscriptPath(s.archiveRoot));
    expect(sealed.sealed_size).toBe(pinned.length);
  });

  const realCorpus = process.env.AGENT_LENS_REAL_CORPUS === '1' ? it : it.skip;

  realCorpus(
    'aggregates >= 3.5x over every real .jsonl, round-trip byte-identical on each',
    () => {
      const sourceRoot = canonicalizeTranscriptPath(resolveTranscriptRoot());
      const work = mkdtempSync(join(tmpdir(), 'agent-lens-seal-ratio-'));
      try {
        const transcripts = readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => join(sourceRoot, name))
          .filter((path) => statSync(path).isFile());
        expect(transcripts.length).toBeGreaterThan(0);

        let rawTotal = 0;
        let sealedTotal = 0;
        let reference: { raw: number; sealed: number } | undefined;

        for (const [index, path] of transcripts.entries()) {
          // Copy first: sealing removes what it compressed, and a transcript is
          // never ours to remove.
          const bytes = readFileSync(path);
          if (bytes.length === 0) continue;
          const copy = join(work, `t-${index}.jsonl`);
          writeFileSync(copy, bytes);

          const sealed = sealArchiveFile(copy, canonicalizeTranscriptPath(work));
          expect(sealed.hot_size, path).toBe(bytes.length);
          expect(zstdDecompressSync(readFileSync(`${copy}.zst`)).equals(bytes), path).toBe(true);

          rawTotal += sealed.hot_size;
          sealedTotal += sealed.sealed_size;
          if (sealed.hot_size === REFERENCE_BYTES) {
            reference = { raw: sealed.hot_size, sealed: sealed.sealed_size };
          }
          rmSync(`${copy}.zst`);
        }

        // The criterion's evidence: an aggregate over the whole transcript
        // class, not one cherry-picked file. Measured 3.99x when this was
        // written; the bar sits below that with room for corpus drift and far
        // above the 3.03x gzip baseline.
        expect(rawTotal / sealedTotal).toBeGreaterThanOrEqual(3.5);

        // The named regression pin, and deliberately NOT the largest file — the
        // largest is the WORST in this corpus at ~2.76x. This is the specific
        // 6,148,090-byte transcript RFC 002 measured at 4.620x, kept because it
        // reds immediately if the compression level stops being passed through
        // `params`. It is a flag guard, never the criterion's evidence.
        if (reference !== undefined) {
          expect(reference.raw / reference.sealed).toBeGreaterThanOrEqual(4.5);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    600000,
  );
});

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

describe('the checksum catches corruption that the content-size check cannot (Test 11)', () => {
  it('a sealed file reds on a flipped byte at unchanged length', () => {
    const s = sb();
    const body = transcriptLines(200);
    const logical = writeArchive(s, SESSION, body);
    sealArchiveFile(logical, canonicalizeTranscriptPath(s.archiveRoot));

    const frame = readBytes(`${logical}.zst`);
    const at = Math.floor(frame.length / 2);
    frame[at] = frame[at]! ^ 0xff;

    // The length is intact, so the frame content-size check would wave this
    // through; the checksum a real seal writes is what stops it.
    expect(codeOf(() => zstdDecompressSync(frame))).toBe('ZSTD_error_checksum_wrong');
  });

  it('the SAME flip: silently wrong bytes without the flag, ZSTD_error_checksum_wrong with it', () => {
    // The negative control, and the only thing that justifies 4 bytes a file.
    const body = Buffer.from(transcriptLines(200));
    const params = {
      [zlibConstants.ZSTD_c_compressionLevel]: 3,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
    };
    const bare = zstdCompressSync(body, { params });
    const guarded = zstdCompressSync(body, {
      params: { ...params, [zlibConstants.ZSTD_c_checksumFlag]: 1 },
    });
    // Only the frame-header descriptor byte and the 4-byte tail differ, so an
    // offset into one frame is the same compressed byte in the other.
    expect(guarded.length).toBe(bare.length + 4);

    // Many flips zstd catches structurally whatever the flag. Find one it does
    // NOT — that is precisely the class the checksum exists for.
    let at = -1;
    for (let i = 6; i < bare.length - 4 && at === -1; i++) {
      const probe = Buffer.from(bare);
      probe[i] = probe[i]! ^ 0xff;
      try {
        const out = zstdDecompressSync(probe);
        if (out.length === body.length && !out.equals(body)) at = i;
      } catch {
        // structurally detected; not the class under test
      }
    }
    expect(at, 'no silently-corrupting single-byte flip exists to control against').toBeGreaterThan(
      -1,
    );

    const bareFlip = Buffer.from(bare);
    bareFlip[at] = bareFlip[at]! ^ 0xff;
    const out = zstdDecompressSync(bareFlip);
    expect(out.length).toBe(body.length);
    expect(out.equals(body)).toBe(false);

    const guardedFlip = Buffer.from(guarded);
    guardedFlip[at] = guardedFlip[at]! ^ 0xff;
    expect(codeOf(() => zstdDecompressSync(guardedFlip))).toBe('ZSTD_error_checksum_wrong');
  });

  it('raw garbage throws ZSTD_error_prefix_unknown', () => {
    // The message is Node's and can move; the code is the stable identifier.
    expect(codeOf(() => zstdDecompressSync(Buffer.from('pretend-zstd-bytes')))).toBe(
      'ZSTD_error_prefix_unknown',
    );
  });
});

describe('the crash window between rename and unlink is a safe no-op (Test 12)', () => {
  it('leaves both files untouched, sealing nothing and deleting nothing', () => {
    const s = sb();
    const body = jsonLines(20);
    // Both halves present, no source: exactly the state a crash after renameSync
    // and before unlinkSync leaves behind.
    writeArchive(s, SESSION, body);
    writeArchive(
      s,
      `${SESSION}.zst`,
      zstdCompressSync(Buffer.from(body), {
        params: {
          [zlibConstants.ZSTD_c_compressionLevel]: 3,
          [zlibConstants.ZSTD_c_checksumFlag]: 1,
          [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
        },
      }),
    );

    const before = snapshotTree(s.archiveRoot);
    const result = pass();

    // discover's sticky `sealed` keys ONE entry for the pair...
    expect(result.filesSeen).toBe(1);
    expect(result.files[0]!.source_state).toBe('expired');
    expect(result.files[0]!.archive_state).toBe('sealed');
    // ...and shouldSeal returns false on `alreadySealed`, so this returns at the
    // missing-source branch rather than at the mirror's sealed guard, which is
    // unreachable when there is no source to open.
    expect(result.sealed).toEqual([]);
    expect(result.files[0]!.sealed_at).toBeUndefined();
    expect(result.files[0]!.archive_sha256).toBeUndefined();

    // Nothing written, and above all nothing deleted.
    expect(snapshotTree(s.archiveRoot)).toEqual(before);
    expect(existsSync(archivePath(s, SESSION))).toBe(true);
    expect(existsSync(`${archivePath(s, SESSION)}.zst`)).toBe(true);
  });
});

describe('a seal-only pass is logged, not swallowed as quiet (Test 13)', () => {
  it('logs a pass whose only work was sealing, and names the sealed path', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(20));
    writeSource(s, OTHER, jsonLines(20, 500));
    const first = pass();
    expect(first.logged).toBe(true);

    const logLines = () =>
      readFileSync(join(s.dataDir, 'logs', 'archive.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean);
    const beforeSeal = logLines().length;

    // The source is gone before the walk, so this pass finds it archive-only:
    // `newly_expired` stays empty and `sealed` is the ONLY non-quiet term. Every
    // one of the five original `isQuiet` conditions is satisfied here.
    rmSync(sourcePath(s, SESSION));
    const sealOnly = pass();

    expect(sealOnly.bytesCopied).toBe(0);
    expect(sealOnly.errors).toEqual([]);
    expect(sealOnly.sealed).toEqual([archivePath(s, SESSION)]);
    expect(sealOnly.logged).toBe(true);

    const lines = logLines();
    expect(lines).toHaveLength(beforeSeal + 1);
    const record = JSON.parse(lines.at(-1)!) as {
      sealed: string[];
      bytes_copied: number;
      newly_expired: string[];
      diverged: unknown[];
      errors: unknown[];
      lock: { state: string };
    };
    expect(record.sealed).toEqual([archivePath(s, SESSION)]);
    // Every other term quiet, so the sixth is demonstrably what carried the line.
    expect(record.bytes_copied).toBe(0);
    expect(record.newly_expired).toEqual([]);
    expect(record.diverged).toEqual([]);
    expect(record.errors).toEqual([]);
    expect(record.lock.state).toBe('acquired');
  });

  it('control — an unchanged corpus is still quiet, so the sixth term is not always-on', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    expect(pass().logged).toBe(true);

    const second = pass();
    expect(second.sealed).toEqual([]);
    expect(second.logged).toBe(false);
  });
});

describe('the forward-contract reword says less, not more (Test 15)', () => {
  it('no file under src/ still defers the stored hash to this very task', () => {
    // Assembled rather than written out, so this scan can cover test files too
    // without matching itself.
    const stale = ['until', 'task', '1.2'].join(' ');

    const offenders = readdirSync(join(REPO_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => readFileSync(join(REPO_ROOT, 'src', name), 'utf8').includes(stale));

    expect(offenders).toEqual([]);
  });

  it('still says a stored hash does not exist, and claims no seal-time check', () => {
    // The reword drops a date, never the claim. Naming the round-trip verify
    // here would be the tempting "improvement" that makes the doctor lie: that
    // check runs once, against bytes then deleted, and is nothing doctor can
    // re-check later.
    const report = readFileSync(join(ARCHIVE_SRC, 'report.ts'), 'utf8');
    const doctor = readFileSync(join(REPO_ROOT, 'src', 'cli', 'commands', 'doctor.ts'), 'utf8');

    expect(report).toContain("'no live source — no stored hash exists'");
    expect(report).toContain("'sealed — no integrity check available (no stored hash exists)'");
    expect(doctor).toContain('No stored hash exists for these, so there is nothing to');

    for (const source of [report, doctor]) {
      expect(source).not.toMatch(/seal[- ]time|checked at seal|verified at seal/i);
    }
  });
});
