// Three guards: 19, that the transcript root is never written to; 20, that the
// binary cron runs never loads `node:sqlite`, transitively; and 21, that a
// symlink planted at an archive leaf is refused rather than followed.

import { afterEach, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { archiveOnce } from '../mirror.js';
import type { ArchiveLogRecord } from '../log.js';
import {
  cleanup,
  jsonLines,
  makeSandbox,
  SLUG,
  snapshotTree,
  snapshotTreeSafe,
  sourcePath,
  writeSource,
  type Sandbox,
} from './fixtures.js';

const REPO = resolve(import.meta.dirname, '../../..');
const BIN = join(REPO, 'bin', 'agent-lens.js');
const ARCHIVE_SRC = join(REPO, 'src', 'archive');

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) {
    restorePermissions(sandbox.sourceRoot);
    cleanup(sandbox);
  }
  sandbox = undefined;
});

/** Dirs 0500, files 0400, bottom-up. */
function lockDown(dir: string): void {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) lockDown(path);
    else chmodSync(path, 0o400);
  }
  chmodSync(dir, 0o500);
}

/** Undo `lockDown`, or the temp-dir teardown itself fails with EACCES. */
function restorePermissions(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    chmodSync(dir, 0o700);
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, dirent.name);
      if (dirent.isDirectory()) restorePermissions(path);
      else chmodSync(path, 0o600);
    }
  } catch {
    // Best effort — teardown must not mask the real assertion failure.
  }
}

const SESSION = `${SLUG}/sess-1.jsonl`;
const VICTIM = `${SLUG}/victim.jsonl`;
const OTHER = `${SLUG}/sess-2.jsonl`;
const META = `${SLUG}/sess-1/subagents/agent-a.meta.json`;
const PARTIAL = `${SLUG}/sess-3.jsonl`;

/** All five scenarios in one corpus, so one pass exercises every branch. */
function buildMixedCorpus(s: Sandbox): void {
  writeSource(s, SESSION, jsonLines(6));
  writeSource(s, OTHER, jsonLines(6, 200));
  writeSource(s, META, '{"model":"claude"}');
  writeSource(s, PARTIAL, `${jsonLines(3, 400)}{"partial":`);

  // Archive everything once, then manufacture the other four states.
  archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

  writeFileSync(sourcePath(s, OTHER), jsonLines(1, 200)); // -> diverged (shrink)
  rmSync(sourcePath(s, META)); // -> expired
  writeSource(s, PARTIAL, `${jsonLines(3, 400)}{"partial":1}\n`); // -> settled partial, completed
  truncateSync(join(s.archiveRoot, SESSION), 12); // -> crash resume
}

describe('the archive never writes to ~/.claude/projects (Test 19)', () => {
  it('leaves every source entry byte-, stat- and mode-identical across all five scenarios', () => {
    const s = sb();
    buildMixedCorpus(s);

    const before = snapshotTree(s.sourceRoot);
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTree(s.sourceRoot);

    // Assert the pass genuinely visited all five states, or the snapshot proves nothing.
    const states = result.files.map((f) => f.source_state);
    expect(states).toContain('diverged');
    expect(states).toContain('expired');
    expect(states).toContain('present');
    expect(result.bytesCopied).toBeGreaterThan(0);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, entry] of before) {
      expect(after.get(rel), rel).toEqual(entry);
    }
  });

  it('succeeds and copies the expected bytes with the source tree recursively read-only', () => {
    const s = sb();
    const body = jsonLines(8);
    writeSource(s, SESSION, body);
    writeSource(s, META, '{"model":"claude"}');
    // Locking only `root` protects nothing: in-scope files are levels deeper.
    lockDown(s.sourceRoot);

    const before = snapshotTree(s.sourceRoot);
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTree(s.sourceRoot);

    expect(result.errors).toEqual([]);
    expect(result.bytesCopied).toBe(body.length + '{"model":"claude"}'.length);
    expect(readFileSync(join(s.archiveRoot, SESSION), 'utf8')).toBe(body);
    for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);
  });

  it('an accidental write into the locked-down source tree really would throw', () => {
    // Positive control: otherwise "the pass succeeded" could mean the chmod
    // protected nothing.
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));
    lockDown(s.sourceRoot);

    expect(() => writeFileSync(sourcePath(s, SESSION), 'nope')).toThrow(/EACCES|EPERM/);
    expect(() => writeFileSync(join(dirname(sourcePath(s, SESSION)), 'new.jsonl'), 'x')).toThrow(
      /EACCES|EPERM/,
    );
  });
});

