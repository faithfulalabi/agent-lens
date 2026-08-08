// Path resolution, source<->archive mapping, containment, and the two
// filesystem primitives that create archive-owned files (a 0700 directory and a
// 0600 line append).
//
// LOCAL COPIES ON PURPOSE. `resolveTranscriptRoot`, `canonicalizeTranscriptPath`
// and `resolveDataDir` are spelled here rather than imported from
// `src/capture/tailer.ts` / `src/capture/spool.ts`, and that is a correctness
// requirement, not a style choice: `tailer.ts` has *value* imports of
// `../db/index.js` and `../server/ingest.js`, and `src/db/index.ts` imports
// `node:sqlite`. Importing one 7-line pure function from it would boot the whole
// DB layer inside a cron job that must depend on nothing. Both originals are
// deleted at plan 002 §4.5, so these are the SURVIVING copies, not duplication
// awaiting a merge. `__tests__/source-readonly.test.ts` guards the import graph;
// `__tests__/mirror.test.ts` (path-helper agreement) guards the copies against
// drift while both spellings still exist.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  realpathSync,
  type Stats,
  type BigIntStats,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const ARCHIVE_DIR = 'archive';
const LOGS_DIR = 'logs';

/** Resolve the data dir: explicit arg -> $AGENT_LENS_DIR -> ~/.agent-lens. */
export function resolveDataDir(dir?: string): string {
  return dir ?? process.env.AGENT_LENS_DIR ?? join(homedir(), '.agent-lens');
}

/** Resolve the transcript root: explicit arg -> env -> ~/.claude/projects. */
export function resolveTranscriptRoot(root?: string): string {
  return root ?? process.env.AGENT_LENS_TRANSCRIPT_ROOT ?? join(homedir(), '.claude', 'projects');
}

/**
 * The ONE spelling of a transcript path. On macOS `resolve()` and `realpathSync`
 * genuinely differ for anything under `os.tmpdir()` (`/var/folders/...` vs
 * `/private/var/folders/...`), which every hermetic test root hits. Falls back to
 * a lexical `resolve()` when the path cannot be resolved, because a vanished file
 * must still key its archived bytes and must never throw and kill the pass.
 */
export function canonicalizeTranscriptPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Absolute path to the archive root inside the data dir. */
export function resolveArchiveRoot(dataDir?: string): string {
  return join(resolveDataDir(dataDir), ARCHIVE_DIR);
}

/** Absolute path to the archive log inside the data dir. */
export function resolveArchiveLogPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), LOGS_DIR, 'archive.jsonl');
}

/** Absolute path to the advisory lock inside the data dir. */
export function resolveLockPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), 'archive.lock');
}

/** True when `path` is `root` or lives beneath it. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The containment guard for every archive write. Throws rather than returning a
 * boolean: a mapped path that escaped the archive root is a bug that must be
 * loud, never a file quietly written somewhere else.
 */
export function assertUnderArchiveRoot(path: string, archiveRoot: string): void {
  if (!isUnder(path, archiveRoot)) {
    throw new Error(`refusing to write outside the archive root: ${path}`);
  }
}

/**
 * THE source<->archive mapping, in both directions.
 *
 * The mapping is a pure substitution — `otherRoot + relative(root, path)` — which
 * is what makes "the same bytes at a different path" literally true. Because it
 * is symmetric, one root-relative spelling serves both directions: `discover.ts`
 * uses it against `sourceRoot` for the source walk and against `archiveRoot` for
 * the archive walk, so the two keyspaces are identical by construction.
 *
 * Returns `undefined` for a path that is not under the root. Rejecting an
 * absolute or `..`-leading result is what keeps the substitution a pure rename
 * and stops a crafted path from escaping the archive tree.
 */
export function relativeUnder(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return undefined;
  }
  return rel;
}

/** Create a directory (and parents) owned by us alone. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Append one line to an archive-owned file at 0600, creating its directory on
 * demand. The `chmodSync` is defensive: umask can mask `appendFileSync`'s
 * create-mode (same reasoning as `src/shared/token.ts:63-65`).
 */
export function appendOwnedLine(path: string, line: string, dir: string): void {
  ensureDir(dir);
  appendFileSync(path, line, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** `statSync` that reports a vanished/unreadable file as `undefined`. */
export function statSafe(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * `statSafe` in nanosecond resolution. `mtimeMs` is float milliseconds
 * (`1786150022452.6375`), which can round a same-millisecond in-place rewrite
 * away; `mtimeNs` cannot, and `utimesSync` takes seconds/ms floats so it cannot
 * forge one either.
 */
export function statSafeBig(path: string): BigIntStats | undefined {
  try {
    return statSync(path, { bigint: true });
  } catch {
    return undefined;
  }
}
