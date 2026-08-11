// The doctor report builder. Every case is synthesized in a temp dir, and every
// case passes an explicit `settingsPath` inside that sandbox — nothing here may
// resolve the developer's real `~/.claude/settings.json`.

import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import {
  buildDoctorReport,
  NO_LIVE_SOURCE_REASON,
  resolveClaudeSettingsPath,
  SEALED_LEGACY_REASON,
  SEALED_UNCHECKED_REASON,
} from '../report.js';
import { formatDoctorReport } from '../../cli/commands/doctor.js';
import {
  archivePath,
  cleanup,
  compressLikeSeal,
  decoyPath,
  jsonLines,
  makeSandbox,
  patchSidecar,
  plantArchiveSymlink,
  plantCrashWindow,
  settingsPath,
  sha256Hex,
  SLUG,
  snapshotTree,
  sourcePath,
  transcriptLines,
  writeArchive,
  writeSettings,
  writeSidecar,
  writeSource,
  type Sandbox,
} from './fixtures.js';
import { archiveOnce } from '../mirror.js';
import { sidecarPath } from '../sidecar.js';

const SESSION = `${SLUG}/sess-1.jsonl`;
const OTHER = `${SLUG}/sess-2.jsonl`;
const THIRD = `${SLUG}/sess-3.jsonl`;
const VICTIM = `${SLUG}/victim.jsonl`;
const TOOL_TXT = `${SLUG}/sess-1/tool-results/big.txt`;

/** Exactly 16 bytes — the number the pre-fix report attributed to the archive. */
const VICTIM_BYTES = 'sixteen bytes!!\n';

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

/** Always sandboxed: `settingsPath` never points at the real user file. */
function report(extra: { verify?: boolean; settingsPath?: string } = {}) {
  const s = sb();
  return buildDoctorReport({
    dataDir: s.dataDir,
    transcriptRoot: s.sourceRoot,
    settingsPath: extra.settingsPath ?? settingsPath(s),
    verify: extra.verify,
  });
}

function archivePass(extra: { verify?: boolean } = {}) {
  const s = sb();
  return archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot, ...extra });
}

/** Rewrites one byte of the ARCHIVED copy, leaving the source untouched. */
function corruptArchivedByte(s: Sandbox, rel: string, offset: number): void {
  const path = archivePath(s, rel);
  const bytes = readFileSync(path);
  bytes[offset] = bytes[offset]! ^ 0xff;
  writeFileSync(path, bytes);
}

describe('AC1a — integrity recomputes over every archived file with a live source', () => {
  it('detects and names a deliberately corrupted archived byte', () => {
    const s = sb();
    // 10 KB, so the corruption can sit in the blind band between head and seam.
    writeSource(s, TOOL_TXT, Buffer.alloc(10240, 0x61));
    archivePass();
    corruptArchivedByte(s, TOOL_TXT, 5000);

    const built = report({ verify: true });

    expect(built.integrity.diverged.map((f) => f.relPath)).toEqual([TOOL_TXT]);
    expect(built.integrity.diverged[0]!.reason).toBe('verify');
    expect(built.integrity.verified).toEqual([]);
    expect(formatDoctorReport(built)).toContain(archivePath(s, TOOL_TXT));
  });

  it('reports an intact mirror as verified, with nothing diverged', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(20));
    archivePass();

    const built = report({ verify: true });

    expect(built.integrity.verified).toEqual([SESSION]);
    expect(built.integrity.diverged).toEqual([]);
    expect(built.integrity.unverifiable).toEqual([]);
  });

  it('a corrupted byte inside the blind band is invisible without --verify', () => {
    // Pins the honest limit of the default pass: head+seam is a sample, and the
    // report must not imply it is more than that.
    const s = sb();
    writeSource(s, TOOL_TXT, Buffer.alloc(10240, 0x61));
    archivePass();
    corruptArchivedByte(s, TOOL_TXT, 4150);

    expect(report().integrity.diverged).toEqual([]);
    expect(report({ verify: true }).integrity.diverged.map((f) => f.relPath)).toEqual([TOOL_TXT]);
  });

  it('--verify is OFF the default path: a plain build does not read the whole file', () => {
    const s = sb();
    const body = Buffer.alloc(2 * 1024 * 1024, 0x61);
    writeSource(s, TOOL_TXT, body);
    archivePass();

    expect(report().integrity.bytesRead).toBeLessThan(64 * 1024);
    expect(report({ verify: true }).integrity.bytesRead).toBeGreaterThanOrEqual(body.length);
  });
});

