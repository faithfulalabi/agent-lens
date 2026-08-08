// `agent-lens doctor` end to end, through the argv the CLI actually threads.
// Every case passes `--settingsPath` into the sandbox: without it the
// immutability assertions below would snapshot the developer's real
// `~/.claude/settings.json`.

import { afterEach, describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Through the public barrel, the way anything outside `src/archive/` reaches it.
import { archiveOnce, buildDoctorReport, SEALED_REASON } from '../../archive/index.js';
import {
  COVERAGE_GAP_STATEMENT,
  doctor,
  DURABILITY_STATEMENT,
  formatDoctorReport,
} from '../commands/doctor.js';
import {
  archivePath,
  cleanup,
  jsonLines,
  makeSandbox,
  settingsPath,
  SLUG,
  snapshotTreeSafe,
  sourcePath,
  writeArchive,
  writeSettings,
  writeSource,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';

const SESSION = `${SLUG}/sess-1.jsonl`;
const OTHER = `${SLUG}/sess-2.jsonl`;

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

/** The argv a real invocation carries. `--flag=value`, never `--flag value`:
 *  `parseStringFlag` would otherwise swallow a following `--verify` as its value. */
function argsFor(s: Sandbox, extra: string[] = []): string[] {
  return [
    `--dataDir=${s.dataDir}`,
    `--transcriptRoot=${s.sourceRoot}`,
    `--settingsPath=${settingsPath(s)}`,
    ...extra,
  ];
}

async function runDoctor(args: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg?: unknown) => {
    lines.push(String(msg));
  };
  try {
    await doctor(args);
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

interface FileStamp {
  mtimeMs: number;
  sha256: string;
}

function stampFile(path: string): FileStamp | undefined {
  if (!existsSync(path)) return undefined;
  return {
    mtimeMs: statSync(path).mtimeMs,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('AC4 — doctor always states the coverage gap and the durability contract', () => {
  it('renders both sentences on a clean, all-green report', async () => {
    // On a report with nothing wrong: a future "only warn on problems" refactor
    // must red here. A green ratio is 100% of the survivors, not of what existed.
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));
    archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    writeSettings(s, { cleanupPeriodDays: 30 });

    const output = await runDoctor(argsFor(s, ['--verify']));

    expect(output).toContain('1 file archived = 1 verified + 0 diverged + 0 unverifiable');
    expect(output).toContain(COVERAGE_GAP_STATEMENT);
    expect(output).toContain(DURABILITY_STATEMENT);
    expect(output).toContain('agent-lens can only archive what exists while it runs');
    expect(output).toContain('rm -rf ~/.agent-lens/archive loses data permanently');
  });

  it('renders both sentences on a report full of problems too', async () => {
    const s = sb();
    writeArchive(s, OTHER, jsonLines(4, 200));

    const output = await runDoctor(argsFor(s));

    expect(output).toContain(COVERAGE_GAP_STATEMENT);
    expect(output).toContain(DURABILITY_STATEMENT);
  });
});

describe('AC3 — doctor never writes the user settings file', () => {
  it('leaves an existing settings.json byte- and mtime-identical across a --verify run', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));
    archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const path = writeSettings(s, { cleanupPeriodDays: 45 });

    const before = stampFile(path);
    const dirBefore = listDir(dirname(path));
    const output = await runDoctor(argsFor(s, ['--verify']));

    // Non-vacuity: the run really did read the file it left alone.
    expect(output).toContain('45 days');
    expect(stampFile(path)).toEqual(before);
    expect(listDir(dirname(path))).toEqual(dirBefore);
  });

  it('does not create settings.json — or its parent dir — when it is absent', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));
    archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const path = settingsPath(s);

    expect(existsSync(dirname(path))).toBe(false);
    const output = await runDoctor(argsFor(s, ['--verify']));

    expect(output).toContain('no settings file — unset — default applies');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });
});

