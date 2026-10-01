// `agent-lens schedule` — the recurring archive job, owned end to end on TWO
// backends chosen by the injected platform:
//
//   darwin → a launchd plist under `~/Library/LaunchAgents`, loaded with `launchctl`
//   linux  → a `.service` + `.timer` under `~/.config/systemd/user`, armed with
//            `systemctl --user`, with the lingering state read via `loginctl`
//
// Both drive the SAME generated wrapper under the data dir, which appends the
// per-pass `cron.log` line `readCronLogStatus` reads — so `doctor`'s freshness
// report works unchanged on both. A second log format would break `doctor` on
// one platform only, which is why the wrapper is reused byte-for-byte rather
// than parameterised. The two backends differ deliberately on catch-up: launchd
// uses `RunAtLoad`, systemd uses `OnCalendar` + `Persistent=true`.
//
// Exit codes: 0 (done, or a report) and 1 (failed, refused, or nothing was set
// up on this platform). Never 2 — reserved product-wide (`commands/archive.ts:1`)
// — and never 3, which belongs to the archive pass itself.
//
// All three binaries sit behind injectable runners, and the platform, home dir,
// uid, `XDG_CONFIG_HOME` and module URL behind `ScheduleDeps`, so the test suite
// never touches the real LaunchAgents dir or a real `~/.config/systemd/user`, and
// never runs a real `launchctl`, `systemctl` or `loginctl`.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNotUnderRoot,
  lstatSafe,
  resolveCronLogPath,
  resolveDataDir,
  resolvePlistPath,
  resolveScheduleWrapperPath,
  resolveSystemdUnitPath,
  resolveSystemdUserDir,
  resolveSystemdWantsPath,
  resolveTranscriptRoot,
  TRANSCRIPT_ROOT_LABEL,
} from '../../archive/paths.js';
import { parseStringFlag } from './archive.js';

export const SCHEDULE_LABEL = 'com.agent-lens.archive';
/** The founder's hand-authored job, migrated out on turn-on so two jobs never race. */
export const LEGACY_LABEL = 'com.faithful.agent-lens.archive';
const START_INTERVAL_SECONDS = 900;
/** `date` format whose output `parseCronLog` anchors on — colon-less offset included. */
export const CRON_STAMP_FORMAT = '+%Y-%m-%dT%H:%M:%S%z';
export const WAKE_TIME_CAVEAT =
  'a wall-clock schedule does not fire while the machine is asleep — treat the interval as a bound on wake time, not on elapsed time';
/**
 * The systemd half of the same honesty `WAKE_TIME_CAVEAT` sets the precedent for:
 * a bound the mechanism cannot deliver gets printed rather than hidden. Quoted
 * verbatim by `README.md`, pinned by `docs.test.ts` — never retyped.
 */
export const LINGER_CAVEAT =
  'a systemd user timer does not run while you are logged out unless lingering is on for your user';

/**
 * The fixed systemd unit pair, named the way the founder's own `internal-docs-sync`
 * pair is rather than reverse-DNS. FIXED is what makes a second turn-on replace
 * its own job instead of duplicating it, the same property the launchd label has.
 */
export const SYSTEMD_UNIT_BASE = 'agent-lens-archive';
const SYSTEMD_SERVICE = `${SYSTEMD_UNIT_BASE}.service`;
const SYSTEMD_TIMER = `${SYSTEMD_UNIT_BASE}.timer`;
/** `systemd-analyze calendar '*:0/15'` on 249 normalises to `*-*-* *:00/15:00`. */
const SYSTEMD_CALENDAR = '*:0/15';
/** Asked for in one `show`; the reply order is NOT the requested order, measured. */
const SYSTEMD_TIMER_PROPERTIES = [
  'ActiveState',
  'UnitFileState',
  'NextElapseUSecRealtime',
  'LastTriggerUSec',
  'Result',
];

const ACTIONS = 'install | status | disable';
const UNSUPPORTED_PLATFORM_POINTER =
  'the recurring job uses launchd on macOS and a systemd user timer on Linux, and this platform ' +
  'is neither. Run `agent-lens archive` every ~15 minutes from whatever scheduler it does have — ' +
  'a cron entry, for instance — per the README section "Keeping the archive current". No cron ' +
  'fallback ships here on purpose: the two backends above are the two this command sets up for you.';
/** Measured: a PRESENT `systemctl` with no user bus exits 1 with exactly this. */
const BUS_HINT =
  '  hint: run this from a logged-in session — `systemctl --user` needs a user D-Bus, with ' +
  'XDG_RUNTIME_DIR pointing at /run/user/<uid>';

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => CommandResult;

/** Alias kept because `schedule.test.ts` imports this name. */
export type LaunchctlResult = CommandResult;
/** Alias kept as bookkeeping; nothing outside this file names it. */
export type LaunchctlRunner = CommandRunner;

