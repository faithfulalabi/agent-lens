// `agent-lens schedule` — both backends. Pure builders get pure tests; argv
// rejection goes through `runMain`; anything touching disk drives `schedule()` with
// injected deps against `makeSandbox()`.
//
// ⚠️ NO test here may run a real `launchctl`, `systemctl` or `loginctl`, or touch a
// real `~/Library/LaunchAgents` or `~/.config/systemd/user`. One reasoned exception:
// describe 18's `it.runIf(process.platform === 'linux')` drives `runMain` with REAL
// deps, the only way to exercise the throw→exit-1 mapping in `index.ts`. Safe
// because the systemd turn-on asserts every path before the first `mkdirSync`, so a
// refused `--dataDir` returns 1 having written nothing and run no binary; guarded to
// Linux because on macOS the same call could run a real `launchctl bootout`.
//
// Describe 17 pins that exception by grepping this file for `runMain` calls naming
// the command, so prose here must never spell a call shape the grep reads as code.
//
// Running the GENERATED wrapper under `/bin/sh` is not a second exception to that
// rule. The rule names three binaries and two directories; `/bin/sh` is in neither
// class, exactly as the real `date` this file already runs is in neither. Such a run
// evaluates the wrapper's preconditions against a sandbox tree and exits before it
// would reach `node`, so it loads nothing and arms nothing.

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  captureConsole,
  pinSandboxEnv,
  runMain,
  snapshotTreeSafe,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';
import { useSandbox } from '../../archive/__tests__/use-sandbox.js';
import { parseCronLog } from '../../archive/cron-log.js';
import {
  resolveCronLogPath,
  resolvePlistPath,
  resolveScheduleWrapperPath,
  resolveSystemdUnitPath,
  resolveSystemdUserDir,
  resolveSystemdWantsPath,
} from '../../archive/paths.js';
import {
  buildPlist,
  BUILT_CLI_ENTRY,
  buildSystemdService,
  buildSystemdTimer,
  buildWrapperScript,
  CRON_STAMP_FORMAT,
  escapeUnitValue,
  LEGACY_LABEL,
  LINGER_CAVEAT,
  parseScheduleAction,
  resolveArchiveInvocation,
  schedule,
  SCHEDULE_LABEL,
  SYSTEMD_UNIT_BASE,
  WAKE_TIME_CAVEAT,
  type CommandResult,
  type LaunchctlResult,
  type ScheduleDeps,
} from '../commands/schedule.js';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

const SERVICE_UNIT = `${SYSTEMD_UNIT_BASE}.service`;
const TIMER_UNIT = `${SYSTEMD_UNIT_BASE}.timer`;

const sb = useSandbox();

/** A fake verdict per argv; `undefined` falls through to plain success. */
type Handler = (args: string[]) => CommandResult | undefined;

interface Fakes {
  systemctl?: Handler;
  loginctl?: Handler;
}

interface TestBed {
  deps: ScheduleDeps;
  /** Every launchctl argv the command asked for, in order. */
  calls: string[][];
  /** The same, for the two Linux runners — the exact-array idiom, per binary. */
  systemctlCalls: string[][];
  loginctlCalls: string[][];
  homeDir: string;
  plistPath: string;
  wrapperPath: string;
  unitDir: string;
  servicePath: string;
  timerPath: string;
  wantsPath: string;
}

/**
 * Deps pinned entirely inside the sandbox; every runner defaults to success.
 * `configHome: undefined` is required — it is what sends unit writes under the
 * sandboxed `homeDir` instead of a real `XDG_CONFIG_HOME`.
 */
function makeDeps(
  s: Sandbox,
  overrides: Partial<ScheduleDeps> = {},
  handler?: (args: string[]) => LaunchctlResult | undefined,
  fakes: Fakes = {},
): TestBed {
  const homeDir = join(s.root, 'home');
  const pkgRoot = join(s.root, 'pkg');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), '{}');
  const calls: string[][] = [];
  const systemctlCalls: string[][] = [];
  const loginctlCalls: string[][] = [];
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
    systemctl: (args) => {
      systemctlCalls.push(args);
      return fakes.systemctl?.(args) ?? { status: 0, stdout: '', stderr: '' };
    },
    // Default `Linger=no`, so the recommended "print the command" path is what
    // the default bed exercises. The `yes` and `unknown` arms are explicit tests.
    loginctl: (args) => {
      loginctlCalls.push(args);
      return fakes.loginctl?.(args) ?? { status: 0, stdout: 'Linger=no\n', stderr: '' };
    },
    configHome: undefined,
    now: () => NOW,
    ...overrides,
  };
  const configHome = deps.configHome;
  return {
    deps,
    calls,
    systemctlCalls,
    loginctlCalls,
    homeDir: deps.homeDir,
    plistPath: resolvePlistPath(SCHEDULE_LABEL, deps.homeDir),
    wrapperPath: resolveScheduleWrapperPath(s.dataDir),
    unitDir: resolveSystemdUserDir(deps.homeDir, configHome),
    servicePath: resolveSystemdUnitPath(SERVICE_UNIT, deps.homeDir, configHome),
    timerPath: resolveSystemdUnitPath(TIMER_UNIT, deps.homeDir, configHome),
    wantsPath: resolveSystemdWantsPath(TIMER_UNIT, deps.homeDir, configHome),
  };
}

/** `makeDeps` on the systemd backend. The bed default stays `darwin`, deliberately. */
function linuxBed(s: Sandbox, overrides: Partial<ScheduleDeps> = {}, fakes: Fakes = {}): TestBed {
  return makeDeps(s, { platform: 'linux', uid: 1000, ...overrides }, undefined, fakes);
}

/** What a real `enable` plants, so turn-off has a symlink to find. */
function plantWantsSymlink(bed: TestBed): void {
  mkdirSync(dirname(bed.wantsPath), { recursive: true });
  symlinkSync(bed.timerPath, bed.wantsPath);
}

