// `agent-lens prune` — the only command in this product that destroys data, so
// this file is weighted towards the arms where nothing may happen.
//
// TWO HARNESSES, `archive.test.ts:1-11`'s split. `formatPruneConfirm` and
// `parsePruneArgs` are pure, so they are unit tests; the EOF-declines claim is
// about a real PROCESS and spawns the binary a cron would invoke. Every run
// carries `--dataDir`, `--transcriptRoot` AND `--settingsPath` into the sandbox:
// an unrecognised flag is silently ignored binary-wide today, so nothing here
// may reach a real `~/.agent-lens` or a real `~/.claude/settings.json`.

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDoctorReport, type DoctorReport } from '../../archive/index.js';
import {
  captureConsole,
  settingsPath,
  snapshotTreeSafe,
  writeSettings,
  useSandbox,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';
import {
  sessionRecords,
  SLUG,
  writeSealedSession,
  writeSession,
  writeSidecar,
} from '../../corpus/__tests__/fixtures.js';
import { openDb } from '../../db/open.js';
import { EXIT_INCOMPLETE, EXIT_OK } from '../commands/archive.js';
import { COVERAGE_GAP_STATEMENT, DURABILITY_STATEMENT } from '../commands/doctor.js';
import {
  formatPruneConfirm,
  parsePruneArgs,
  prune,
  resolvePruneTarget,
  type PruneTarget,
} from '../commands/prune.js';

const START = '2026-08-14T09:00:00.000Z';
const END = '2026-08-14T09:00:30.000Z';
const ONE = 'aaaaaaaa-1111-4111-8111-pr0000000001';
const TWO = 'aaaaaaaa-1111-4111-8111-pr0000000002';

const HERE = resolve(import.meta.dirname, '../../..');
const BIN = join(HERE, 'bin', 'agent-lens.js');

const sb = useSandbox();

function argsFor(s: Sandbox, extra: string[] = []): string[] {
  return [
    ...extra,
    `--dataDir=${s.dataDir}`,
    `--transcriptRoot=${s.sourceRoot}`,
    `--settingsPath=${settingsPath(s)}`,
  ];
}

/** The resolved target, or a red naming why it could not resolve. */
function targetOf(report: DoctorReport, id?: string): PruneTarget {
  const resolved = resolvePruneTarget(report, id);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.target;
}

function reportFor(s: Sandbox): DoctorReport {
  return buildDoctorReport({
    dataDir: s.dataDir,
    transcriptRoot: s.sourceRoot,
    settingsPath: settingsPath(s),
  });
}

async function runPrune(args: string[], answer?: string): Promise<{ code: number; out: string }> {
  const options = answer === undefined ? {} : { confirm: () => Promise.resolve(answer) };
  const { value: code, lines } = await captureConsole(() => prune(args, options));
  return { code, out: lines.join('\n') };
}

/** Spawns the real binary with stdin already at EOF — what a cron gives it. */
function spawnPrune(args: string[], dataDir: string): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, 'prune', ...args], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, AGENT_LENS_DIR: dataDir },
    });
    child.stdin.end();
    child.on('close', (status) => resolvePromise(status));
  });
}

describe('14 + 15 — the confirm text, which is the whole of AC4 (AC4)', () => {
  it('carries both shared statements, the resolved root, the counts and the retention line', () => {
    const s = sb();
    writeSession(s, ONE, sessionRecords('c1', START, END));
    writeSession(s, TWO, sessionRecords('c2', START, END));
    writeSettings(s, { cleanupPeriodDays: 30 });

    const report = reportFor(s);
    const text = formatPruneConfirm(report, targetOf(report));

    // ★ NON-VACUITY: the constants are IMPORTED, the way `doctor.test.ts:12-17`
    // imports them, so retyping either sentence inside prune.ts reds this.
    expect(text).toContain(DURABILITY_STATEMENT);
    expect(text).toContain(COVERAGE_GAP_STATEMENT);
    // …and they really are the sentences, not two empty strings.
    expect(text).toContain('rm -rf ~/.agent-lens/archive loses data permanently');
    expect(text).toContain('a gap in uptime is a gap in the record');

    // The RESOLVED root: a mistyped flag is silently ignored today, so the only
    // defence left is showing the human what is actually about to go.
    expect(text).toContain(report.archiveRoot);
    expect(text).toContain(`${report.bytes.hotFiles + report.bytes.sealedFiles} files`);
    expect(text).toContain(`${report.bytes.totalBytes} bytes`);
    expect(text).toContain(`${report.coverage.archiveOnly} have no live source left`);
    expect(text).toContain('Claude Code retention (cleanupPeriodDays): 30 days');
    expect(text).toContain('Type `delete` to confirm');
    // Non-vacuity for the counts: an all-zero fixture would satisfy them blind.
    expect(report.bytes.totalBytes).toBeGreaterThan(0);
    expect(report.coverage.archiveOnly).toBe(2);
  });

  it('states no retention number of its own, on a machine with no settings file', () => {
    // The task's "nothing older than 41 days survives" does NOT reproduce and is
    // struck; the confirm prints this machine's measurement instead. This pins
    // the retracted figure out of the one screen that can least afford a
    // number nobody can check.
    const s = sb();
    writeSession(s, ONE, sessionRecords('c1', START, END));

    const report = reportFor(s);
    const text = formatPruneConfirm(report, targetOf(report));

    expect(text).not.toMatch(/\b41 days\b/);
    expect(text).not.toMatch(/\b53 of 97\b/);
    // The retention line is still THERE — it just carries the measured state.
    expect(text).toContain('no settings file — unset — default applies');
  });
});

