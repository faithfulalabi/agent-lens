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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