/** A real seal, so the `.zst` on disk carries the sidecar this build publishes. */
function sealForReal(rel: string, body: string = jsonLines(40)): string {
  const s = sb();
  writeSource(s, rel, body);
  archivePass();
  rmSync(sourcePath(s, rel));
  archivePass();
  return `${archivePath(s, rel)}.zst`;
}

describe('AC3/AC5 — the sidecar is outside the accounting, and the wording stays true', () => {
  it('counts the frame alone, while an ordinary archived file beside it is still counted', () => {
    const s = sb();
    const sealedPath = sealForReal(SESSION);
    expect(existsSync(sidecarPath(sealedPath))).toBe(true);

    const one = report();
    expect(one.bytes.sealedFiles).toBe(1);
    expect(one.bytes.hotFiles).toBe(0);
    expect(one.integrity.archivedFileCount).toBe(1);
    // The sidecar's own bytes are absent from every total.
    expect(one.bytes.totalBytes).toBe(statSync(sealedPath).size);
    expect(one.bytes.totalBytes).toBeLessThan(
      statSync(sealedPath).size + statSync(sidecarPath(sealedPath)).size,
    );

    // Positive control: a second archived file in the SAME directory is seen and
    // counted, so the exclusion above is the suffix rule and not a broken walk.
    const other = writeArchive(s, OTHER, jsonLines(4, 200));
    const two = report();
    expect(two.integrity.archivedFileCount).toBe(2);
    expect(two.bytes.totalBytes).toBe(statSync(sealedPath).size + statSync(other).size);
  });

  it('one report holds a row of each sealed reason, and the two say different things', () => {
    const s = sb();
    // Sealed by this build, so a stored hash exists on disk for it…
    const sealedPath = sealForReal(SESSION);
    // …and a `.zst` from before sidecars existed, which never gets a backfill.
    writeArchive(s, `${OTHER}.zst`, Buffer.from('pretend-zstd-bytes'));
    expect(existsSync(sidecarPath(sealedPath))).toBe(true);
    expect(existsSync(sidecarPath(`${archivePath(s, OTHER)}.zst`))).toBe(false);

    const built = report();
    const text = formatDoctorReport(built);

    // The successor to the single string that had to be true of both. Each row
    // now says which case it is in, and neither claims a check happened.
    expect(new Map(built.integrity.unverifiable.map((f) => [f.relPath, f.reason]))).toEqual(
      new Map([
        [SESSION, SEALED_UNCHECKED_REASON],
        [OTHER, SEALED_LEGACY_REASON],
      ]),
    );
    expect(built.integrity.verified).toEqual([]);
    expect(built.integrity.diverged).toEqual([]);
    expect(built.integrity.archivedFileCount).toBe(2);
    // The default path read no content bytes for either.
    expect(built.integrity.bytesRead).toBe(0);
    expect(text).toContain('2 files archived = 0 verified + 0 diverged + 2 unverifiable');
    expect(text).not.toMatch(/seal[- ]time|checked at seal|verified at seal/i);
  });

  it('under --verify the same pair splits: the one with a record is verified, the legacy one is not', () => {
    const s = sb();
    const body = jsonLines(40);
    sealForReal(SESSION, body);
    writeArchive(s, `${OTHER}.zst`, Buffer.from('pretend-zstd-bytes'));

    const built = report({ verify: true });

    expect(built.integrity.verified).toEqual([SESSION]);
    expect(built.integrity.unverifiable.map((f) => f.reason)).toEqual([SEALED_LEGACY_REASON]);
    expect(built.integrity.diverged).toEqual([]);
    // The decompressed seal, and nothing at all for the legacy `.zst` — which is
    // the byte-level statement that rung 1 stopped before the decompressor.
    expect(built.integrity.bytesRead).toBe(body.length);
  });
});

