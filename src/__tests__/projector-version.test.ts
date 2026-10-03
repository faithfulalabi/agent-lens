// `PROJECTOR_VERSION` is guarded by a committed sha256 over the projector's own source. There is
// NO regeneration script and no env escape hatch: the test prints the recomputed hash, but
// nothing writes it for you.
//
// The version lives INSIDE the hashed tree, so it cannot be bumped without rehashing. The
// reverse — a new sha with no bump — is correct for a change that does not alter what projection
// emits; nothing in-repo distinguishes the two, only review does.
//
// The hash covers non-test `.ts` only: a test edit cannot change projection output, and an
// unfiltered walk would take stray untracked files with it, so a dev box and CI would disagree.
// `npm run format` rewrites these bytes, so recompute AFTER formatting, never before.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECTOR_VERSION } from '../transcript/version.js';

const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Both halves of the projector. */
const HASHED_TREES = ['transcript', 'project'] as const;

/** The committed pair. Both change together or this file reds. */
const PROJECTOR_SOURCE_SHA = 'd9218496838669d87ec6f6b761a9d4a399cb0e917382cc2ae951194c7fd7e575';

interface HashedFile {
  path: string;
  bytes: Buffer;
}

/** Non-test `.ts` under one tree, repo-relative. Absent tree contributes []. */
function treeFiles(tree: string): string[] {
  const root = join(SRC_DIR, tree);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((name) => `${tree}/${name.split('\\').join('/')}`)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .filter((name) => !name.endsWith('.test.ts') && !name.includes('__tests__/'));
}

function hashedFiles(trees: readonly string[] = HASHED_TREES): HashedFile[] {
  return trees
    .flatMap(treeFiles)
    .sort()
    .map((path) => ({ path, bytes: readFileSync(join(SRC_DIR, path)) }));
}

/**
 * sha256 over path + byte length + raw bytes, per file in sorted path order, so a rename or a
 * shuffle of content between two files reds too. Sorting here keeps it enumeration-independent.
 */
function projectorHash(files: readonly HashedFile[] = hashedFiles()): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(String(file.bytes.byteLength));
    hash.update('\0');
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

function bumpMessage(actual: string): string {
  return (
    'you changed the projector; bump PROJECTOR_VERSION\n' +
    `  recomputed: ${actual}\n` +
    '  Paste that into PROJECTOR_SOURCE_SHA in the same diff that bumps the constant.\n' +
    '  If src/project/ just appeared, this is expected and it is your task (3.1): ' +
    'bump PROJECTOR_VERSION and paste the printed sha.'
  );
}

