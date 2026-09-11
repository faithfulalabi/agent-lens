// `agent-lens doctor` end to end, through the argv the CLI actually threads.
// Every case passes `--settingsPath` into the sandbox: without it the
// immutability assertions below would snapshot the developer's real
// `~/.claude/settings.json`.

import { afterEach, describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Through the public barrel, the way anything outside `src/archive/` reaches it.
import { archiveOnce, buildDoctorReport, SEALED_LEGACY_REASON } from '../../archive/index.js';
import {
  COVERAGE_GAP_STATEMENT,
  doctor,
  DURABILITY_STATEMENT,
  formatDoctorReport,
  formatLastPassSection,
  readCacheStats,
} from '../commands/doctor.js';
import type { LastPassReport } from '../../archive/index.js';
import {
  archivePath,
  cleanup,
  jsonLines,
  makeSandbox,
  settingsPath,
  sha256Hex,
  SLUG,
  snapshotTreeSafe,
  sourcePath,
  writeArchive,
  writeSettings,
  writeSidecar,
  writeSource,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';
import { sessionRecords, writeSession } from '../../corpus/__tests__/fixtures.js';
import { createCorpusSweep } from '../../corpus/watch.js';
import { openDb } from '../../db/open.js';

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
      { relPath: OTHER, archivePath: `${archivePath(s, OTHER)}.zst`, reason: SEALED_LEGACY_REASON },
    ]);
    expect(json.retention).toEqual({ state: 'set', days: 45 });
    // The same object the text formatter renders, so the two cannot drift.
    expect(formatDoctorReport(json)).toContain(SEALED_LEGACY_REASON);
  });

  it('gives a sealed diverged row exactly the keys it can honestly fill', async () => {
    const s = sb();
    const body = jsonLines(20);
    // A frame that is not what its record describes, and no source anywhere.
    writeArchive(s, `${OTHER}.zst`, Buffer.from('pretend-zstd-bytes'));
    writeSidecar(s, OTHER, {
      file: 'sess-2.jsonl',
      sha256: sha256Hex(body),
      hot_size: body.length,
      sealed_size: 18,
    });

    const json = JSON.parse(await runDoctor(argsFor(s, ['--verify', '--json']))) as ReturnType<
      typeof buildDoctorReport
    >;
    const row = json.integrity.diverged[0] as unknown as Record<string, unknown>;

    expect(row).toEqual({
      relPath: OTHER,
      archivePath: `${archivePath(s, OTHER)}.zst`,
      reason: 'sealed-frame',
    });
    // The KEY SET, not merely the values: a sealed row has no live source, so
    // `sourcePath` must be absent rather than empty, null or invented.
    expect(Object.keys(row).sort()).toEqual(['archivePath', 'reason', 'relPath']);
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

/* ------------------------------------------------------- the cache block --- */

const CACHE_ONE = 'aaaaaaaa-1111-4111-8111-dc0000000001';
const CACHE_TWO = 'aaaaaaaa-1111-4111-8111-dc0000000002';

/** Two archived sessions, indexed AND projected the way a boot sweep leaves them. */
function seedProjectedCache(s: Sandbox): void {
  writeSession(
    s,
    CACHE_ONE,
    sessionRecords('c1', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:30.000Z'),
  );
  writeSession(
    s,
    CACHE_TWO,
    sessionRecords('c2', '2026-08-14T09:01:00.000Z', '2026-08-14T09:01:30.000Z'),
  );
  const opened = openDb({ dataDir: s.dataDir });
  try {
    createCorpusSweep({ db: opened.db, dataDir: s.dataDir, transcriptRoot: s.sourceRoot }).tick();
  } finally {
    opened.close();
  }
}

describe('AC2 — doctor reports the cache beside the archive', () => {
  it('prints the path, bytes, indexed vs projected, both versions and the drift census', async () => {
    const s = sb();
    seedProjectedCache(s);

    const output = await runDoctor(argsFor(s));

    expect(output).toContain(`cache: ${join(s.dataDir, 'cache.db')}`);
    expect(output).toMatch(/^ {2}\d+ bytes$/m);
    expect(output).toContain('2 sessions indexed, 2 projected');
    expect(output).toMatch(/schema_version \d+, projector_version \d+/);
    // The census counts CLEAN rows too, which is what makes "0 drifting of 2 on
    // 2.1.212" a different statement from a broken reader returning nothing.
    expect(output).toContain('drift by harness version');
    expect(output).toContain('2.1.212: 2 projected, 0 drifting');
  });

  it('leaves the two closing statements last, after the cache block', async () => {
    // The property `commands/doctor.ts:20-24` states: a refactor that demotes
    // them must red. A section appended below them would do exactly that.
    const s = sb();
    seedProjectedCache(s);

    const lines = (await runDoctor(argsFor(s))).split('\n');

    expect(lines.at(-2)).toBe(COVERAGE_GAP_STATEMENT);
    expect(lines.at(-1)).toBe(DURABILITY_STATEMENT);
    expect(lines.findIndex((l) => l.startsWith('cache: '))).toBeLessThan(lines.length - 2);
  });

  it('--json carries the same cache numbers the text form renders', async () => {
    const s = sb();
    seedProjectedCache(s);

    const json = JSON.parse(await runDoctor(argsFor(s, ['--json']))) as {
      cache: ReturnType<typeof readCacheStats>;
    };
    const text = await runDoctor(argsFor(s));

    expect(json.cache.state).toBe('ready');
    const stats = (json.cache as { stats: { db_bytes: number; sessions_indexed: number } }).stats;
    expect(text).toContain(`  ${stats.db_bytes} bytes`);
    expect(text).toContain(`${stats.sessions_indexed} sessions indexed`);
  });

  it('no cache yet — one honest line, and doctor still returns normally', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));

    const output = await runDoctor(argsFor(s));

    expect(output).toContain('not created yet');
    expect(output).toContain('`agent-lens start` builds it');
    // The report must not manufacture the evidence it is reporting on.
    expect(existsSync(join(s.dataDir, 'cache.db'))).toBe(false);
    expect(existsSync(s.dataDir)).toBe(false);
  });

  it('a cache held by a live writer still reports, because the handle is read-only', async () => {
    // MEASURED on node:sqlite/Node 26: a read-only connection reads committed
    // rows while another process holds the WAL handle. It is why the cache block
    // does not have to degrade whenever the server happens to be running.
    const s = sb();
    seedProjectedCache(s);
    const holder = openDb({ dataDir: s.dataDir });
    try {
      const output = await runDoctor(argsFor(s));

      expect(output).toContain('2 sessions indexed, 2 projected');
      expect(output).toContain(DURABILITY_STATEMENT);
    } finally {
      holder.close();
    }
  });

  it('a torn cache degrades to one line and still says nothing was lost', async () => {
    const s = sb();
    mkdirSync(s.dataDir, { recursive: true });
    writeFileSync(join(s.dataDir, 'cache.db'), 'this is not a database');

    const output = await runDoctor(argsFor(s));

    expect(output).toContain('stats unavailable');
    expect(output).toContain('`agent-lens rebuild` recreates the whole file');
    expect(output).toContain(DURABILITY_STATEMENT);
  });

  it('reading a closed cache adds SQLite’s own two sidecars and nothing else', async () => {
    // The honest qualification on "doctor writes nothing": a read-only handle on
    // a WAL database whose -shm was checkpointed away RECREATES cache.db-wal and
    // cache.db-shm. Measured, and pinned here rather than left in a comment —
    // two empty sidecars of SQLite's own, beside a file that already exists.
    const s = sb();
    seedProjectedCache(s);
    const before = snapshotTreeSafe(s.dataDir);
    const cacheBefore = stampFile(join(s.dataDir, 'cache.db'));

    await runDoctor(argsFor(s, ['--verify']));

    const after = snapshotTreeSafe(s.dataDir);
    const added = [...after.keys()].filter((rel) => !before.has(rel)).sort();
    expect(added).toEqual(['cache.db-shm', 'cache.db-wal']);
    // The database itself, and the archive it reports on, are untouched.
    expect(stampFile(join(s.dataDir, 'cache.db'))).toEqual(cacheBefore);
    for (const [rel, entry] of before) {
      if (rel.startsWith('archive/')) expect(after.get(rel), rel).toEqual(entry);
    }
  });
});