describe('AC1b/AC1c — the unverifiable population is counted, named and never called verified', () => {
  it('counts and names both an archive-only file and a sealed one, and the three populations partition', () => {
    const s = sb();
    // An expired file the archive is now the only copy of…
    writeArchive(s, OTHER, jsonLines(4, 200));
    // …and a sealed sibling, keyed under its logical name.
    writeArchive(s, `${SESSION}.zst`, Buffer.from('pretend-zstd-bytes'));

    const built = report({ verify: true });
    const text = formatDoctorReport(built);

    expect(built.integrity.unverifiable).toHaveLength(2);
    expect(built.integrity.verified).toEqual([]);
    expect(built.integrity.archivedFileCount).toBe(2);
    expect(
      built.integrity.verified.length +
        built.integrity.diverged.length +
        built.integrity.unverifiable.length,
    ).toBe(built.integrity.archivedFileCount);

    const byPath = new Map(built.integrity.unverifiable.map((f) => [f.relPath, f.reason]));
    expect(byPath.get(OTHER)).toBe(NO_LIVE_SOURCE_REASON);
    expect(byPath.get(SESSION)).toBe(SEALED_LEGACY_REASON);

    // Named in the rendered text, not merely counted.
    expect(text).toContain(archivePath(s, OTHER));
    expect(text).toContain(`${archivePath(s, SESSION)}.zst`);
    expect(text).toContain('unverifiable (2)');
    expect(text).toContain('2 files archived = 0 verified + 0 diverged + 2 unverifiable');
  });

  it('states the legacy sealed reason verbatim and claims no seal-time check', () => {
    const s = sb();
    writeArchive(s, `${SESSION}.zst`, Buffer.from('pretend-zstd-bytes'));

    const built = report();
    const text = formatDoctorReport(built);

    expect(built.integrity.unverifiable[0]!.reason).toBe(
      'sealed — no stored hash on disk: sealed before sidecars existed, and there is nothing honest to backfill',
    );
    expect(text).toContain(SEALED_LEGACY_REASON);
    // This file has no record at all, so the report may not imply anything was
    // compared. The alternatives below stay forbidden whatever the population:
    // a seal's round-trip check ran once, against bytes since deleted, and is
    // nothing this command can re-check.
    expect(text).not.toMatch(/seal[- ]time|checked at seal|verified at seal/i);
  });

  it('a sealed file whose source is alive is still unverifiable, not verified', () => {
    // The compressed bytes on disk are no comparison for the live source.
    const s = sb();
    writeArchive(s, `${SESSION}.zst`, Buffer.from('pretend-zstd-bytes'));
    writeSource(s, SESSION, jsonLines(4));

    const built = report({ verify: true });

    expect(built.integrity.verified).toEqual([]);
    expect(built.integrity.unverifiable.map((f) => f.reason)).toEqual([SEALED_LEGACY_REASON]);
  });

  it('an unreadable source is unverifiable, not a crash and not verified', () => {
    // A report that dies on one bad file is worse than useless, and counting it
    // as verified would be the exact lie AC1c exists to prevent.
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));
    writeSource(s, OTHER, jsonLines(6, 200));
    archivePass();
    chmodSync(sourcePath(s, SESSION), 0o000);

    try {
      // Positive control: otherwise a chmod that protected nothing would make
      // the assertions below pass vacuously.
      expect(() => readFileSync(sourcePath(s, SESSION))).toThrow(/EACCES|EPERM/);

      const { integrity } = report({ verify: true });

      expect(integrity.verified).toEqual([OTHER]);
      expect(integrity.unverifiable.map((f) => f.relPath)).toEqual([SESSION]);
      expect(integrity.unverifiable[0]!.reason).toMatch(/^unreadable — /);
      expect(integrity.archivedFileCount).toBe(2);
    } finally {
      chmodSync(sourcePath(s, SESSION), 0o600);
    }
  });

  it('the partition holds across a mixed corpus of all four kinds', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));
    writeSource(s, THIRD, jsonLines(6, 300));
    archivePass();
    // Now manufacture a diverged file, an archive-only one and a sealed one.
    writeFileSync(sourcePath(s, THIRD), jsonLines(1, 300));
    writeArchive(s, OTHER, jsonLines(4, 200));
    writeArchive(s, `${TOOL_TXT}.zst`, Buffer.from('pretend-zstd-bytes'));

    const { integrity } = report({ verify: true });

    expect(integrity.archivedFileCount).toBe(4);
    expect(integrity.verified).toEqual([SESSION]);
    expect(integrity.diverged.map((f) => f.relPath)).toEqual([THIRD]);
    expect(integrity.unverifiable.map((f) => f.relPath).sort()).toEqual([OTHER, TOOL_TXT].sort());
  });
});

