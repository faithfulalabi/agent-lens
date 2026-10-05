// Asserts over the source text that `raw-types.ts` declares types only, every field optional and
// `unknown`-valued, and that neither module can reach the filesystem or the clock. Every helper
// takes a DEFAULTED `text` parameter so the mutation controls at the bottom drive the real
// helper bodies rather than a re-derived copy.
//
// Type-only is checked two ways because `export declare const X: number` emits nothing — so the
// byte-identical-emit limb passes it and only the statement-kind limb catches it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** `src/transcript/` — the directory this file's `__tests__/` sits in. */
const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const RAW_TYPES = 'raw-types.ts';
const ACCESSORS = 'accessors.ts';

/**
 * Identifiers neither module may name. `isoTs` validates by regex precisely so this can be a
 * flat zero rather than a judgement call about which clock call is acceptable.
 */
const BANNED = new Set(['Date', 'performance', 'process', 'Math', 'globalThis', 'require']);

function read(file: string): string {
  return readFileSync(join(MODULE_DIR, file), 'utf8');
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(join(MODULE_DIR, file), text, ts.ScriptTarget.ESNext, true);
}

/** The JavaScript `text` compiles to. The filename is a module-format hint and nothing more. */
function emit(text: string): string {
  return ts.transpileModule(text, {
    fileName: 'module-under-test.ts',
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
      removeComments: true,
    },
  }).outputText;
}

/** What a module of nothing but type declarations compiles down to. */
const TYPE_ONLY_EMIT = emit('export type Nothing = never;\n');

/**
 * Every top-level statement that is not a pure type declaration, labelled.
 * A type-only `import`/`export` is allowed here and refused separately by
 * `importSpecifiers` — the two limbs guard different things, and the split is
 * what lets a future type-only import be a deliberate decision rather than an
 * accident that slips through both.
 */
function executableStatements(file: string, text = read(file)): string[] {
  const source = parse(file, text);
  return source.statements
    .filter((statement) => {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
        return false;
      if (ts.isImportDeclaration(statement)) return statement.importClause?.isTypeOnly !== true;
      if (ts.isExportDeclaration(statement)) return !statement.isTypeOnly;
      return true;
    })
    .map((statement) => {
      const kind = ts.SyntaxKind[statement.kind];
      return `${kind}: ${statement.getText(source).split('\n')[0]}`;
    });
}

interface FieldSignature {
  name: string;
  optional: boolean;
  unknownTyped: boolean;
}