describe('16 + 17 — accepting deletes, and everything else does not (AC4)', () => {
  it('the exact word deletes the archive and leaves cache.db alone', async () => {
    const s = sb();
    writeSession(s, ONE, sessionRecords('c1', START, END));
    openDb({ dataDir: s.dataDir }).close();
    const cachePath = join(s.dataDir, 'cache.db');
    expect(existsSync(cachePath)).toBe(true);

    const { code, out } = await runPrune(argsFor(s), 'delete');

    expect(code).toBe(EXIT_OK);
    expect(existsSync(s.archiveRoot)).toBe(false);
    // The inverted contract, demonstrated rather than asserted in prose: the
    // disposable file survives the command that destroys the durable one.
    expect(existsSync(cachePath)).toBe(true);
    expect(out).toContain('deleted the whole archive');
  });

  it.each(['n', 'y', 'DELETE', '', 'delete ', ' delete', 'yes', 'Delete'])(
    'answering %j deletes nothing and exits 0',
    async (answer) => {
      const s = sb();
      writeSession(s, ONE, sessionRecords('c1', START, END));
      const before = snapshotTreeSafe(s.archiveRoot);
      expect(before.size, 'the fixture must have something to lose').toBeGreaterThan(0);

      const { code, out } = await runPrune(argsFor(s), answer);

      // 0, not 1: the human was asked and answered, and nothing failed.
      expect(code).toBe(EXIT_OK);
      expect(out).toContain('nothing was deleted');
      const after = snapshotTreeSafe(s.archiveRoot);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);
    },
  );
});

describe('18 — a cron can never prune (AC4)', () => {
  it('spawned with stdin at EOF it declines, exits 0, and the archive is intact', async () => {
    const s = sb();
    writeSession(s, ONE, sessionRecords('c1', START, END));
    const before = snapshotTreeSafe(s.archiveRoot);

    const status = await spawnPrune(argsFor(s), s.dataDir);

    expect(status).toBe(EXIT_OK);
    expect(status).not.toBe(2); // exit 2 blocks a Claude Code session
    const after = snapshotTreeSafe(s.archiveRoot);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  }, 20_000);
});