/** Everything the command reads from the machine, injectable for tests. */
export interface ScheduleDeps {
  platform: NodeJS.Platform;
  execPath: string;
  homeDir: string;
  uid: number;
  /** Decides the dev-vs-built invocation and locates the package root. */
  moduleUrl: string;
  launchctl: CommandRunner;
  systemctl: CommandRunner;
  /** Read-only, and only for the lingering advisory — never `enable-linger`. */
  loginctl: CommandRunner;
  /**
   * `XDG_CONFIG_HOME`, or `undefined`. A dep rather than an env read inside
   * `resolveSystemdUserDir`, so no test can land a unit in a real config home.
   */
  configHome: string | undefined;
  now: () => number;
}

/** One spawn shape for all three binaries; a spawn ERROR becomes stderr + a null status. */
function realRunner(bin: string): CommandRunner {
  return (args) => {
    const result = spawnSync(bin, args, { encoding: 'utf8' });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.error === undefined ? (result.stderr ?? '') : String(result.error.message),
    };
  };
}

function realDeps(): ScheduleDeps {
  return {
    platform: process.platform,
    execPath: process.execPath,
    homeDir: homedir(),
    // `?? 0` cannot fire on the only platform that reads `uid` for a systemd
    // path: `process.getuid` is always defined on Linux. A genuine root turn-on
    // gives `loginctl show-user 0` exit 1, which reads as `unknown`.
    uid: process.getuid?.() ?? 0,
    moduleUrl: import.meta.url,
    launchctl: realRunner('launchctl'),
    systemctl: realRunner('systemctl'),
    loginctl: realRunner('loginctl'),
    configHome: process.env.XDG_CONFIG_HOME,
    now: Date.now,
  };
}

/**
 * The one bare token, walked the way `validateArgs` walks: a `--dataDir` value
 * is consumed by position and never inspected.
 */
export function parseScheduleAction(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      if (arg === '--dataDir') i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

// --- invocation resolution ---------------------------------------------------

export interface ArchiveInvocation {
  packageRoot: string;
  /** `source` = a dev checkout running under tsx; `built` = the shipped package. */
  kind: 'source' | 'built';
}

/** Nearest ancestor holding a `package.json` — the `resolveUiDir` idiom. */
function resolvePackageRoot(fromDir: string): string {
  let dir = fromDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no package.json above ${fromDir}; cannot locate the package root`);
    }
    dir = parent;
  }
}

/**
 * The non-stale way to run the archive from a job. A dev checkout runs the
 * TypeScript entry under tsx, so a stale `dist/` can never silently execute
 * old archive logic; the built package runs `bin/agent-lens.js`, which
 * re-resolves its co-located `dist/` in-process on every pass.
 */
export function resolveArchiveInvocation(moduleUrl: string): ArchiveInvocation {
  const modulePath = fileURLToPath(moduleUrl);
  return {
    packageRoot: resolvePackageRoot(dirname(modulePath)),
    kind: modulePath.endsWith('.ts') ? 'source' : 'built',
  };
}

// --- generated artifacts (pure text builders) --------------------------------

/** POSIX single-quote escaping, so a path with spaces or quotes cannot split. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface WrapperOptions {
  nodePath: string;
  invocation: ArchiveInvocation;
  /** The RESOLVED data dir, baked in: launchd's minimal env has no overrides. */
  dataDir: string;
  cronLogPath: string;
}

/**
 * The wrapper the plist invokes. Its `cron.log` line is byte-compatible with
 * `parseCronLog`: `date "+%Y-%m-%dT%H:%M:%S%z"`, a status token, a summary —
 * continuation lines carry no timestamp and are skipped by the reader.
 */
export function buildWrapperScript(opts: WrapperOptions): string {
  const { kind, packageRoot } = opts.invocation;
  const entry = kind === 'source' ? '$ROOT/src/cli/index.ts' : '$ROOT/bin/agent-lens.js';
  // `--dataDir` is explicit so the pass archives into the SAME data dir the
  // cron.log lives in — an env-default lookup under launchd could diverge.
  const run =
    kind === 'source'
      ? '"$NODE" --import tsx "$ROOT/src/cli/index.ts" archive --dataDir "$DATA_DIR"'
      : '"$NODE" "$ROOT/bin/agent-lens.js" archive --dataDir "$DATA_DIR"';
  return `#!/bin/sh
# agent-lens archive — unattended pass, invoked by the launchd agent
# ${SCHEDULE_LABEL} every ${START_INTERVAL_SECONDS / 60} minutes.
#
# GENERATED by \`agent-lens schedule\` — do not edit. Turning the job on again
# rewrites this file in full, which is what keeps it current with the package
# that shipped it.
#
# Coverage is wake-time-bounded: ${WAKE_TIME_CAVEAT}.
#
# Exit codes are the archive command's own and are load-bearing:
#   0 = clean pass       1 = usage error / crash       3 = archive-side errors
#   2 is RESERVED product-wide and must never appear here.
set -u

NODE=${shQuote(opts.nodePath)}
ROOT=${shQuote(packageRoot)}
DATA_DIR=${shQuote(opts.dataDir)}
LOG=${shQuote(opts.cronLogPath)}
MAX_LINES=5000

# launchd hands over a minimal PATH. The node binary is addressed absolutely so
# the pass cannot hit an \`env: node\` lookup failure, and the export keeps
# anything the pass shells out to on a sane PATH too.
PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

mkdir -p "$(dirname "$LOG")"

stamp() { date "${CRON_STAMP_FORMAT}"; }
say() { printf '%s %s\\n' "$(stamp)" "$1" >>"$LOG"; }

# Preconditions are logged loudly rather than failing silently: a job that
# quietly does nothing is indistinguishable from one that is working.
[ -d "$ROOT" ]              || { say "FATAL package root missing: $ROOT"; exit 1; }
[ -x "$NODE" ]              || { say "FATAL node missing: $NODE"; exit 1; }
[ -e "${entry}" ] || { say "FATAL entry missing: ${entry}"; exit 1; }
[ -d "$ROOT/node_modules" ] || { say "FATAL node_modules missing — run npm install in $ROOT"; exit 1; }

cd "$ROOT" || { say "FATAL cannot cd to $ROOT"; exit 1; }

OUT=$(${run} 2>&1)
CODE=$?

case "$CODE" in
  0) say "ok   $OUT" ;;
  3) say "ERR3 archive-side errors — $OUT" ;;
  2) say "BUG  exit 2 is reserved product-wide and must never come from archive — $OUT" ;;
  *) say "ERR$CODE $OUT" ;;
