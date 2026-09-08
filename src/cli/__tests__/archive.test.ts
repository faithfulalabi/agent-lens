// The exit-code contract of `agent-lens archive`, stated at `commands/archive.ts:1`
// and pinned here — the first tests of that file in the repo.
//
// Two harnesses, deliberately. `exitCodeFor` and `formatSummary` are pure, so the
// rule table and the summary leader are unit tests. Everything that claims a
// PROCESS exit code spawns the real binary the cron invokes, because that is the
// only place the chain `archive -> main -> bin/agent-lens.js` is actually joined.
//
// Every spawn carries BOTH the flags and `AGENT_LENS_DIR` / `AGENT_LENS_TRANSCRIPT_ROOT`
// into the sandbox: an unrecognised flag is silently ignored today, so the env vars
// are the belt to the flags' braces. No test here may reach a real `~/.agent-lens`.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveArchiveLogPath, resolveLockPath, type ArchiveResult } from '../../archive/index.js';
import { main } from '../index.js';
import {
  EXIT_ARCHIVE_ERRORS,
  EXIT_INCOMPLETE,
  EXIT_OK,
  exitCodeFor,
  formatSummary,
} from '../commands/archive.js';
import {
  archivePath,
  cleanup,
  decoyPath,
  jsonLines,
  makeSandbox,
  plantArchiveSymlink,
  SLUG,
  sourcePath,
  writeArchive,
  writeSource,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';

const SESSION = `${SLUG}/sess-1.jsonl`;
const OTHER = `${SLUG}/sess-2.jsonl`;

const HERE = resolve(import.meta.dirname, '../../..');
const BIN = join(HERE, 'bin', 'agent-lens.js');

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

/** Run the real binary — what cron invokes — and parse its `--json` pass report. */
function runBinary(s: Sandbox): Promise<{ status: number | null; result: ArchiveResult }> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [BIN, 'archive', '--dataDir', s.dataDir, '--transcriptRoot', s.sourceRoot, '--json'],
      {
        env: {
          ...process.env,
          AGENT_LENS_DIR: s.dataDir,
          AGENT_LENS_TRANSCRIPT_ROOT: s.sourceRoot,
        },
      },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.on('close', (status) =>
      resolvePromise({ status, result: JSON.parse(stdout) as ArchiveResult }),
    );
  });
}

/** Spawn any subcommand for its status alone. `dataDir` sandboxes commands with no flag for it. */
function runCommand(args: string[], dataDir: string): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, AGENT_LENS_DIR: dataDir },
    });
    child.stdin.end();
    child.on('close', (status) => resolvePromise(status));
  });
}

/** `main` writes the summary to stdout; tests that only want its code must not print it. */
async function silentMain(args: string[]): Promise<number> {
  const original = console.log;
  console.log = () => {};
  try {
    return await main(args);
  } finally {
    console.log = original;
  }
}

function resultWith(
  errors: ArchiveResult['errors'],
  overrides: Partial<ArchiveResult> = {},
): ArchiveResult {
  return {
    files: [],
    filesSeen: 1,
    bytesCopied: 8,
    bytesRead: 8,
    lock: { state: 'acquired' },
    errors,
    sourceRoot: '/src',
    archiveRoot: '/data/archive',
    logged: true,
    sealed: [],
    ...overrides,
  };
}

function err(
  origin: ArchiveResult['errors'][number]['origin'],
  path = '/p',
): ArchiveResult['errors'][number] {
  return { path, message: `Error: ${origin} failed`, origin };
}

describe('exitCodeFor — the rule, one row per outcome (AC1, AC4)', () => {
  it.each([
    ['a clean pass', resultWith([]), EXIT_OK],
    ['an archive-side error', resultWith([err('archive')]), EXIT_ARCHIVE_ERRORS],
    ['a source-side error', resultWith([err('source')]), EXIT_OK],
    ['a log-append error', resultWith([err('log')]), EXIT_OK],
    [
      'all three at once — the archive-side one decides',
      resultWith([err('source'), err('log'), err('archive')]),
      EXIT_ARCHIVE_ERRORS,
    ],
    [
      'a held lock and no errors',
      resultWith([], { lock: { state: 'held', holder_pid: 1 }, filesSeen: 0, bytesCopied: 0 }),
      EXIT_OK,
    ],
    [
      'a held lock whose only failure was the log append',
      resultWith([err('log')], { lock: { state: 'held', holder_pid: 1 } }),
      EXIT_OK,
    ],
    [
      'a diverged file and no errors',
      resultWith([], {
        files: [
          {
            source_path: '/src/a.jsonl',
            source_size: 2,
            source_mtime_ms: 0,
            source_head_sha256: 'sha',
            source_head_len: 2,
            source_state: 'diverged',
            archive_path: '/data/archive/a.jsonl',
            archive_size: 9,
            archive_state: 'hot',
            reason: 'shrink',
            bytes_copied: 0,
          },
        ],
      }),
      EXIT_OK,
    ],
  ])('%s exits %i', (_name, result, expected) => {
    expect(exitCodeFor(result)).toBe(expected);
  });

  it('never returns 2 — reserved protocol-wide, because it blocks a Claude Code session', () => {
    // `src/cli/hook.ts:3`. The codes are a binary-wide namespace, so the rule is
    // pinned where the only code-producing command lives.
    const everyShape = [
      resultWith([]),
      resultWith([err('source')]),
      resultWith([err('log')]),
      resultWith([err('archive')]),
      resultWith([err('archive'), err('source'), err('log')]),
    ];
    for (const result of everyShape) expect(exitCodeFor(result)).not.toBe(2);
    expect([EXIT_OK, EXIT_INCOMPLETE, EXIT_ARCHIVE_ERRORS]).not.toContain(2);
  });
});

