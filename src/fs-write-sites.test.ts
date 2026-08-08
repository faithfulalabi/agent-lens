// AC4, static half — the read-only guarantee over `~/.claude/projects`; the
// behavioural half is `capture/__tests__/read-only.test.ts`. Static analysis
// cannot decide that a write target *is* `dataDir`, so this pins a reviewed
// inventory, asserted both ways. The key is `<file>#<ordinal>`: keying on
// `{file, callee, pathExpr}` would collapse `cli/hook.ts`'s two identical
// `mkdirSync(logsDir, …)` calls, and `<file>:<line>` would red on line shifts.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// `open`/`openSync` are handled separately — write-capable or not depending on
// flags. Omitting them would make "zero writes in the tailer" an artifact.
const WRITE_CALLEES = new Set([
  'appendFile',
  'appendFileSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createWriteStream',
  'ftruncate',
  'ftruncateSync',
  'futimes',
  'futimesSync',
  'link',
  'linkSync',
  'lutimes',
  'lutimesSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'symlink',
  'symlinkSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'utimes',
  'utimesSync',
  'write',
  'writeFile',
  'writeFileSync',
  'writeSync',
  'writev',
  'writevSync',
]);

const OPEN_CALLEES = new Set(['open', 'openSync']);

const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

/** One call site, keyed the way the manifest keys it. */
interface Site {
  key: string;
  file: string;
  callee: string;
  line: number;
  /** Informational, never asserted on. */
  pathExpr: string;
  flags?: string;
}

// Every `why` names the directory the write lands in. None is a transcript root.
const WRITE_SITES: readonly { key: string; callee: string; why: string }[] = [
  {
    key: 'capture/replay.ts#1',
    callee: 'rmSync',
    why: 'deletes a spool file under <dataDir>/spool once it has been replayed',
  },
  {
    key: 'capture/spool.ts#1',
    callee: 'mkdirSync',
    why: 'creates <dataDir>/spool before the adapter writes into it',
  },
  {
    key: 'capture/spool.ts#2',
    callee: 'appendFileSync',
    why: 'appends one spooled envelope to spoolFile(sessionId, dataDir)',
  },
  {
    key: 'cli/hook.ts#1',
    callee: 'mkdirSync',
    why: "creates the CLI's own <dataDir>/logs dir before the failure log",
  },
  {
    key: 'cli/hook.ts#2',
    callee: 'appendFileSync',
    why: 'appends a hook failure to <dataDir>/logs — diagnostics, never a transcript',
  },
  {
    key: 'cli/hook.ts#3',
    callee: 'mkdirSync',
    why: 'byte-identical sibling of #1 on the second failure path; the ordinal is what separates them',
  },
  {
    key: 'cli/hook.ts#4',
    callee: 'appendFileSync',
    why: 'the second failure path\'s log append, same <dataDir>/logs target',
  },
  {
    key: 'server/config.ts#1',
    callee: 'writeFileSync',
    why: 'writes the temp half of the atomic config write, inside dataDir',
  },
  {
    key: 'server/config.ts#2',
    callee: 'chmodSync',
    why: 'forces 0600 on that temp file, since umask can mask the create mode',
  },
  {
    key: 'server/config.ts#3',
    callee: 'renameSync',
    why: 'atomically moves the temp file onto <dataDir>/config.json',
  },
  {
    key: 'server/config.ts#4',
    callee: 'rmSync',
    why: 'removes <dataDir>/config.json on clean shutdown',
  },
  {
    key: 'server/start.ts#1',
    callee: 'mkdirSync',
    why: 'creates the data dir on boot — the only write `npm run dev` itself causes',
  },
  {
    key: 'shared/token.ts#1',
    callee: 'mkdirSync',
    why: 'creates the data dir before the token file is minted',
  },
  {
    key: 'shared/token.ts#2',
    callee: 'writeFileSync',
    why: 'writes the temp half of the atomic token write, inside dataDir',
  },
  {
    key: 'shared/token.ts#3',
    callee: 'chmodSync',
    why: 'forces 0600 on the temp token file',
  },
  {
    key: 'shared/token.ts#4',
    callee: 'renameSync',
    why: 'atomically moves the temp file onto <dataDir>/token',
  },
];

/** Every non-test `.ts` under `src/`, repo-relative with forward slashes. */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.split('\\').join('/'))
    .filter((name) => !name.endsWith('.test.ts') && !name.includes('__tests__/'))
    .sort();
}