esac

# Bounded log: keep the most recent MAX_LINES so months of 15-minute passes
# cannot fill the disk the archive depends on.
if [ -f "$LOG" ]; then
  LINES=$(wc -l <"$LOG" 2>/dev/null || echo 0)
  if [ "$LINES" -gt "$MAX_LINES" ]; then
    tail -n "$MAX_LINES" "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
fi

exit "$CODE"
`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The launchd plist. Every property is the founder's hand-tuned job with a
 * generic label: 15-minute interval, catch-up at load, background priority,
 * launchd-level failures to their own logs, and deliberately no KeepAlive.
 */
export function buildPlist(opts: { wrapperPath: string; dataDir: string }): string {
  const outLog = xmlEscape(join(opts.dataDir, 'logs', 'launchd.out.log'));
  const errLog = xmlEscape(join(opts.dataDir, 'logs', 'launchd.err.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SCHEDULE_LABEL}</string>

  <!-- Coverage is wake-time-bounded: ${xmlEscape(WAKE_TIME_CAVEAT)}. -->

  <!-- /bin/sh rather than the script directly: launchd exec failures are then
       reported against a known-good binary, so a broken shebang or a lost
       +x bit shows up as a script error instead of a silent no-op. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(opts.wrapperPath)}</string>
  </array>

  <key>StartInterval</key>
  <integer>${START_INTERVAL_SECONDS}</integer>

  <!-- Catch up immediately at login rather than waiting out the first interval:
       the gap after a reboot is exactly when expiry is most likely to have run. -->
  <key>RunAtLoad</key>
  <true/>

  <!-- launchd-level failures ONLY (exec errors, Full Disk Access denials).
       The pass's own results go to logs/cron.log via the wrapper. -->
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>

  <key>ProcessType</key>
  <string>Background</string>

  <!-- Deliberately NOT set: KeepAlive. This is a periodic batch job, not a
       daemon; KeepAlive would restart it in a tight loop after every exit. -->
</dict>
</plist>
`;
}

/**
 * A systemd `.ini` value is neither a shell word nor a unit NAME, so neither
 * `shQuote` nor `systemd-escape` is the right tool. Straight from the three man
 * pages, in this order:
 *
 * 1. `\` → `\\`  — an unrecognised escape pattern otherwise WARNS and silently
 *    changes the value (`systemd.syntax(7)`); a trailing `\` merges two lines.
 * 2. `"` → `\"`  — AFTER step 1, so the backslash step 1 introduces is not
 *    re-doubled. Quotes wrap an item and are removed on parse.
 * 3. `%` → `%%`  — otherwise a `%` in the path expands as a specifier and the
 *    unit fails to load (`systemd.unit(5)`: `%%` is one literal percent).
 * 4. `$` → `$$`  — otherwise `$FOO` expands, and `systemd.service(5)` says a
 *    variable with no value at expansion time becomes an EMPTY string, so the
 *    path would be silently mangled rather than loudly broken.
 *
 * A newline cannot be encoded at all — it splits the directive — so it throws.
 * `index.ts` turns that into exit 1, and because both unit texts are built before
 * the first write, a refused value leaves nothing on disk.
 */
