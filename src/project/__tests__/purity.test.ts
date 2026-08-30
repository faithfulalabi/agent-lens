// AC1's static half, and AC2's negative half. Same shape as
// `src/transcript/__tests__/module-shape.test.ts`, which is the repo's
// established source-property guard: `typescript` as `ts`, every helper taking a
// DEFAULTED `text` parameter so the mutation controls at the bottom drive the
// REAL helper bodies with fixture text instead of disk. Re-deriving a comparison
// inline in a control would prove nothing — softening a real assertion would
// leave it green.
//
// ★ THE CLOCK BAN ON `src/project/` IS SELF-IMPOSED. `module-shape.test.ts`
// applies its banned set to exactly two files — every assertion there is
// `it.each([RAW_TYPES, ACCESSORS])` — so nothing in the repo bans the clock here
// and a two-line date parse would compile and pass every other guard. This file
// extends the ban anyway, for the reason `module-shape.test.ts` already records:
// "this tree names no clock" is a fact a reader checks at a glance, where "only
// the parser, never the reader" is a judgement that rots. AC1's whole claim IS
// purity, so the ~20 LOC of hand-rolled epoch arithmetic is a price this task
// chooses to pay rather than one it inherits.
//
// The import limb is TRANSITIVE, following `./`-relative specifiers: a pure
// module that imports an impure one is not pure, and only the walk sees that.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = dirname(PROJECT_DIR);

/**
 * Identifiers no module in this tree may name. The clock is the load-bearing
 * one: `epochMs` slices a fixed-width stamp precisely so this can be a flat zero
 * rather than a judgement call that rots. The last two close the obvious escape
 * hatch from all of the above.
 */
const BANNED = new Set(['Date', 'performance', 'process', 'Math', 'globalThis', 'require']);