// --- Test 21: the archive never follows a symlinked leaf (task 1.4) ------

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDWR, O_WRONLY } = constants;

/** The one message every refusal must produce, whichever errno the kernel used. */
const REFUSED = /refusing to follow a symlinked archive destination/;

const DECOYS = 'decoys';

/**
 * Plants a symlink where the archive would put `rel`. `discover` cannot see it —
 * `readDirSafe` filters on `isFile()` and a symlink `Dirent` reports `false` — so
 * the entry still arrives from the source walk, which is the whole point.
 */
function plantArchiveSymlink(s: Sandbox, rel: string, target: string): string {
  const link = join(s.archiveRoot, rel);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
  return link;
}

/**
 * Creates `<dataDir>/decoys` and returns a path inside it — under `<dataDir>` but
 * outside the archive root, so the target is harmless and the dir is snapshottable
 * on its own without the archive log and lock churning underneath it.
 */
function decoyPath(s: Sandbox, name: string): string {
  const dir = join(s.dataDir, DECOYS);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function readArchiveLog(s: Sandbox): ArchiveLogRecord[] {
  const path = join(s.dataDir, 'logs', 'archive.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ArchiveLogRecord);
}

describe('the archive refuses a symlinked leaf (Test 21)', () => {
  it('(1) refuses a leaf symlink aimed into the transcript root, leaving the victim intact', () => {
    // The reproduction from the task's Why, committed. Pre-fix this pass returned
    // `errors: []`, copied 32 bytes, and appended `{"c":3}` to the victim.
    const s = sb();
    writeSource(s, SESSION, '{"a":1}\n{"b":2}\n{"c":3}\n');
    // A byte-PREFIX of the source on purpose: a non-prefix victim short-circuits
    // `detectDivergence` to 'head', so nothing is written and the repro looks
    // safe for the wrong reason. Case (3) below covers that path instead.
    const victim = writeSource(s, VICTIM, '{"a":1}\n{"b":2}\n');
    const link = plantArchiveSymlink(s, SESSION, victim);

    const victimBytes = readFileSync(victim);
    const before = snapshotTree(s.sourceRoot);

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    // (a) The load-bearing assertion: the victim's own bytes. Nothing about this
    // can pass vacuously — a followed symlink changes them.
    expect(readFileSync(victim)).toEqual(victimBytes);

    // (b) …and nothing else in the transcript root moved either.
    const after = snapshotTree(s.sourceRoot);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, entry] of before) expect(after.get(rel), rel).toEqual(entry);

    // (c) Reported through archiveOnce's error channel, naming the archive leaf.
    // `errors[].path` is the SOURCE path (mirror.ts), so the message is the only
    // place the planted link can be named.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(REFUSED);
    expect(result.errors[0]?.message).toContain(link);

    // (d) Non-vacuity: one refusal did not abort the pass. victim.jsonl is itself
    // a source file, and its own legitimate archive copy is still written.
    expect(readFileSync(join(s.archiveRoot, VICTIM))).toEqual(victimBytes);
  });

  it('(2) refuses a leaf symlink aimed at a harmless EMPTY decoy under <dataDir>', () => {
    // The guard is "do not follow a final symlink", not "do not follow one that
    // lands somewhere I recognise". An empty target also means `archiveSize === 0`,
    // which skips the divergence block — so this exercises the WRITE open.
    const s = sb();
    const body = jsonLines(4);
    writeSource(s, SESSION, body);
    const decoy = decoyPath(s, 'empty.bin');
    writeFileSync(decoy, '');
    plantArchiveSymlink(s, SESSION, decoy);

    const before = snapshotTreeSafe(join(s.dataDir, DECOYS));
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTreeSafe(join(s.dataDir, DECOYS));

    expect(readFileSync(decoy)).toHaveLength(0); // pre-fix: receives `body`
    expect(after).toEqual(before); // covers ino, mtimeNs, size, mode
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(REFUSED);
    expect(result.bytesCopied).toBe(0);
  });

  it('(3) refuses a leaf symlink aimed at a NON-PREFIX decoy, fabricating no diverged row', () => {
    // The silent second mode: pre-fix the divergence read followed the link, saw a
    // mismatched head, and archiveOnce reported `errors: []` plus a `diverged` row
    // — reason 'head', archive_size 18 — about a file the archive never wrote.
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    const decoy = decoyPath(s, 'nonprefix.bin');
    writeFileSync(decoy, '{"not":"a prefix"}');
    plantArchiveSymlink(s, SESSION, decoy);

    const before = snapshotTreeSafe(join(s.dataDir, DECOYS));
    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });
    const after = snapshotTreeSafe(join(s.dataDir, DECOYS));

    expect(readFileSync(decoy, 'utf8')).toBe('{"not":"a prefix"}');
    expect(after).toEqual(before);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(REFUSED);
    expect(result.files.map((f) => f.source_state)).not.toContain('diverged');

    // Asserted on the LOG, not only on the result: the fabricated row was durable.
    const logged = readArchiveLog(s);
    expect(logged.flatMap((r) => r.diverged)).toEqual([]);
    expect(logged.flatMap((r) => r.errors.map((e) => e.message))).toContainEqual(
      expect.stringMatching(REFUSED),
    );
  });

  it('(4) refuses a DANGLING leaf symlink, and names it instead of reporting a bare EEXIST', () => {
    // Already refused pre-fix — `statSafe` throws, so the create branch runs and
    // O_CREAT|O_EXCL returns EEXIST for a dangling link too. The delta here is the
    // message, not the safety: an unexplained EEXIST reads as a benign collision.
    const s = sb();
    writeSource(s, SESSION, jsonLines(4));
    const nowhere = decoyPath(s, 'nowhere.bin');
    plantArchiveSymlink(s, SESSION, nowhere);

    const result = archiveOnce({ dataDir: s.dataDir, transcriptRoot: s.sourceRoot });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(REFUSED);
    expect(existsSync(nowhere)).toBe(false); // nothing created through the link
    expect(result.bytesCopied).toBe(0);
  });

  it('(5) platform control — O_EXCL and O_NOFOLLOW are what refuse, and EEXIST is ambiguous', () => {
    // Asserted rather than assumed, per AC2, and the justification for mapping
    // EEXIST only after a post-hoc lstat. Uses openSync directly: test files are
    // excluded from the write-site scan (fs-write-sites.test.ts), so no site is added.
    const s = sb();
    const dir = join(s.root, 'probe');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'target');
    writeFileSync(target, 'target\n');
    const plain = join(dir, 'plain');
    writeFileSync(plain, 'plain\n');
    const liveLink = join(dir, 'live-link');
    symlinkSync(target, liveLink);
    const danglingLink = join(dir, 'dangling-link');
    symlinkSync(join(dir, 'nowhere'), danglingLink);

    // The create path is already safe: O_CREAT|O_EXCL refuses a final symlink by
    // POSIX rule, live or dangling. 'wx' is that pair, so it holds today too.
    expect(() => openSync(liveLink, 'wx', 0o600)).toThrow(/EEXIST/);
    expect(() => openSync(danglingLink, 'wx', 0o600)).toThrow(/EEXIST/);
    expect(() => openSync(liveLink, O_WRONLY | O_CREAT | O_EXCL, 0o600)).toThrow(/EEXIST/);

    // …but EEXIST is NOT symlink-specific, so mapping it unconditionally would be a
    // false accusation. Reaching this branch from archiveOnce needs a genuine race
    // — a plain file present before the pass is seen by statSafe and takes the r+
    // branch — so it is pinned here at the kernel level rather than claimed above.
    expect(() => openSync(plain, O_WRONLY | O_CREAT | O_EXCL, 0o600)).toThrow(/EEXIST/);

    // The r+ branch is the one that needed changing, and O_NOFOLLOW is what changed it.
    expect(() => openSync(liveLink, O_RDWR | O_NOFOLLOW)).toThrow(/ELOOP/);
    closeSync(openSync(liveLink, O_RDWR)); // negative control: nothing ambient refuses
  });
});