export function escapeUnitValue(value: string): string {
  if (/[\n\r]/.test(value)) {
    throw new Error(
      'refusing to write a systemd unit: a line break in a unit value would split the ' +
        `directive — ${JSON.stringify(value)}`,
    );
  }
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$');
}

/**
 * The systemd service: one oneshot pass, the same wrapper launchd runs. `/bin/sh`
 * rather than the script directly for the plist's own reason — an exec failure is
 * then reported against a known-good binary, so a broken shebang or a lost +x bit
 * surfaces as a script error instead of a silent no-op.
 *
 * No `StandardOutput=append:`: the pass's own results already go to `cron.log`
 * through the wrapper, unit-level failures go to the journal, and `install` prints
 * the `journalctl` command that reads them. `append:` also has a later systemd
 * floor than every directive here.
 */
export function buildSystemdService(opts: { wrapperPath: string }): string {
  return `[Unit]
Description=agent-lens archive — unattended pass, every ${START_INTERVAL_SECONDS / 60} minutes
#
# GENERATED by \`agent-lens schedule\` — do not edit. Turning the job on again
# rewrites this file in full, which is what keeps it current with the package
# that shipped it.
#
# Coverage is wake-time-bounded: ${escapeUnitValue(WAKE_TIME_CAVEAT)}.
#
# Exit codes are the archive command's own: 0 clean, 1 usage error / crash,
# 3 archive-side errors. 2 is RESERVED product-wide and must never appear.

[Service]
Type=oneshot
ExecStart=/bin/sh "${escapeUnitValue(opts.wrapperPath)}"
`;
}

/**
 * The timer. `OnCalendar` + `Persistent=true` rather than `OnUnitActiveSec=900`,
 * deliberately and for two measured reasons: `Persistent=true` runs ONE catch-up
 * pass for a slot missed while the machine was off — the same intent as the
 * plist's `RunAtLoad`, which `OnUnitActiveSec` has no equivalent of at all — and
 * an `OnUnitActiveSec` timer reports an EMPTY `NextElapseUSecRealtime`, so only a
 * calendar timer can give `schedule status` a next trigger to print.
 */
export function buildSystemdTimer(): string {
  return `[Unit]
Description=agent-lens archive — timer for ${escapeUnitValue(SYSTEMD_SERVICE)}
#
# GENERATED by \`agent-lens schedule\` — do not edit. Turning the job on again
# rewrites this file in full.
#
# Coverage is wake-time-bounded: ${escapeUnitValue(WAKE_TIME_CAVEAT)}.
#
# And ${escapeUnitValue(LINGER_CAVEAT)} — \`agent-lens schedule status\` reports which.

[Timer]
OnCalendar=${escapeUnitValue(SYSTEMD_CALENDAR)}
Persistent=true
AccuracySec=1min
Unit=${escapeUnitValue(SYSTEMD_SERVICE)}

[Install]
WantedBy=timers.target
`;
}

// --- the few writes, each behind one call site -------------------------------

/**
 * The one mkdir. `assertNotUnderRoot` keeps the read-only guarantee over the
 * corpus even against `--dataDir ~/.claude/projects`.
 */
function ensureDirOutsideCorpus(dir: string, mode: number, transcriptRoot: string): void {
  assertNotUnderRoot(dir, transcriptRoot, TRANSCRIPT_ROOT_LABEL);
  mkdirSync(dir, { recursive: true, mode });
}