describe('formatSummary names the error count in its leader (AC — the non-paging channel)', () => {
  // Under this contract a source-side or log-side failure exits 0 and `doctor`
  // reports a fully green archive, so this line is the ONLY channel that carries
  // the signal to a human. `head -1` of a run with errors must not read as success.
  it('a clean pass keeps the bare leader', () => {
    expect(formatSummary(resultWith([])).split('\n')[0]).toBe(
      'agent-lens archive: 1 files, 8 bytes copied',
    );
  });

  it('one error is named in the leader, singular', () => {
    expect(formatSummary(resultWith([err('log', '/d/logs/archive.jsonl')])).split('\n')[0]).toBe(
      'agent-lens archive: 1 files, 8 bytes copied, 1 error',
    );
  });

  it('several errors are named in the leader, plural', () => {
    const summary = formatSummary(resultWith([err('source', '/a'), err('archive', '/b')]));
    expect(summary.split('\n')[0]).toBe('agent-lens archive: 1 files, 8 bytes copied, 2 errors');
  });

  it('a held lock that failed to log says so in its leader too', () => {
    const summary = formatSummary(
      resultWith([err('log')], { lock: { state: 'held', holder_pid: 7 } }),
    );
    expect(summary.split('\n')[0]).toBe(
      'agent-lens archive: another pass holds the lock (pid 7) — copied nothing, 1 error',
    );
  });

  it('still prints one detail line per error underneath', () => {
    const summary = formatSummary(resultWith([err('archive', '/b')]));
    expect(summary.split('\n')[1]).toBe('  error  /b: Error: archive failed');
  });
});

