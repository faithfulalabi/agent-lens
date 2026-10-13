// Planning-document vocabulary kept out of test names, which print on every run
// and every failure — so a contributor who trips one is handed a pointer into a
// document they cannot read.
//
// Scoped to NAMES, not whole files, and that scoping is the whole design. A
// text scan of test files would red on ~190 comment sites carrying the same
// vocabulary, which are out of scope by ruling; `render-gate/report.ts` holds
// dozens more. So this reads titles off the AST instead, the way
// `fs-write-sites.test.ts` reads call sites. A selector over string literals
// would be the wrong instrument in the other direction: it misses `it.each`
// titles and anything non-literal, which is how the last sweep of these names
// left two sites behind.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Every tree that carries test names. `smoke/` holds Playwright specs. */
const TREES = ['src', 'ui/src', 'smoke'] as const;

const FORBIDDEN: ReadonlyMap<string, RegExp> = new Map([
  ['an acceptance-criterion id', /\bAC-?R?\d/],
  ['a task pointer', /\btasks?\s*\(?\d+\.\d+/i],
]);

const RUNNERS = new Set(['describe', 'it', 'test', 'suite', 'bench']);

interface Title {
  file: string;
  line: number;
  text: string;
}

interface Source {
  file: string;
  text: string;
}

function testFiles(): string[] {
  return TREES.flatMap((tree) =>
    readdirSync(join(REPO_ROOT, tree), { recursive: true, encoding: 'utf8' })
      .map((name) => `${tree}/${name.split('\\').join('/')}`)
      .filter((path) => /\.(test|spec)\.tsx?$/.test(path))
      .filter((path) => statSync(join(REPO_ROOT, path)).isFile())
      .sort(),
  );
}

/**
 * `.tsx` must be parsed as TSX: under `ScriptKind.TS` the JSX reads as type
 * assertions and whole call expressions vanish, so a misparse would HIDE
 * offenders. The diagnostics are asserted empty below for the same reason.
 */
function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The runner a call resolves to, through `.each(…)` and `.only`/`.skip`/`.concurrent`. */
function runnerOf(expression: ts.Expression): string | null {
  let node: ts.Node = expression;
  while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) {
    node = node.expression;
  }
  return ts.isIdentifier(node) ? node.text : null;
}

function isTextLiteral(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** `parseDiagnostics` carries no public type, and nothing else reports a misparse. */
function parseErrorCount(source: ts.SourceFile): number {
  return (source as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length;
}

/**
 * Titles one source carries. `.each` table literals count as titles: the printed
 * name of `it.each([['AC9 x']])('%s')` lives in the table, never in the title.
 */
function titlesIn({ file, text }: Source): Title[] {
  const source = parse(file, text);
  const found: Title[] = [];
  const record = (node: ts.Node): void => {
    if (!isTextLiteral(node)) return;
    found.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text: node.text,
    });
  };

  const recordDeep = (node: ts.Node): void => {
    record(node);
    ts.forEachChild(node, recordDeep);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (RUNNERS.has(runnerOf(node.expression) ?? '')) {
        record(node.arguments[0]!);
        if (ts.isCallExpression(node.expression)) node.expression.arguments.forEach(recordDeep);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

function corpus(): Source[] {
  return testFiles().map((file) => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }));
}

/** `file:line  text` for every hit, so a failure says where to look. */
function offendersIn(sources: readonly Source[], pattern: RegExp): string[] {
  return sources
    .flatMap(titlesIn)
    .filter((title) => pattern.test(title.text))
    .map((title) => `${title.file}:${title.line}  ${title.text}`);
}

describe('no test name cites a planning document', () => {
  const SOURCES = corpus();

  it.each([...FORBIDDEN])('no test name carries %s', (_label, pattern) => {
    expect(offendersIn(SOURCES, pattern)).toEqual([]);
  });
});

describe('the guard reds when the property it protects is broken', () => {
  // Assembled from an in-memory source, never a file, so the planted names are
  // invisible to the scan that reads titles off disk.
  const PLANTED: readonly Source[] = [
    { file: 'planted.ts', text: `describe('AC9 — a planted name', () => {});\n` },
    { file: 'planted-each.tsx', text: `it.each([['AC9 in a table']])('%s', () => {});\n` },
    { file: 'planted-task.ts', text: `it('deferred to task 9.9', () => {});\n` },
  ];

  it('reds on a planted name, in a title and in an `.each` table alike', () => {
    const ids = offendersIn(PLANTED, FORBIDDEN.get('an acceptance-criterion id')!);
    expect(ids).toEqual([
      'planted.ts:1  AC9 — a planted name',
      'planted-each.tsx:1  AC9 in a table',
    ]);
    expect(offendersIn(PLANTED, FORBIDDEN.get('a task pointer')!)).toEqual([
      'planted-task.ts:1  deferred to task 9.9',
    ]);
  });

  it('stays quiet on a planted name that cites nothing', () => {
    const clean = [{ file: 'clean.ts', text: `describe('a name citing nothing', () => {});\n` }];
    for (const pattern of FORBIDDEN.values()) {
      expect(offendersIn(clean, pattern)).toEqual([]);
    }
  });

  it('reaches every test file, including its own and the widest `.tsx`', () => {
    const files = testFiles();
    expect(files).toContain('src/__tests__/test-names.test.ts');
    expect(files).toContain('ui/src/components/session/__tests__/span-tree.test.tsx');
    expect(files).toContain('smoke/cold-run.spec.ts');
    expect(files.filter((path) => path.endsWith('.tsx')).length).toBeGreaterThan(5);
  });

  it('parses every guarded file cleanly, so no misparse can hide an offender', () => {
    const broken = corpus()
      .map(({ file, text }) => ({ file, count: parseErrorCount(parse(file, text)) }))
      .filter(({ count }) => count > 0);
    expect(broken).toEqual([]);
  });

  it('finds a title in every guarded file, so no file contributes nothing', () => {
    expect(corpus().filter((source) => titlesIn(source).length === 0)).toEqual([]);
  });
});