describe('AC1/AC2 — a sealed file is checked against the hash the seal recorded', () => {
  it('verifies a real seal against its own record', () => {
    sealForReal(SESSION);

    const built = report({ verify: true });

    expect(built.integrity.verified).toEqual([SESSION]);
    expect(built.integrity.diverged).toEqual([]);
    expect(built.integrity.unverifiable).toEqual([]);
  });

  it('defers only the hash on the default path, and names what it deferred', () => {
    sealForReal(SESSION);

    const built = report();

    expect(built.integrity.verified).toEqual([]);
    expect(built.integrity.unverifiable.map((f) => f.reason)).toEqual([SEALED_UNCHECKED_REASON]);
    expect(built.integrity.bytesRead).toBe(0);
    expect(formatDoctorReport(built)).toContain('pass --verify to re-hash the archived bytes');
  });

  it('an unreadable frame is unverifiable, never diverged', () => {
    const sealedPath = sealForReal(SESSION);
    chmodSync(sealedPath, 0o000);

    try {
      // Positive control: otherwise a chmod that protected nothing would make
      // the assertions below pass vacuously.
      expect(() => readFileSync(sealedPath)).toThrow(/EACCES|EPERM/);

      const { integrity } = report({ verify: true });

      // An I/O failure says nothing about the contents, so it may not be called
      // a divergence — that is the whole point of classifying by exclusion.
      expect(integrity.diverged).toEqual([]);
      expect(integrity.verified).toEqual([]);
      expect(integrity.unverifiable.map((f) => f.relPath)).toEqual([SESSION]);
      expect(integrity.unverifiable[0]!.reason).toMatch(/^unreadable — /);
    } finally {
      chmodSync(sealedPath, 0o600);
    }
  });

  it('a record naming a different file diverges: sealed-attribution', () => {
    sealForReal(SESSION);
    patchSidecar(sb(), SESSION, { file: 'sess-9.jsonl' });

    const { integrity } = report({ verify: true });

    expect(integrity.diverged.map((f) => [f.relPath, f.reason])).toEqual([
      [SESSION, 'sealed-attribution'],
    ]);
    expect(integrity.bytesRead).toBe(0);
  });

  it('attribution compares the LOGICAL basename, so the on-disk name is a mismatch', () => {
    sealForReal(SESSION);
    // `sess-1.jsonl.zst` — the name the frame occupies, one suffix away from the
    // name a seal actually records. Comparing against the wrong one would make
    // every real seal in the tree look misattributed.
    patchSidecar(sb(), SESSION, { file: 'sess-1.jsonl.zst' });

    expect(report({ verify: true }).integrity.diverged[0]!.reason).toBe('sealed-attribution');
  });

  it('a sealed_size disagreeing with the file on disk diverges on the DEFAULT path, reading nothing', () => {
    sealForReal(SESSION);
    patchSidecar(sb(), SESSION, { sealed_size: 999_999 });

    const { integrity } = report();

    expect(integrity.diverged.map((f) => [f.relPath, f.reason])).toEqual([
      [SESSION, 'sealed-size'],
    ]);
    expect(integrity.unverifiable).toEqual([]);
    // The O(1) limbs really are free: a divergence was found without --verify
    // and without reading a content byte.
    expect(integrity.bytesRead).toBe(0);
  });

  it('a plain truncation stops at sealed-size, before the decompressor', () => {
    // The realistic truncation, with the record left alone. Truncating a `.zst`
    // changes its size on disk, so rung 3 fires and the frame limb is never
    // reached — which is why the next test has to defeat rung 3 deliberately.
    const sealedPath = sealForReal(SESSION);
    truncateSync(sealedPath, statSync(sealedPath).size - 20);

    const { integrity } = report({ verify: true });

    expect(integrity.diverged.map((f) => [f.relPath, f.reason])).toEqual([
      [SESSION, 'sealed-size'],
    ]);
    expect(integrity.bytesRead).toBe(0);
  });

  it('a truncation whose sealed_size was rewritten reaches sealed-frame, and the counter moved', () => {
    // Deliberately NOT the fixture above. On a small seal the truncated frame
    // decompresses to nothing at all, so `bytesRead` is 0 whether the counter is
    // placed before the comparisons or after them, and the placement would ship
    // untested. Past ~1 MB the two orders give different answers.
    const sealedPath = sealForReal(SESSION, jsonLines(40_000));
    truncateSync(sealedPath, statSync(sealedPath).size - 100);
    patchSidecar(sb(), SESSION, { sealed_size: statSync(sealedPath).size });

    const { integrity } = report({ verify: true });

    expect(integrity.diverged.map((f) => [f.relPath, f.reason])).toEqual([
      [SESSION, 'sealed-frame'],
    ]);
    // Every byte the decompressor produced is counted whatever the verdict.
    // Counting only on the verified branch reports 0 here.
    expect(integrity.bytesRead).toBeGreaterThan(0);
  });

  it('a byte flip the codec refuses outright is a divergence, not a crash', () => {
    const sealedPath = sealForReal(SESSION);
    const frame = readFileSync(sealedPath);
    const originalSize = frame.length;

    // Search for the flip rather than guessing one: which offsets the codec
    // refuses is a property of zstd, not of this repo, and the repo already uses
    // this idiom where that matters.
    let at = -1;
    for (let i = 6; i < frame.length - 4 && at === -1; i++) {
      const probe = Buffer.from(frame);
      probe[i] = probe[i]! ^ 0xff;
      try {
        zstdDecompressSync(probe);
      } catch {
        at = i;
      }
    }
    expect(at, 'no single-byte flip makes this frame undecodable').toBeGreaterThan(-1);

    frame[at] = frame[at]! ^ 0xff;
    writeFileSync(sealedPath, frame);
    // The length is untouched, so rung 3 passes and the ladder must reach the
    // frame itself rather than short-circuiting on the size.
    expect(statSync(sealedPath).size).toBe(originalSize);

    const { integrity } = report({ verify: true });

    expect(integrity.diverged.map((f) => [f.relPath, f.reason])).toEqual([
      [SESSION, 'sealed-frame'],
    ]);
    expect(integrity.verified).toEqual([]);
    // It threw before producing anything, so nothing was counted.
    expect(integrity.bytesRead).toBe(0);
  });

  it('catches what only a stored hash can: a valid frame of the same length holding other content', () => {
    const s = sb();
    const bodyA = jsonLines(40);
    const frameA = compressLikeSeal(bodyA);

    // Search for a witness rather than assuming one: substituting a character
    // usually moves the compressed length by a byte, and then rung 3 would fire
    // first and the hash limb would never run.
    let bodyB = '';
    for (let i = 0; i < bodyA.length && bodyB === ''; i++) {
      const candidate = `${bodyA.slice(0, i)}${bodyA[i] === 'z' ? 'y' : 'z'}${bodyA.slice(i + 1)}`;
      if (compressLikeSeal(candidate).length === frameA.length) bodyB = candidate;
    }
    expect(bodyB, 'no equal-length one-character witness exists').not.toBe('');

    const frameB = compressLikeSeal(bodyB);
    // Controls: B's frame is perfectly valid, correctly checksummed, and exactly
    // as long as A's. Every structural check in the system passes on it.
    expect(zstdDecompressSync(frameB).toString()).toBe(bodyB);
    expect(frameB.length).toBe(frameA.length);

    writeArchive(s, `${SESSION}.zst`, frameB);
    writeSidecar(s, SESSION, {
      file: 'sess-1.jsonl',
      sha256: sha256Hex(bodyA),
      hot_size: bodyA.length,
      sealed_size: frameA.length,
    });

    const { integrity } = report({ verify: true });

    expect(integrity.diverged.map((f) => [f.relPath, f.reason])).toEqual([
      [SESSION, 'sealed-hash'],
    ]);
    expect(integrity.verified).toEqual([]);
    expect(integrity.bytesRead).toBe(bodyB.length);
  });

  it('renders every sealed reason it can produce, verbatim, beside the path', () => {
    // The four strings are user-facing: `doctor` prints `${reason}  ${path}`.
    const s = sb();
    sealForReal(SESSION);
    patchSidecar(s, SESSION, { sealed_size: 999_999 });

    const built = report();
    const text = formatDoctorReport(built);

    expect(text).toContain(`sealed-size  ${archivePath(s, SESSION)}.zst`);
    expect(text).toContain('compared against the hash the seal recorded');
    // The live-source paragraph survives: it is still the honest reading for a
    // diverged file that HAS a source.
    expect(text).toContain('source was rewritten, or the archived bytes were corrupted');
    expect(text).not.toMatch(/seal[- ]time|checked at seal|verified at seal/i);
  });
});