describe('the spawned binary carries the code (AC2)', () => {
  it('a clean pass exits 0 — the positive control', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(3));

    const { status, result } = await runBinary(s);

    expect(status).toBe(EXIT_OK);
    expect(result.errors).toHaveLength(0); // non-vacuity: nothing was wrong to begin with
    expect(existsSync(archivePath(s, SESSION))).toBe(true);
  });

  it("task 1.4's leaf-symlink refusal is archive-side, so it exits 3", async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(3));
    writeSource(s, OTHER, jsonLines(2));
    const decoy = decoyPath(s, 'leaf-target.txt');
    writeFileSync(decoy, 'ORIGINAL-LEAF');
    plantArchiveSymlink(s, SESSION, decoy);

    const { status, result } = await runBinary(s);

    expect(status).toBe(EXIT_ARCHIVE_ERRORS);
    // …and NOT 1: "a pass ran and the write path failed" stays distinguishable
    // from "nothing ran at all", which is the whole point of a third code.
    expect(status).not.toBe(EXIT_INCOMPLETE);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.origin).toBe('archive');
    expect(result.errors[0]?.message).toMatch(/refusing to follow a symlinked archive destination/);
    // The victim is untouched and the rest of the pass still ran.
    expect(readFileSync(decoy, 'utf8')).toBe('ORIGINAL-LEAF');
    expect(existsSync(archivePath(s, OTHER))).toBe(true);
  });

  it("task 1.5's log-leaf refusal is log-side, so it exits 0", async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(3));
    const decoy = decoyPath(s, 'log-target.txt');
    writeFileSync(decoy, 'ORIGINAL-LOG');
    const logPath = resolveArchiveLogPath(s.dataDir);
    mkdirSync(join(s.dataDir, 'logs'), { recursive: true });
    symlinkSync(decoy, logPath);

    const { status, result } = await runBinary(s);

    expect(status).toBe(EXIT_OK);
    expect(result.errors).toHaveLength(1); // non-vacuity: the refusal really happened
    expect(result.errors[0]?.origin).toBe('log');
    expect(result.logged).toBe(false);
    // The bytes the pass already copied are not costed by the log refusal (1.5's Ruling 2).
    expect(readFileSync(decoy, 'utf8')).toBe('ORIGINAL-LOG');
    expect(existsSync(archivePath(s, SESSION))).toBe(true);
  });

  it('an unreadable source is source-side, so it exits 0 and the rest still mirrors', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(3));
    const locked = writeSource(s, OTHER, jsonLines(2));
    chmodSync(locked, 0o000);
    try {
      const { status, result } = await runBinary(s);

      // A source that cannot be read is a COVERAGE gap, which `doctor` reports.
      // Paging nightly for it would mute the alert long before anyone read it.
      expect(status).toBe(EXIT_OK);
      expect(result.errors).toHaveLength(1); // reds loudly rather than passing if run as root
      expect(result.errors[0]?.origin).toBe('source');
      expect(result.errors[0]?.path).toBe(sourcePath(s, OTHER));
      expect(existsSync(archivePath(s, SESSION))).toBe(true);
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it('a dangling symlinked ancestor is archive-side too, though no guard classified it', async () => {
    // The case an error-CLASS discriminator provably misses: the kernel's ENOENT
    // out of `mkdirSync` inside `ensureDir` never passes through
    // `refuseSymlinkedLeaf` or `assertUnderArchiveRoot` at all
    // (`archive/__tests__/source-readonly.test.ts` (B3)). Classifying by which
    // path the failing syscall named catches it anyway.
    const s = sb();
    writeSource(s, SESSION, jsonLines(3));
    const escapeParent = join(s.root, 'escape-parent');
    mkdirSync(escapeParent, { recursive: true });
    mkdirSync(s.archiveRoot, { recursive: true });
    const danglingTarget = join(escapeParent, 'nonexistent');
    symlinkSync(danglingTarget, join(s.archiveRoot, SLUG));

    const { status, result } = await runBinary(s);

    expect(status).toBe(EXIT_ARCHIVE_ERRORS);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.origin).toBe('archive');
    expect(result.errors[0]?.message).toMatch(/ENOENT/);
    expect(existsSync(danglingTarget)).toBe(false);
  });
});

describe('the 1.4 and 1.5 populations diverge, deliberately (AC3)', () => {
  it('the leaf refusal pages and the log refusal does not, in one assertion', async () => {
    // AC3 as ruled: each population is pinned by its own test above, and the SPLIT
    // between them is asserted here so neither can drift into the other's code by
    // accident. Both are refusals of a planted symlink; only one is on the path
    // that holds the bytes.
    const leaf = sb();
    writeSource(leaf, SESSION, jsonLines(3));
    const leafDecoy = decoyPath(leaf, 'leaf-target.txt');
    writeFileSync(leafDecoy, 'ORIGINAL-LEAF');
    plantArchiveSymlink(leaf, SESSION, leafDecoy);

    const log = makeSandbox();
    try {
      writeSource(log, SESSION, jsonLines(3));
      const logDecoy = decoyPath(log, 'log-target.txt');
      writeFileSync(logDecoy, 'ORIGINAL-LOG');
      mkdirSync(join(log.dataDir, 'logs'), { recursive: true });
      symlinkSync(logDecoy, resolveArchiveLogPath(log.dataDir));

      const [leafRun, logRun] = [await runBinary(leaf), await runBinary(log)];

      expect([leafRun.status, logRun.status]).toEqual([EXIT_ARCHIVE_ERRORS, EXIT_OK]);
      expect(EXIT_ARCHIVE_ERRORS).not.toBe(EXIT_OK);
      // Both really failed — the split is between two errors, not between an error
      // and a clean pass.
      expect([leafRun.result.errors[0]?.origin, logRun.result.errors[0]?.origin]).toEqual([
        'archive',
        'log',
      ]);
    } finally {
      cleanup(log);
    }
  });
});

describe('the codes a wrapper can tell apart (AC1)', () => {
  // The other half of this pin — an errored pass exits 3 and NOT 1 — rides on the
  // leaf-refusal test above rather than re-planting the same fixture to spawn again.
  it('an unknown command still exits 1 — no pass ran, so nothing is said about the archive', async () => {
    const s = sb();
    expect(await runCommand(['bogus-command'], s.dataDir)).toBe(EXIT_INCOMPLETE);
  });
});

