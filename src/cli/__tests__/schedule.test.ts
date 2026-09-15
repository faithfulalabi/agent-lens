// `agent-lens schedule` — the recurring archive job. Harness split follows
// `args.test.ts`: pure builders get pure tests; argv rejection goes through
// `runMain` (rejected BEFORE dispatch, so nothing loads); everything touching
// disk drives `schedule()` directly with injected deps against `makeSandbox()`.
//
// ⚠️ NO test here may ever run a real `launchctl` or touch the real
// `~/Library/LaunchAgents` — the runner is always the fake, and the home dir is
// always inside the sandbox. The real launchd interaction is verified by manual
// measurement on the founder's machine, exactly as the wrapper's predecessor was.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cleanup,
  makeSandbox,
  runMain,
  snapshotTreeSafe,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';
import { parseCronLog } from '../../archive/cron-log.js';
import {
  resolveCronLogPath,
  resolvePlistPath,
  resolveScheduleWrapperPath,
} from '../../archive/paths.js';
import {
  buildPlist,
  buildWrapperScript,
  CRON_STAMP_FORMAT,
  LEGACY_LABEL,
  parseScheduleAction,
  resolveArchiveInvocation,
  schedule,
  SCHEDULE_LABEL,
  WAKE_TIME_CAVEAT,
  type LaunchctlResult,
  type ScheduleDeps,
} from '../commands/schedule.js';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

interface TestBed {
  deps: ScheduleDeps;
  /** Every launchctl argv the command asked for, in order. */
  calls: string[][];
  homeDir: string;
  plistPath: string;
  wrapperPath: string;
}

/**
 * Deps pinned entirely inside the sandbox: home dir, package root and the fake
 * runner. `handler` overrides individual launchctl verdicts; default is success.
 */
function makeDeps(
  s: Sandbox,
  overrides: Partial<ScheduleDeps> = {},
  handler?: (args: string[]) => LaunchctlResult | undefined,
): TestBed {
  const homeDir = join(s.root, 'home');
  const pkgRoot = join(s.root, 'pkg');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), '{}');
  const calls: string[][] = [];
  const deps: ScheduleDeps = {
    platform: 'darwin',
    execPath: '/test/bin/node',
    homeDir,
    uid: 501,
    moduleUrl: pathToFileURL(join(pkgRoot, 'src', 'cli', 'commands', 'schedule.ts')).href,
    launchctl: (args) => {
      calls.push(args);
      return handler?.(args) ?? { status: 0, stdout: '', stderr: '' };
    },
    now: () => NOW,
    ...overrides,
  };
  return {
    deps,
    calls,
    homeDir,
    plistPath: resolvePlistPath(SCHEDULE_LABEL, homeDir),
    wrapperPath: resolveScheduleWrapperPath(s.dataDir),
  };
}

