// Shared fixture plumbing for the archive tests.
//
// Fixtures are SYNTHESIZED in temp dirs. Nothing here reads the developer's real
// `~/.claude/projects` — `real-corpus.test.ts` is the single opt-in exception.
//
// The slug is dash-prefixed on purpose: 12 of 12 real project dirs begin with `-`
// (`-Users-faithful-Desktop-agent-lens`), which breaks `ls`, `diff` and every
// other tool that parses a leading dash as a flag. Every comparison in these
// tests is therefore done in Node, never by shelling out.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/** Write a source file at a `sourceRoot`-relative path, creating parents. */
export function writeSource(sandbox: Sandbox, rel: string, content: string | Buffer): string {
  const path = join(sandbox.sourceRoot, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Write a file directly into the archive tree (to stand in for what 1.2 produces). */
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

/** `n` newline-terminated JSON lines, each padded to a predictable width. */
export function jsonLines(n: number, from = 0): string {
  let out = '';
  for (let i = from; i < from + n; i++) out += `{"i":${i},"pad":"${'x'.repeat(10)}"}\n`;
  return out;
}

export function readBytes(path: string): Buffer {
  return readFileSync(path);
}

/** Byte-for-byte equality, in Node — never `diff`, which chokes on the dash-prefixed slug. */
export function bytesEqual(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}
