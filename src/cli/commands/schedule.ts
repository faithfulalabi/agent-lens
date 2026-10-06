// `agent-lens schedule` — the recurring archive job: a launchd plist on darwin, a
// `.service` + `.timer` on linux, chosen by the injected platform. Both drive the
// SAME generated wrapper byte-for-byte, so `doctor` reads one `cron.log` format on
// both; a second format would break it on one platform only.
//
// Exit codes are 0 and 1 only. Every binary, path and env read is an injected dep,
// so no test reaches a real `launchctl`/`systemctl`/`loginctl` or unit dir.

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
/** A hand-authored predecessor, removed on turn-on so two jobs never race. */
export const LEGACY_LABEL = 'com.faithful.agent-lens.archive';
const START_INTERVAL_SECONDS = 900;
/** Pinned: `parseCronLog` anchors on this exact shape, colon-less offset included. */
export const CRON_STAMP_FORMAT = '+%Y-%m-%dT%H:%M:%S%z';
/**
 * The compiled entry `bin/agent-lens.js` imports, relative to the package root.
 *
 * The only literal of this path in `src/`: the generated wrapper guards a built
 * layout on it, and `bin/agent-lens.js` imports it. `packaging.test.ts` asserts
 * the shim's source contains `../${BUILT_CLI_ENTRY}`, so the two sites cannot
 * drift apart without reddening.
 */
export const BUILT_CLI_ENTRY = 'dist/src/cli/index.js';
export const WAKE_TIME_CAVEAT =
  'a wall-clock schedule does not fire while the machine is asleep — treat the interval as a bound on wake time, not on elapsed time';
/** Quoted verbatim by `README.md` and pinned by `docs.test.ts` — never retype it. */
export const LINGER_CAVEAT =
  'a systemd user timer does not run while you are logged out unless lingering is on for your user';

/** Fixed, so a second turn-on replaces its own units rather than duplicating them. */
export const SYSTEMD_UNIT_BASE = 'agent-lens-archive';
const SYSTEMD_SERVICE = `${SYSTEMD_UNIT_BASE}.service`;
const SYSTEMD_TIMER = `${SYSTEMD_UNIT_BASE}.timer`;
const SYSTEMD_CALENDAR = '*:0/15';
/** Asked for in one `show`, whose reply order is not the requested order. */
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
  /** `XDG_CONFIG_HOME`; a dep, not an env read, so no test lands a unit in a real one. */
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
    // `?? 0` is unreachable where it matters: `getuid` is always defined on Linux.
    uid: process.getuid?.() ?? 0,
    moduleUrl: import.meta.url,
    launchctl: realRunner('launchctl'),
    systemctl: realRunner('systemctl'),
    loginctl: realRunner('loginctl'),
    configHome: process.env.XDG_CONFIG_HOME,
    now: Date.now,
  };
}

/** First bare token; a `--dataDir` value is consumed by position, never inspected. */
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

/** Nearest ancestor holding a `package.json`. */
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
 * A dev checkout runs the TS entry under tsx, so a stale `dist/` can never silently
 * execute old archive logic; the built package runs `bin/agent-lens.js`.
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
 * The wrapper both backends run. Its `cron.log` line must stay byte-compatible with
 * `parseCronLog`: timestamp, status token, summary.
 */
