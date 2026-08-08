// Tests 19 and 20 — the two guards that matter most.
//
// 19: `~/.claude/projects` is NEVER written to. Structurally the module only ever
// opens a source `'r'` and funnels every write through one containment-checked
// function, but structure is not evidence, so this asserts it.
//
// 20: `agent-lens archive` must not load `node:sqlite`, transitively, in the
// process CRON ACTUALLY RUNS. A grep of `src/archive/**` cannot see one hop away,
// which is how a `tailer.ts` import (value-importing `src/db/index.ts`, whose
// line 1 is `import { DatabaseSync } from 'node:sqlite'`) survived review.

import { afterEach, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { archiveOnce } from '../mirror.js';
import {
  cleanup,
  jsonLines,
  makeSandbox,
  SLUG,
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

interface Entry {
  size: bigint;
  mtimeNs: bigint;
  ino: bigint;
  mode: bigint;
}

/**
 * `{relpath -> {size, mtimeNs, ino, mode}}` for every entry under `root`.
 *
 * `mtimeNs`, not `mtimeMs`: the latter is float milliseconds
 * (`1786150022452.6375`) and a same-millisecond, same-size in-place write is
 * invisible to it. `atime` is excluded on purpose — we open sources for reading,
 * which is the whole point.
 */
function snapshotTree(
  root: string,
  prefix = '',
  out = new Map<string, Entry>(),
): Map<string, Entry> {
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
    const stat = statSync(join(root, dirent.name), { bigint: true });
    out.set(rel, {
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ino: stat.ino,
      mode: stat.mode,
    });
    if (dirent.isDirectory()) snapshotTree(join(root, dirent.name), rel, out);
  }
  return out;
}

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
    // `chmodSync(root, 0o500)` alone protects NOTHING — every in-scope file is
    // 2-5 levels deeper, and an append to `<root>/a/b/x.jsonl` still succeeds.
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
    // The positive control for the test above: without this, "the pass succeeded"
    // could just mean the chmod protected nothing.
    const s = sb();
    writeSource(s, SESSION, jsonLines(2));
    lockDown(s.sourceRoot);

    expect(() => writeFileSync(sourcePath(s, SESSION), 'nope')).toThrow(/EACCES|EPERM/);
    expect(() => writeFileSync(join(dirname(sourcePath(s, SESSION)), 'new.jsonl'), 'x')).toThrow(
      /EACCES|EPERM/,
    );
  });
});

// --- Test 20: the import graph -------------------------------------------

/** Write the module probe. Runs in EVERY node process the binary spawns. */
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
    // Deliberately not an in-process import of `src/archive/index.ts`: cron runs
    // the binary, whose entry is `src/cli/index.ts`. With eager command imports
    // that entry loaded 253 native modules including `Internal Binding sqlite`,
    // so a guard on the archive module would be green while the real thing was
    // dirty. A child process is required anyway — `process.moduleLoadList` is
    // process-global and vitest workers share one.
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
    // Non-vacuity: at least one probed process must actually have run the archive
    // code, which is the only thing here that pulls in node:crypto.
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

  it('(c) names no write syscall outside paths.ts, mirror.ts and lock.ts', () => {
    const allowed = new Set(['paths.ts', 'mirror.ts', 'lock.ts']);
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

/** Follow relative import/export specifiers from `entry`, resolving `.js` -> `.ts`. */
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
