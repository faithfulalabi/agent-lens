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
  'fchmod',
  'fchmodSync',
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
    why: 'unlinks the lock path, and only when the record still names our pid (lock.ts:91-92); unlink removes the link itself, never a symlink target. All three in-repo callers pass resolveLockPath(dataDir) (lock.ts:120,130,177), but releaseLock IS re-exported from index.ts, so an external caller supplies the path — this is not the closed-caller-set argument used for ensureDir/appendOwnedLine',
  },
  {
    key: 'archive/lock.ts#4',
    callee: 'unlinkSync',
    why: 'same fixed lock path on the reclaim path (lock.ts:168); same non-following unlink',
  },
  {
    key: 'archive/mirror.ts#1',
    callee: 'openSync',
    why: 'opens <dataDir>/archive/<relPath> for the mirrored bytes, with O_NOFOLLOW on the r+ branch and O_CREAT|O_EXCL on the create branch, so the kernel itself refuses a symlinked LEAF. Scope of the guarantee: FINAL COMPONENT ONLY. The directory chain above it is check-then-act: ensureDirUnder (writeArchiveBytes in mirror.ts) asserts containment before AND after its mkdir, which refuses a pre-planted LIVE symlinked ancestor. It does not refuse one planted between the assert and the mkdir, nor a DANGLING one (realpathSync reports ENOENT for a dangling link and for an absent component alike, so the guard cannot tell them apart — the kernel stops that case instead, with its own ENOENT). What is left is narrowed by task 1.7; the concurrent-plant window itself is PERMANENT, because closing it needs openat/mkdirat against a dirfd and Node exposes no such API at all',
  },
  {
    key: 'archive/mirror.ts#2',
    callee: 'chmodSync',
    why: 'forces 0600 on that same archive path (umask can mask the create-mode); reached only via the !archiveExists branch, i.e. only after O_CREAT|O_EXCL proved we created the file. Path-based, so it re-resolves the leaf after we already hold the fd: the residual race can mis-chmod a victim to 0600 but cannot alter content. fchmodSync closes it, and archive/paths.ts#3 now uses exactly that for the log write, so the two are inconsistent — task 1.7 owns making them agree. Same directory-chain scope as #1, permanent half included',
  },
  {
    key: 'archive/mirror.ts#3',
    callee: 'writeSync',
    why: "writes the mirrored bytes positionally to the fd from #1; inherits #1's scope exactly, including the directory-chain residual task 1.7 narrows and the concurrent-plant window nothing can close",
  },
  {
    key: 'archive/mirror.ts#4',
    callee: 'openSync',
    why: 'opens the existing archive file READ-ONLY (O_RDONLY|O_NOFOLLOW) to feed detectDivergence; writes nothing. Listed only because the scanner counts a non-string flags argument as a write — its documented safe direction to be wrong in (see the `record` comment in this file). O_NOFOLLOW is here so a symlinked leaf cannot fabricate a `diverged` row about a file the archive never wrote. Directory chain as in #1: narrowed by ensureDirUnder, narrowed further by task 1.7, permanently open to a concurrent plant',
  },
  {
    key: 'archive/seal.ts#1',
    callee: 'openSync',
    why: 'opens the HOT archive file READ-ONLY (O_RDONLY|O_NOFOLLOW) to hash and compress it; writes nothing. Listed only because the scanner counts a non-string flags argument as a write — the same documented safe direction as archive/mirror.ts#4. O_NOFOLLOW is load-bearing here rather than decorative: without it a symlinked leaf under the archive root would be read THROUGH the link, so a live transcript would be compressed into the archive and the link unlinked by #10. Directory chain as in archive/mirror.ts#1: narrowed by ensureDirUnder, narrowed further by task 1.7, permanently open to a concurrent plant',
  },
  {
    key: 'archive/seal.ts#2',
    callee: 'openSync',
    why: "creates <archivePath>.zst.tmp.<pid> with 'wx' (O_WRONLY|O_CREAT|O_EXCL), which POSIX requires to refuse a final symlink, live or dangling. The path is the archive path from #1 plus a fixed suffix, and assertUnderArchiveRoot has already run on its parent directory (sealArchiveFile, before this open). The `.tmp.<pid>` suffix is what keeps a crashed temp out of discover's union. Directory chain as in archive/mirror.ts#1: narrowed by ensureDirUnder, narrowed further by task 1.7, permanently open to a concurrent plant",
  },
  {
    key: 'archive/seal.ts#3',
    callee: 'fchmodSync',
    why: 'forces 0600 on the temp file from #2 (umask can mask the create-mode). fd-based, so unlike archive/mirror.ts#2 it re-resolves no path at all and has no residual leaf race',
  },
  {
    key: 'archive/seal.ts#4',
    callee: 'writeSync',
    why: "writes the compressed frame positionally to the fd from #2; no path of its own, and inherits #2's scope",
  },
  {
    key: 'archive/seal.ts#5',
    callee: 'openSync',
    why: "creates <archivePath>.zst.sha256.tmp.<pid> with 'wx' (O_WRONLY|O_CREAT|O_EXCL), which POSIX requires to refuse a final symlink, live or dangling. Same directory as #2, covered by the same assertUnderArchiveRoot call, and the same `.tmp.<pid>` trick that keeps a crashed temp out of discover's union. Directory chain as in archive/mirror.ts#1: narrowed by ensureDirUnder, narrowed further by task 1.7, permanently open to a concurrent plant",
  },
  {
    key: 'archive/seal.ts#6',
    callee: 'fchmodSync',
    why: 'forces 0600 on the sidecar temp from #5 (umask can mask the create-mode). fd-based like #3, so it re-resolves no path and has no residual leaf race',
  },
  {
    key: 'archive/seal.ts#7',
    callee: 'writeSync',
    why: "writes the one JSON line of the seal record positionally to the fd from #5; no path of its own, and inherits #5's scope",
  },
  {
    key: 'archive/seal.ts#8',
    callee: 'renameSync',
    why: "atomically moves the sidecar temp from #5 onto <archivePath>.zst.sha256, in the directory asserted before #2. rename(2) acts on the link itself, never a symlink target. Ordered BEFORE #9 on purpose: publishing the record first is what makes 'a .zst at its final name always has a sidecar' an invariant, and a crash between the two leaves an inert sidecar with no frame, which the next pass overwrites",
  },
  {
    key: 'archive/seal.ts#9',
    callee: 'renameSync',
    why: 'atomically moves the temp file from #2 onto <archivePath>.zst, both under the archive root asserted before #2. rename(2) acts on the link itself, never a symlink target. Ordered after #8 so the frame never reaches its final name without its sidecar, and before #10 so no instant exists at which only a partial frame is present',
  },
  {
    key: 'archive/seal.ts#10',
    callee: 'unlinkSync',
    why: 'removes the hot archive file from #1, only after #9 published a frame already round-trip verified byte-identical to it. unlink(2) removes the link itself, never a symlink target — and #1 refused to follow one in the first place',
  },
  {
    key: 'archive/paths.ts#1',
    callee: 'mkdirSync',
    why: 'ensureDir: creates a directory lexically under <dataDir>. ONE caller reaches it through ensureDirUnder, which asserts containment before and after this mkdir and so refuses a pre-planted LIVE symlinked ancestor (writeArchiveBytes in mirror.ts); a dangling one is stopped by the ENOENT from this mkdir instead, not by the guard. THREE callers still call ensureDir bare and stay lexical only, because none of their targets is under an archive root to be checked against: acquireLock (lock.ts, <dataDir>), appendOwnedLine below (<dataDir>/logs), and archiveOnce (mirror.ts), which CREATES <dataDir>/archive and so has no root yet. Recursive mkdir traverses existing symlinked components at all three — measured through a symlinked <dataDir>, not assumed. Those three are narrowed by task 1.7; the concurrent-plant window is PERMANENT, since closing it needs mkdirat against a dirfd and Node exposes none',
  },
  {
    key: 'archive/paths.ts#2',
    callee: 'openSync',
    why: "opens <dataDir>/logs/archive.jsonl (resolveArchiveLogPath) for the archive's own event log with O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW, so the kernel refuses a symlinked final component — live OR dangling, since O_CREAT without O_EXCL does not rescue a dangling link from O_NOFOLLOW. Fixed name, single caller: appendArchiveLog in log.ts. O_APPEND lands every write at EOF, which is the append semantics the appendFileSync it replaced provided",
  },
  {
    key: 'archive/paths.ts#3',
    callee: 'fchmodSync',
    why: 'forces 0600 on the fd from #2 (umask can mask the create-mode). fd-based like archive/seal.ts#3, so it re-resolves no path at all and — unlike archive/mirror.ts#2 — has no residual leaf race',
  },
  {
    key: 'archive/paths.ts#4',
    callee: 'writeSync',
    why: 'writes the one JSONL line to the fd from #2; no path of its own, and O_APPEND is what puts it at EOF',
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
    why: "creates <repoRoot>/.render-gate/<task> for the gate's own artifacts. The only variable component is the --task id, which parseArgv rejects when it holds a path separator or is a bare `..` (index.ts). Scope: lexical — recursive mkdir traverses existing symlinked components, the same class as archive/paths.ts#1's three bare-ensureDir callers rather than the one guarded by ensureDirUnder. Never a transcript root; the gate only READS ~/.claude/projects, through the tailer",
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
// (archive/lock.ts#1, archive/mirror.ts#1, archive/mirror.ts#4, archive/paths.ts#2,
// archive/seal.ts#1, archive/seal.ts#2, archive/seal.ts#5) and reviewed there; the read-only rows are
// listed only so `openSync` cannot silently leave the scan. The four numeric rows
// are the archive-side opens given O_NOFOLLOW: they carry no string literal, so
// isReadOnlyFlags rejects all four and they land in `writes` too — including
// archive/mirror.ts#4 and archive/seal.ts#1, which only read. archive/paths.ts is
// the one of the four that genuinely writes: it is the event-log append, and
// O_NOFOLLOW is what stops it following a link planted at the log path.
const OPEN_SITES: readonly string[] = [
  "archive/lock.ts:'wx'",
  'archive/mirror.ts:archiveExists ? O_RDWR | O_NOFOLLOW : O_WRONLY | O_CREAT | O_EXCL',
  'archive/mirror.ts:O_RDONLY | O_NOFOLLOW',
  "archive/mirror.ts:'r'",
  'archive/paths.ts:O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW',
  // The accessor reads only, and both of its opens carry a plain 'r' literal so
  // that the ENOENT fallback from hot to sealed stays a two-outcome dispatch.
  "archive/read.ts:'r'",
  "archive/read.ts:'r'",
  "archive/report.ts:'r'",
  "archive/report.ts:'r'",
  'archive/seal.ts:O_RDONLY | O_NOFOLLOW',
  // Two: the frame's temp and the sidecar's, both created with O_CREAT|O_EXCL.
  "archive/seal.ts:'wx'",
  "archive/seal.ts:'wx'",
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

/**
 * Every manifest entry whose `why` cites a task, and which tasks it cites.
 * DERIVED from the `why` strings, never hand-listed: the array this replaced
 * named six keys while nine `why`s cited a task, so three caveats
 * (archive/mirror.ts#4, archive/seal.ts#1, archive/seal.ts#2) were policed by
 * nothing at all and could have outlived the task they named indefinitely.
 */
function taskCitations(manifest: readonly ManifestEntry[] = WRITE_SITES): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of manifest) {
    const tasks = [...entry.why.matchAll(/task (\d+\.\d+)/gi)].map((match) => match[1]!);
    if (tasks.length > 0) out.set(entry.key, [...new Set(tasks)].sort());
  }
  return out;
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

  it('the fd-based mode changer is registered, so a seal-time chmod cannot hide', () => {
    // Without `fchmodSync` in WRITE_CALLEES the seal's 0600 would be invisible to
    // this manifest, which is worse than a red. Its async sibling is registered
    // for the same reason `futimes` is: so it cannot arrive unnoticed later.
    for (const name of ['fchmod', 'fchmodSync']) {
      expect(WRITE_CALLEES.has(name), `${name} must stay in WRITE_CALLEES`).toBe(true);
    }
    expect(WRITE_SITES.find((e) => e.key === 'archive/seal.ts#3')?.callee).toBe('fchmodSync');
    expect(writeKeysOf(undefined, 'archive/seal.ts')).toContain('archive/seal.ts#3');
    // Inert for the async form: nothing under src/ calls it.
    expect(scanAll().writes.filter((s) => s.callee === 'fchmod')).toEqual([]);
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

  it('every partial-guarantee entry cites the OPEN follow-up, and none cites a closed task', () => {
    // The mechanical half of AC1: honesty is not checkable, the citation is.
    // Without this, a later edit could strip a caveat while the gap is still open
    // — or leave one naming a task that shipped, which is the same rot pointing
    // the other way. Both directions come from `toEqual` on the derived map: a
    // key that grows a citation must appear, one that loses its caveat must go.
    expect(Object.fromEntries(taskCitations())).toEqual({
      'archive/mirror.ts#1': ['1.7'],
      'archive/mirror.ts#2': ['1.7'],
      'archive/mirror.ts#3': ['1.7'],
      'archive/mirror.ts#4': ['1.7'],
      'archive/paths.ts#1': ['1.7'],
      'archive/seal.ts#1': ['1.7'],
      'archive/seal.ts#2': ['1.7'],
      'archive/seal.ts#5': ['1.7'],
    });

    // A citation is worth something only while the task is open, so the set of
    // tasks named anywhere in the manifest is exactly the one open follow-up.
    // Task 1.5 closed the log leaf; nothing may still name it, and the two rows
    // it closed (archive/paths.ts#2, #3) carry no caveat to cite for.
    expect([...new Set([...taskCitations().values()].flat())].sort()).toEqual(['1.7']);
  });

  it('a stripped caveat drops its key out of the derived citation set', () => {
    // Proves the assertion above reds rather than assuming it. The mutation lands
    // on archive/seal.ts#1 on purpose: it is one of the three keys the previous
    // hand-maintained array left unpoliced, so this is the exact hole being closed.
    const stripped = WRITE_SITES.map((entry) =>
      entry.key === 'archive/seal.ts#1'
        ? { ...entry, why: entry.why.replace(/task 1\.7/g, 'nothing in particular') }
        : entry,
    );

    const mutated = taskCitations(stripped);
    expect(mutated.has('archive/seal.ts#1')).toBe(false);
    expect(Object.fromEntries(mutated)).not.toEqual(Object.fromEntries(taskCitations()));
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