export function buildWrapperScript(opts: WrapperOptions): string {
  const { kind, packageRoot } = opts.invocation;
  const entry = kind === 'source' ? '$ROOT/src/cli/index.ts' : '$ROOT/bin/agent-lens.js';
  // `--dataDir` explicit: an env-default lookup under launchd could pick another dir.
  const run =
    kind === 'source'
      ? '"$NODE" --import tsx "$ROOT/src/cli/index.ts" archive --dataDir "$DATA_DIR"'
      : '"$NODE" "$ROOT/bin/agent-lens.js" archive --dataDir "$DATA_DIR"';
  // The fourth precondition is the ONE thing the two layouts genuinely disagree
  // about, and hardcoding the source answer is what made every published install
  // FATAL on a correct tree. A checkout needs `tsx`, a devDependency, so it lives
  // only in that checkout's own `node_modules`. A published install needs the
  // compiled file its shim imports; its two runtime deps are hoisted to an
  // ANCESTOR of `$ROOT` that Node's resolver reaches unaided, so `$ROOT/node_modules`
  // neither exists nor needs to. `-f` on the entry rather than `-d dist`: an empty
  // or half-extracted `dist/` passes a directory test and then dies inside the
  // shim's `await import` as ERR_MODULE_NOT_FOUND, which the `case` below reports
  // as a status token plus a stack trace instead of naming the path and the remedy.
  const requirement =
    kind === 'source'
      ? '[ -d "$ROOT/node_modules" ] || { say "FATAL node_modules missing — run npm install in $ROOT"; exit 1; }'
      : `[ -f "$ROOT/${BUILT_CLI_ENTRY}" ] || { say "FATAL built CLI missing: $ROOT/${BUILT_CLI_ENTRY} — reinstall @faithfulalabi/agent-lens"; exit 1; }`;
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
${requirement}

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
 * Escaping for a systemd `.ini` VALUE — not a shell word, not a unit name, so
 * neither `shQuote` nor `systemd-escape`. The order is load-bearing: `\`, then `"`,
 * then `%` (unescaped it expands as a specifier and the unit fails to load), then
 * `$` (unescaped it expands to an empty string, silently mangling the path). A
 * newline cannot be encoded and throws; both unit texts are built before the first
 * write, so a refused value leaves nothing on disk.
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
 * One oneshot pass of the shared wrapper. `/bin/sh <wrapper>` rather than the script
 * directly, so a broken shebang or a lost +x bit surfaces as a script error instead
 * of a silent no-op. No `StandardOutput=append:` — results already reach `cron.log`,
 * and `append:` has a later systemd floor than every directive here.
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
 * `OnCalendar` + `Persistent=true`, not `OnUnitActiveSec`: only the calendar form
 * catches up a slot missed while the machine was off, and only it reports a
 * `NextElapseUSecRealtime` for `schedule status` to print.
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

// --- writes, each behind one call site ---------------------------------------

/** The one mkdir; the assert keeps `--dataDir ~/.claude/projects` out of the corpus. */
function ensureDirOutsideCorpus(dir: string, mode: number, transcriptRoot: string): void {
  assertNotUnderRoot(dir, transcriptRoot, TRANSCRIPT_ROOT_LABEL);
  mkdirSync(dir, { recursive: true, mode });
}

/** Temp-write → chmod → rename. */
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
 * Only for `<dataDir>/schedule` — never the systemd unit dir or `timers.target.wants`,
 * which are shared with every other user unit. `rmdir(2)` removes an empty directory
 * only, so a non-empty or absent one is a tolerated no-op; the try/catch wraps the
 * rmdir ALONE so a containment refusal still reaches the caller.
 */
function removeEmptyDir(dir: string, transcriptRoot: string): void {
  assertNotUnderRoot(dir, transcriptRoot, TRANSCRIPT_ROOT_LABEL);
  try {
    rmdirSync(dir);
  } catch {
    // Not empty, or never created — either way it is not ours to force.
  }
}

// --- actions -----------------------------------------------------------------

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

  // Migrate the legacy job out FIRST, so the two never race.
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

  // Bootout then bootstrap, so a second run replaces rather than duplicates;
  // "not loaded" from the bootout is the healthy first run and is ignored.
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
  // Lazy: `doctor.ts` statically reaches `node:sqlite`, which a status must not load.
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

// --- systemd backend ---------------------------------------------------------

interface SystemdPaths {
  unitDir: string;
  servicePath: string;
  timerPath: string;
  /** The symlink `enable` plants; outside the data dir and shared, by design. */
  wantsPath: string;
}

/** From the injected home dir and `configHome`, never ambient env. */
function systemdPaths(deps: ScheduleDeps): SystemdPaths {
  return {
    unitDir: resolveSystemdUserDir(deps.homeDir, deps.configHome),
    servicePath: resolveSystemdUnitPath(SYSTEMD_SERVICE, deps.homeDir, deps.configHome),
    timerPath: resolveSystemdUnitPath(SYSTEMD_TIMER, deps.homeDir, deps.configHome),
    wantsPath: resolveSystemdWantsPath(SYSTEMD_TIMER, deps.homeDir, deps.configHome),
  };
}

/** Refusal detail; a spawn error arrives as stderr. */
function detailOf(result: CommandResult): string {
  return (result.stderr || result.stdout).trim() || `systemctl exited ${String(result.status)}`;
}

/** `k=v` as a map, never positionally: `show` does not reply in the requested order. */
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
 * Anything but an explicit `yes`/`no` is `unknown` — a `loginctl` that exits 0
 * printing nothing must not read as "off". A missing one degrades to `unknown` too.
 */
function readLingerState(deps: ScheduleDeps): LingerState {
  const result = deps.loginctl(['show-user', String(deps.uid), '--property=Linger']);
  if (result.status !== 0) return 'unknown';
  const value = parseProperties(result.stdout).get('Linger');
  if (value === 'yes') return 'on';
  if (value === 'no') return 'off';
  return 'unknown';
}

/** Advisory only: `enable-linger` writes outside everything this tool owns, so it is printed, never run. */
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

  // Assert EVERY path and build both unit texts before the first mkdir, so a
  // corpus `--dataDir` or a line break in a unit value refuses with nothing written.
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
  // 0o700 only lands on a unit dir this command creates; `mkdir -p` leaves an
  // existing directory's mode alone.
  ensureDirOutsideCorpus(unitDir, 0o700, transcriptRoot);
  atomicWrite(wrapperPath, wrapperText, 0o700, transcriptRoot);
  atomicWrite(servicePath, serviceText, 0o644, transcriptRoot);
  atomicWrite(timerPath, timerText, 0o644, transcriptRoot);

  // `restart` re-arms with the fresh text, starts an inactive timer, and does not
  // reset the Persistent stamp.
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

  // Required: a Persistent timer stamps itself at first start, so without this kick
  // a fresh turn-on idles a whole slot. `--no-block` so turn-on never waits on a pass.
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
  // The lstat gate is load-bearing: `show` cannot tell absent from installed-but-idle
  // — both answer `ActiveState=inactive` and exit 0.
  if (lstatSafe(timerPath)?.isFile() === true) {
    lines.push(`recurring archive job: installed — ${timerPath}`);
    lines.push(`  service  ${servicePath}`);
    // Exit code ignored on purpose: the lstat above already answered the question.
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
  // Same lazy import as the launchd arm: no `node:sqlite` in a status report.
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

  // Two verbs, not `disable --now`: avoids the one version-floor question. Neither
  // status becomes the exit code — off when already off is not a failure.
  const stopped = deps.systemctl(['--user', 'stop', SYSTEMD_TIMER]);
  const disabled = deps.systemctl(['--user', 'disable', SYSTEMD_TIMER]);

  const removed: string[] = [];
  // `wantsPath` is named explicitly: `disable` leaves that symlink dangling once the
  // unit file is gone.
  for (const path of [timerPath, servicePath, wantsPath, wrapperPath]) {
    if (removeIfPresent(path, transcriptRoot)) removed.push(path);
  }
  deps.systemctl(['--user', 'daemon-reload']);
  removeEmptyDir(dirname(wrapperPath), transcriptRoot);

  const lines: string[] = [];
  const refused = [stopped, disabled].find((result) => result.status !== 0);
  if (refused !== undefined && wasInstalled) {
    // Otherwise a missing user bus prints "removed" and exits 0 in silence.
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