/** Every declared field in `file`, however deeply nested inside a type. */
function fieldSignatures(file: string, text = read(file)): FieldSignature[] {
  const source = parse(file, text);
  const fields: FieldSignature[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertySignature(node)) {
      fields.push({
        name: node.name.getText(source),
        optional: node.questionToken !== undefined,
        unknownTyped: node.type?.kind === ts.SyntaxKind.UnknownKeyword,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return fields;
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

/**
 * Every identifier `file` names. IDENTIFIERS rather than raw text, so the modules can explain
 * in prose why they avoid the clock without tripping their own guard.
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

/** The banned subset. A filter over the walk above, so a walk that stopped recursing reds there. */
function bannedIdentifiers(file: string, text = read(file)): string[] {
  return identifiers(file, text).filter((name) => BANNED.has(name));
}

/** The clock global anywhere in the raw text, comments and all. See its test. */
function namesClockInText(file: string, text = read(file)): boolean {
  return /\bDate\b/.test(text);
}

describe('AC1 — raw-types.ts is documentation that compiles', () => {
  it('emits no JavaScript at all', () => {
    expect(emit(read(RAW_TYPES))).toBe(TYPE_ONLY_EMIT);
  });

  it('declares nothing but types', () => {
    expect(
      executableStatements(RAW_TYPES),
      'raw-types.ts must hold type declarations only — no value, however inert.',
    ).toEqual([]);
  });

  it('declares every harness field optional and unknown-valued', () => {
    const fields = fieldSignatures(RAW_TYPES);

    // Non-vacuous: an empty file would satisfy every assertion below it.
    expect(fields.length).toBeGreaterThan(50);

    expect(fields.filter((f) => !f.optional).map((f) => f.name)).toEqual([]);
    expect(fields.filter((f) => !f.unknownTyped).map((f) => f.name)).toEqual([]);
  });

  it('names the record types, content blocks and sub-objects that were measured', () => {
    // The module's whole purpose is a measured field INVENTORY, so losing an interface is
    // losing the measurement. "Contains", not "equals": adding a type must not red.
    const declared = new Set(
      parse(RAW_TYPES, read(RAW_TYPES))
        .statements.filter(ts.isInterfaceDeclaration)
        .map((statement) => statement.name.text),
    );

    for (const name of [
      'RawUserLine',
      'RawAssistantLine',
      'RawSystemLine',
      'RawAttachmentLine',
      'RawModeLine',
      'RawPermissionModeLine',
      'RawFileHistorySnapshotLine',
      'RawAiTitleLine',
      'RawLastPromptLine',
      'RawAtisLatchLine',
      'RawCostStateLine',
      'RawForkContextRefLine',
      'RawMessage',
      'RawUsage',
      'RawOrigin',
      'RawTextBlock',
      'RawThinkingBlock',
      'RawToolUseBlock',
      'RawToolResultBlock',
    ]) {
      expect(declared.has(name), `${name} went missing from the measured inventory`).toBe(true);
    }
  });
});

describe('AC4 — neither module imports anything, nor can reach a clock', () => {
  it.each([RAW_TYPES, ACCESSORS])('%s imports nothing at all', (file) => {
    // Stronger than "imports no node:fs / node:sqlite", and stronger on purpose:
    // an empty import set is a fact a reader can check at a glance, whereas a
    // denylist is a list someone has to remember to extend.
    expect(importSpecifiers(file)).toEqual([]);
  });

  it.each([RAW_TYPES, ACCESSORS])('%s names no clock, no randomness, no escape hatch', (file) => {
    expect(bannedIdentifiers(file)).toEqual([]);
  });

  it.each([RAW_TYPES, ACCESSORS])('%s does not contain the clock global even in prose', (file) => {
    // The rule is that the identifier must not appear AT ALL, and the AST walk above cannot
    // see it in a comment, so this limb reads the raw text. The cost is that both modules
    // must explain why they avoid the clock without naming it; they do.
    expect(namesClockInText(file)).toBe(false);
  });

  it('the identifier walk actually sees identifiers', () => {
    // Without this, a walker that silently stopped recursing would make the two
    // assertions above pass for every file on earth.
    const named = identifiers(ACCESSORS);
    expect(named).toContain('isoTs');
    // `Array.isArray` is the throwing call the `try` in `arr`/`obj` exists for.
    // Seeing it here proves the walk reaches inside a function body, which is
    // exactly where a clock read would hide.
    expect(named).toContain('Array');
    expect(named.length).toBeGreaterThan(20);
    expect(identifiers(RAW_TYPES).length).toBeGreaterThan(50);
  });
});

describe('the guard reds when the property it protects is broken', () => {
  const RAW_SRC = read(RAW_TYPES);
  const ACCESSORS_SRC = read(ACCESSORS);

  it('the unmutated sources, through the same seams, are clean', () => {
    // Proves each mutation below reds because of the mutation, not because
    // feeding the helpers fixture text is itself enough to trip them.
    expect(executableStatements(RAW_TYPES, RAW_SRC)).toEqual([]);
    expect(fieldSignatures(RAW_TYPES, RAW_SRC).filter((f) => !f.optional)).toEqual([]);
    expect(importSpecifiers(ACCESSORS, ACCESSORS_SRC)).toEqual([]);
    expect(bannedIdentifiers(ACCESSORS, ACCESSORS_SRC)).toEqual([]);
  });

  it('an exported const reds both AC1 limbs', () => {
    const mutated = `${RAW_SRC}\nexport const X = 1;\n`;
    expect(executableStatements(RAW_TYPES, mutated)).toHaveLength(1);
    expect(emit(mutated)).not.toBe(TYPE_ONLY_EMIT);
  });

  it('an ambient declaration reds the AST limb, and ONLY the AST limb', () => {
    // Why it is asserted two ways: `declare` is erased at emit, so the byte-comparison sees a
    // clean module and only the statement kind catches it.
    const mutated = `${RAW_SRC}\nexport declare const Y: number;\n`;
    expect(emit(mutated)).toBe(TYPE_ONLY_EMIT);
    expect(executableStatements(RAW_TYPES, mutated)).toHaveLength(1);
  });

  it('a const enum reds both AC1 limbs', () => {
    const mutated = `${RAW_SRC}\nexport const enum E {\n  A,\n}\n`;
    expect(executableStatements(RAW_TYPES, mutated)).toHaveLength(1);
    expect(emit(mutated)).not.toBe(TYPE_ONLY_EMIT);
  });

  it('a required field reds the optionality limb', () => {
    const mutated = `${RAW_SRC}\nexport interface Mutant {\n  forced: unknown;\n}\n`;
    expect(
      fieldSignatures(RAW_TYPES, mutated)
        .filter((f) => !f.optional)
        .map((f) => f.name),
    ).toEqual(['forced']);
  });

  it('a typed field reds the unknown-valued limb', () => {
    // The subtler half: `narrowed?: string` is optional, so only the type limb
    // catches it — and it is the one that matters, because a declared `string`
    // is the exact lie that lets a read skip an accessor.
    const mutated = `${RAW_SRC}\nexport interface Mutant {\n  narrowed?: string;\n}\n`;
    const fields = fieldSignatures(RAW_TYPES, mutated);
    expect(fields.filter((f) => !f.optional)).toEqual([]);
    expect(fields.filter((f) => !f.unknownTyped).map((f) => f.name)).toEqual(['narrowed']);
  });

  it('a clock read reds the banned-identifier limb', () => {
    expect(
      bannedIdentifiers(ACCESSORS, `${ACCESSORS_SRC}\nexport const now = Date.now();\n`),
    ).toEqual(['Date']);
    expect(
      bannedIdentifiers(ACCESSORS, `${ACCESSORS_SRC}\nexport const r = Math.random();\n`),
    ).toEqual(['Math']);
  });

  it('the clock global reds the text limb even when only a comment names it', () => {
    // The case the AST limb cannot see, and the reason the text limb exists.
    const commented = `${ACCESSORS_SRC}\n// returns a Date, eventually\n`;
    expect(bannedIdentifiers(ACCESSORS, commented)).toEqual([]);
    expect(namesClockInText(ACCESSORS, commented)).toBe(true);
    expect(namesClockInText(ACCESSORS, ACCESSORS_SRC)).toBe(false);
  });

  it('a filesystem import reds the import limb', () => {
    const mutated = `import { readFileSync } from 'node:fs';\n${ACCESSORS_SRC}`;
    expect(importSpecifiers(ACCESSORS, mutated)).toEqual(['node:fs']);
  });

  it('a type-only import reds the import limb but not the statement limb', () => {
    // Documents the split deliberately: today both modules import nothing, so a
    // type-only import is still a change someone has to make on purpose.
    const mutated = `import type { RawUsage } from './raw-types.js';\n${RAW_SRC}`;
    expect(executableStatements(RAW_TYPES, mutated)).toEqual([]);
    expect(importSpecifiers(RAW_TYPES, mutated)).toEqual(['./raw-types.js']);
  });

  it('a dynamic import reds the import limb', () => {
    const mutated = `${ACCESSORS_SRC}\nexport const load = () => import('node:fs');\n`;
    expect(importSpecifiers(ACCESSORS, mutated)).toEqual(["'node:fs'"]);
  });
});
