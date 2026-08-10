// The doctor report builder. Every case is synthesized in a temp dir, and every
// case passes an explicit `settingsPath` inside that sandbox — nothing here may
// resolve the developer's real `~/.claude/settings.json`.

import { afterEach, describe, it, expect } from 'vitest';
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildDoctorReport,
  NO_LIVE_SOURCE_REASON,
  resolveClaudeSettingsPath,
  SEALED_REASON,
} from '../report.js';
import { formatDoctorReport } from '../../cli/commands/doctor.js';
import {
  archivePath,
  cleanup,
  jsonLines,
  makeSandbox,
  plantArchiveSymlink,
  settingsPath,
  SLUG,
  sourcePath,
  writeArchive,
  writeSettings,
  writeSource,
  type Sandbox,
} from './fixtures.js';
import { archiveOnce } from '../mirror.js';

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
    expect(byPath.get(SESSION)).toBe(SEALED_REASON);

    // Named in the rendered text, not merely counted.
    expect(text).toContain(archivePath(s, OTHER));
    expect(text).toContain(`${archivePath(s, SESSION)}.zst`);
    expect(text).toContain('unverifiable (2)');
    expect(text).toContain('2 files archived = 0 verified + 0 diverged + 2 unverifiable');
  });

  it('states the sealed reason verbatim and claims no seal-time check', () => {
    const s = sb();
    writeArchive(s, `${SESSION}.zst`, Buffer.from('pretend-zstd-bytes'));

    const built = report();
    const text = formatDoctorReport(built);

    expect(built.integrity.unverifiable[0]!.reason).toBe(
      'sealed — no integrity check available (no stored hash exists)',
    );
    expect(text).toContain(SEALED_REASON);
    // No sealing code exists in this repo, so nothing may imply a check happened.
    expect(text).not.toMatch(/seal[- ]time|checked at seal|verified at seal/i);
  });

  it('a sealed file whose source is alive is still unverifiable, not verified', () => {
    // The compressed bytes on disk are no comparison for the live source.
    const s = sb();
    writeArchive(s, `${SESSION}.zst`, Buffer.from('pretend-zstd-bytes'));
    writeSource(s, SESSION, jsonLines(4));

    const built = report({ verify: true });

    expect(built.integrity.verified).toEqual([]);
    expect(built.integrity.unverifiable.map((f) => f.reason)).toEqual([SEALED_REASON]);
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
