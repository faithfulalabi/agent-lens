// Units for `isUnderAnyRoot` — the containment predicate both spill-resolution
// sites inject (security finding F1). Realpath-based on purpose: the archive
// reader opens without `O_NOFOLLOW`, so lexical containment is not containment.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, makeSandbox, type Sandbox } from './fixtures.js';
import { isUnderAnyRoot } from '../paths.js';

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox !== undefined) cleanup(sandbox);
  sandbox = undefined;
});

function plant(path: string, content = 'body'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('isUnderAnyRoot — the F1 containment predicate', () => {
  it('a real file under a root is contained', () => {
    const file = plant(join(sb().sourceRoot, 'slug', 'sess', 'tool-results', 'b1.txt'));
    expect(isUnderAnyRoot(file, [sb().sourceRoot])).toBe(true);
  });

  it('any root in the list suffices', () => {
    const file = plant(join(sb().archiveRoot, 'slug', 'sess', 'tool-results', 'b2.txt'));
    expect(isUnderAnyRoot(file, [sb().sourceRoot, sb().archiveRoot])).toBe(true);
  });

  it('the root itself is contained', () => {
    expect(isUnderAnyRoot(sb().sourceRoot, [sb().sourceRoot])).toBe(true);
  });

  it('a missing tail under a root is still contained — existence is the probe’s job', () => {
    expect(isUnderAnyRoot(join(sb().sourceRoot, 'ghost', 'x.txt'), [sb().sourceRoot])).toBe(true);
  });

  it('a sibling, a parent and an absolute system path are all outside', () => {
    const outside = plant(join(sb().root, 'outside.txt'));
    expect(isUnderAnyRoot(outside, [sb().sourceRoot])).toBe(false);
    expect(isUnderAnyRoot(sb().root, [sb().sourceRoot])).toBe(false);
    expect(isUnderAnyRoot('/etc/passwd', [sb().sourceRoot, sb().archiveRoot])).toBe(false);
  });

  it('a prefix that is not a path boundary is outside', () => {
    // `<root>-evil` starts with the root STRING but is a sibling directory.
    expect(isUnderAnyRoot(`${sb().sourceRoot}-evil/x.txt`, [sb().sourceRoot])).toBe(false);
  });

  it('`..` traversal out of a root is outside', () => {
    expect(isUnderAnyRoot(join(sb().sourceRoot, '..', 'escape.txt'), [sb().sourceRoot])).toBe(
      false,
    );
  });

  it('a symlink under a root pointing out of it is outside', () => {
    const secret = plant(join(sb().root, 'secret.txt'), 'SENTINEL');
    const link = join(sb().sourceRoot, 'link.txt');
    symlinkSync(secret, link);
    expect(isUnderAnyRoot(link, [sb().sourceRoot])).toBe(false);
  });

  it('a symlinked ANCESTOR escaping the root is outside', () => {
    const outsideDir = join(sb().root, 'real-dir');
    mkdirSync(outsideDir, { recursive: true });
    plant(join(outsideDir, 'f.txt'));
    const linkDir = join(sb().sourceRoot, 'esc');
    symlinkSync(outsideDir, linkDir);
    expect(isUnderAnyRoot(join(linkDir, 'f.txt'), [sb().sourceRoot])).toBe(false);
  });

  it('a sealed-only spill — honest `.zst` twin, absent logical tail — is contained', () => {
    plant(join(sb().sourceRoot, 'sess', 'tool-results', 'sealed.txt.zst'));
    const logical = join(sb().sourceRoot, 'sess', 'tool-results', 'sealed.txt');
    expect(isUnderAnyRoot(logical, [sb().sourceRoot])).toBe(true);
  });

  it('a `.zst` twin that is a symlink escaping the root is outside', () => {
    // The reader opens `<p>.zst` when `<p>` is absent, so a symlink planted AS
    // the twin must be realpath-contained too — the logical leaf never resolves.
    const secret = plant(join(sb().root, 'id_rsa'), 'SENTINEL');
    const dir = join(sb().sourceRoot, 'sess', 'tool-results');
    mkdirSync(dir, { recursive: true });
    const logical = join(dir, 'evil.txt');
    symlinkSync(secret, `${logical}.zst`);
    expect(isUnderAnyRoot(logical, [sb().sourceRoot])).toBe(false);
  });

  it('an empty root list refuses everything — fail-closed', () => {
    const file = plant(join(sb().sourceRoot, 'a.txt'));
    expect(isUnderAnyRoot(file, [])).toBe(false);
  });
});