/** `schedule()` with both console channels captured, `runMain`'s shape. */
async function run(
  args: string[],
  deps: ScheduleDeps,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (msg?: unknown) => void out.push(String(msg));
  console.error = (msg?: unknown) => void err.push(String(msg));
  try {
    return { code: await schedule(args, deps), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function dataDirArgs(s: Sandbox, action: string): string[] {
  return [action, '--dataDir', s.dataDir];
}

function plantCronLog(s: Sandbox, text: string): void {
  const path = resolveCronLogPath(s.dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe('1 — registration and dispatch (AC1, AC7)', () => {
  it('schedule --bogus is refused before dispatch, exits 1, names the flag', async () => {
    const { code, err } = await runMain(['schedule', '--bogus']);
    expect(code).toBe(1);
    expect(err).toContain('--bogus');
    expect(err).toContain('agent-lens schedule');
  });

  it.each([
    [['--dataDir', '/x', 'install'], 'install'],
    [['--dataDir=/x', 'status'], 'status'],
    [['disable', '--dataDir', '/y'], 'disable'],
    [[], undefined],
    // The flag's value is consumed by position, never read as the action.
    [['--dataDir', 'install'], undefined],
  ])('parseScheduleAction(%j) → %j', (args, expected) => {
    expect(parseScheduleAction(args)).toBe(expected);
  });

  it('a missing action exits 1 and lists the actions', async () => {
    const s = sb();
    const { code, err } = await run(['--dataDir', s.dataDir], makeDeps(s).deps);
    expect(code).toBe(1);
    expect(err).toContain('install | status | disable');
  });
});

describe('2 — exit codes are 0 and 1 only, never 2, never 3 (AC7)', () => {
  it.each([['bogus-action'], ['on'], ['uninstall']])(
    'unknown action %s exits 1',
    async (action) => {
      const s = sb();
      const { code, err } = await run(dataDirArgs(s, action), makeDeps(s).deps);
      expect(code).toBe(1);
      expect(code).not.toBe(2);
      expect(code).not.toBe(3);
      expect(err).toContain(action);
    },
  );

  it('the non-macOS refusal is 1, not 2 and not 3', async () => {
    const s = sb();
    const { code } = await run(dataDirArgs(s, 'install'), makeDeps(s, { platform: 'linux' }).deps);
    expect(code).toBe(1);
    expect(code).not.toBe(2);
    expect(code).not.toBe(3);
  });
});

describe('3 — the wrapper line round-trips through parseCronLog (AC2)', () => {
  const wrapper = buildWrapperScript({
    nodePath: '/test/bin/node',
    invocation: { packageRoot: '/pkg', kind: 'source' },
    dataDir: '/data',
    cronLogPath: '/data/logs/cron.log',
  });

  it('the wrapper stamps with the exact colon-less format the reader anchors on', () => {
    expect(wrapper).toContain(`date "${CRON_STAMP_FORMAT}"`);
  });

  it.each([
    ['ok', 'ok   agent-lens archive: 12 files, 0 bytes copied'],
    ['ERR3', 'ERR3 archive-side errors — boom'],
    ['ERR127', 'ERR127 env failure'],
  ])('a real `date` stamp + %s token parses as one found entry', (status, tail) => {
    // The actual `date` binary, run with the format string the wrapper embeds —
    // not a hand-typed timestamp that could drift from what ships.
    const stamp = execFileSync('date', [CRON_STAMP_FORMAT], { encoding: 'utf8' }).trim();
    const entries = parseCronLog(`${stamp} ${tail}\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe(status);
    expect(Math.abs(entries[0]!.epochMs - Date.now())).toBeLessThan(5_000);
  });

  it('a multi-line pass summary contributes exactly one entry', () => {
    const stamp = execFileSync('date', [CRON_STAMP_FORMAT], { encoding: 'utf8' }).trim();
    const entries = parseCronLog(`${stamp} ok   leader line\n  61 expired at the source\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('ok');
  });

  it('keeps the bounded-log rotation and the exit-code→token mapping', () => {
    expect(wrapper).toContain('MAX_LINES=5000');
    expect(wrapper).toContain('ERR$CODE');
    expect(wrapper).toContain('exit 2 is reserved product-wide');
  });
});

describe('4 — the generated artifacts are well-formed and non-stale (AC1, AC4)', () => {
  it('the plist carries every hand-tuned property under the generic label', () => {
    const plist = buildPlist({ wrapperPath: '/data/schedule/archive.sh', dataDir: '/data' });
    expect(plist).toContain(`<string>${SCHEDULE_LABEL}</string>`);
    expect(plist).not.toContain(LEGACY_LABEL);
    expect(plist).toContain('<integer>900</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<string>/bin/sh</string>');
    expect(plist).toContain('<string>/data/schedule/archive.sh</string>');
    expect(plist).toContain('<string>Background</string>');
    expect(plist).toContain(join('/data', 'logs', 'launchd.out.log'));
    expect(plist).toContain(join('/data', 'logs', 'launchd.err.log'));
    expect(plist).toContain(WAKE_TIME_CAVEAT);
    // The comment naming KeepAlive as deliberately absent is allowed; the KEY is not.
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });

  it('a source checkout wraps the tsx entry, so stale dist can never run', () => {
    const s = sb();
    const bed = makeDeps(s);
    const invocation = resolveArchiveInvocation(bed.deps.moduleUrl);
    expect(invocation).toEqual({ packageRoot: join(s.root, 'pkg'), kind: 'source' });
    const wrapper = buildWrapperScript({
      nodePath: bed.deps.execPath,
      invocation,
      dataDir: s.dataDir,
      cronLogPath: resolveCronLogPath(s.dataDir),
    });
    expect(wrapper).toContain(
      '--import tsx "$ROOT/src/cli/index.ts" archive --dataDir "$DATA_DIR"',
    );
    expect(wrapper).toContain(`ROOT='${join(s.root, 'pkg')}'`);
    expect(wrapper).toContain(`NODE='/test/bin/node'`);
    expect(wrapper).toContain(`DATA_DIR='${s.dataDir}'`);
    expect(wrapper).toContain(WAKE_TIME_CAVEAT);
  });

  it('a built layout wraps bin/agent-lens.js, which re-resolves its own dist', () => {
    const s = sb();
    const bed = makeDeps(s);
    const builtUrl = pathToFileURL(
      join(s.root, 'pkg', 'dist', 'src', 'cli', 'commands', 'schedule.js'),
    ).href;
    const invocation = resolveArchiveInvocation(builtUrl);
    expect(invocation).toEqual({ packageRoot: join(s.root, 'pkg'), kind: 'built' });
    const wrapper = buildWrapperScript({
      nodePath: bed.deps.execPath,
      invocation,
      dataDir: s.dataDir,
      cronLogPath: resolveCronLogPath(s.dataDir),
    });
    expect(wrapper).toContain('"$NODE" "$ROOT/bin/agent-lens.js" archive --dataDir "$DATA_DIR"');
    expect(wrapper).not.toContain('tsx');
  });
});

describe('5 — turn-on is idempotent: replace, never duplicate (AC3)', () => {
  it('two runs leave exactly one plist and one wrapper, byte-stable', async () => {
    const s = sb();
    const bed = makeDeps(s);

    const first = await run(dataDirArgs(s, 'install'), bed.deps);
    expect(first.code).toBe(0);
    expect(first.out).toContain(WAKE_TIME_CAVEAT);
    const wrapper1 = readFileSync(bed.wrapperPath, 'utf8');
    const plist1 = readFileSync(bed.plistPath, 'utf8');
    // The pass and the log are pinned to the SAME data dir the flag named.
    expect(wrapper1).toContain(`DATA_DIR='${s.dataDir}'`);
    // The label is booted out BEFORE the fresh plist is bootstrapped in.
    expect(bed.calls).toEqual([
      ['bootout', `gui/501/${SCHEDULE_LABEL}`],
      ['bootstrap', 'gui/501', bed.plistPath],
    ]);

    const second = await run(dataDirArgs(s, 'install'), bed.deps);
    expect(second.code).toBe(0);
    expect(readFileSync(bed.wrapperPath, 'utf8')).toBe(wrapper1);
    expect(readFileSync(bed.plistPath, 'utf8')).toBe(plist1);
    // Exactly one of each — no duplicates, no temp residue.
    expect(readdirSync(dirname(bed.plistPath))).toEqual([`${SCHEDULE_LABEL}.plist`]);
    expect(readdirSync(dirname(bed.wrapperPath))).toEqual(['archive.sh']);
  });

  it('modes: wrapper 0700 (ours to run), plist 0644 (launchd reads it)', async () => {
    const s = sb();
    const bed = makeDeps(s);
    await run(dataDirArgs(s, 'install'), bed.deps);
    expect(statSync(bed.wrapperPath).mode & 0o777).toBe(0o700);
    expect(statSync(bed.plistPath).mode & 0o777).toBe(0o644);
  });

  it('falls back to the legacy launchctl verbs when bootstrap fails', async () => {
    const s = sb();
    const bed = makeDeps(s, {}, (args) =>
      args[0] === 'bootstrap' ? { status: 1, stdout: '', stderr: 'nope' } : undefined,
    );
    const { code } = await run(dataDirArgs(s, 'install'), bed.deps);
    expect(code).toBe(0);
    expect(bed.calls).toEqual([
      ['bootout', `gui/501/${SCHEDULE_LABEL}`],
      ['bootstrap', 'gui/501', bed.plistPath],
      ['unload', '-w', bed.plistPath],
      ['load', '-w', bed.plistPath],
    ]);
  });

  it('reports failure as 1 when both launchctl forms refuse', async () => {
    const s = sb();
    const bed = makeDeps(s, {}, (args) =>
      args[0] === 'bootstrap' || args[0] === 'load'
        ? { status: 1, stdout: '', stderr: 'denied' }
        : undefined,
    );
    const { code, err } = await run(dataDirArgs(s, 'install'), bed.deps);
    expect(code).toBe(1);
    expect(err).toContain('launchctl');
    expect(err).toContain('denied');
  });
});

describe('6 — turn-off removes what turn-on created, and nothing else (AC3)', () => {
  it('the data dir and home trees return to their pre-turn-on shape', async () => {
    const s = sb();
    const bed = makeDeps(s);
    // Pre-existing state the job must NOT remove: a cron.log, an archive file,
    // and the LaunchAgents dir itself.
    plantCronLog(s, '2026-09-14T11:55:00+0000 ok   fine\n');
    mkdirSync(join(s.archiveRoot, '-slug'), { recursive: true });
    writeFileSync(join(s.archiveRoot, '-slug', 'sess.jsonl'), '{}\n');
    mkdirSync(dirname(bed.plistPath), { recursive: true });

    const beforeData = [...snapshotTreeSafe(s.dataDir).keys()].sort();
    const beforeHome = [...snapshotTreeSafe(bed.homeDir).keys()].sort();

    await run(dataDirArgs(s, 'install'), bed.deps);
    const off = await run(dataDirArgs(s, 'disable'), bed.deps);

    expect(off.code).toBe(0);
    expect(off.out).toContain(bed.plistPath);
    expect(off.out).toContain(bed.wrapperPath);
    expect([...snapshotTreeSafe(s.dataDir).keys()].sort()).toEqual(beforeData);
    expect([...snapshotTreeSafe(bed.homeDir).keys()].sort()).toEqual(beforeHome);
    // The label was booted out as part of the turn-off.
    expect(bed.calls.at(-1)).toEqual(['bootout', `gui/501/${SCHEDULE_LABEL}`]);
  });

  it('turn-off with nothing on is a clean 0, and says so', async () => {
    const s = sb();
    const bed = makeDeps(s);
    const { code, out } = await run(dataDirArgs(s, 'disable'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('nothing to remove');
  });
});

describe('7 — status distinguishes the three states (AC3, AC4)', () => {
  it('no plist → not installed, exit 0, caveat present', async () => {
    const s = sb();
    const { code, out } = await run(dataDirArgs(s, 'status'), makeDeps(s).deps);
    expect(code).toBe(0);
    expect(out).toContain('not installed');
    expect(out).toContain(WAKE_TIME_CAVEAT);
  });

  it('installed + loaded + recent ok → last successful pass, doctor wording', async () => {
    const s = sb();
    const bed = makeDeps(s);
    await run(dataDirArgs(s, 'install'), bed.deps);
    plantCronLog(s, '2026-09-14T11:55:00+0000 ok   agent-lens archive: 1 files\n');
    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('installed');
    expect(out).toContain('loaded in launchd');
    expect(out).toContain('last successful pass: 5m ago');
    expect(out).toContain(WAKE_TIME_CAVEAT);
  });

  it('installed but the last attempt failed → the failing attempt is named', async () => {
    const s = sb();
    const bed = makeDeps(s);
    await run(dataDirArgs(s, 'install'), bed.deps);
    plantCronLog(
      s,
      '2026-09-14T11:55:00+0000 ok   fine\n' +
        '2026-09-14T11:58:00+0000 ERR3 archive-side errors — boom\n',
    );
    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('most recent attempt: ERR3');
    expect(out).toContain('last successful pass: 5m ago');
  });

  it('plist on disk but launchd does not know the label → NOT loaded', async () => {
    const s = sb();
    const bed = makeDeps(s, {}, (args) =>
      args[0] === 'print' ? { status: 113, stdout: '', stderr: 'not found' } : undefined,
    );
    await run(dataDirArgs(s, 'install'), bed.deps);
    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('NOT loaded');
  });
});

describe('8 — non-macOS platforms get an honest pointer, never a silent no-op (AC5)', () => {
  it('turn-on refuses with the manual alternative, writes nothing, exits 1', async () => {
    const s = sb();
    const bed = makeDeps(s, { platform: 'linux' });
    const { code, err } = await run(dataDirArgs(s, 'install'), bed.deps);
    expect(code).toBe(1);
    expect(err).toContain('systemd');
    expect(err).toContain('Keeping the archive current');
    expect(snapshotTreeSafe(s.dataDir).size).toBe(0);
    expect(snapshotTreeSafe(bed.homeDir).size).toBe(0);
    expect(bed.calls).toEqual([]);
  });

  it('turn-off refuses the same way, exits 1', async () => {
    const s = sb();
    const bed = makeDeps(s, { platform: 'linux' });
    const { code, err } = await run(dataDirArgs(s, 'disable'), bed.deps);
    expect(code).toBe(1);
    expect(err).toContain('Keeping the archive current');
    expect(bed.calls).toEqual([]);
  });

  it('status is a report: same pointer, caveat, exit 0', async () => {
    const s = sb();
    const bed = makeDeps(s, { platform: 'linux' });
    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('Keeping the archive current');
    expect(out).toContain(WAKE_TIME_CAVEAT);
  });
});

describe('9 — the legacy hand-authored job is migrated out, one-way (#83)', () => {
  it('turn-on boots the legacy label out and removes both legacy artifacts', async () => {
    const s = sb();
    const bed = makeDeps(s);
    const legacyPlist = resolvePlistPath(LEGACY_LABEL, bed.homeDir);
    const legacyWrapper = join(bed.homeDir, '.agent-lens', 'archive-cron.sh');
    mkdirSync(dirname(legacyPlist), { recursive: true });
    writeFileSync(legacyPlist, '<plist/>');
    mkdirSync(dirname(legacyWrapper), { recursive: true });
    writeFileSync(legacyWrapper, '#!/bin/sh\n');

    const { code, out } = await run(dataDirArgs(s, 'install'), bed.deps);

    expect(code).toBe(0);
    expect(bed.calls).toEqual([
      ['bootout', `gui/501/${LEGACY_LABEL}`],
      ['bootout', `gui/501/${SCHEDULE_LABEL}`],
      ['bootstrap', 'gui/501', bed.plistPath],
    ]);
    expect(snapshotTreeSafe(dirname(legacyPlist)).has(`${LEGACY_LABEL}.plist`)).toBe(false);
    expect(snapshotTreeSafe(dirname(legacyWrapper)).has('archive-cron.sh')).toBe(false);
    expect(readdirSync(dirname(bed.plistPath))).toEqual([`${SCHEDULE_LABEL}.plist`]);
    expect(out).toContain('migrated the legacy');
  });

  it('with no legacy artifacts present, no legacy bootout is even attempted', async () => {
    const s = sb();
    const bed = makeDeps(s);
    await run(dataDirArgs(s, 'install'), bed.deps);
    expect(bed.calls.some((args) => args.includes(`gui/501/${LEGACY_LABEL}`))).toBe(false);
  });
});
