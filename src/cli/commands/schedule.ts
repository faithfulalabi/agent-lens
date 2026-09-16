// `agent-lens schedule` — the recurring archive job, owned end to end: a
// generated wrapper under the data dir, a launchd plist under the user's
// LaunchAgents, and the `launchctl` calls that load and unload them. The
// wrapper appends the per-pass `cron.log` line `readCronLogStatus` reads, so
// `doctor`'s freshness report keeps working unchanged.
//
// Exit codes: 0 (done, or a report) and 1 (failed, refused, or nothing was set
// up on this platform). Never 2 — reserved product-wide (`commands/archive.ts:1`)
// — and never 3, which belongs to the archive pass itself.
//
// `launchctl` sits behind an injectable runner and the platform, home dir, uid
// and module URL behind `ScheduleDeps`, so the test suite never touches the
// real LaunchAgents dir and never runs a real `launchctl`.

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

const ACTIONS = 'install | status | disable';
const NON_MACOS_POINTER =
  'the recurring job uses launchd, which is macOS-only. Elsewhere, run `agent-lens archive` ' +
  'every ~15 minutes yourself — a systemd timer or cron entry — per the README section ' +
  '"Keeping the archive current".';

export interface LaunchctlResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type LaunchctlRunner = (args: string[]) => LaunchctlResult;

/** Everything the command reads from the machine, injectable for tests. */
export interface ScheduleDeps {
  platform: NodeJS.Platform;
  execPath: string;
  homeDir: string;
  uid: number;
  /** Decides the dev-vs-built invocation and locates the package root. */
  moduleUrl: string;
  launchctl: LaunchctlRunner;
  now: () => number;
}

function realLaunchctl(args: string[]): LaunchctlResult {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.error === undefined ? (result.stderr ?? '') : String(result.error.message),
  };
}

function realDeps(): ScheduleDeps {
  return {
    platform: process.platform,
    execPath: process.execPath,
    homeDir: homedir(),
    uid: process.getuid?.() ?? 0,
    moduleUrl: import.meta.url,
    launchctl: realLaunchctl,
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

// --- the three actions -------------------------------------------------------

function gui(deps: ScheduleDeps, label: string): string {
  return `gui/${deps.uid}/${label}`;
}

function install(dataDirFlag: string | undefined, deps: ScheduleDeps): number {
  if (deps.platform !== 'darwin') {
    console.error(`agent-lens schedule: nothing was set up — ${NON_MACOS_POINTER}`);
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
  if (deps.platform !== 'darwin') {
    console.log(`agent-lens schedule: ${NON_MACOS_POINTER}`);
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
  if (deps.platform !== 'darwin') {
    console.error(`agent-lens schedule: nothing was removed — ${NON_MACOS_POINTER}`);
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
  try {
    // Only the directory the turn-on created, and only when nothing else is in it.
    rmdirSync(dirname(wrapperPath));
  } catch {
    // Not empty, or never created — either way it is not ours to force.
  }
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