/** Local names bound to `node:fs`(/promises) exports, plus namespace imports. */
function fsBindings(source: ts.SourceFile): {
  named: Map<string, string>;
  namespaces: Set<string>;
} {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !FS_MODULES.has(specifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        named.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
  }
  return { named, namespaces };
}

/** Every `node:fs` call in `file` that can write, plus every `open`/`openSync`. */
function scan(file: string): { writes: Site[]; opens: Site[] } {
  const path = join(SRC_DIR, file);
  const text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true);
  const { named, namespaces } = fsBindings(source);

  const writes: Site[] = [];
  const opens: Site[] = [];

  const record = (node: ts.CallExpression, callee: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const site: Site = {
      key: '',
      file,
      callee,
      line,
      pathExpr: node.arguments[0]?.getText(source) ?? '',
    };
    if (OPEN_CALLEES.has(callee)) {
      site.flags = node.arguments[1]?.getText(source);
      opens.push(site);
      // Unrecognisable flags count as a write — the safe direction to be wrong in.
      if (!isReadOnlyFlags(site.flags)) writes.push(site);
      return;
    }
    writes.push(site);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if (ts.isIdentifier(target)) {
        const imported = named.get(target.text);
        if (imported !== undefined && (WRITE_CALLEES.has(imported) || OPEN_CALLEES.has(imported))) {
          record(node, imported);
        }
      } else if (
        ts.isPropertyAccessExpression(target) &&
        ts.isIdentifier(target.expression) &&
        namespaces.has(target.expression.text) &&
        (WRITE_CALLEES.has(target.name.text) || OPEN_CALLEES.has(target.name.text))
      ) {
        record(node, target.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  writes.sort((a, b) => a.line - b.line);
  writes.forEach((site, i) => {
    site.key = `${file}#${i + 1}`;
  });
  return { writes, opens };
}

function scanAll(): { writes: Site[]; opens: Site[] } {
  const writes: Site[] = [];
  const opens: Site[] = [];
  for (const file of sourceFiles()) {
    const found = scan(file);
    writes.push(...found.writes);
    opens.push(...found.opens);
  }
  return { writes, opens };
}

describe('AC4 (static) — every write-capable fs call in src/ is reviewed', () => {
  it('finds no unreviewed write site, and no stale manifest entry', () => {
    const { writes } = scanAll();
    const found = new Set(writes.map((s) => s.key));
    const allowed = new Set(WRITE_SITES.map((e) => e.key));

    const unexpected = writes
      .filter((s) => !allowed.has(s.key))
      .map((s) => `${s.key} — ${s.callee}(${s.pathExpr}) at line ${s.line}`)
      .sort();
    expect(
      unexpected,
      'new write-capable fs call site(s) in src/. Confirm the target is under the ' +
        'data dir (never a transcript root), then add each to WRITE_SITES with a reason.',
    ).toEqual([]);

    const stale = [...allowed].filter((key) => !found.has(key)).sort();
    expect(
      stale,
      'WRITE_SITES entries that match nothing — the call moved or went away; delete them.',
    ).toEqual([]);
  });

  it('each reviewed site is still the call the review looked at', () => {
    // Stops the ordinal surviving a reordering that repoints an entry elsewhere.
    const byKey = new Map(scanAll().writes.map((s) => [s.key, s]));
    for (const entry of WRITE_SITES) {
      expect(byKey.get(entry.key)?.callee, `${entry.key} changed callee`).toBe(entry.callee);
      expect(entry.why.length, `${entry.key} needs a justification`).toBeGreaterThan(0);
    }
  });

  it('the tailer writes nothing, and its only openSync is read-only', () => {
    const { writes, opens } = scanAll();
    // `npm run dev` backfills real transcripts through this module.
    expect(writes.filter((s) => s.file === 'capture/tailer.ts')).toEqual([]);

    // …which would be vacuous if `openSync` were simply off the scan.
    expect(opens.map((s) => `${s.file}:${s.flags ?? '(default)'}`)).toEqual([
      "capture/tailer.ts:'r'",
    ]);
  });
});

/** True when an `open`/`openSync` flags argument cannot write. */
function isReadOnlyFlags(flags: string | undefined): boolean {
  // Omitted flags default to `'r'`.
  if (flags === undefined) return true;
  const literal = /^['"`](.*)['"`]$/.exec(flags)?.[1];
  if (literal === undefined) return false;
  return /^rs?$/.test(literal);
}