/** Temp-write → chmod → rename, the `server/config.ts` idiom. */
function atomicWrite(path: string, text: string, mode: number, transcriptRoot: string): void {
  assertNotUnderRoot(path, transcriptRoot, TRANSCRIPT_ROOT_LABEL);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** `unlink` acts on the link itself, never a target; absent is not an error. */
function removeIfPresent(path: string, transcriptRoot: string): boolean {
  if (lstatSafe(path) === undefined) return false;
  assertNotUnderRoot(path, transcriptRoot, TRANSCRIPT_ROOT_LABEL);
  unlinkSync(path);
  return true;
}

/**
 * The one rmdir, for the one directory a turn-on creates: `<dataDir>/schedule`.
 * `rmdir(2)` only ever removes an EMPTY directory, so anything a user parked in
 * there survives and the call degrades to a no-op.
 *
 * The try/catch wraps the rmdir ALONE and never the assert. A non-empty or absent
 * directory is a tolerated no-op; a containment refusal is not, and must reach the
 * caller the way `removeIfPresent`'s does. That assert is new here — the inline
 * `rmdirSync` this helper took over was the one write in this file with no
 * containment guard at all.
 *
 * Deliberately NOT used on the systemd unit dir or on `timers.target.wants`: both
 * are shared with every other user unit on the box.
 */
function removeEmptyDir(dir: string, transcriptRoot: string): void {
  assertNotUnderRoot(dir, transcriptRoot, TRANSCRIPT_ROOT_LABEL);
  try {
    rmdirSync(dir);
  } catch {
    // Not empty, or never created — either way it is not ours to force.
  }
}

// --- the three actions -------------------------------------------------------

function gui(deps: ScheduleDeps, label: string): string {
  return `gui/${deps.uid}/${label}`;
}

function install(dataDirFlag: string | undefined, deps: ScheduleDeps): number {
  if (deps.platform === 'linux') return installSystemd(dataDirFlag, deps);
  if (deps.platform !== 'darwin') {
    console.error(`agent-lens schedule: nothing was set up — ${UNSUPPORTED_PLATFORM_POINTER}`);
    return 1;
  }
  const dataDir = resolveDataDir(dataDirFlag);
  const transcriptRoot = resolveTranscriptRoot();
  const wrapperPath = resolveScheduleWrapperPath(dataDir);
  const plistPath = resolvePlistPath(SCHEDULE_LABEL, deps.homeDir);
  const cronLogPath = resolveCronLogPath(dataDir);
  const lines: string[] = [];

  // Migrate the founder's hand-authored job out FIRST, so the two never race.
  const legacyPlist = resolvePlistPath(LEGACY_LABEL, deps.homeDir);
  const legacyWrapper = join(deps.homeDir, '.agent-lens', 'archive-cron.sh');
  if (lstatSafe(legacyPlist) !== undefined || lstatSafe(legacyWrapper) !== undefined) {
    deps.launchctl(['bootout', gui(deps, LEGACY_LABEL)]);
    removeIfPresent(legacyPlist, transcriptRoot);
    removeIfPresent(legacyWrapper, transcriptRoot);
    lines.push(`migrated the legacy ${LEGACY_LABEL} job out — one job, one label`);
  }

  const invocation = resolveArchiveInvocation(deps.moduleUrl);
  ensureDirOutsideCorpus(dirname(wrapperPath), 0o700, transcriptRoot);
  ensureDirOutsideCorpus(dirname(cronLogPath), 0o700, transcriptRoot);
  ensureDirOutsideCorpus(dirname(plistPath), 0o755, transcriptRoot);
  atomicWrite(
    wrapperPath,
    buildWrapperScript({ nodePath: deps.execPath, invocation, dataDir, cronLogPath }),
    0o700,
    transcriptRoot,
  );
  atomicWrite(plistPath, buildPlist({ wrapperPath, dataDir }), 0o644, transcriptRoot);

  // Keyed on the fixed label: boot any previous instance out, then load the
  // fresh plist, so a second run replaces rather than duplicates. "Not loaded"
  // from the bootout is the healthy first-run case, ignored on purpose.
  deps.launchctl(['bootout', gui(deps, SCHEDULE_LABEL)]);
  const bootstrap = deps.launchctl(['bootstrap', `gui/${deps.uid}`, plistPath]);
  if (bootstrap.status !== 0) {
    // Older macOS: the legacy verbs.
    deps.launchctl(['unload', '-w', plistPath]);
    const load = deps.launchctl(['load', '-w', plistPath]);
    if (load.status !== 0) {
      const detail = (load.stderr || bootstrap.stderr).trim();
      console.error(`agent-lens schedule: launchctl could not load the job — ${detail}`);
      return 1;
    }
  }

  lines.push(
    `recurring archive job on — label ${SCHEDULE_LABEL}, every ` +
      `${START_INTERVAL_SECONDS / 60} minutes (${invocation.kind} layout)`,
    `  wrapper  ${wrapperPath}`,
    `  passes   ${cronLogPath}`,
    `note: ${WAKE_TIME_CAVEAT}`,
  );
  console.log(lines.join('\n'));
  return 0;
}

async function status(dataDirFlag: string | undefined, deps: ScheduleDeps): Promise<number> {
  if (deps.platform === 'linux') return statusSystemd(dataDirFlag, deps);
  if (deps.platform !== 'darwin') {
    console.log(`agent-lens schedule: ${UNSUPPORTED_PLATFORM_POINTER}`);
    console.log(`note: ${WAKE_TIME_CAVEAT}`);
    return 0;
  }
  const plistPath = resolvePlistPath(SCHEDULE_LABEL, deps.homeDir);
  const lines: string[] = [];
  if (lstatSafe(plistPath)?.isFile() === true) {
    lines.push(`recurring archive job: installed — ${plistPath}`);
    const print = deps.launchctl(['print', gui(deps, SCHEDULE_LABEL)]);
    lines.push(
      print.status === 0
        ? `  loaded in launchd (${SCHEDULE_LABEL})`
        : `  NOT loaded in launchd — run \`agent-lens schedule install\` to load it`,
    );
  } else {
    lines.push('recurring archive job: not installed');
    lines.push('  turn it on with: agent-lens schedule install');
  }
  // Lazy: `doctor.ts` statically reaches `node:sqlite` via db/open, which a
  // status report must not load. Same freshness wording as `doctor` by reuse.
  const [{ formatLastPassSection }, { readCronLogStatus }] = await Promise.all([
    import('./doctor.js'),
    import('../../archive/cron-log.js'),
  ]);
  lines.push(...formatLastPassSection(readCronLogStatus(dataDirFlag), deps.now()));
  lines.push('', `note: ${WAKE_TIME_CAVEAT}`);
  console.log(lines.join('\n'));
  return 0;
}

function disable(dataDirFlag: string | undefined, deps: ScheduleDeps): number {
  if (deps.platform === 'linux') return disableSystemd(dataDirFlag, deps);
  if (deps.platform !== 'darwin') {
    console.error(`agent-lens schedule: nothing was removed — ${UNSUPPORTED_PLATFORM_POINTER}`);
    return 1;
  }
  const transcriptRoot = resolveTranscriptRoot();
  const plistPath = resolvePlistPath(SCHEDULE_LABEL, deps.homeDir);
  const wrapperPath = resolveScheduleWrapperPath(resolveDataDir(dataDirFlag));

  const bootout = deps.launchctl(['bootout', gui(deps, SCHEDULE_LABEL)]);
  if (bootout.status !== 0 && lstatSafe(plistPath) !== undefined) {
    deps.launchctl(['unload', '-w', plistPath]); // older macOS; "not loaded" is fine
  }
  const removed: string[] = [];
  if (removeIfPresent(plistPath, transcriptRoot)) removed.push(plistPath);
  if (removeIfPresent(wrapperPath, transcriptRoot)) removed.push(wrapperPath);
  removeEmptyDir(dirname(wrapperPath), transcriptRoot);
  if (removed.length === 0) {
    console.log('recurring archive job: not installed — nothing to remove');
  } else {
    console.log(
      ['recurring archive job off — removed:', ...removed.map((path) => `  ${path}`)].join('\n') +
        '\n  cron.log and the archive itself are untouched',
    );
  }
  return 0;
}

// --- the systemd backend -----------------------------------------------------

interface SystemdPaths {
  unitDir: string;
  servicePath: string;
  timerPath: string;
  /** The symlink `enable` plants; outside the data dir and shared, by design. */
  wantsPath: string;
}

/** Every systemd path, from the INJECTED home dir and `configHome`, never ambient env. */
function systemdPaths(deps: ScheduleDeps): SystemdPaths {
  return {
    unitDir: resolveSystemdUserDir(deps.homeDir, deps.configHome),
    servicePath: resolveSystemdUnitPath(SYSTEMD_SERVICE, deps.homeDir, deps.configHome),
    timerPath: resolveSystemdUnitPath(SYSTEMD_TIMER, deps.homeDir, deps.configHome),
    wantsPath: resolveSystemdWantsPath(SYSTEMD_TIMER, deps.homeDir, deps.configHome),
  };
}

/** The sentence a refusal gets reported with; a spawn error arrives as stderr. */
function detailOf(result: CommandResult): string {
  return (result.stderr || result.stdout).trim() || `systemctl exited ${String(result.status)}`;
}

/**
 * `k=v` lines as a map, NEVER positionally: `systemctl show` was measured to reply
 * in a different order than the properties were asked for. An absent or empty
 * value is reported as unknown rather than as a fact — `show` on a unit that does
 * not exist at all exits 0 with every value empty.
 */
function parseProperties(stdout: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const split = line.indexOf('=');
    if (split > 0) properties.set(line.slice(0, split).trim(), line.slice(split + 1).trim());
  }
  return properties;
}