// --- Test 20: the import graph -------------------------------------------

/** The probe runs in every node process the binary spawns. */
function writeProbe(dir: string): string {
  const path = join(dir, 'module-probe.mjs');
  writeFileSync(
    path,
    [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const out = process.env.AGENT_LENS_MODULE_PROBE_OUT;',
      'if (out) {',
      "  process.on('exit', () => {",
      '    try {',
      '      writeFileSync(join(out, `probe-${process.pid}.json`), JSON.stringify(process.moduleLoadList));',
      '    } catch {}',
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  return path;
}

function probedRun(
  args: string[],
  probePath: string,
  outDir: string,
): Promise<{ status: number | null; modules: string[][] }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env: {
        ...process.env,
        AGENT_LENS_MODULE_PROBE_OUT: outDir,
        NODE_OPTIONS: `--import file://${probePath}`,
      },
      stdio: 'ignore',
    });
    child.on('close', (status) => {
      const modules = readdirSync(outDir).map(
        (file) => JSON.parse(readFileSync(join(outDir, file), 'utf8')) as string[],
      );
      resolvePromise({ status, modules });
    });
  });
}

describe('agent-lens archive never loads node:sqlite (Test 20)', () => {
  it('(a) the SPAWNED BINARY — what cron actually runs — loads no sqlite module', async () => {
    // Probes the binary, not `src/archive/index.ts`: a guard on the archive
    // module alone stays green while the real entry point is dirty.
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));
    const probe = writeProbe(s.root);
    const outDir = join(s.root, 'probe-archive');
    mkdirSync(outDir, { recursive: true });

    const { status, modules } = await probedRun(
      [BIN, 'archive', '--dataDir', s.dataDir, '--transcriptRoot', s.sourceRoot],
      probe,
      outDir,
    );

    expect(status).toBe(0);
    expect(modules.length).toBeGreaterThan(0);
    // Non-vacuity: node:crypto is the marker that archive code really ran.
    expect(modules.some((list) => list.some((m) => /crypto/i.test(m)))).toBe(true);
    for (const list of modules) {
      expect(list.filter((m) => /sqlite/i.test(m))).toEqual([]);
    }
  }, 60000);

  it('(a-control) the same probe DOES report sqlite for a known-dirty entry point', async () => {
    // Without this, a probe that silently loaded nothing would pass vacuously.
    const s = sb();
    const probe = writeProbe(s.root);
    const outDir = join(s.root, 'probe-control');
    mkdirSync(outDir, { recursive: true });

    const { modules } = await probedRun(
      ['--import', 'tsx', '-e', "import('./src/db/index.ts')"],
      probe,
      outDir,
    );

    expect(modules.some((list) => list.some((m) => /sqlite/i.test(m)))).toBe(true);
  }, 60000);

  it('(b) no file reachable from src/archive/index.ts lives under db/, server/ or capture/', () => {
    const reachable = transitiveRelativeImports(join(ARCHIVE_SRC, 'index.ts'));

    expect(reachable.size).toBeGreaterThan(1);
    const forbidden = [...reachable].filter((file) => /\/src\/(db|server|capture)\//.test(file));
    expect(forbidden).toEqual([]);
  });

  it('(c) names no write syscall outside paths.ts, mirror.ts, lock.ts and seal.ts', () => {
    // `seal.ts` joins the allowlist because it names renameSync and unlinkSync —
    // the temp+rename publish and the removal of the hot file it just compressed.
    // `read.ts` is deliberately NOT here: the accessor names none of the six, and
    // allowlisting it would weaken the guard for nothing.
    const allowed = new Set(['paths.ts', 'mirror.ts', 'lock.ts', 'seal.ts']);
    const pattern = /\b(appendFileSync|writeFileSync|rmSync|renameSync|unlinkSync|mkdirSync)\b/;
    const offenders: string[] = [];

    for (const file of readdirSync(ARCHIVE_SRC, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.ts')) continue;
      if (allowed.has(file.name)) continue;
      if (pattern.test(readFileSync(join(ARCHIVE_SRC, file.name), 'utf8'))) {
        offenders.push(file.name);
      }
    }

    expect(offenders).toEqual([]);
    // Non-vacuity: the allowlisted writer really does name one.
    expect(pattern.test(readFileSync(join(ARCHIVE_SRC, 'paths.ts'), 'utf8'))).toBe(true);
  });
});

/** Follow relative specifiers from `entry`, resolving `.js` -> `.ts`. */
function transitiveRelativeImports(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry) || !existsSync(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  const pattern = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]!;
    const resolved = join(dirname(entry), specifier.replace(/\.js$/, '.ts'));
    transitiveRelativeImports(resolved, seen);
  }
  return seen;
}