describe('AC3 — a sealed file with no usable record is refused before anything is read', () => {
  it('never reaches the decompressor, even under --verify', () => {
    const s = sb();
    // Not a zstd frame at all: were rung 1 skipped this would throw `not a zstd
    // frame` and be classified as diverged instead.
    writeArchive(s, `${SESSION}.zst`, Buffer.from('pretend-zstd-bytes'));

    const { integrity } = report({ verify: true });

    expect(integrity.unverifiable.map((f) => f.reason)).toEqual([SEALED_LEGACY_REASON]);
    expect(integrity.diverged).toEqual([]);
    expect(integrity.bytesRead).toBe(0);
  });

  it('writes nothing while checking one — there is no backfill', () => {
    const s = sb();
    writeArchive(s, `${SESSION}.zst`, Buffer.from('pretend-zstd-bytes'));
    const before = snapshotTree(s.archiveRoot);

    report({ verify: true });

    expect(snapshotTree(s.archiveRoot)).toEqual(before);
    expect(existsSync(sidecarPath(`${archivePath(s, SESSION)}.zst`))).toBe(false);
  });

  it.each([
    {
      label: 'a version this build does not know',
      text: `${JSON.stringify({
        v: 99,
        file: 'sess-1.jsonl',
        sha256: 'a'.repeat(64),
        hot_size: 1,
        sealed_size: 1,
        sealed_at: '2026-08-11T00:00:00.000Z',
      })}\n`,
    },
    { label: 'a record truncated mid-line', text: '{"v":1,"file":"sess-1.jsonl","sha' },
  ])('a record that is $label behaves exactly as an absent one', ({ text }) => {
    const s = sb();
    sealForReal(SESSION);
    writeArchive(s, `${SESSION}.zst.sha256`, text);

    const { integrity } = report({ verify: true });

    expect(integrity.unverifiable.map((f) => f.reason)).toEqual([SEALED_LEGACY_REASON]);
    expect(integrity.verified).toEqual([]);
    expect(integrity.bytesRead).toBe(0);
  });

  it('a symlink planted at the record name is refused, not followed', () => {
    const s = sb();
    const sealedPath = sealForReal(SESSION);
    const record = sidecarPath(sealedPath);
    // The link points at a PERFECTLY GOOD record for this very frame, so a
    // ladder that followed it would report `verified`. Refusing to follow is
    // what makes this the legacy case instead.
    const elsewhere = decoyPath(s, 'sidecar-target.json');
    writeFileSync(elsewhere, readFileSync(record));
    rmSync(record);
    symlinkSync(elsewhere, record);

    const { integrity } = report({ verify: true });

    expect(integrity.verified).toEqual([]);
    expect(integrity.unverifiable.map((f) => f.reason)).toEqual([SEALED_LEGACY_REASON]);
  });

  it('a FIFO planted at the record name does not block the default path', () => {
    const sealedPath = sealForReal(SESSION);
    const record = sidecarPath(sealedPath);
    rmSync(record);
    execFileSync('mkfifo', [record]);

    // `readSidecar` reads by path with no `lstat` and no bound, and a read of a
    // FIFO with no writer never returns. Without the `isFile()` gate this call
    // hangs the process — on the command a cron is meant to be able to run. That
    // it returns at all is the assertion; the classification is the rest.
    const { integrity } = report();

    expect(integrity.unverifiable.map((f) => f.reason)).toEqual([SEALED_LEGACY_REASON]);
    expect(integrity.verified).toEqual([]);
  });
});