/** systemd's own timestamp strings go out VERBATIM, so nothing here parses one. */
function reported(value: string | undefined): string {
  return value === undefined || value === '' ? 'unknown — systemd reported nothing' : value;
}

type LingerState = 'on' | 'off' | 'unknown';

/**
 * One `loginctl show-user <uid> --property=Linger`. Anything that is not an
 * explicit `yes` or `no` is `unknown`, and the enable command prints anyway:
 * `loginctl show-user` with NO argument was measured to exit 0 printing NOTHING,
 * which is exactly the shape a naive parser reads as "lingering is off". A missing
 * `loginctl` degrades to `unknown` too, never to a failure.
 */
function readLingerState(deps: ScheduleDeps): LingerState {
  const result = deps.loginctl(['show-user', String(deps.uid), '--property=Linger']);
  if (result.status !== 0) return 'unknown';
  const value = parseProperties(result.stdout).get('Linger');
  if (value === 'yes') return 'on';
  if (value === 'no') return 'off';
  return 'unknown';
}

/**
 * The lingering advisory: PRINTED, never run. `loginctl enable-linger` writes
 * `/var/lib/systemd/linger/<user>` — outside everything this tool owns — is
 * commonly polkit-gated, and prompting for it would need `prune`'s injected
 * `confirm` plus its non-TTY-declines rule inside a command scripts invoke.
 */
