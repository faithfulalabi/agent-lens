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

/** One reviewed write site. A `why` records what the review established — no more. */
interface ManifestEntry {
  key: string;
  callee: string;
  why: string;
}

// Every `why` names the directory the write lands in. None is a transcript root.
// Where a guarantee is only partial, the `why` names the part that does not hold
// rather than rounding up: an entry that overstates is worse than no entry.
const WRITE_SITES: readonly ManifestEntry[] = [
  {
    key: 'archive/lock.ts#1',
    callee: 'openSync',
    why: 'opens <dataDir>/archive.lock (resolveLockPath, paths.ts:48-50), a fixed name never derived from the transcript corpus; no containment assert is applied to this path',
  },
  {
    key: 'archive/lock.ts#2',
    callee: 'writeSync',
    why: 'writes the JSON lock record to the fd from #1; no path of its own',
  },
  {
    key: 'archive/lock.ts#3',
    callee: 'unlinkSync',
    why: 'unlinks the lock path, and only when the record still names our pid (lock.ts:91-92); unlink removes the link itself, never a symlink target. All three in-repo callers pass resolveLockPath(dataDir) (lock.ts:120,130,177), but releaseLock IS re-exported at index.ts:16, so an external caller supplies the path — this is not the closed-caller-set argument used for ensureDir/appendOwnedLine',
  },
  {
    key: 'archive/lock.ts#4',
    callee: 'unlinkSync',
    why: 'same fixed lock path on the reclaim path (lock.ts:168); same non-following unlink',
  },
  {
    key: 'archive/mirror.ts#1',
    callee: 'openSync',
    why: 'opens <dataDir>/archive/<relPath> for the mirrored bytes. Scope of the guarantee: containment is asserted on the realpath of the PARENT DIRECTORY only (mirror.ts:176-177); the leaf is not resolved and openSync carries no O_NOFOLLOW, so a leaf symlink under <dataDir>/archive is followed. Filed as task 1.4; not fixed here',
  },
  {
    key: 'archive/mirror.ts#2',
    callee: 'chmodSync',
    why: 'forces 0600 on that same archive path (umask can mask the create-mode); reached only via the !archiveExists branch. Same partial scope as #1 — parent dir realpathed, leaf not (task 1.4)',
  },
  {
    key: 'archive/mirror.ts#3',
    callee: 'writeSync',
    why: "writes the mirrored bytes positionally to the fd from #1; inherits #1's scope exactly, including the unresolved leaf (task 1.4)",
  },
  {
    key: 'archive/paths.ts#1',
    callee: 'mkdirSync',
    why: 'ensureDir: creates a directory that is lexically under <dataDir> at all four callers (lock.ts:114, paths.ts:78, mirror.ts:175, mirror.ts:387). Lexical only: recursive mkdir traverses existing symlinked components, and at mirror.ts:175 it runs before the assert at :177 — see task 1.4',
  },
  {
    key: 'archive/paths.ts#2',
    callee: 'appendFileSync',
    why: "appends one JSONL line to <dataDir>/logs/archive.jsonl (paths.ts:44-46) for the archive's own event log; fixed name, single caller (log.ts:41). Flag 'a' follows a leaf symlink at that path — same unresolved-leaf class as task 1.4",
  },
  {
    key: 'archive/paths.ts#3',
    callee: 'chmodSync',
    why: 'forces 0600 on that same log path; follows a leaf symlink there for the same reason as #2 (task 1.4)',
  },
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
    why: "the second failure path's log append, same <dataDir>/logs target",
  },
  {
    key: 'render-gate/index.ts#1',
    callee: 'mkdirSync',
    why: "creates <repoRoot>/.render-gate/<task> for the gate's own artifacts. The only variable component is the --task id, which parseArgv rejects when it holds a path separator or is a bare `..` (index.ts). Scope: lexical — recursive mkdir traverses existing symlinked components, same class as archive/paths.ts#1. Never a transcript root; the gate only READS ~/.claude/projects, through the tailer",
  },
  {
    key: 'render-gate/index.ts#2',
    callee: 'writeFileSync',
    why: 'writes one screenshot PNG per shot into the directory from #1; the four names are a closed literal union (ShotName), never derived from any corpus',
  },
  {
    key: 'render-gate/index.ts#3',
    callee: 'writeFileSync',
    why: 'writes report.json into the directory from #1; fixed name',
  },
  {
    key: 'render-gate/index.ts#4',
    callee: 'writeFileSync',
    why: 'writes the index.html contact sheet into the directory from #1; fixed name',
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

// Exhaustive, like WRITE_SITES. Every writing row here is also a WRITE_SITES row
// (archive/lock.ts#1, archive/mirror.ts#1) and reviewed there; the read-only rows
// are listed only so `openSync` cannot silently leave the scan.
const OPEN_SITES: readonly string[] = [
  "archive/lock.ts:'wx'",
  "archive/mirror.ts:archiveExists ? 'r+' : 'wx'",
  "archive/mirror.ts:'r'",
  "archive/mirror.ts:'r'",
  "archive/report.ts:'r'",
  "archive/report.ts:'r'",
  "capture/tailer.ts:'r'",
];

// The three helpers below are what the real assertions and their mutation controls
// share. A control that re-derives the comparison inline proves nothing about the
// assertion it protects: softening the real body would leave the control green.
// Parameters are DEFAULTED so each real assertion reads as an argument-free call —
// there is no call-site expression for a future `.filter(...)` to hide in. A shared
// body protects the body, never the arguments, so the defaults close the hole.

/** Both directions of the manifest: sites with no entry, entries with no site. */
function unreviewedKeys(
  writes: readonly Site[] = scanAll().writes,
  manifest: readonly ManifestEntry[] = WRITE_SITES,
): { unexpected: string[]; stale: string[] } {
  const found = new Set(writes.map((s) => s.key));
  const allowed = new Set(manifest.map((e) => e.key));
  return {
    unexpected: writes
      .filter((s) => !allowed.has(s.key))
      .map((s) => `${s.key} — ${s.callee}(${s.pathExpr}) at line ${s.line}`)
      .sort(),
    stale: [...allowed].filter((key) => !found.has(key)).sort(),
  };
}

/** One `file:flags` row per open site, sorted; `file` narrows to a single module. */
function openRowsOf(opens: readonly Site[] = scanAll().opens, file?: string): string[] {
  return opens
    .filter((s) => file === undefined || s.file === file)
    .map((s) => `${s.file}:${s.flags ?? '(default)'}`)
    .sort();
}

/** Write-site keys for one module. Shared by the tailer assertion and its control. */
function writeKeysOf(writes: readonly Site[] = scanAll().writes, file?: string): string[] {
  return writes
    .filter((s) => file === undefined || s.file === file)
    .map((s) => s.key)
    .sort();
}

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

/**
 * Every `node:fs` call in `file` that can write, plus every `open`/`openSync`.
 * `text` is defaulted rather than read inline so the mutation control can feed
 * the scanner a fixture without touching disk.
 */
function scan(
  file: string,
  text = readFileSync(join(SRC_DIR, file), 'utf8'),
): { writes: Site[]; opens: Site[] } {
  const path = join(SRC_DIR, file);
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
    const { unexpected, stale } = unreviewedKeys();

    expect(
      unexpected,
      'new write-capable fs call site(s) in src/. Confirm the target is under the ' +
        'data dir (never a transcript root), then add each to WRITE_SITES with a reason.',
    ).toEqual([]);

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
    // `npm run dev` backfills real transcripts through this module.
    expect(writeKeysOf(undefined, 'capture/tailer.ts')).toEqual([]);

    // …which would be vacuous if `openSync` were simply off the scan. The whole-repo
    // row set stays exhaustive; the archive's writing opens are reviewed in WRITE_SITES.
    expect(openRowsOf()).toEqual([...OPEN_SITES].sort());

    // The row that keeps the `writes` assertion above honest: positive and
    // non-empty, so a scan that stopped seeing `openSync` reds here first.
    expect(openRowsOf(undefined, 'capture/tailer.ts')).toEqual(["capture/tailer.ts:'r'"]);
  });
});

