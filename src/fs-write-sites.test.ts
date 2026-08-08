// AC4, static half — the read-only guarantee over `~/.claude/projects`.
//
// agent-lens reads the developer's transcripts. It must never write into them,
// and `npm run dev` now points the tailer at the real corpus with backfill on,
// so "the tailer only reads" stops being a comment and becomes a thing that has
// to be provable. Two proofs, because each misses what the other catches: this
// one is static (every write-capable call site in `src/`, reviewed), and
// `capture/__tests__/read-only.test.ts` is behavioural (the bytes did not move).
//
// **What this test is NOT.** Static analysis cannot decide that a target *is*
// `dataDir`: `spool.ts` writes to `spoolFile(sessionId, dataDir)` (a call),
// `hook.ts` to a local `logsDir`, `config.ts` to a derived `temp`, `replay.ts`
// to a readdir-derived `path`. So this pins a REVIEWED INVENTORY instead — every
// write-capable site, each carrying a written justification — asserted in both
// directions, the shape `ui/src/__tests__/no-egress.test.ts` established: a new
// site reds until someone reviews it, and an entry nothing matches reds too,
// because an exemption nothing needs is an exemption that stopped being read.
//
// The key is `<file>#<ordinal>`, the 1-based index of the site among write sites
// in that file in source order. A `{file, callee, pathExpr}` key would COLLAPSE
// `cli/hook.ts`'s two byte-identical `mkdirSync(logsDir, …)` calls, making the
// found set 15 against an allowlist of 16 — the stale direction going red on a
// correct implementation. `<file>:<line>` reds on unrelated line shifts; the
// ordinal is stable under those and still reds when a site is inserted, which is
// exactly when a human should look again.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The write-capable `node:fs` / `node:fs/promises` surface. `open`/`openSync`
 * are handled separately — they are write-capable or not depending on their
 * flags argument, and leaving them off the list entirely would make "zero write
 * sites in the tailer" an artifact of the omission rather than a fact.
 */
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
  /** The first argument's source text — informational, never asserted on. */
  pathExpr: string;
  /** For `open`/`openSync`: the flags argument's source text, or `undefined`. */
  flags?: string;
}

/**
 * The reviewed inventory. Every entry is a place agent-lens writes to disk, and
 * every `why` says which directory it lands in — all of them under the data dir,
 * the spool, or the CLI's own log dir. None of them is under a transcript root.
 */
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
      // Read-only unless the flags say otherwise; an unrecognisable flags
      // expression counts as a write, which is the safe direction to be wrong in.
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

  // Source order, then the ordinal that keys the manifest.
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
    // The ordinal survives line shifts on purpose; this is what stops it
    // surviving a *reordering* that silently repoints an entry at another call.
    const byKey = new Map(scanAll().writes.map((s) => [s.key, s]));
    for (const entry of WRITE_SITES) {
      expect(byKey.get(entry.key)?.callee, `${entry.key} changed callee`).toBe(entry.callee);
      expect(entry.why.length, `${entry.key} needs a justification`).toBeGreaterThan(0);
    }
  });

  it('the tailer writes nothing, and its only openSync is read-only', () => {
    const { writes, opens } = scanAll();
    // The whole point: `npm run dev` backfills the developer's real transcripts,
    // so the module that reads them must have no write-capable call at all.
    expect(writes.filter((s) => s.file === 'capture/tailer.ts')).toEqual([]);

    // …and that claim would be vacuous if `openSync` were simply off the scan.
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
