// These path helpers are copied from `src/capture/tailer.ts`, not imported:
// that module pulls in the DB layer, and with it `node:sqlite`.

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

export function resolveArchiveRoot(dataDir?: string): string {
  return join(resolveDataDir(dataDir), ARCHIVE_DIR);
}

export function resolveArchiveLogPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), LOGS_DIR, 'archive.jsonl');
}

export function resolveLockPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), 'archive.lock');
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Containment guard for every archive write. */
export function assertUnderArchiveRoot(path: string, archiveRoot: string): void {
  if (!isUnder(path, archiveRoot)) {
    throw new Error(`refusing to write outside the archive root: ${path}`);
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

/** The `chmodSync` is not redundant: umask can mask `appendFileSync`'s create-mode. */
export function appendOwnedLine(path: string, line: string, dir: string): void {
  ensureDir(dir);
  appendFileSync(path, line, { mode: 0o600 });
  chmodSync(path, 0o600);
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
