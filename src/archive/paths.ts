// These path helpers are copied from `src/capture/tailer.ts`, not imported:
// that module pulls in the DB layer, and with it `node:sqlite`.
//
// This is also the module that owns every archive write, so the two safety
// primitives every writer needs live here rather than above them:
// `assertUnderArchiveRoot` for the directory chain and `refuseSymlinkedLeaf`
// for the final component. Keeping them here is what makes the archive's module
// graph acyclic — `paths` is the leaf everything else sits on.

import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
  type BigIntStats,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const { O_APPEND, O_CREAT, O_NOFOLLOW, O_WRONLY } = constants;

const ARCHIVE_DIR = 'archive';
const LOGS_DIR = 'logs';

export function resolveDataDir(dir?: string): string {
  return dir ?? process.env.AGENT_LENS_DIR ?? join(homedir(), '.agent-lens');
}

export function resolveTranscriptRoot(root?: string): string {
  return root ?? process.env.AGENT_LENS_TRANSCRIPT_ROOT ?? join(homedir(), '.claude', 'projects');
}

/**
 * Must stay `realpathSync`, not `resolve`: on macOS they differ under
 * `os.tmpdir()`. Falls back to a lexical resolve so a vanished file still keys
 * its archived bytes.
 */
export function canonicalizeTranscriptPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The realpath of the deepest component that exists, with the missing tail
 * re-appended lexically. `canonicalizeTranscriptPath` degrades to a purely
 * lexical `resolve` the moment the path is absent, which is why the containment
 * assert could only ever run AFTER the directory was created. This resolves a
 * path that does not exist yet, so the assert can run first.
 */
export function realpathDeepest(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root without resolving anything: lexical is all
      // there is, and it is what the previous behaviour fell back to anyway.
      if (parent === current) return absolute;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export function resolveArchiveRoot(dataDir?: string): string {
  return join(resolveDataDir(dataDir), ARCHIVE_DIR);
}

export function resolveArchiveLogPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), LOGS_DIR, 'archive.jsonl');
}

export function resolveLockPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), 'archive.lock');
}

/** Pure lexical comparison over two ALREADY-resolved paths. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Containment guard for every archive write. Canonicalizes BOTH sides rather
 * than trusting the caller to have done it, so the rule is stated once: the
 * archive root may itself be a symlink (relocating a "keep everything forever"
 * store onto another volume is a legitimate thing to do), an interior symlink
 * that stays inside the real root is allowed, and one that escapes it is not.
 */
export function assertUnderArchiveRoot(path: string, archiveRoot: string): void {
  const resolved = realpathDeepest(path);
  if (!isUnder(resolved, realpathDeepest(archiveRoot))) {
    throw new Error(`refusing to write outside the archive root: ${resolved}`);
  }
}

/** Root-relative mapping key, or `undefined` when `path` escapes `root`. */
export function relativeUnder(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return undefined;
  }
  return rel;
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * `ensureDir` with the containment assert on both sides of it. The pre-assert is
 * the new half: it refuses a symlinked ancestor that was already planted, before
 * any directory is created through it. The post-assert preserves the refusal the
 * mirror already had.
 *
 * Still check-then-act, and deliberately not claimed otherwise. A link planted
 * BETWEEN the pre-assert and the `mkdirSync` still gets directories created
 * through it and is only stopped at the write by the post-assert. Closing that
 * window needs a directory-fd-relative syscall family — `openat`/`mkdirat` with
 * `O_NOFOLLOW` per component — and Node exposes none: `fs.opendir` yields an
 * iterator, not a resolution base, so every `fs` call re-resolves from a string.
 * It is a permanent limitation of this runtime, not unfinished work.
 */
export function ensureDirUnder(dir: string, archiveRoot: string): void {
  assertUnderArchiveRoot(dir, archiveRoot);
  ensureDir(dir);
  assertUnderArchiveRoot(dir, archiveRoot);
}

/** `lstat`, shaped like `statSafe`. Never follows what it is asked about. */
export function lstatSafe(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Names the kernel's refusal so it survives `String(error)` in `archiveOnce`.
 * Every archive-side open goes through here; anything else is rethrown
 * unchanged, so an unexpected errno degrades to the previous behaviour rather
 * than to silence.
 *
 * Lives beside the containment guard rather than in `mirror.ts` because
 * `paths.ts` is the module every archive write sits on, and the log append below
 * needs it too. Importing it upward from `mirror.ts` would invert the layering
 * and drag `node:zlib` into every consumer; duplicating the errno mapping is the
 * thing this function exists to prevent.
 */
export function refuseSymlinkedLeaf<T>(archivePath: string, open: () => T): T {
  try {
    return open();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ELOOP: O_NOFOLLOW refused a symlinked final component.
    if (code === 'ELOOP') {
      throw new Error(`refusing to follow a symlinked archive destination: ${archivePath} (ELOOP)`);
    }
    // EEXIST is NOT symlink-specific: O_CREAT|O_EXCL returns it for any
    // pre-existing path. We only reach the create branch when `statSafe` saw
    // nothing, so a plain file here means one appeared in that window. The
    // `lstat` runs AFTER the failure and is diagnostic only — the kernel has
    // already decided; this only picks the truthful sentence.
    if (code === 'EEXIST') {
      if (lstatSafe(archivePath)?.isSymbolicLink() === true) {
        throw new Error(
          `refusing to follow a symlinked archive destination: ${archivePath} (EEXIST)`,
        );
      }
      throw new Error(`archive destination already exists: ${archivePath} (EEXIST)`);
    }
    throw error;
  }
}

/**
 * One open, then everything through the fd. `O_NOFOLLOW` makes the kernel refuse
 * a symlinked final component — live or dangling, since `O_CREAT` without
 * `O_EXCL` does not rescue a dangling link from it — and `O_APPEND` lands every
 * write at EOF atomically, which is the append semantics `appendFileSync` gave.
 * The mode change is `fchmodSync` rather than a path-based `chmodSync`: umask
 * can still mask the create-mode, but the fd re-resolves nothing.
 */
export function appendOwnedLine(path: string, line: string, dir: string): void {
  ensureDir(dir);
  const fd = refuseSymlinkedLeaf(path, () =>
    openSync(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600),
  );
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

export function statSafe(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** Nanosecond resolution: float `mtimeMs` can round away a same-millisecond rewrite. */
export function statSafeBig(path: string): BigIntStats | undefined {
  try {
    return statSync(path, { bigint: true });
  } catch {
    return undefined;
  }
}