/** Nothing in a pure projector may reach either of these, at any depth. */
const IMPURE_MODULES = ['node:fs', 'node:sqlite'];

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Every non-test `.ts` under one tree, absolute. Same filter as the hash guard. */
function sources(tree: string): string[] {
  return readdirSync(tree, { recursive: true, encoding: 'utf8' })
    .map((name) => name.split('\\').join('/'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .filter((name) => !name.endsWith('.test.ts') && !name.includes('__tests__/'))
    .map((name) => join(tree, name))
    .sort();
}

const PROJECT_SOURCES = sources(PROJECT_DIR);

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
}

/** Every module `file` imports from, by specifier. */
function importSpecifiers(file: string, text = read(file)): string[] {
  const source = parse(file, text);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const target = node.moduleSpecifier;
      if (target !== undefined && ts.isStringLiteral(target)) specifiers.push(target.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      specifiers.push(node.moduleReference.getText(source));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifiers.push(node.arguments[0]?.getText(source) ?? '<dynamic>');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** A `./`-relative specifier as a real file on disk, or nothing. */
function resolveLocal(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = resolve(dirname(from), specifier.replace(/\.js$/, '.ts'));
  return existsSync(target) ? target : undefined;
}

/** Every file and every specifier reachable from `entry`, following `./` hops. */
function reachable(entry: string): { files: string[]; specifiers: string[] } {
  const files: string[] = [];
  const specifiers: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    for (const specifier of importSpecifiers(file)) {
      specifiers.push(specifier);
      const next = resolveLocal(file, specifier);
      if (next !== undefined) queue.push(next);
    }
  }
  return { files: files.sort(), specifiers };
}

/**
 * Every identifier `file` names. Walking IDENTIFIERS rather than raw text is
 * deliberate: comments are trivia and never reach the AST, so a module can
 * explain in prose exactly why it avoids the clock without tripping its own
 * guard — and that explanation is what stops a future maintainer "simplifying"
 * `epochMs` back onto a date parser.
 */
function identifiers(file: string, text = read(file)): string[] {
  const source = parse(file, text);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The banned subset. Deliberately a filter over the walk above rather than a
 * second walker: the non-vacuity test drives `identifiers` directly, so a walk
 * that stopped recursing reds there instead of silently emptying this list.
 */
function bannedIdentifiers(file: string, text = read(file)): string[] {
  return identifiers(file, text).filter((name) => BANNED.has(name));
}

/** The clock global anywhere in the raw text, comments and all. See its test. */
function namesClockInText(file: string, text = read(file)): boolean {
  return /\bDate\b/.test(text);
}

describe('AC1 — src/project/ is pure, asserted over the source text', () => {
  it('has sources to check at all', () => {
    // Non-vacuity: every `it.each` below is trivially green over an empty list.
    expect(PROJECT_SOURCES.length).toBeGreaterThan(0);
    expect(PROJECT_SOURCES.map((file) => file.slice(SRC_DIR.length + 1))).toContain(
      'project/pipeline.ts',
    );
  });

  it.each(PROJECT_SOURCES)('%s names no clock, no randomness, no escape hatch', (file) => {
    expect(bannedIdentifiers(file)).toEqual([]);
  });

  it.each(PROJECT_SOURCES)('%s does not contain the clock global even in prose', (file) => {
    // The founder ruling is that the identifier must not appear AT ALL, and the
    // AST walk above satisfies only the precise reading of that. This limb takes
    // the ruling literally over the raw text, so nobody has to adjudicate which
    // reading was meant.
    expect(namesClockInText(file)).toBe(false);
  });

  it.each(PROJECT_SOURCES)('%s cannot reach the filesystem or a database', (file) => {
    const { specifiers } = reachable(file);
    expect(specifiers.filter((name) => IMPURE_MODULES.includes(name))).toEqual([]);
    expect(specifiers.filter((name) => name.startsWith('node:'))).toEqual([]);
  });

  it('the transitive walk really follows more than one hop', () => {
    // Without this, a walk that stopped at the entry file would pass the limb
    // above for every module on earth.
    const { files, specifiers } = reachable(join(PROJECT_DIR, 'pipeline.ts'));
    const relative = files.map((file) => file.slice(SRC_DIR.length + 1));

    expect(relative).toContain('transcript/line.ts');
    // Two hops out: pipeline -> line -> accessors.
    expect(relative).toContain('transcript/accessors.ts');
    expect(specifiers.length).toBeGreaterThan(files.length - 1);
  });

  it('the identifier walk actually sees identifiers', () => {
    const named = identifiers(join(PROJECT_DIR, 'pipeline.ts'));
    expect(named).toContain('runPipeline');
    // Inside a function body, which is exactly where a clock read would hide.
    expect(named).toContain('epochMs');
    expect(named.length).toBeGreaterThan(20);
  });
});

describe('AC2 — no ancestor walk survives anywhere under src/', () => {
  it('finds the 128-hop walker in no file at all', () => {
    const walker = /MAX_ANCESTOR_HOPS|promptIdViaAncestors/;
    const scanned = sources(SRC_DIR);
    const carriers = scanned
      .filter((file) => walker.test(read(file)))
      .map((file) => file.slice(SRC_DIR.length + 1));

    // ★ THE NON-VACUITY GUARD BELONGS HERE, on `sources(SRC_DIR)`, and nowhere
    // else in this file guards it: `:180-187` guards `identifiers()` and the
    // `sources()` check at `:144` runs over PROJECT_DIR. Task 4.5 deleted
    // `capture/merge.ts`, so this expectation is now `[]` — and an empty walk,
    // for any reason at all, would satisfy that without the line below.
    expect(scanned.length).toBeGreaterThan(20);
    expect(carriers).toEqual([]);
  });
});

describe('the guard reds when the property it protects is broken', () => {
  const PIPELINE = join(PROJECT_DIR, 'pipeline.ts');
  const SOURCE = read(PIPELINE);

  it('the unmutated source, through the same seams, is clean', () => {
    // Proves each mutation below reds because of the mutation, not because
    // feeding the helpers fixture text is itself enough to trip them.
    expect(bannedIdentifiers(PIPELINE, SOURCE)).toEqual([]);
    expect(namesClockInText(PIPELINE, SOURCE)).toBe(false);
    expect(importSpecifiers(PIPELINE, SOURCE).filter((name) => name.startsWith('node:'))).toEqual(
      [],
    );
  });

  it('a clock read reds the banned-identifier limb', () => {
    expect(bannedIdentifiers(PIPELINE, `${SOURCE}\nexport const now = Date.now();\n`)).toEqual([
      'Date',
    ]);
    expect(bannedIdentifiers(PIPELINE, `${SOURCE}\nexport const r = Math.random();\n`)).toEqual([
      'Math',
    ]);
  });

  it('the clock global reds the text limb even when only a comment names it', () => {
    // The case the AST limb cannot see, and the reason the text limb exists.
    const commented = `${SOURCE}\n// returns a Date, eventually\n`;
    expect(bannedIdentifiers(PIPELINE, commented)).toEqual([]);
    expect(namesClockInText(PIPELINE, commented)).toBe(true);
  });

  it('a filesystem import reds the import limb', () => {
    const mutated = `import { readFileSync } from 'node:fs';\n${SOURCE}`;
    expect(importSpecifiers(PIPELINE, mutated)).toContain('node:fs');
  });

  it('a dynamic import reds the import limb', () => {
    const mutated = `${SOURCE}\nexport const load = () => import('node:sqlite');\n`;
    expect(importSpecifiers(PIPELINE, mutated)).toContain("'node:sqlite'");
  });
});