describe('19 + 20 — one session, and the sidecar that refuses (AC4)', () => {
  it('removes only that transcript and its directory; a sibling survives', async () => {
    const s = sb();
    writeSession(s, ONE, sessionRecords('c1', START, END));
    writeSidecar(s, ONE, 'kid', sessionRecords('nested', START, END), { toolUseId: 'c1' });
    writeSession(s, TWO, sessionRecords('c2', START, END));
    writeSidecar(s, TWO, 'kid2', sessionRecords('nested2', START, END), { toolUseId: 'c2' });

    const { code, out } = await runPrune(argsFor(s, [ONE]), ONE);

    expect(code).toBe(EXIT_OK);
    expect(out).toContain(`session ${ONE}`);
    expect(existsSync(join(s.archiveRoot, SLUG, `${ONE}.jsonl`))).toBe(false);
    expect(existsSync(join(s.archiveRoot, SLUG, ONE))).toBe(false);
    // The sibling, both halves of it.
    expect(existsSync(join(s.archiveRoot, SLUG, `${TWO}.jsonl`))).toBe(true);
    expect(existsSync(join(s.archiveRoot, SLUG, TWO, 'subagents', 'agent-kid2.jsonl'))).toBe(true);
  });

  it('removes the sealed twin when the transcript is sealed', async () => {
    const s = sb();
    writeSealedSession(s, ONE, sessionRecords('c1', START, END));
    writeSession(s, TWO, sessionRecords('c2', START, END));
    const sealed = join(s.archiveRoot, SLUG, `${ONE}.jsonl.zst`);
    expect(existsSync(sealed)).toBe(true);

    expect((await runPrune(argsFor(s, [ONE]), ONE)).code).toBe(EXIT_OK);

    expect(existsSync(sealed)).toBe(false);
    expect(existsSync(join(s.archiveRoot, SLUG, `${TWO}.jsonl`))).toBe(true);
  });

  it('a sidecar id refuses, names its parent, and deletes nothing', async () => {
    const s = sb();
    writeSession(s, ONE, sessionRecords('c1', START, END));
    writeSidecar(s, ONE, 'kid', sessionRecords('nested', START, END), { toolUseId: 'c1' });
    const before = snapshotTreeSafe(s.archiveRoot);

    const { code, out } = await runPrune(argsFor(s, ['kid']), 'kid');

    expect(code).toBe(EXIT_INCOMPLETE);
    expect(out).toContain('sub-agent transcript');
    expect(out).toContain(ONE);
    expect([...snapshotTreeSafe(s.archiveRoot).keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('an unknown session id refuses and deletes nothing', async () => {
    const s = sb();
    writeSession(s, ONE, sessionRecords('c1', START, END));
    const before = snapshotTreeSafe(s.archiveRoot);

    const { code, out } = await runPrune(argsFor(s, ['no-such-session']), 'no-such-session');

    expect(code).toBe(EXIT_INCOMPLETE);
    expect(out).toContain('no archived session');
    expect([...snapshotTreeSafe(s.archiveRoot).keys()].sort()).toEqual([...before.keys()].sort());
  });
});

describe('21 — the read-only guarantee over the corpus survives the one destructive command', () => {
  it('an archive root symlinked AT the transcript root is refused before any delete', async () => {
    const s = sb();
    // The nightmare: `<dataDir>/archive` IS `~/.claude/projects`. A prune that
    // followed it would delete the corpus agent-lens exists to preserve.
    writeFileSync(join(s.sourceRoot, 'decoy.jsonl'), '{"i":0}\n');
    mkdirSync(s.dataDir, { recursive: true });
    symlinkSync(s.sourceRoot, s.archiveRoot);
    const before = snapshotTreeSafe(s.sourceRoot);
    expect(before.size).toBeGreaterThan(0);

    const { code, out } = await runPrune(argsFor(s), 'delete');

    expect(code).toBe(EXIT_INCOMPLETE);
    expect(out).toMatch(/refusing to write (outside the data dir|inside the transcript root)/);
    const after = snapshotTreeSafe(s.sourceRoot);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);
  });
});

describe('22 — prune refuses arguments it does not recognise', () => {
  it.each([
    ['--data-dir=/nope'],
    ['--older-than=30'],
    ['--max-size=1G'],
    ['--yes'],
    ['-f'],
    ['one', 'two'],
  ])('%j exits 1', async (...bad) => {
    const s = sb();
    writeSession(s, ONE, sessionRecords('c1', START, END));
    const before = snapshotTreeSafe(s.archiveRoot);

    const { code } = await runPrune(argsFor(s, bad), 'delete');

    expect(code).toBe(EXIT_INCOMPLETE);
    expect([...snapshotTreeSafe(s.archiveRoot).keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('parsePruneArgs takes the flags it documents, in both forms', () => {
    expect(parsePruneArgs([])).toEqual({ ok: true });
    expect(parsePruneArgs(['abc'])).toEqual({ ok: true, id: 'abc' });
    expect(parsePruneArgs(['--dataDir=/x', 'abc'])).toEqual({ ok: true, id: 'abc' });
    // `--flag value` consumes its value, so `/x` is not read as a session id.
    expect(parsePruneArgs(['--dataDir', '/x'])).toEqual({ ok: true });
    expect(parsePruneArgs(['--transcriptRoot', '/x', '--settingsPath=/y'])).toEqual({ ok: true });
    expect(parsePruneArgs(['--nope'])).toEqual({
      ok: false,
      message: expect.stringContaining('unrecognised option --nope') as string,
    });
  });
});