describe('AC4 — the crash-window pair is never verified on the hot file’s bytes', () => {
  it('reports a garbage frame as diverged even though a valid hot file sits beside it', () => {
    const s = sb();
    const body = jsonLines(20);
    plantCrashWindow(s, SESSION, { hot: body, sealed: Buffer.from('pretend-zstd-bytes') });

    const built = report({ verify: true });

    // Both non-vacuity conditions hold. The hot bytes differ from anything this
    // `.zst` could hold, so `verified` is reachable only by reading the wrong
    // file; and `sealed_size` equals the garbage's actual length, so rung 3 does
    // not short-circuit and the ladder really does reach the frame.
    expect(built.integrity.diverged.map((f) => [f.relPath, f.reason])).toEqual([
      [SESSION, 'sealed-frame'],
    ]);
    expect(built.integrity.verified).toEqual([]);
    // `discover` collides both archive-walk hits onto one entry and marks it
    // `both`, so the pair counts as mirrored rather than archive-only.
    expect(built.coverage).toMatchObject({ found: 1, mirrored: 1, archiveOnly: 0 });
  });

  it('positive control — the same pair with a real frame verifies', () => {
    const s = sb();
    const body = jsonLines(20);
    plantCrashWindow(s, SESSION, { hot: body, sealed: compressLikeSeal(body) });

    // Shows the ladder read the frame, rather than skipping sealed files or
    // reading nothing at all.
    expect(report({ verify: true }).integrity.verified).toEqual([SESSION]);
  });

  it('the discriminating control — a garbage HOT file cannot make the frame fail', () => {
    const s = sb();
    const body = jsonLines(20);
    plantCrashWindow(s, SESSION, {
      hot: 'not the archived bytes, and not a frame either\n',
      sealed: compressLikeSeal(body),
      describes: body,
    });

    const built = report({ verify: true });

    // This one can only pass if the hot file was never opened.
    expect(built.integrity.verified).toEqual([SESSION]);
    expect(built.integrity.diverged).toEqual([]);
  });
});

