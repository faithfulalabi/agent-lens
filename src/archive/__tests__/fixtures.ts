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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SLUG = '-Users-dev-proj';

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