describe('PROJECTOR_VERSION is guarded by a committed source hash', () => {
  it('the projector source still hashes to the committed sha', () => {
    const actual = projectorHash();
    expect(actual, bumpMessage(actual)).toBe(PROJECTOR_SOURCE_SHA);
  });

  it('the version is imported, not redeclared, and lives inside the hashed tree', () => {
    // Deliberately NOT pinned to a literal: a pin would red a bump that is the correct
    // response to a projector change. The hash above polices the value; this polices the shape.
    expect(Number.isInteger(PROJECTOR_VERSION)).toBe(true);
    expect(PROJECTOR_VERSION).toBeGreaterThan(0);
    expect(hashedFiles().map((file) => file.path)).toContain('transcript/version.ts');
  });

  it('hashes production source only, and every projector module is in it', () => {
    const paths = hashedFiles().map((file) => file.path);

    // Containment, never a bare count: modules get added to this tree.
    expect(paths).toEqual(expect.arrayContaining(['transcript/version.ts']));
    for (const module of [
      'accessors',
      'blocks',
      'drift',
      'human',
      'line',
      'raw-types',
      'spill',
      'usage',
    ]) {
      expect(paths).toContain(`transcript/${module}.ts`);
    }
    expect(paths).toContain('project/pipeline.ts');
    expect(paths).toContain('project/subagents.ts');

    expect(paths.filter((path) => path.endsWith('.test.ts'))).toEqual([]);
    expect(paths.filter((path) => path.includes('__tests__/'))).toEqual([]);
    expect(paths.filter((path) => path.endsWith('.d.ts'))).toEqual([]);
    expect(paths.filter((path) => !path.endsWith('.ts'))).toEqual([]);

    // The fixtures are real and adjacent, so this exclusion is load-bearing.
    expect(
      readdirSync(join(SRC_DIR, 'transcript', '__tests__'), { recursive: true, encoding: 'utf8' })
        .length,
    ).toBeGreaterThan(0);
  });

  it('editing a test file leaves the digest alone', () => {
    // The exclusion happens in the FILE LIST, so the proof is that no real file under
    // `transcript/__tests__/` reaches the digest at all.
    const hashed = new Set(hashedFiles().map((file) => file.path));
    const testTree = readdirSync(join(SRC_DIR, 'transcript', '__tests__'), {
      recursive: true,
      encoding: 'utf8',
    }).map((name) => `transcript/__tests__/${name.split('\\').join('/')}`);

    expect(testTree.length).toBeGreaterThan(0);
    expect(testTree.filter((path) => hashed.has(path))).toEqual([]);

    // …and a test file forced into the list WOULD move it, so the exclusion is
    // doing the work rather than the hash being blind to those bytes.
    const forced = [
      ...hashedFiles(),
      { path: 'transcript/__tests__/drift.test.ts', bytes: Buffer.from('edited\n') },
    ];
    expect(projectorHash(forced)).not.toBe(PROJECTOR_SOURCE_SHA);
  });

  it('is deterministic and independent of enumeration order', () => {
    const files = hashedFiles();
    expect(projectorHash(files)).toBe(projectorHash(files));
    expect(projectorHash([...files].reverse())).toBe(projectorHash(files));

    const shuffled = [...files].sort(() => Math.random() - 0.5);
    expect(projectorHash(shuffled)).toBe(PROJECTOR_SOURCE_SHA);
  });

  it('src/project/ is present and contributes its production source only', () => {
    expect(existsSync(join(SRC_DIR, 'project'))).toBe(true);
    expect(treeFiles('project').length).toBeGreaterThan(0);

    // …and its own `__tests__/` contribute nothing, exactly as transcript's do.
    const paths = hashedFiles().map((file) => file.path);
    expect(paths.filter((path) => path.startsWith('project/__tests__/'))).toEqual([]);
    expect(
      readdirSync(join(SRC_DIR, 'project', '__tests__'), { recursive: true, encoding: 'utf8' })
        .length,
    ).toBeGreaterThan(0);

    expect(projectorHash()).toBe(PROJECTOR_SOURCE_SHA);
  });

  it('the absent tree is not special-cased, so the 3.1 red will fire', () => {
    const withProject = [
      ...hashedFiles(),
      { path: 'project/version.ts', bytes: Buffer.from('export const X = 1;\n') },
    ];
    expect(projectorHash(withProject)).not.toBe(PROJECTOR_SOURCE_SHA);
  });

  it('one byte, a rename, or a version bump each red it', () => {
    const files = hashedFiles();
    const index = files.findIndex((file) => file.path === 'transcript/line.ts');
    expect(index).toBeGreaterThanOrEqual(0);

    const edited = [...files];
    edited[index] = {
      ...files[index]!,
      bytes: Buffer.concat([files[index]!.bytes, Buffer.from(' ')]),
    };
    expect(projectorHash(edited)).not.toBe(PROJECTOR_SOURCE_SHA);

    const renamed = [...files];
    renamed[index] = { ...files[index]!, path: 'transcript/lines.ts' };
    expect(projectorHash(renamed)).not.toBe(PROJECTOR_SOURCE_SHA);

    // Content shuffled between two files, total bytes unchanged.
    const other = files.findIndex((file) => file.path === 'transcript/usage.ts');
    expect(other).toBeGreaterThanOrEqual(0);
    const shuffled = [...files];
    shuffled[index] = { ...files[index]!, bytes: files[other]!.bytes };
    shuffled[other] = { ...files[other]!, bytes: files[index]!.bytes };
    expect(projectorHash(shuffled)).not.toBe(PROJECTOR_SOURCE_SHA);

    // Bumping the constant — the whole point of putting it inside the tree. Derived from the
    // imported value rather than a literal, so this keeps testing a real bump after each one.
    const bumped = [...files];
    const versionAt = files.findIndex((file) => file.path === 'transcript/version.ts');
    const source = files[versionAt]!.bytes.toString('utf8');
    const declaration = `PROJECTOR_VERSION = ${PROJECTOR_VERSION}`;
    expect(source, 'version.ts stopped declaring the constant this hash guards').toContain(
      declaration,
    );
    bumped[versionAt] = {
      ...files[versionAt]!,
      bytes: Buffer.from(
        source.replace(declaration, `PROJECTOR_VERSION = ${PROJECTOR_VERSION + 1}`),
      ),
    };
    expect(bumped[versionAt]!.bytes.equals(files[versionAt]!.bytes)).toBe(false);
    expect(projectorHash(bumped)).not.toBe(PROJECTOR_SOURCE_SHA);
  });

  it('the failure message is the literal contract string', () => {
    expect(bumpMessage('abc')).toContain('you changed the projector; bump PROJECTOR_VERSION');
    expect(bumpMessage('abc')).toContain('abc');
    expect(bumpMessage('abc')).toContain('src/project/');
  });
});