describe('AC6 — the cost boundary holds over a SEALED corpus, not just a hot one', () => {
  it('reads no content bytes by default, and the whole corpus under --verify', () => {
    // The boundary test above is a hot-only corpus, so it is blind to what a
    // sealed file costs. This is the sealed half of the same claim, and the
    // second assertion is what keeps the first from being vacuous.
    const body = transcriptLines(1200);
    expect(body.length).toBeGreaterThan(200 * 1024);
    sealForReal(SESSION, body);

    expect(report().integrity.bytesRead).toBeLessThan(64 * 1024);
    expect(report({ verify: true }).integrity.bytesRead).toBeGreaterThanOrEqual(body.length);
  });
});

describe('AC2 — coverage, bytes, divergence and retention', () => {
  it('counts mirrored out of found, and names what is not mirrored', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    writeSource(s, OTHER, jsonLines(4, 200));
    archivePass();
    // A third source appears after the pass: found but not yet mirrored.
    writeSource(s, THIRD, jsonLines(4, 300));

    const built = report();

    expect(built.coverage.found).toBe(3);
    expect(built.coverage.mirrored).toBe(2);
    expect(built.coverage.unmirrored).toEqual([THIRD]);
    expect(formatDoctorReport(built)).toContain('coverage: 2 of 3 source files mirrored');
  });

  it('counts an archive-only file as coverage.archiveOnly, never as found', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    archivePass();
    rmSync(sourcePath(s, SESSION));

    const built = report();

    expect(built.coverage.found).toBe(0);
    expect(built.coverage.mirrored).toBe(0);
    expect(built.coverage.archiveOnly).toBe(1);
    expect(formatDoctorReport(built)).toContain('the archive is the only copy');
  });

  it('splits total archive bytes into hot and sealed, and renders both', () => {
    const s = sb();
    const body = jsonLines(6);
    writeSource(s, SESSION, body);
    archivePass();
    const sealed = Buffer.from('pretend-zstd-bytes');
    writeArchive(s, `${OTHER}.zst`, sealed);

    const built = report();

    expect(built.bytes.hotFiles).toBe(1);
    expect(built.bytes.hotBytes).toBe(body.length);
    expect(built.bytes.sealedFiles).toBe(1);
    expect(built.bytes.sealedBytes).toBe(sealed.length);
    expect(built.bytes.totalBytes).toBe(body.length + sealed.length);
    expect(formatDoctorReport(built)).toContain(
      `archive bytes: ${body.length + sealed.length} total — ${body.length} hot in 1 file, ` +
        `${sealed.length} sealed in 1 file`,
    );
  });

  it('names every live diverged file with its reason, in the report and the text', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(10));
    writeSource(s, OTHER, jsonLines(10, 200));
    archivePass();
    writeFileSync(sourcePath(s, SESSION), jsonLines(2));
    writeFileSync(sourcePath(s, OTHER), jsonLines(2, 200));

    const built = report();
    const text = formatDoctorReport(built);

    expect(built.integrity.diverged.map((f) => f.relPath).sort()).toEqual([SESSION, OTHER].sort());
    for (const file of built.integrity.diverged) {
      expect(file.reason).toBe('shrink');
      expect(text).toContain(`shrink  ${file.archivePath}`);
    }
    // Both readings named, neither asserted as the cause.
    expect(text).toContain('source was rewritten, or the archived bytes were corrupted');
  });

  it('reports retention as unset when the key is absent — the state measured on this machine', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));
    // A real-shaped settings file with everything EXCEPT cleanupPeriodDays.
    writeSettings(s, { includeCoAuthoredBy: false, permissions: { allow: [] } });

    const built = report();

    expect(built.retention).toEqual({ state: 'unset' });
    expect(formatDoctorReport(built)).toContain('unset — default applies');
  });

  it.each([
    {
      label: 'a number renders as the value',
      contents: { cleanupPeriodDays: 45 } as unknown,
      expected: { state: 'set', days: 45 },
      contains: '45 days',
    },
    {
      label: 'a non-number falls back to unset',
      contents: { cleanupPeriodDays: 'forever' } as unknown,
      expected: { state: 'unset' },
      contains: 'unset — default applies',
    },
  ])('retention: $label', ({ contents, expected, contains }) => {
    const s = sb();
    writeSettings(s, contents);

    const built = report();

    expect(built.retention).toEqual(expected);
    expect(formatDoctorReport(built)).toContain(contains);
  });

  it('retention: no settings file at all reports absent, without throwing', () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));

    const built = report();

    expect(built.retention).toEqual({ state: 'absent' });
    expect(formatDoctorReport(built)).toContain('unset — default applies');
  });

  it('retention: unparseable JSON reports unreadable, without throwing', () => {
    const s = sb();
    writeSettings(s, '{');

    const built = report();

    expect(built.retention.state).toBe('unreadable');
    expect(formatDoctorReport(built)).toContain('Claude Code retention: unreadable —');
  });
});