describe('AC3 — doctor writes nothing at all', () => {
  it('leaves the data dir and the transcript root byte-, stat- and mode-identical', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(8));
    writeSource(s, OTHER, jsonLines(8, 200));
    archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    writeSettings(s, { cleanupPeriodDays: 30 });
    // Give it something to report on: one diverged file, one archive-only.
    writeFileSync(sourcePath(s, OTHER), jsonLines(1, 200));

    const dataBefore = snapshotTreeSafe(s.dataDir);
    const sourceBefore = snapshotTreeSafe(s.sourceRoot);
    const output = await runDoctor(argsFor(s, ['--verify']));
    const dataAfter = snapshotTreeSafe(s.dataDir);
    const sourceAfter = snapshotTreeSafe(s.sourceRoot);

    // Non-vacuity: a run that reported nothing would prove nothing.
    expect(output).toContain('diverged (1)');
    expect(dataBefore.size).toBeGreaterThan(0);
    expect([...dataAfter.keys()].sort()).toEqual([...dataBefore.keys()].sort());
    for (const [rel, entry] of dataBefore) expect(dataAfter.get(rel), rel).toEqual(entry);
    expect([...sourceAfter.keys()].sort()).toEqual([...sourceBefore.keys()].sort());
    for (const [rel, entry] of sourceBefore) expect(sourceAfter.get(rel), rel).toEqual(entry);
  });

  it('takes no lock and appends no log line — a concurrent cron pass must not see `held`', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(8));
    // This pass is what creates the log; doctor must leave it exactly as it is.
    archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const log = join(s.dataDir, 'logs', 'archive.jsonl');
    const before = stampFile(log);
    expect(before, 'the setup pass should have written a log line').toBeDefined();

    await runDoctor(argsFor(s, ['--verify']));

    expect(existsSync(join(s.dataDir, 'archive.lock'))).toBe(false);
    expect(stampFile(log)).toEqual(before);
  });

  it('does not create the data dir on a machine that has never archived', async () => {
    // The report must not manufacture the evidence it is reporting on.
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));

    expect(existsSync(s.dataDir)).toBe(false);
    const output = await runDoctor(argsFor(s, ['--verify']));

    expect(output).toContain('coverage: 0 of 1 source files mirrored');
    expect(existsSync(s.dataDir)).toBe(false);
    expect(snapshotTreeSafe(s.dataDir).size).toBe(0);
  });
});

describe('the rendered report and --json carry the same facts', () => {
  it('round-trips the unverifiable list, the counts and the retention state', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(6));
    archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    writeArchive(s, `${OTHER}.zst`, Buffer.from('pretend-zstd-bytes'));
    writeSettings(s, { cleanupPeriodDays: 45 });

    const json = JSON.parse(await runDoctor(argsFor(s, ['--verify', '--json']))) as ReturnType<
      typeof buildDoctorReport
    >;

    expect(json.integrity.verify).toBe(true);
    expect(json.integrity.archivedFileCount).toBe(2);
    expect(json.integrity.verified).toEqual([SESSION]);
    expect(json.integrity.unverifiable).toEqual([
      { relPath: OTHER, archivePath: `${archivePath(s, OTHER)}.zst`, reason: SEALED_REASON },
    ]);
    expect(json.retention).toEqual({ state: 'set', days: 45 });
    // The same object the text formatter renders, so the two cannot drift.
    expect(formatDoctorReport(json)).toContain(SEALED_REASON);
  });

  it('--json emits one parseable line and no prose', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));

    const output = await runDoctor(argsFor(s, ['--json']));

    expect(output.split('\n')).toHaveLength(1);
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain(COVERAGE_GAP_STATEMENT);
  });
});

describe('doctor caps a long list rather than printing thousands of rows', () => {
  it('names the first 20 unverifiable files and gives the total', async () => {
    const s = sb();
    for (let i = 0; i < 25; i++) {
      writeArchive(s, `${SLUG}/expired-${String(i).padStart(2, '0')}.jsonl`, jsonLines(1, i));
    }

    const output = await runDoctor(argsFor(s));

    expect(output).toContain('unverifiable (25)');
    expect(output).toContain('… and 5 more (25 in total)');
    expect(output).toContain('expired-00.jsonl');
    expect(output).not.toContain('expired-24.jsonl');
  });
});