/** `schedule()` with both console channels captured, `runMain`'s shape. */
async function run(
  args: string[],
  deps: ScheduleDeps,
): Promise<{ code: number; out: string; err: string }> {
  const { value: code, out, err } = await captureConsole(() => schedule(args, deps));
  return { code, out, err };
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

  it('the unsupported-platform refusal is 1, not 2 and not 3', async () => {
    const s = sb();
    const { code } = await run(dataDirArgs(s, 'install'), makeDeps(s, { platform: 'win32' }).deps);
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
    // `tsx` is a devDependency, so it exists only in a checkout's own
    // `node_modules` — the one layout where this guard is the right question.
    expect(wrapper).toContain('[ -d "$ROOT/node_modules" ]');
    expect(wrapper).toContain('FATAL node_modules missing — run npm install in $ROOT');
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
    // ★ The defect this task fixes. npm hoists the package's dependencies to an
    // ANCESTOR of `$ROOT` in every published layout, so demanding
    // `$ROOT/node_modules` here FATALs on a perfectly good install.
    expect(wrapper).not.toContain('$ROOT/node_modules');
    expect(wrapper).not.toContain('node_modules missing');
    // `-f` on the file the shim imports, not `-d dist`: a directory test passes on
    // an empty `dist/` and the failure then arrives as a stack trace. Spelled
    // LITERALLY, not through `BUILT_CLI_ENTRY`: interpolating the constant would
    // make this assertion true of whatever the constant later became.
    expect(wrapper).toContain('[ -f "$ROOT/dist/src/cli/index.js" ]');
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
    // Pass and log pinned to the SAME data dir the flag named.
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

describe('8 — a platform that is neither gets an honest pointer, never a silent no-op (AC5)', () => {
  it('turn-on refuses with the manual alternative, writes nothing, exits 1', async () => {
    const s = sb();
    const bed = makeDeps(s, { platform: 'win32' });
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
    const bed = makeDeps(s, { platform: 'win32' });
    const { code, err } = await run(dataDirArgs(s, 'disable'), bed.deps);
    expect(code).toBe(1);
    expect(err).toContain('Keeping the archive current');
    expect(bed.calls).toEqual([]);
  });

  it('status is a report: same pointer, caveat, exit 0', async () => {
    const s = sb();
    const bed = makeDeps(s, { platform: 'win32' });
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

describe('10 — the Linux turn-on writes both units and arms the timer (AC1)', () => {
  it('writes timer, service and wrapper, and calls the four verbs in order', async () => {
    const s = sb();
    const bed = linuxBed(s);

    const { code, out } = await run(dataDirArgs(s, 'install'), bed.deps);

    expect(code).toBe(0);
    expect(readFileSync(bed.timerPath, 'utf8')).toContain('[Timer]');
    expect(readFileSync(bed.servicePath, 'utf8')).toContain('[Service]');
    expect(readFileSync(bed.wrapperPath, 'utf8')).toContain('#!/bin/sh');
    // `--user` spelled out at every call site, and the order is load-bearing:
    // arm the timer, THEN run one pass immediately so a fresh turn-on does not
    // wait out a whole 15-minute slot.
    expect(bed.systemctlCalls).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', TIMER_UNIT],
      ['--user', 'restart', TIMER_UNIT],
      ['--user', 'start', '--no-block', SERVICE_UNIT],
    ]);
    expect(bed.calls).toEqual([]);
    // One read-only linger query, against the INJECTED uid.
    expect(bed.loginctlCalls).toEqual([['show-user', '1000', '--property=Linger']]);
    expect(out).toContain(bed.timerPath);
    expect(out).toContain(bed.servicePath);
    expect(out).toContain(bed.wrapperPath);
    expect(out).toContain(resolveCronLogPath(s.dataDir));
    expect(out).toContain(`journalctl --user -u ${SERVICE_UNIT}`);
    expect(out).toContain(WAKE_TIME_CAVEAT);
    expect(out).toContain(LINGER_CAVEAT);
    expect(out).toContain('loginctl enable-linger 1000');
  });

  it('the unit text carries every directive the design turns on', async () => {
    const s = sb();
    const bed = linuxBed(s);
    await run(dataDirArgs(s, 'install'), bed.deps);

    const timer = readFileSync(bed.timerPath, 'utf8');
    expect(timer).toContain('OnCalendar=*:0/15');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('AccuracySec=1min');
    expect(timer).toContain(`Unit=${SERVICE_UNIT}`);
    expect(timer).toContain('WantedBy=timers.target');
    // Deliberately absent: an OnUnitActiveSec timer reports an empty
    // NextElapseUSecRealtime, so `status` would have no next trigger to print.
    expect(timer).not.toContain('OnUnitActiveSec');

    const service = readFileSync(bed.servicePath, 'utf8');
    expect(service).toContain('Type=oneshot');
    expect(service).toContain(`ExecStart=/bin/sh "${bed.wrapperPath}"`);
    // The journal is the unit-level debug surface; no `append:` file mirroring.
    expect(service).not.toContain('StandardOutput=');
  });

  it('modes: wrapper 0700 (ours to run), units 0644 (systemd reads them)', async () => {
    const s = sb();
    const bed = linuxBed(s);
    await run(dataDirArgs(s, 'install'), bed.deps);
    expect(statSync(bed.wrapperPath).mode & 0o777).toBe(0o700);
    expect(statSync(bed.timerPath).mode & 0o777).toBe(0o644);
    expect(statSync(bed.servicePath).mode & 0o777).toBe(0o644);
    // 0o700 for a unit dir this command created.
    expect(statSync(bed.unitDir).mode & 0o777).toBe(0o700);
  });

  it('lingering already on prints a confirmation, not homework', async () => {
    const s = sb();
    const bed = linuxBed(
      s,
      {},
      { loginctl: () => ({ status: 0, stdout: 'Linger=yes\n', stderr: '' }) },
    );
    const { code, out } = await run(dataDirArgs(s, 'install'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('lingering: on');
    expect(out).not.toContain('enable-linger');
  });
});

describe('11 — both backends share the wrapper and the cron.log contract', () => {
  it('the wrapper the Linux turn-on writes is byte-identical to the macOS one', async () => {
    const s = sb();
    await run(dataDirArgs(s, 'install'), makeDeps(s).deps);
    const fromLaunchd = readFileSync(resolveScheduleWrapperPath(s.dataDir), 'utf8');

    await run(dataDirArgs(s, 'install'), linuxBed(s).deps);
    const fromSystemd = readFileSync(resolveScheduleWrapperPath(s.dataDir), 'utf8');

    // Not a paraphrase of equality — the actual bytes. A second log format would
    // break `doctor`'s freshness report on one platform only.
    expect(fromSystemd).toBe(fromLaunchd);
  });

  it('a real `date` stamp from the Linux-written wrapper parses as one found entry', async () => {
    const s = sb();
    const bed = linuxBed(s);
    await run(dataDirArgs(s, 'install'), bed.deps);
    const wrapper = readFileSync(bed.wrapperPath, 'utf8');
    expect(wrapper).toContain(`date "${CRON_STAMP_FORMAT}"`);

    const stamp = execFileSync('date', [CRON_STAMP_FORMAT], { encoding: 'utf8' }).trim();
    const entries = parseCronLog(`${stamp} ok   agent-lens archive: 3 files\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('ok');
  });
});

// ★ Byte pins for the launchd output; the other assertions are `toContain` checks,
// so a shared-code change could alter a generated byte without reddening anything.
// Plain string constants, deliberately NOT `toMatchInlineSnapshot`, so `vitest -u`
// cannot rewrite them. If one reds, read the diff — never retype the constant.
const WRAPPER_GOLDEN_96cbd39 = [
  '#!/bin/sh',
  '# agent-lens archive — unattended pass, invoked by the launchd agent',
  '# com.agent-lens.archive every 15 minutes.',
  '#',
  '# GENERATED by `agent-lens schedule` — do not edit. Turning the job on again',
  '# rewrites this file in full, which is what keeps it current with the package',
  '# that shipped it.',
  '#',
  '# Coverage is wake-time-bounded: a wall-clock schedule does not fire while the machine is asleep — treat the interval as a bound on wake time, not on elapsed time.',
  '#',
  "# Exit codes are the archive command's own and are load-bearing:",
  '#   0 = clean pass       1 = usage error / crash       3 = archive-side errors',
  '#   2 is RESERVED product-wide and must never appear here.',
  'set -u',
  '',
  "NODE='/test/bin/node'",
  "ROOT='/pkg'",
  "DATA_DIR='/data'",
  "LOG='/data/logs/cron.log'",
  'MAX_LINES=5000',
  '',
  '# launchd hands over a minimal PATH. The node binary is addressed absolutely so',
  '# the pass cannot hit an `env: node` lookup failure, and the export keeps',
  '# anything the pass shells out to on a sane PATH too.',
  'PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"',
  'export PATH',
  '',
  'mkdir -p "$(dirname "$LOG")"',
  '',
  'stamp() { date "+%Y-%m-%dT%H:%M:%S%z"; }',
  'say() { printf \'%s %s\\n\' "$(stamp)" "$1" >>"$LOG"; }',
  '',
  '# Preconditions are logged loudly rather than failing silently: a job that',
  '# quietly does nothing is indistinguishable from one that is working.',
  '[ -d "$ROOT" ]              || { say "FATAL package root missing: $ROOT"; exit 1; }',
  '[ -x "$NODE" ]              || { say "FATAL node missing: $NODE"; exit 1; }',
  '[ -e "$ROOT/src/cli/index.ts" ] || { say "FATAL entry missing: $ROOT/src/cli/index.ts"; exit 1; }',
  '[ -d "$ROOT/node_modules" ] || { say "FATAL node_modules missing — run npm install in $ROOT"; exit 1; }',
  '',
  'cd "$ROOT" || { say "FATAL cannot cd to $ROOT"; exit 1; }',
  '',
  'OUT=$("$NODE" --import tsx "$ROOT/src/cli/index.ts" archive --dataDir "$DATA_DIR" 2>&1)',
  'CODE=$?',
  '',
  'case "$CODE" in',
  '  0) say "ok   $OUT" ;;',
  '  3) say "ERR3 archive-side errors — $OUT" ;;',
  '  2) say "BUG  exit 2 is reserved product-wide and must never come from archive — $OUT" ;;',
  '  *) say "ERR$CODE $OUT" ;;',
  'esac',
  '',
  '# Bounded log: keep the most recent MAX_LINES so months of 15-minute passes',
  '# cannot fill the disk the archive depends on.',
  'if [ -f "$LOG" ]; then',
  '  LINES=$(wc -l <"$LOG" 2>/dev/null || echo 0)',
  '  if [ "$LINES" -gt "$MAX_LINES" ]; then',
  '    tail -n "$MAX_LINES" "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"',
  '  fi',
  'fi',
  '',
  'exit "$CODE"',
  '',
].join('\n');

// ★ The same pin for the BUILT layout, which had no byte golden until now — which
// is how a guard that was wrong for every published install shipped while the
// source-layout golden above stayed green.
//
// NAMING, deliberately different from the two constants that bracket it: no sha
// suffix, because the generating commit cannot be known before it exists, and no
// task pointer. The `96cbd39` names are back-fills that recorded the commit whose
// output they captured after the fact; this one is written in the same commit as
// the builder change it pins, so there is nothing to back-fill. Do not "fix" the
// inconsistency by inventing a sha for this one.
//
// It must differ from WRAPPER_GOLDEN_96cbd39 in EXACTLY three lines — the entry
// test, the fourth precondition, and the `OUT=` run line — and nowhere else.
const WRAPPER_BUILT_GOLDEN = [
  '#!/bin/sh',
  '# agent-lens archive — unattended pass, invoked by the launchd agent',
  '# com.agent-lens.archive every 15 minutes.',
  '#',
  '# GENERATED by `agent-lens schedule` — do not edit. Turning the job on again',
  '# rewrites this file in full, which is what keeps it current with the package',
  '# that shipped it.',
  '#',
  '# Coverage is wake-time-bounded: a wall-clock schedule does not fire while the machine is asleep — treat the interval as a bound on wake time, not on elapsed time.',
  '#',
  "# Exit codes are the archive command's own and are load-bearing:",
  '#   0 = clean pass       1 = usage error / crash       3 = archive-side errors',
  '#   2 is RESERVED product-wide and must never appear here.',
  'set -u',
  '',
  "NODE='/test/bin/node'",
  "ROOT='/pkg'",
  "DATA_DIR='/data'",
  "LOG='/data/logs/cron.log'",
  'MAX_LINES=5000',
  '',
  '# launchd hands over a minimal PATH. The node binary is addressed absolutely so',
  '# the pass cannot hit an `env: node` lookup failure, and the export keeps',
  '# anything the pass shells out to on a sane PATH too.',
  'PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"',
  'export PATH',
  '',
  'mkdir -p "$(dirname "$LOG")"',
  '',
  'stamp() { date "+%Y-%m-%dT%H:%M:%S%z"; }',
  'say() { printf \'%s %s\\n\' "$(stamp)" "$1" >>"$LOG"; }',
  '',
  '# Preconditions are logged loudly rather than failing silently: a job that',
  '# quietly does nothing is indistinguishable from one that is working.',
  '[ -d "$ROOT" ]              || { say "FATAL package root missing: $ROOT"; exit 1; }',
  '[ -x "$NODE" ]              || { say "FATAL node missing: $NODE"; exit 1; }',
  '[ -e "$ROOT/bin/agent-lens.js" ] || { say "FATAL entry missing: $ROOT/bin/agent-lens.js"; exit 1; }',
  '[ -f "$ROOT/dist/src/cli/index.js" ] || { say "FATAL built CLI missing: $ROOT/dist/src/cli/index.js — reinstall @faithfulalabi/agent-lens"; exit 1; }',
  '',
  'cd "$ROOT" || { say "FATAL cannot cd to $ROOT"; exit 1; }',
  '',
  'OUT=$("$NODE" "$ROOT/bin/agent-lens.js" archive --dataDir "$DATA_DIR" 2>&1)',
  'CODE=$?',
  '',
  'case "$CODE" in',
  '  0) say "ok   $OUT" ;;',
  '  3) say "ERR3 archive-side errors — $OUT" ;;',
  '  2) say "BUG  exit 2 is reserved product-wide and must never come from archive — $OUT" ;;',
  '  *) say "ERR$CODE $OUT" ;;',
  'esac',
  '',
  '# Bounded log: keep the most recent MAX_LINES so months of 15-minute passes',
  '# cannot fill the disk the archive depends on.',
  'if [ -f "$LOG" ]; then',
  '  LINES=$(wc -l <"$LOG" 2>/dev/null || echo 0)',
  '  if [ "$LINES" -gt "$MAX_LINES" ]; then',
  '    tail -n "$MAX_LINES" "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"',
  '  fi',
  'fi',
  '',
  'exit "$CODE"',
  '',
].join('\n');

const PLIST_GOLDEN_96cbd39 = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '  <key>Label</key>',
  '  <string>com.agent-lens.archive</string>',
  '',
  '  <!-- Coverage is wake-time-bounded: a wall-clock schedule does not fire while the machine is asleep — treat the interval as a bound on wake time, not on elapsed time. -->',
  '',
  '  <!-- /bin/sh rather than the script directly: launchd exec failures are then',
  '       reported against a known-good binary, so a broken shebang or a lost',
  '       +x bit shows up as a script error instead of a silent no-op. -->',
  '  <key>ProgramArguments</key>',
  '  <array>',
  '    <string>/bin/sh</string>',
  '    <string>/data/schedule/archive.sh</string>',
  '  </array>',
  '',
  '  <key>StartInterval</key>',
  '  <integer>900</integer>',
  '',
  '  <!-- Catch up immediately at login rather than waiting out the first interval:',
  '       the gap after a reboot is exactly when expiry is most likely to have run. -->',
  '  <key>RunAtLoad</key>',
  '  <true/>',
  '',
  '  <!-- launchd-level failures ONLY (exec errors, Full Disk Access denials).',
  "       The pass's own results go to logs/cron.log via the wrapper. -->",
  '  <key>StandardOutPath</key>',
  '  <string>/data/logs/launchd.out.log</string>',
  '  <key>StandardErrorPath</key>',
  '  <string>/data/logs/launchd.err.log</string>',
  '',
  '  <key>ProcessType</key>',
  '  <string>Background</string>',
  '',
  '  <!-- Deliberately NOT set: KeepAlive. This is a periodic batch job, not a',
  '       daemon; KeepAlive would restart it in a tight loop after every exit. -->',
  '</dict>',
  '</plist>',
  '',
].join('\n');

describe('12 — the launchd bytes are pinned, so no shared-code change can drift them (AC5)', () => {
  it('the wrapper is byte-for-byte what 96cbd39 generated', () => {
    expect(
      buildWrapperScript({
        nodePath: '/test/bin/node',
        invocation: { packageRoot: '/pkg', kind: 'source' },
        dataDir: '/data',
        cronLogPath: '/data/logs/cron.log',
      }),
    ).toBe(WRAPPER_GOLDEN_96cbd39);
  });

  it('the plist is byte-for-byte what 96cbd39 generated', () => {
    expect(buildPlist({ wrapperPath: '/data/schedule/archive.sh', dataDir: '/data' })).toBe(
      PLIST_GOLDEN_96cbd39,
    );
  });

  it('the built-layout wrapper is byte-for-byte its own golden', () => {
    expect(
      buildWrapperScript({
        nodePath: '/test/bin/node',
        invocation: { packageRoot: '/pkg', kind: 'built' },
        dataDir: '/data',
        cronLogPath: '/data/logs/cron.log',
      }),
    ).toBe(WRAPPER_BUILT_GOLDEN);
  });

  it('the two layouts differ in exactly the three kind-dependent lines', () => {
    // The two-sided form of the pin. Either golden alone can be edited to match a
    // drifted builder; this says the ONLY licensed divergence between the layouts
    // is the entry test, the fourth precondition and the run line. A shared-code
    // change that leaked into one layout only would show up here as a fourth line.
    const source = WRAPPER_GOLDEN_96cbd39.split('\n');
    const built = WRAPPER_BUILT_GOLDEN.split('\n');
    expect(built).toHaveLength(source.length);
    const differing = source
      .map((line, i) => (line === built[i] ? null : built[i]!))
      .filter((line): line is string => line !== null);
    expect(differing).toEqual([
      '[ -e "$ROOT/bin/agent-lens.js" ] || { say "FATAL entry missing: $ROOT/bin/agent-lens.js"; exit 1; }',
      `[ -f "$ROOT/${BUILT_CLI_ENTRY}" ] || { say "FATAL built CLI missing: $ROOT/${BUILT_CLI_ENTRY} — reinstall @faithfulalabi/agent-lens"; exit 1; }`,
      'OUT=$("$NODE" "$ROOT/bin/agent-lens.js" archive --dataDir "$DATA_DIR" 2>&1)',
    ]);
  });
});

describe('13 — Linux status is a report in every state, always 0 (AC2)', () => {
  /** `show` output in the order systemd replies in — not the asked order. */
  const SHOW_REPLY =
    'NextElapseUSecRealtime=Mon 2026-09-14 12:15:00 UTC\n' +
    'ActiveState=active\n' +
    'Result=success\n' +
    'LastTriggerUSec=Mon 2026-09-14 12:00:00 UTC\n' +
    'UnitFileState=enabled\n';

  function showing(stdout: string, status = 0): Fakes {
    return {
      systemctl: (args) => (args.includes('show') ? { status, stdout, stderr: '' } : undefined),
    };
  }

  it('nothing installed → the lstat gate answers, `show` is never asked (exit 0)', async () => {
    const s = sb();
    const bed = linuxBed(s);
    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('not installed');
    expect(out).toContain('agent-lens schedule install');
    // Load-bearing: `show` on an absent unit exits 0 with every value empty, so it
    // can never be the thing that decides "installed".
    expect(bed.systemctlCalls).toEqual([]);
    expect(out).toContain(WAKE_TIME_CAVEAT);
  });

  it('installed and active → both timestamps echo VERBATIM, keys read as a map', async () => {
    const s = sb();
    const bed = linuxBed(s, {}, showing(SHOW_REPLY));
    await run(dataDirArgs(s, 'install'), bed.deps);
    plantCronLog(s, '2026-09-14T11:55:00+0000 ok   agent-lens archive: 1 files\n');

    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);

    expect(code).toBe(0);
    expect(out).toContain(`installed — ${bed.timerPath}`);
    expect(out).toContain('timer state: active');
    expect(out).toContain('unit file: enabled');
    // Verbatim, because nothing here parses a systemd-locale timestamp.
    expect(out).toContain('next trigger: Mon 2026-09-14 12:15:00 UTC');
    expect(out).toContain('last trigger: Mon 2026-09-14 12:00:00 UTC');
    expect(out).toContain('last result: success');
    // One `show`, asking for all five properties at once.
    expect(bed.systemctlCalls.at(-1)).toEqual([
      '--user',
      'show',
      TIMER_UNIT,
      '--property=ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec,Result',
    ]);
    // The EXISTING freshness path, through formatLastPassSection.
    expect(out).toContain('last successful pass: 5m ago');
  });

  it('installed but idle → reported as inactive, still exit 0', async () => {
    const s = sb();
    const bed = linuxBed(s, {}, showing('ActiveState=inactive\nUnitFileState=enabled\n'));
    await run(dataDirArgs(s, 'install'), bed.deps);
    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('timer state: inactive');
    expect(out).toContain('next trigger: unknown');
  });

  it('an empty UnitFileState= is reported as unknown, never as a fact', async () => {
    const s = sb();
    const bed = linuxBed(s, {}, showing('ActiveState=inactive\nUnitFileState=\n'));
    await run(dataDirArgs(s, 'install'), bed.deps);
    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('unit file: unknown');
    // The file IS on disk — the lstat said so — so "not installed" would be a lie.
    expect(out).not.toContain('not installed');
  });

  it.each([
    ['Linger=yes\n', 0, 'lingering: on'],
    ['Linger=no\n', 0, 'lingering: off'],
    // `loginctl show-user` with no argument exits 0 printing nothing. A naive parser
    // reads that as "off"; it must read as unknown.
    ['', 0, 'lingering: unknown'],
    ['', 1, 'lingering: unknown'],
  ])('loginctl %j (exit %i) → %s', async (stdout, status, expected) => {
    const s = sb();
    const bed = linuxBed(s, {}, { loginctl: () => ({ status, stdout, stderr: '' }) });
    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain(expected);
  });
});

describe('14 — the Linux turn-off removes exactly what the turn-on created (AC3)', () => {
  it('removes both units, the wants symlink and the wrapper; leaves the rest', async () => {
    const s = sb();
    const bed = linuxBed(s);
    plantCronLog(s, '2026-09-14T11:55:00+0000 ok   fine\n');
    mkdirSync(join(s.archiveRoot, '-slug'), { recursive: true });
    writeFileSync(join(s.archiveRoot, '-slug', 'sess.jsonl'), '{}\n');

    const beforeData = [...snapshotTreeSafe(s.dataDir).keys()].sort();
    await run(dataDirArgs(s, 'install'), bed.deps);
    plantWantsSymlink(bed);
    // A sibling unit, to prove the shared dirs are not swept.
    writeFileSync(join(bed.unitDir, 'other.timer'), '[Timer]\n');

    const off = await run(dataDirArgs(s, 'disable'), bed.deps);

    expect(off.code).toBe(0);
    for (const path of [bed.timerPath, bed.servicePath, bed.wantsPath, bed.wrapperPath]) {
      expect(off.out).toContain(path);
      expect(snapshotTreeSafe(dirname(path)).has(basename(path))).toBe(false);
    }
    // cron.log and the archive are untouched: the data dir is back to its
    // pre-turn-on shape, `<dataDir>/schedule` included.
    expect([...snapshotTreeSafe(s.dataDir).keys()].sort()).toEqual(beforeData);
    // The SHARED dirs stay, and so does the sibling unit — `removeEmptyDir` is
    // deliberately pointed only at `<dataDir>/schedule`.
    expect(readdirSync(bed.unitDir).sort()).toEqual(['other.timer', 'timers.target.wants']);
    expect(statSync(dirname(bed.wantsPath)).isDirectory()).toBe(true);
    // Two verbs, not `disable --now`, then a reload once the files are gone.
    expect(bed.systemctlCalls.slice(-3)).toEqual([
      ['--user', 'stop', TIMER_UNIT],
      ['--user', 'disable', TIMER_UNIT],
      ['--user', 'daemon-reload'],
    ]);
  });

  it('a refused `disable` still clears the dangling symlink, warns, and exits 0', async () => {
    const s = sb();
    // `disable` on a unit whose file is gone exits 1 and leaves
    // `timers.target.wants/<timer>` behind as a dangling link.
    const bed = linuxBed(
      s,
      {},
      {
        systemctl: (args) =>
          args.includes('disable') || args.includes('stop')
            ? { status: 1, stdout: '', stderr: `Unit file ${TIMER_UNIT} does not exist.` }
            : undefined,
      },
    );
    await run(dataDirArgs(s, 'install'), bed.deps);
    plantWantsSymlink(bed);

    const { code, out } = await run(dataDirArgs(s, 'disable'), bed.deps);

    expect(code).toBe(0);
    expect(readdirSync(dirname(bed.wantsPath))).toEqual([]);
    expect(out).toContain('warning:');
    expect(out).toContain('does not exist.');
    expect(out).toContain('removed anyway');
  });

  it('turn-off with nothing on is a clean 0, says so, and warns about nothing', async () => {
    const s = sb();
    const bed = linuxBed(
      s,
      {},
      {
        systemctl: (args) =>
          args.includes('stop') ? { status: 1, stdout: '', stderr: 'no such unit' } : undefined,
      },
    );
    const { code, out } = await run(dataDirArgs(s, 'disable'), bed.deps);
    expect(code).toBe(0);
    expect(out).toContain('nothing to remove');
    // Nothing was installed, so a refusal is not worth a warning.
    expect(out).not.toContain('warning:');
  });
});

describe('15 — two Linux turn-ons leave exactly one timer and one service (AC4)', () => {
  it('byte-stable, no temp residue, and nothing is asserted about pass count', async () => {
    const s = sb();
    const bed = linuxBed(s);

    expect((await run(dataDirArgs(s, 'install'), bed.deps)).code).toBe(0);
    const timer1 = readFileSync(bed.timerPath, 'utf8');
    const service1 = readFileSync(bed.servicePath, 'utf8');
    const wrapper1 = readFileSync(bed.wrapperPath, 'utf8');
    plantWantsSymlink(bed);

    expect((await run(dataDirArgs(s, 'install'), bed.deps)).code).toBe(0);

    expect(readFileSync(bed.timerPath, 'utf8')).toBe(timer1);
    expect(readFileSync(bed.servicePath, 'utf8')).toBe(service1);
    expect(readFileSync(bed.wrapperPath, 'utf8')).toBe(wrapper1);
    // Exactly one of each, plus the symlink dir a real `enable` makes. No
    // `.tmp.<pid>` residue from the atomic writes.
    expect(readdirSync(bed.unitDir).sort()).toEqual([
      SERVICE_UNIT,
      TIMER_UNIT,
      'timers.target.wants',
    ]);
    expect(readdirSync(dirname(bed.wrapperPath))).toEqual(['archive.sh']);
    // NOT asserted: how many passes ran. `restart` on a Persistent timer can itself
    // fire a catch-up, and counting them would pin systemd internals.
  });
});

describe('16 — macOS is untouched, and a third platform still gets a pointer (AC5, AC6)', () => {
  it('platform darwin still takes the launchd path and no new binary is called', async () => {
    const s = sb();
    const bed = makeDeps(s);
    const { code } = await run(dataDirArgs(s, 'install'), bed.deps);
    expect(code).toBe(0);
    expect(readFileSync(bed.plistPath, 'utf8')).toContain('<plist version="1.0">');
    expect(bed.calls).toEqual([
      ['bootout', `gui/501/${SCHEDULE_LABEL}`],
      ['bootstrap', 'gui/501', bed.plistPath],
    ]);
    expect(bed.systemctlCalls).toEqual([]);
    expect(bed.loginctlCalls).toEqual([]);
    // No systemd artifact anywhere near a macOS turn-on.
    expect(snapshotTreeSafe(join(bed.homeDir, '.config')).size).toBe(0);
  });

  it.each([
    ['install', 1],
    ['disable', 1],
    ['status', 0],
  ])('win32 %s exits %i with a pointer that names Linux as supported', async (action, expected) => {
    const s = sb();
    const bed = makeDeps(s, { platform: 'win32' });
    const { code, out, err } = await run(dataDirArgs(s, action), bed.deps);
    const text = out + err;
    expect(code).toBe(expected);
    expect(text).toContain('systemd user timer on Linux');
    expect(text).toContain('cron');
    expect(text).toContain('Keeping the archive current');
    expect(snapshotTreeSafe(s.dataDir).size).toBe(0);
    expect(snapshotTreeSafe(bed.homeDir).size).toBe(0);
    expect(bed.calls).toEqual([]);
    expect(bed.systemctlCalls).toEqual([]);
    expect(bed.loginctlCalls).toEqual([]);
  });
});

describe('17 — no real binary and no real unit dir can be reached (AC7)', () => {
  it('the default unit dir is inside the sandbox, never a real ~/.config', () => {
    const s = sb();
    const bed = linuxBed(s);
    expect(resolveSystemdUserDir(bed.homeDir, undefined).startsWith(s.root)).toBe(true);
    expect(bed.timerPath).toBe(join(bed.homeDir, '.config', 'systemd', 'user', TIMER_UNIT));
  });

  it('the injected configHome decides where units land', async () => {
    const s = sb();
    const configHome = join(s.root, 'xdg-config');
    const bed = linuxBed(s, { configHome });
    await run(dataDirArgs(s, 'install'), bed.deps);
    expect(bed.unitDir).toBe(join(configHome, 'systemd', 'user'));
    expect(readdirSync(bed.unitDir).sort()).toEqual([SERVICE_UNIT, TIMER_UNIT]);
  });

  it('an ambient XDG_CONFIG_HOME cannot retarget a unit write — the DEP decides', async () => {
    const s = sb();
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/nonexistent/ambient/config';
    try {
      const bed = linuxBed(s);
      await run(dataDirArgs(s, 'install'), bed.deps);
      expect(bed.unitDir.startsWith(bed.homeDir)).toBe(true);
      expect(readFileSync(bed.timerPath, 'utf8')).toContain('[Timer]');
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });

  // ★ `deps = realDeps()` is a default parameter, so `tsc` cannot stop a `runMain`
  // call from reaching the real machine; the call sites are pinned by text instead.
  // The grep matches source TEXT, so prose here must not spell a call shape it would
  // mistake for code.
  it('every runMain that reaches `schedule` is on the reviewed allow-list', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const ALLOWED = [
      // Refused by `validateArgs` BEFORE dispatch, so `realDeps()` is never built.
      "'schedule', '--bogus'",
      // Real deps on purpose, guarded to Linux, refused before the first write —
      // the only call here that reaches `realDeps()`.
      "'schedule', 'install', '--dataDir', insideTheCorpus",
    ];
    const found: string[] = [];
    for (const file of ['schedule.test.ts', 'args.test.ts']) {
      const text = readFileSync(join(here, file), 'utf8');
      for (const match of text.matchAll(/runMain\(\s*\[([\s\S]*?)\]/g)) {
        const argv = match[1]!.replace(/\s+/g, ' ').trim().replace(/,$/, '');
        if (argv.includes("'schedule'")) found.push(argv);
      }
    }
    expect(
      [...new Set(found)].sort(),
      'a new CLI-level call reaching `schedule` would drive `realDeps()` against ' +
        'the machine running the tests — a real systemctl, a real launchctl, a ' +
        'real unit dir. Add it here only with a reason it is safe.',
    ).toEqual([...ALLOWED].sort());
  });
});

describe('18 — containment refuses a unit or wrapper path inside the corpus (AC8)', () => {
  /** Home AND data dir inside the sandbox corpus, so every target is refused. */
  function cornered(s: Sandbox): { bed: TestBed; inside: string; restore: () => void } {
    const restore = pinSandboxEnv(s);
    const inside = join(s.sourceRoot, 'swallowed');
    const bed = linuxBed(s, { homeDir: inside });
    return { bed, inside, restore };
  }

  it.each([
    ['the wrapper, via --dataDir', (inside: string) => ['install', '--dataDir', inside]],
    ['the wrapper, on the turn-off path', (inside: string) => ['disable', '--dataDir', inside]],
  ])('%s is refused, and nothing is written', async (_label, argv) => {
    const s = sb();
    const { bed, inside, restore } = cornered(s);
    try {
      const before = [...snapshotTreeSafe(s.sourceRoot).keys()].sort();
      await expect(schedule(argv(inside), bed.deps)).rejects.toThrow(
        /refusing to write inside the transcript root/,
      );
      // True because every path is asserted before the first mkdir.
      expect([...snapshotTreeSafe(s.sourceRoot).keys()].sort()).toEqual(before);
    } finally {
      restore();
    }
  });

  it('a unit dir resolving inside the corpus is refused too', async () => {
    const s = sb();
    const restore = pinSandboxEnv(s);
    try {
      // Only HOME is swallowed, so the refusal can only come from the unit path.
      const bed = linuxBed(s, { homeDir: join(s.sourceRoot, 'swallowed-home') });
      await expect(schedule(dataDirArgs(s, 'install'), bed.deps)).rejects.toThrow(
        /refusing to write inside the transcript root/,
      );
      expect(snapshotTreeSafe(s.sourceRoot).size).toBe(0);
      expect(snapshotTreeSafe(s.dataDir).size).toBe(0);
    } finally {
      restore();
    }
  });

  it('a line break in a unit value refuses with nothing written', async () => {
    const s = sb();
    const bed = linuxBed(s);
    const broken = join(s.root, 'data\nwith-a-newline');
    await expect(schedule(['install', '--dataDir', broken], bed.deps)).rejects.toThrow(
      /would split the directive/,
    );
    // Both unit texts are built BEFORE the first write, so the refusal is total.
    expect(snapshotTreeSafe(broken).size).toBe(0);
    expect(snapshotTreeSafe(bed.unitDir).size).toBe(0);
    expect(bed.systemctlCalls).toEqual([]);
  });

  // (b) The exit code rather than the throw — `index.ts` is the only thing that
  // turns one into the other. Guarded to Linux: see the banner at the top.
  it.runIf(process.platform === 'linux')(
    'the refusal reaches the CLI as exit 1, not an unhandled rejection',
    async () => {
      const s = sb();
      const restore = pinSandboxEnv(s);
      const insideTheCorpus = join(s.sourceRoot, 'swallowed');
      try {
        const { code, err } = await runMain(['schedule', 'install', '--dataDir', insideTheCorpus]);
        expect(code).toBe(1);
        expect(code).not.toBe(2);
        expect(err).toMatch(/refusing to write inside the transcript root/);
        expect(snapshotTreeSafe(s.sourceRoot).size).toBe(0);
      } finally {
        restore();
      }
    },
  );
});

describe('19 — exit codes stay 0 and 1 for every failure shape a runner can hand back', () => {
  const SPAWN_ABSENT: CommandResult = {
    status: null,
    stdout: '',
    stderr: 'spawnSync systemctl ENOENT',
  };
  const NO_BUS: CommandResult = {
    status: 1,
    stdout: '',
    stderr: 'Failed to connect to bus: No medium found',
  };
  const REFUSED: CommandResult = {
    status: 1,
    stdout: '',
    stderr: 'Interactive authentication required.',
  };
  // No verb this command runs is known to return 3, but "never 3" has to hold for
  // any status a runner hands back.
  const UNMEASURED_THREE: CommandResult = { status: 3, stdout: '', stderr: 'surprise' };

  const SHAPES: ReadonlyArray<readonly [string, CommandResult]> = [
    ['an absent binary', SPAWN_ABSENT],
    ['a present binary with no user bus', NO_BUS],
    ['an ordinary refusal', REFUSED],
    ['an unmeasured exit 3', UNMEASURED_THREE],
  ];

  const ARMING_VERBS = ['daemon-reload', 'enable', 'restart'];

  it.each(
    SHAPES.flatMap(([label, result]) =>
      ARMING_VERBS.map((verb) => [`${verb} / ${label}`, verb, result] as const),
    ),
  )('install refuses at %s with exactly 1', async (_label, verb, result) => {
    const s = sb();
    const bed = linuxBed(
      s,
      {},
      { systemctl: (args) => (args.includes(verb) ? result : undefined) },
    );
    const { code, err } = await run(dataDirArgs(s, 'install'), bed.deps);
    expect(code).toBe(1);
    expect(code).not.toBe(2);
    expect(code).not.toBe(3);
    expect(err).toContain(verb);
  });

  it('the no-bus failure prints the XDG_RUNTIME_DIR hint, and only then', async () => {
    const s = sb();
    const withBusError = linuxBed(s, {}, { systemctl: () => NO_BUS });
    const busRun = await run(dataDirArgs(s, 'install'), withBusError.deps);
    expect(busRun.code).toBe(1);
    expect(busRun.err).toContain('XDG_RUNTIME_DIR');
    expect(busRun.err).toContain('/run/user/<uid>');

    const s2 = sb();
    const plainRefusal = linuxBed(s2, {}, { systemctl: () => REFUSED });
    const plainRun = await run(dataDirArgs(s2, 'install'), plainRefusal.deps);
    expect(plainRun.code).toBe(1);
    expect(plainRun.err).not.toContain('XDG_RUNTIME_DIR');
  });

  it.each(SHAPES)(
    'a failed FIRST PASS is a warning, not a failure (%s)',
    async (_label, result) => {
      const s = sb();
      const bed = linuxBed(
        s,
        {},
        {
          systemctl: (args) => (args.includes('--no-block') ? result : undefined),
        },
      );
      const { code, out } = await run(dataDirArgs(s, 'install'), bed.deps);
      // The timer IS armed; only the immediate catch-up pass did not start.
      expect(code).toBe(0);
      expect(out).toContain('warning: the first pass could not be started');
      expect(readFileSync(bed.timerPath, 'utf8')).toContain('OnCalendar');
    },
  );

  it.each(
    SHAPES.flatMap(([label, result]) =>
      (['stop', 'disable'] as const).map((verb) => [`${verb} / ${label}`, verb, result] as const),
    ),
  )('disable stays 0 at %s — "already off" is not a failure', async (_label, verb, result) => {
    const s = sb();
    const bed = linuxBed(
      s,
      {},
      { systemctl: (args) => (args.includes(verb) ? result : undefined) },
    );
    await run(dataDirArgs(s, 'install'), linuxBed(s).deps);
    const { code } = await run(dataDirArgs(s, 'disable'), bed.deps);
    expect(code).toBe(0);
    expect(code).not.toBe(2);
    expect(code).not.toBe(3);
  });

  it.each(SHAPES)('status stays 0 when `show` answers with %s', async (_label, result) => {
    const s = sb();
    const bed = linuxBed(
      s,
      {},
      { systemctl: (args) => (args.includes('show') ? result : undefined) },
    );
    await run(dataDirArgs(s, 'install'), bed.deps);
    const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
    expect(code).toBe(0);
    expect(code).not.toBe(2);
    expect(code).not.toBe(3);
    expect(out).toContain('unknown');
  });

  it.each(SHAPES)(
    'status and install stay 0/1 when `loginctl` answers with %s',
    async (_label, result) => {
      const s = sb();
      const bed = linuxBed(s, {}, { loginctl: () => result });
      expect((await run(dataDirArgs(s, 'install'), bed.deps)).code).toBe(0);
      const { code, out } = await run(dataDirArgs(s, 'status'), bed.deps);
      expect(code).toBe(0);
      expect(out).toContain('lingering: unknown');
    },
  );
});

describe('20 — escapeUnitValue and the pure unit builders', () => {
  it.each([
    ['a percent expands as a specifier unless doubled', 'a%b', 'a%%b'],
    ['a dollar expands to empty unless doubled', 'a$b', 'a$$b'],
    ['a quote is escaped, not stripped', 'a"b', 'a\\"b'],
    ['a backslash is doubled', 'a\\b', 'a\\\\b'],
    // Backslash BEFORE quote, so the backslash it adds is not re-doubled.
    ['backslash runs before quote', '\\"', '\\\\\\"'],
    ['a space passes through — the value is already inside quotes', 'a b', 'a b'],
    [
      'an ordinary path is unchanged',
      '/home/x/.agent-lens/schedule/archive.sh',
      '/home/x/.agent-lens/schedule/archive.sh',
    ],
  ])('%s', (_label, input, expected) => {
    expect(escapeUnitValue(input)).toBe(expected);
  });

  it.each([['\n'], ['\r'], ['a\nb']])('%j throws rather than being encoded', (value) => {
    expect(() => escapeUnitValue(value)).toThrow(/would split the directive/);
  });

  it('a hostile --dataDir lands in ExecStart with nothing left bare', async () => {
    const s = sb();
    const hostile = join(s.root, 'odd % $ " \\ dir');
    const bed = linuxBed(s);
    const { code } = await run(['install', '--dataDir', hostile], bed.deps);
    expect(code).toBe(0);

    const execStart = readFileSync(bed.servicePath, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('ExecStart='))!;
    // The raw path does NOT appear — every special character was transformed.
    expect(execStart).not.toContain(hostile);
    expect(execStart).toContain('%%');
    expect(execStart).toContain('$$');
    expect(execStart).toContain('\\"');
    expect(execStart).toContain('\\\\');
    // No single `%` or `$` survives undoubled, which is what makes the unit load.
    expect(execStart.replace(/%%/g, '').includes('%')).toBe(false);
    expect(execStart.replace(/\$\$/g, '').includes('$')).toBe(false);
  });

  it('both units carry the GENERATED banner, the caveats, and no reverse-DNS label', () => {
    const service = buildSystemdService({ wrapperPath: '/data/schedule/archive.sh' });
    const timer = buildSystemdTimer();
    for (const text of [service, timer]) {
      expect(text).toContain('GENERATED by `agent-lens schedule`');
      expect(text).toContain(WAKE_TIME_CAVEAT);
      // Plain unit names, not reverse-DNS.
      expect(text).not.toContain(SCHEDULE_LABEL);
      expect(text).not.toContain(LEGACY_LABEL);
    }
    expect(timer).toContain(LINGER_CAVEAT);
    expect(SYSTEMD_UNIT_BASE).toBe('agent-lens-archive');
    expect(`${SYSTEMD_UNIT_BASE}.service`).toBe(SERVICE_UNIT);
    expect(`${SYSTEMD_UNIT_BASE}.timer`).toBe(TIMER_UNIT);
  });
});

describe('21 — a built layout whose compiled entry is absent FATALs loudly (AC3)', () => {
  /**
   * A package root shaped like a published install with its `dist/` gone: the
   * `bin/` shim is present, so only the fourth precondition can catch it.
   *
   * `nodePath: process.execPath` is load-bearing. The bed default is
   * `/test/bin/node`, which does not exist, so `[ -x "$NODE" ]` would fire first
   * and the test would assert the wrong FATAL and pass for the wrong reason.
   */
  function probe(s: Sandbox): { wrapperPath: string; logPath: string; packageRoot: string } {
    const packageRoot = join(s.root, 'published-pkg');
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{}');
    writeFileSync(join(packageRoot, 'bin', 'agent-lens.js'), '// shim\n');
    const builtUrl = pathToFileURL(
      join(packageRoot, 'dist', 'src', 'cli', 'commands', 'schedule.js'),
    ).href;
    const invocation = resolveArchiveInvocation(builtUrl);
    expect(invocation).toEqual({ packageRoot, kind: 'built' });

    const logPath = join(s.dataDir, 'logs', 'probe.log');
    const wrapperPath = join(s.dataDir, 'schedule', 'probe.sh');
    mkdirSync(dirname(wrapperPath), { recursive: true });
    writeFileSync(
      wrapperPath,
      buildWrapperScript({
        nodePath: process.execPath,
        invocation,
        dataDir: s.dataDir,
        cronLogPath: logPath,
      }),
    );
    return { wrapperPath, logPath, packageRoot };
  }

  /** `/bin/sh <script>`, the form both backends use — so no exec bit is needed. */
  function runWrapper(
    wrapperPath: string,
    logPath: string,
  ): { status: number | null; entries: ReturnType<typeof parseCronLog>; log: string } {
    const result = spawnSync('/bin/sh', [wrapperPath], { encoding: 'utf8' });
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    return { status: result.status, entries: parseCronLog(log), log };
  }

  it('dist/ missing: exit 1 and one FATAL naming the compiled entry', () => {
    const s = sb();
    const { wrapperPath, logPath, packageRoot } = probe(s);
    const { status, entries, log } = runWrapper(wrapperPath, logPath);
    expect(status, `cron.log was:\n${log}`).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('FATAL');
    // The name-the-path-and-the-remedy contract, with $ROOT expanded by the shell.
    expect(entries[0]!.summary).toContain(join(packageRoot, BUILT_CLI_ENTRY));
    expect(entries[0]!.summary).toContain('reinstall @faithfulalabi/agent-lens');
    // Never the source layout's remedy: there is no npm install to run here.
    expect(entries[0]!.summary).not.toContain('node_modules');
  });

  it('dist/ present but EMPTY: still exit 1, which `-d dist` would have missed', () => {
    const s = sb();
    const { wrapperPath, logPath, packageRoot } = probe(s);
    // The whole reason the guard tests a FILE. An empty or half-extracted dist/
    // satisfies a directory test and then dies inside the shim's own import.
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    const { status, entries, log } = runWrapper(wrapperPath, logPath);
    expect(status, `cron.log was:\n${log}`).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('FATAL');
    expect(entries[0]!.summary).toContain(join(packageRoot, BUILT_CLI_ENTRY));
  });
});

describe('22 — turn-on hands the builder its four inputs on a built moduleUrl (AC2)', () => {
  it('the wrapper on disk is exactly what those four inputs produce', async () => {
    // The one compound the packed-tarball smoke cannot reach: that the turn-on
    // composes `resolveArchiveInvocation(deps.moduleUrl)` with the node path, the
    // data dir and the log path. Pinned with `toBe` against the builder itself, so
    // no real launchctl, systemctl or unit dir is involved.
    const s = sb();
    const builtUrl = pathToFileURL(
      join(s.root, 'pkg', 'dist', 'src', 'cli', 'commands', 'schedule.js'),
    ).href;
    const bed = makeDeps(s, { moduleUrl: builtUrl });

    const { code } = await run(dataDirArgs(s, 'install'), bed.deps);
    expect(code).toBe(0);

    const invocation = resolveArchiveInvocation(builtUrl);
    expect(invocation).toEqual({ packageRoot: join(s.root, 'pkg'), kind: 'built' });
    expect(readFileSync(bed.wrapperPath, 'utf8')).toBe(
      buildWrapperScript({
        nodePath: bed.deps.execPath,
        invocation,
        dataDir: s.dataDir,
        cronLogPath: resolveCronLogPath(s.dataDir),
      }),
    );
  });
});