describe('widening `Command.run` leaves every other command at 0', () => {
  // `main` returns `code ?? 0`, so a command that returns `void` keeps its old
  // code only because `undefined ?? 0` is 0. Nothing exercised that before.
  //
  // Re-pointed from `hook` to `doctor` by task 4.5: `hook` was the cheapest
  // non-`archive` command to drive, and it is deleted. `doctor` is the only
  // remaining `void` command — `start` boots a server — and the pairing with the
  // unknown-command row above is what makes this a differential rather than an
  // assertion that everything is 0.
  it('main(["doctor"]) returns 0 — a void command still reports success', async () => {
    const s = sb();
    mkdirSync(s.dataDir, { recursive: true });
    expect(
      await silentMain(['doctor', `--dataDir=${s.dataDir}`, `--transcriptRoot=${s.sourceRoot}`]),
    ).toBe(EXIT_OK);
  });

  it('a spawned `agent-lens doctor` exits 0, never 2', async () => {
    const s = sb();
    mkdirSync(s.dataDir, { recursive: true });

    const status = await runCommand(['doctor', `--dataDir=${s.dataDir}`], s.dataDir);

    expect(status).toBe(EXIT_OK);
    expect(status).not.toBe(2); // exit 2 blocks a Claude Code session
  });
});

describe('the ship-phase commands stay inside the same code namespace', () => {
  // Extends the never-2 pin from prose to the four commands that arrived with
  // `rebuild`/`warm`/`prune`, in a SUCCESS and a FAILURE shape each — a rule
  // asserted only over green paths says nothing about the paths that matter.
  //
  // `runCommand` closes stdin, so the `prune` rows arrive at EOF and decline.
  // Every row carries `--transcriptRoot` as well as the env var: `prune` reads
  // the transcript tree to resolve a target, and no test may reach a real one.
  it.each([
    ['rebuild, nothing to drop', EXIT_OK, (s: Sandbox) => ['rebuild', `--dataDir=${s.dataDir}`]],
    [
      'rebuild, unknown session',
      EXIT_INCOMPLETE,
      (s: Sandbox) => ['rebuild', 'no-such-session', `--dataDir=${s.dataDir}`],
    ],
    ['rebuild, flag with no value', EXIT_INCOMPLETE, () => ['rebuild', '--dataDir']],
    [
      'warm, an empty corpus',
      EXIT_OK,
      (s: Sandbox) => ['warm', `--dataDir=${s.dataDir}`, `--transcriptRoot=${s.sourceRoot}`],
    ],
    ['warm, flag with no value', EXIT_INCOMPLETE, () => ['warm', '--dataDir']],
    [
      'prune, declined at EOF',
      EXIT_OK,
      (s: Sandbox) => ['prune', `--dataDir=${s.dataDir}`, `--transcriptRoot=${s.sourceRoot}`],
    ],
    ['prune, an option it does not recognise', EXIT_INCOMPLETE, () => ['prune', '--older-than=30']],
    ['doctor', EXIT_OK, (s: Sandbox) => ['doctor', `--dataDir=${s.dataDir}`]],
    // Task 0.6, at PROCESS level: the rejection has to survive the whole chain
    // `main -> bin/agent-lens.js -> exit code`, not just return 1 in-process.
    // No `start` row here on purpose — a stale `dist/` would boot a server and
    // hang the suite rather than fail it. `args.test.ts` covers it in-process.
    ['archive, the 2026-08-09 typo', EXIT_INCOMPLETE, () => ['archive', '--data-dir=/nope']],
    [
      'rebuild, id after a flag',
      EXIT_INCOMPLETE,
      (s: Sandbox) => ['rebuild', `--dataDir=${s.dataDir}`, 'no-such-session'],
    ],
  ])('%s exits %i, never 2', async (_name, expected, argsOf) => {
    const s = sb();
    mkdirSync(s.dataDir, { recursive: true });

    const status = await runCommand(argsOf(s), s.dataDir);

    expect(status).toBe(expected);
    expect(status).not.toBe(2); // exit 2 blocks a Claude Code session
  });
});

describe('the pass outcomes the contract promises stay at 0 (AC4)', () => {
  it('a diverged pass exits 0 and reports no error', async () => {
    const s = sb();
    writeArchive(s, SESSION, jsonLines(8));
    writeSource(s, SESSION, jsonLines(2));

    expect(
      await silentMain(['archive', `--dataDir=${s.dataDir}`, `--transcriptRoot=${s.sourceRoot}`]),
    ).toBe(EXIT_OK);
  });

  it('a held lock exits 0 — a cron must not page for a normal overlap', async () => {
    const s = sb();
    writeSource(s, SESSION, jsonLines(3));
    mkdirSync(s.dataDir, { recursive: true });
    writeFileSync(
      resolveLockPath(s.dataDir),
      JSON.stringify({ pid: 1, started_at: Date.now(), hostname: hostname() }),
      { mode: 0o600 },
    );

    expect(
      await silentMain(['archive', `--dataDir=${s.dataDir}`, `--transcriptRoot=${s.sourceRoot}`]),
    ).toBe(EXIT_OK);
    expect(existsSync(archivePath(s, SESSION))).toBe(false);
  });
});