function lingerLines(deps: ScheduleDeps): string[] {
  const state = readLingerState(deps);
  if (state === 'on') {
    return ['  lingering: on — the timer keeps running while you are logged out'];
  }
  return [
    `  lingering: ${state} — ${LINGER_CAVEAT}`,
    `  turn lingering on with: loginctl enable-linger ${deps.uid}`,
  ];
}

function installSystemd(dataDirFlag: string | undefined, deps: ScheduleDeps): number {
  const dataDir = resolveDataDir(dataDirFlag);
  const transcriptRoot = resolveTranscriptRoot();
  const wrapperPath = resolveScheduleWrapperPath(dataDir);
  const cronLogPath = resolveCronLogPath(dataDir);
  const { unitDir, servicePath, timerPath } = systemdPaths(deps);

  // EVERY path asserted and BOTH unit texts built before the first mkdir. That
  // ordering is the whole containment proof: a `--dataDir` inside the corpus, or
  // a line break in a unit value, refuses with nothing written at all. Asserting
  // up front adds reads only, so it costs no `fs-write-sites` manifest entry.
  for (const path of [wrapperPath, cronLogPath, unitDir, servicePath, timerPath]) {
    assertNotUnderRoot(path, transcriptRoot, TRANSCRIPT_ROOT_LABEL);
  }
  const invocation = resolveArchiveInvocation(deps.moduleUrl);
  const wrapperText = buildWrapperScript({
    nodePath: deps.execPath,
    invocation,
    dataDir,
    cronLogPath,
  });
  const serviceText = buildSystemdService({ wrapperPath });
  const timerText = buildSystemdTimer();

  ensureDirOutsideCorpus(dirname(wrapperPath), 0o700, transcriptRoot);
  ensureDirOutsideCorpus(dirname(cronLogPath), 0o700, transcriptRoot);
  // 0o700 applies only to a unit dir THIS command creates: `mkdir -p` does not
  // change the mode of a directory that already exists.
  ensureDirOutsideCorpus(unitDir, 0o700, transcriptRoot);
  atomicWrite(wrapperPath, wrapperText, 0o700, transcriptRoot);
  atomicWrite(servicePath, serviceText, 0o644, transcriptRoot);
  atomicWrite(timerPath, timerText, 0o644, transcriptRoot);

  // Keyed on the fixed unit names, so a second turn-on replaces rather than
  // duplicates. `restart` re-arms with the fresh text, starts the timer when it
  // was inactive, and does not reset the Persistent stamp.
  const armed: string[][] = [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', SYSTEMD_TIMER],
    ['--user', 'restart', SYSTEMD_TIMER],
  ];
  for (const argv of armed) {
    const result = deps.systemctl(argv);
    if (result.status !== 0) {
      console.error(
        `agent-lens schedule: \`systemctl ${argv.join(' ')}\` failed — ${detailOf(result)}`,
      );
      // A present binary with no user bus, not an absent one: exit 1, not null.
      if (/Failed to connect to bus/.test(result.stderr)) console.error(BUS_HINT);
      return 1;
    }
  }

  // LOAD-BEARING, not a nicety. A never-run Persistent timer does not catch up:
  // systemd writes the stamp at first start using the current time and does not
  // read a missing stamp as a missed window. Without this, a fresh turn-on waits
  // out a whole 15-minute slot before its first pass — the "merged but never
  // executed" gap this command exists to close. `--no-block` keeps the turn-on
  // from blocking on a whole pass.
  const firstPass = deps.systemctl(['--user', 'start', '--no-block', SYSTEMD_SERVICE]);
  const lines: string[] = [];
  if (firstPass.status !== 0) {
    lines.push(`warning: the first pass could not be started — ${detailOf(firstPass)}`);
  }
  lines.push(
    `recurring archive job on — ${SYSTEMD_TIMER}, every ` +
      `${START_INTERVAL_SECONDS / 60} minutes (${invocation.kind} layout)`,
    `  timer    ${timerPath}`,
    `  service  ${servicePath}`,
    `  wrapper  ${wrapperPath}`,
    `  passes   ${cronLogPath}`,
    `  unit log journalctl --user -u ${SYSTEMD_SERVICE}`,
    `note: ${WAKE_TIME_CAVEAT}`,
    ...lingerLines(deps),
  );
  console.log(lines.join('\n'));
  return 0;
}