describe('the guard reds when the property it protects is broken', () => {
  const TAILER_FILE = 'capture/tailer.ts';
  const TAILER_SRC = readFileSync(join(SRC_DIR, TAILER_FILE), 'utf8');

  // Controls drive the same helpers the real assertions call. Re-deriving the
  // comparison inline here would prove nothing: softening a real assertion body
  // would leave an inline control green.

  it('the unmutated tailer source, through the same seam, is clean', () => {
    // Proves the mutation below reds because of the appended line, not because
    // feeding `scan` fixture text is itself enough to trip the guard.
    const clean = scan(TAILER_FILE, TAILER_SRC);

    expect(unreviewedKeys(clean.writes, WRITE_SITES).unexpected).toEqual([]);
    expect(clean.writes).toEqual([]);
    expect(openRowsOf(clean.opens, TAILER_FILE)).toEqual(["capture/tailer.ts:'r'"]);
  });

  it('a writing openSync in the tailer reds every assertion that guards it', () => {
    // `'a'` fails isReadOnlyFlags, so the mutant lands in `writes` too. The call
    // binds to the file's own `openSync` import, which is what fsBindings resolves.
    const mutated = scan(TAILER_FILE, `${TAILER_SRC}\nopenSync('/tmp/x', 'a');\n`);

    // Load-bearing: the helper is handed tailer sites directly, so a future
    // `.filter(s => s.file !== 'capture/tailer.ts')` in the real body cannot hide.
    const { unexpected } = unreviewedKeys(mutated.writes, WRITE_SITES);
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toMatch(/^capture\/tailer\.ts#1 /);

    expect(writeKeysOf(mutated.writes, TAILER_FILE)).toContain('capture/tailer.ts#1');

    const tailerRows = openRowsOf(mutated.opens, TAILER_FILE);
    expect(tailerRows).not.toEqual(["capture/tailer.ts:'r'"]);
    expect(tailerRows).toContain("capture/tailer.ts:'a'");

    const swapped = [...scanAll().opens.filter((s) => s.file !== TAILER_FILE), ...mutated.opens];
    expect(openRowsOf(swapped)).not.toEqual([...OPEN_SITES].sort());
  });

  it('every partial-guarantee entry still cites the task that closes the gap', () => {
    // The mechanical half of AC1: honesty is not checkable, the citation is.
    // Without this, a later edit could strip a caveat while the gap is still open.
    const partial = [
      'archive/mirror.ts#1',
      'archive/mirror.ts#2',
      'archive/mirror.ts#3',
      'archive/paths.ts#2',
      'archive/paths.ts#3',
    ];
    for (const key of partial) {
      const entry = WRITE_SITES.find((e) => e.key === key);
      expect(entry, `${key} is missing from WRITE_SITES`).toBeDefined();
      expect(entry?.why, `${key} must name the limit of its guarantee and cite task 1.4`).toMatch(
        /task 1\.4/,
      );
    }
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