/* ------------------------------------------------- the archive-job block --- */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A `found` report with sane defaults, so each case states only what it tests. */
function foundReport(partial: {
  lastEntry?: { epochMs: number; status: string; summary: string };
  lastOk?: { epochMs: number; status: string; summary: string } | undefined;
}): LastPassReport {
  const ok = {
    epochMs: 0,
    status: 'ok',
    summary: 'agent-lens archive: 854 files, 0 bytes copied',
  };
  return {
    state: 'found',
    path: '/data/logs/cron.log',
    lastEntry: partial.lastEntry ?? partial.lastOk ?? ok,
    lastOk: 'lastOk' in partial ? partial.lastOk : ok,
  };
}

describe('task 0.10 — doctor reports time since the last successful pass', () => {
  it('a recent all-ok, 0-bytes-copied log renders as healthy — never as a failure', () => {
    // 36 of 36 passes on 2026-08-29 were `ok … 0 bytes copied`; that is the
    // healthy steady state, and the section keys on the status token alone.
    const lines = formatLastPassSection(
      foundReport({ lastOk: { epochMs: 14 * MINUTE, status: 'ok', summary: 'x, 0 bytes copied' } }),
      28 * MINUTE,
    );

    expect(lines).toEqual([
      '',
      'archive job: /data/logs/cron.log',
      '  last successful pass: 14m ago',
    ]);
    expect(lines.join('\n')).not.toMatch(/fail|error|stale|never/i);
  });

  it('a 29-hour gap renders the elapsed time plainly, distinguishable from never-ran', () => {
    const lines = formatLastPassSection(
      foundReport({ lastOk: { epochMs: 0, status: 'ok', summary: 'x' } }),
      29 * HOUR,
    );

    expect(lines).toContain('  last successful pass: 1d 5h ago');
    expect(lines.join('\n')).not.toContain('never run');
  });

  it('a trailing error is named beside the last success, with its own age', () => {
    const lines = formatLastPassSection(
      foundReport({
        lastOk: { epochMs: 0, status: 'ok', summary: 'x' },
        lastEntry: { epochMs: 55 * MINUTE, status: 'ERR3', summary: 'archive-side errors — y' },
      }),
      HOUR,
    );

    expect(lines).toContain('  last successful pass: 1h 0m ago');
    expect(lines).toContain('  most recent attempt: ERR3, 5m ago — archive-side errors — y');
  });

  it('ran-but-never-succeeded is distinct from both never-ran and recently-ok', () => {
    const lines = formatLastPassSection(
      foundReport({
        lastOk: undefined,
        lastEntry: { epochMs: 0, status: 'ERR127', summary: 'env: node: No such file' },
      }),
      2 * HOUR,
    );

    expect(lines).toContain('  no successful pass on record');
    expect(lines).toContain('  most recent attempt: ERR127, 2h 0m ago — env: node: No such file');
    expect(lines.join('\n')).not.toContain('never run');
  });

  it('absent and empty are two different sentences, and neither implies failure', () => {
    const absent = formatLastPassSection({ state: 'absent', path: '/data/logs/cron.log' });
    const empty = formatLastPassSection({ state: 'empty', path: '/data/logs/cron.log' });

    expect(absent.join('\n')).toContain('never run');
    expect(empty.join('\n')).toContain('records no pass');
    expect(absent).not.toEqual(empty);
  });

  it('end to end: text and --json carry the same last-pass facts from a fixture log', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));
    // Whole seconds: the wrapper's stamp has no millisecond field to carry.
    const okEpoch = Math.floor((Date.now() - 5 * MINUTE) / 1000) * 1000;
    const stamp = `${new Date(okEpoch).toISOString().slice(0, 19)}+0000`;
    mkdirSync(join(s.dataDir, 'logs'), { recursive: true });
    writeFileSync(
      join(s.dataDir, 'logs', 'cron.log'),
      `${stamp} ok   agent-lens archive: 854 files, 0 bytes copied\n` +
        '  297 expired at the source — the archive is now the only copy\n',
    );

    const text = await runDoctor(argsFor(s));
    const json = JSON.parse(await runDoctor(argsFor(s, ['--json']))) as {
      lastPass: LastPassReport;
    };

    expect(text).toMatch(/ {2}last successful pass: \d+m ago/);
    expect(json.lastPass.state).toBe('found');
    if (json.lastPass.state !== 'found') return;
    expect(json.lastPass.lastOk?.epochMs).toBe(okEpoch);
    expect(json.lastPass.lastEntry.status).toBe('ok');

    // The block sits with the other sections, never after the two closing lines.
    const lines = text.split('\n');
    expect(lines.at(-2)).toBe(COVERAGE_GAP_STATEMENT);
    expect(lines.at(-1)).toBe(DURABILITY_STATEMENT);
    const sectionAt = lines.findIndex((l) => l.startsWith('archive job: '));
    expect(sectionAt).toBeGreaterThan(-1);
    expect(sectionAt).toBeLessThan(lines.length - 2);
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