describe('a symlinked archive leaf is never counted as a mirror (task 1.5)', () => {
  /** Task 1.4's repro layout: a live source, a live victim, one leaf symlink. */
  function plantVictimLink(s: Sandbox): void {
    writeSource(s, SESSION, jsonLines(4));
    const victim = writeSource(s, VICTIM, VICTIM_BYTES);
    plantArchiveSymlink(s, SESSION, victim);
    expect(statSync(victim).size).toBe(16);
  }

  it('excludes it from coverage.mirrored and attributes none of its target bytes', () => {
    // Pre-fix these read `mirrored: 1`, `hotFiles: 1`, `hotBytes: 16` — sixteen
    // bytes the archive never wrote, belonging to a file inside the transcript
    // root, because the gate was a following `statSync`.
    const s = sb();
    plantVictimLink(s);

    const built = report();

    expect(built.coverage.mirrored).toBe(0);
    expect(built.coverage.unmirrored).toContain(SESSION);
    expect(built.bytes.hotFiles).toBe(0);
    expect(built.bytes.hotBytes).toBe(0);
    expect(built.bytes.totalBytes).toBe(0);
    expect(built.integrity.archivedFileCount).toBe(0);

    // …and it is not classified at all. Pre-fix it was `unverifiable` for having
    // no live source WHILE THE SOURCE WAS ALIVE, because the presence gating and
    // the stat gating disagreed about what the leaf was.
    expect(
      built.integrity.unverifiable,
      `nothing may be classified here, least of all "${NO_LIVE_SOURCE_REASON}"`,
    ).toEqual([]);
  });

  it('positive control — a real 16-byte mirror beside it is still counted', () => {
    // Without this the fix could have simply stopped counting. `buildDoctorReport`
    // also runs `assertPopulationsPartition` internally, so it throws rather than
    // returns if the three integrity lists stop partitioning the archived files.
    const s = sb();
    plantVictimLink(s);
    writeSource(s, OTHER, VICTIM_BYTES);
    writeArchive(s, OTHER, VICTIM_BYTES);

    const built = report();

    expect(built.coverage.mirrored).toBe(1);
    expect(built.coverage.unmirrored).toContain(SESSION);
    expect(built.bytes.hotFiles).toBe(1);
    expect(built.bytes.hotBytes).toBe(16);
    expect(built.bytes.totalBytes).toBe(16);
    expect(built.integrity.verified).toEqual([OTHER]);
  });
});

describe('the settings path never falls back to the real user file in a test', () => {
  it('the explicit flag value is what gets read', () => {
    const s = sb();
    const path = writeSettings(s, { cleanupPeriodDays: 7 });

    expect(report({ settingsPath: path }).retention).toEqual({ state: 'set', days: 7 });
    expect(report({ settingsPath: path }).settingsPath).toBe(path);
  });

  it('AGENT_LENS_CLAUDE_SETTINGS reaches the same sandbox file with no flag', () => {
    const s = sb();
    const path = writeSettings(s, { cleanupPeriodDays: 12 });
    const previous = process.env.AGENT_LENS_CLAUDE_SETTINGS;
    process.env.AGENT_LENS_CLAUDE_SETTINGS = path;
    try {
      const built = buildDoctorReport({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
      expect(built.settingsPath).toBe(path);
      expect(built.retention).toEqual({ state: 'set', days: 12 });
    } finally {
      if (previous === undefined) delete process.env.AGENT_LENS_CLAUDE_SETTINGS;
      else process.env.AGENT_LENS_CLAUDE_SETTINGS = previous;
    }
  });

  it('the default resolves to the user-level settings file — asserted as a string, never read', () => {
    // Deliberately a string comparison. Reading the real file here would make the
    // suite depend on whatever is on the developer's machine.
    const previous = process.env.AGENT_LENS_CLAUDE_SETTINGS;
    delete process.env.AGENT_LENS_CLAUDE_SETTINGS;
    try {
      expect(resolveClaudeSettingsPath()).toBe(join(homedir(), '.claude', 'settings.json'));
    } finally {
      if (previous !== undefined) process.env.AGENT_LENS_CLAUDE_SETTINGS = previous;
    }
  });
});
