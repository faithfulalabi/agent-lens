// Shared fixture plumbing; everything is synthesized in temp dirs. The slug is
// dash-prefixed to match real project dirs, which is why comparisons are done in
// Node: `ls`/`diff` parse a leading dash as a flag.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib';
import { main } from '../../cli/index.js';
import { serializeSidecar, SIDECAR_VERSION, type SealSidecar } from '../sidecar.js';

export const SLUG = '-Users-dev-proj';

/** Under `<dataDir>` but outside the archive root — see `decoyPath`. */
export const DECOYS = 'decoys';

export interface Sandbox {
  root: string;
  sourceRoot: string;
  dataDir: string;
  archiveRoot: string;
}

/** A hermetic sandbox. `realpathSync` because macOS tmp is `/var` -> `/private/var`. */
export function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-lens-archive-')));
  const sourceRoot = join(root, 'projects');
  const dataDir = join(root, 'data');
  mkdirSync(sourceRoot, { recursive: true });
  return { root, sourceRoot, dataDir, archiveRoot: join(dataDir, 'archive') };
}

export function cleanup(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true });
}

export function writeSource(sandbox: Sandbox, rel: string, content: string | Buffer): string {
  const path = join(sandbox.sourceRoot, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export function writeArchive(sandbox: Sandbox, rel: string, content: string | Buffer): string {
  const path = join(sandbox.archiveRoot, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/**
 * Plants a symlink where the archive would put `rel`. `discover` cannot see it —
 * `readDirSafe` filters on `isFile()` and a symlink `Dirent` reports `false` — so
 * the entry still arrives from the source walk, which is the whole point.
 */
export function plantArchiveSymlink(sandbox: Sandbox, rel: string, target: string): string {
  const link = join(sandbox.archiveRoot, rel);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
  return link;
}

/**
 * Plants a symlinked DIRECTORY component at `rel` under the archive root, aimed
 * at `targetDir` (created if absent). The directory-chain counterpart of
 * `plantArchiveSymlink`.
 */
export function plantDirSymlink(sandbox: Sandbox, rel: string, targetDir: string): string {
  const link = join(sandbox.archiveRoot, rel);
  mkdirSync(dirname(link), { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  symlinkSync(targetDir, link);
  return link;
}

/**
 * Points `<dataDir>` ITSELF at `targetDir` (created if absent) — the supported
 * relocation layout, a "keep everything forever" store moved onto another
 * volume. `makeSandbox` returns `dataDir` as an unmade path and never links it,
 * so this layout has only ever been measured, never committed as a fixture.
 */
export function plantDataDirSymlink(sandbox: Sandbox, targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  symlinkSync(targetDir, sandbox.dataDir);
  return targetDir;
}

/**
 * Creates `<dataDir>/decoys` and returns a path inside it — under `<dataDir>` but
 * outside the archive root, so the target is harmless and the dir is snapshottable
 * on its own without the archive log and lock churning underneath it.
 */
export function decoyPath(sandbox: Sandbox, name: string): string {
  const dir = join(sandbox.dataDir, DECOYS);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

export function sourcePath(sandbox: Sandbox, rel: string): string {
  return join(sandbox.sourceRoot, rel);
}

export function archivePath(sandbox: Sandbox, rel: string): string {
  return join(sandbox.archiveRoot, rel);
}

/** `n` newline-terminated JSON lines, padded to a predictable width. */
export function jsonLines(n: number, from = 0): string {
  let out = '';
  for (let i = from; i < from + n; i++) out += `{"i":${i},"pad":"${'x'.repeat(10)}"}\n`;
  return out;
}

/**
 * `n` transcript-shaped JSON lines. Unlike `jsonLines` the content varies per
 * line, so a compression ratio measured over it is not an artifact of repeats.
 */
export function transcriptLines(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += `${JSON.stringify({
      type: i % 3 === 0 ? 'user' : 'assistant',
      uuid: `0000${i}-aaaa-bbbb-cccc-${String(i).padStart(12, '0')}`,
      timestamp: `2026-08-0${(i % 9) + 1}T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
      message: {
        role: i % 3 === 0 ? 'user' : 'assistant',
        content: `line ${i}: the archive keeps everything forever, which is why sealing exists at all.`,
      },
    })}\n`;
  }
  return out;
}

export function readBytes(path: string): Buffer {
  return readFileSync(path);
}

/** Byte-for-byte equality, in Node — never `diff` (see the dash-prefixed slug above). */
export function bytesEqual(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}

/** The sandbox's stand-in for `~/.claude/settings.json`. Never the real user file. */
export function settingsPath(sandbox: Sandbox): string {
  return join(sandbox.root, 'claude', 'settings.json');
}

/** Plants a settings file inside the sandbox so no test can reach the real one. */
export function writeSettings(sandbox: Sandbox, contents: unknown): string {
  const path = settingsPath(sandbox);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

export interface TreeEntry {
  size: bigint;
  mtimeNs: bigint;
  ino: bigint;
  mode: bigint;
}

/** `mtimeNs` because float `mtimeMs` hides a same-millisecond in-place write. */
export function snapshotTree(
  root: string,
  prefix = '',
  out = new Map<string, TreeEntry>(),
): Map<string, TreeEntry> {
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

/**
 * `snapshotTree` for a root that may not exist. `makeSandbox` creates only
 * `sourceRoot`, so a doctor-only test that never runs `archiveOnce` has no
 * `dataDir` on disk — and "it still does not exist afterwards" is the assertion
 * that matters there.
 */
export function snapshotTreeSafe(root: string): Map<string, TreeEntry> {
  return existsSync(root) ? snapshotTree(root) : new Map();
}

/** A lock record that reads as genuinely held: pid 1 is alive and is not us. */
export function plantHeldLock(path: string): void {
  writeFileSync(path, JSON.stringify({ pid: 1, started_at: Date.now(), hostname: hostname() }), {
    mode: 0o600,
  });
}

/** The `code` a throw carries. Node's messages move; the code is the stable identifier. */
export function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

// --- driving the CLI in-process ----------------------------------------------

/**
 * Runs `fn` with BOTH console channels captured: `out` and `err` per channel,
 * `lines` in the interleaved order they were written. The one capture every
 * CLI suite's runner is built on.
 */
export async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; out: string; err: string; lines: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (msg?: unknown) => {
    out.push(String(msg));
    lines.push(String(msg));
  };
  console.error = (msg?: unknown) => {
    err.push(String(msg));
    lines.push(String(msg));
  };
  try {
    return { value: await fn(), out: out.join('\n'), err: err.join('\n'), lines };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** `main` with both channels captured — a rejection message goes to stderr. */
export async function runMain(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const { value: code, out, err } = await captureConsole(() => main(args));
  return { code, out, err };
}

/** Pins the two resolver env vars at a sandbox, and restores whatever was there. */
export function pinSandboxEnv(sandbox: Sandbox): () => void {
  const previous = {
    AGENT_LENS_DIR: process.env.AGENT_LENS_DIR,
    AGENT_LENS_TRANSCRIPT_ROOT: process.env.AGENT_LENS_TRANSCRIPT_ROOT,
  };
  process.env.AGENT_LENS_DIR = sandbox.dataDir;
  process.env.AGENT_LENS_TRANSCRIPT_ROOT = sandbox.sourceRoot;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// --- sealed frames and their sidecars ---------------------------------------

/**
 * The seal's own compressor params (`seal.ts`), so a hand-built frame is the
 * frame `sealArchiveFile` would have produced for the same bytes — including the
 * checksum and the declared content size a reader checks against.
 */
export function compressLikeSeal(body: string | Buffer): Buffer {
  return zstdCompressSync(Buffer.from(body), {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: 3,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
    },
  });
}

export function sha256Hex(body: string | Buffer): string {
  return createHash('sha256').update(Buffer.from(body)).digest('hex');
}

/**
 * Writes the record for `<rel>.zst`. `writeArchive` takes arbitrary names, so
 * the `.zst.sha256` pair is expressible without teaching it the suffix. The
 * defaults exist so a caller can state only the field under test.
 */
export function writeSidecar(
  sandbox: Sandbox,
  rel: string,
  record: Partial<SealSidecar> & Pick<SealSidecar, 'file' | 'sha256'>,
): string {
  return writeArchive(
    sandbox,
    `${rel}.zst.sha256`,
    serializeSidecar({
      v: SIDECAR_VERSION,
      hot_size: 0,
      sealed_size: 0,
      sealed_at: '2026-08-11T00:00:00.000Z',
      ...record,
    }),
  );
}

/** Rewrites named fields of an EXISTING record, leaving the frame alone. */
export function patchSidecar(sandbox: Sandbox, rel: string, patch: Partial<SealSidecar>): void {
  const path = join(sandbox.archiveRoot, `${rel}.zst.sha256`);
  const record = JSON.parse(readFileSync(path, 'utf8')) as SealSidecar;
  writeFileSync(path, serializeSidecar({ ...record, ...patch }));
}

/**
 * The crash window a seal leaves between its `rename` and its `unlink`: the hot
 * file and the frame both on disk, no source. `sealed` is planted verbatim so a
 * caller can make it garbage, and the record describes `describes` — defaulting
 * to the hot bytes, which is what a real seal would have hashed.
 */
export function plantCrashWindow(
  sandbox: Sandbox,
  rel: string,
  parts: { hot: string | Buffer; sealed: Buffer; describes?: string | Buffer },
): void {
  const described = Buffer.from(parts.describes ?? parts.hot);
  writeArchive(sandbox, rel, parts.hot);
  writeArchive(sandbox, `${rel}.zst`, parts.sealed);
  writeSidecar(sandbox, rel, {
    file: basename(rel),
    sha256: sha256Hex(described),
    hot_size: described.length,
    sealed_size: parts.sealed.length,
  });
}