async function statusSystemd(dataDirFlag: string | undefined, deps: ScheduleDeps): Promise<number> {
  const { servicePath, timerPath } = systemdPaths(deps);
  const lines: string[] = [];
  // The lstat gate is LOAD-BEARING: `show` cannot tell "absent" from "installed
  // but idle" — both answer `ActiveState=inactive` and exit 0.
  if (lstatSafe(timerPath)?.isFile() === true) {
    lines.push(`recurring archive job: installed — ${timerPath}`);
    lines.push(`  service  ${servicePath}`);
    // One `show`, and its exit code is IGNORED on purpose: the lstat above has
    // already answered the only question the code could speak to.
    const shown = deps.systemctl([
      '--user',
      'show',
      SYSTEMD_TIMER,
      `--property=${SYSTEMD_TIMER_PROPERTIES.join(',')}`,
    ]);
    const properties = parseProperties(shown.stdout);
    lines.push(
      `  timer state: ${reported(properties.get('ActiveState'))}`,
      `  unit file: ${reported(properties.get('UnitFileState'))}`,
      `  next trigger: ${reported(properties.get('NextElapseUSecRealtime'))}`,
      `  last trigger: ${reported(properties.get('LastTriggerUSec'))}`,
      `  last result: ${reported(properties.get('Result'))}`,
    );
  } else {
    lines.push('recurring archive job: not installed');
    lines.push('  turn it on with: agent-lens schedule install');
  }
  lines.push(...lingerLines(deps));
  // The EXISTING freshness path, unchanged — same lazy import as the launchd arm,
  // so a status report never loads `node:sqlite` through `doctor.ts`.
  const [{ formatLastPassSection }, { readCronLogStatus }] = await Promise.all([
    import('./doctor.js'),
    import('../../archive/cron-log.js'),
  ]);
  lines.push(...formatLastPassSection(readCronLogStatus(dataDirFlag), deps.now()));
  lines.push('', `note: ${WAKE_TIME_CAVEAT}`);
  console.log(lines.join('\n'));
  return 0;
}

function disableSystemd(dataDirFlag: string | undefined, deps: ScheduleDeps): number {
  const transcriptRoot = resolveTranscriptRoot();
  const wrapperPath = resolveScheduleWrapperPath(resolveDataDir(dataDirFlag));
  const { servicePath, timerPath, wantsPath } = systemdPaths(deps);
  const wasInstalled = lstatSafe(timerPath) !== undefined || lstatSafe(servicePath) !== undefined;

  // Two verbs, not `disable --now`: splitting removes the only version-floor
  // question in the verb set and gives two separately reportable statuses.
  // Neither status becomes the exit code — turning something off that is already
  // off is not a failure, and the files below come away either way.
  const stopped = deps.systemctl(['--user', 'stop', SYSTEMD_TIMER]);
  const disabled = deps.systemctl(['--user', 'disable', SYSTEMD_TIMER]);

  const removed: string[] = [];
  // Four paths, and the `timers.target.wants` symlink is the one that matters:
  // `disable` on a unit whose file is already gone exits 1 WITHOUT removing it,
  // leaving a dangling link behind. `removeIfPresent` is `lstat` + `unlink`,
  // which takes the link itself and never its target.
  for (const path of [timerPath, servicePath, wantsPath, wrapperPath]) {
    if (removeIfPresent(path, transcriptRoot)) removed.push(path);
  }
  deps.systemctl(['--user', 'daemon-reload']);
  // `<dataDir>/schedule` only. The unit dir and `timers.target.wants` are shared
  // with every other user unit on the box and are deliberately left standing.
  removeEmptyDir(dirname(wrapperPath), transcriptRoot);

  const lines: string[] = [];
  const refused = [stopped, disabled].find((result) => result.status !== 0);
  if (refused !== undefined && wasInstalled) {
    // Without this, an absent `systemctl` or a missing user bus would print
    // "removed" and exit 0 in silence.
    lines.push(
      `warning: systemctl --user could not stop the timer — ${detailOf(refused)}`,
      '  the unit files were removed anyway, so nothing is left to fire',
    );
  }
  if (removed.length === 0) {
    lines.push('recurring archive job: not installed — nothing to remove');
  } else {
    lines.push(
      'recurring archive job off — removed:',
      ...removed.map((path) => `  ${path}`),
      '  cron.log and the archive itself are untouched',
    );
  }
  console.log(lines.join('\n'));
  return 0;
}

export async function schedule(
  args: string[] = [],
  deps: ScheduleDeps = realDeps(),
): Promise<number> {
  const action = parseScheduleAction(args);
  const dataDir = parseStringFlag(args, 'dataDir');
  switch (action) {
    case 'install':
      return install(dataDir, deps);
    case 'status':
      return status(dataDir, deps);
    case 'disable':
      return disable(dataDir, deps);
    case undefined:
      console.error(`agent-lens schedule: an action is required — ${ACTIONS}`);
      return 1;
    default:
      console.error(`agent-lens schedule: unknown action ${action} — expected ${ACTIONS}`);
      return 1;
  }
}
