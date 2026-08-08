// A union of two recursive walks, source and archive, keyed on the mapped
// relative path. Both walks are needed: keyed on the source alone, a file whose
// source is already gone is never enumerated, making `expired` unreachable. The
// `.zst` strip is needed too, or a sealed file drops out of the union and a
// reappearing source is written fresh from byte 0 beside its sealed copy.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relativeUnder } from './paths.js';

const SESSION_SUBDIRS = ['subagents', 'tool-results'] as const;

/** The kinds that expire — `<slug>/memory/*.md` and `sessions-index.json` do not. */
const ALLOWED_SUFFIXES = ['.jsonl', '.meta.json', '.txt'] as const;

const SEALED_SUFFIX = '.zst';

/** One logical file, as seen by either walk or both. */
export interface DiscoveredEntry {
  /** The key: relative to whichever root, identical on both sides. */
  relPath: string;
  sourcePath: string;
  /** Logical: when `sealed`, the file on disk is this + `.zst`. */
  archivePath: string;
  presence: 'both' | 'source-only' | 'archive-only';
  sealed: boolean;
}

function readDirSafe(dir: string, wantDirs: boolean): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (wantDirs ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Expects an already `.zst`-stripped name. */
function isAllowed(name: string): boolean {
  return ALLOWED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function walkRecursive(dir: string, stripSealed: boolean, out: string[]): void {
  for (const name of readDirSafe(dir, false)) {
    if (isAllowed(stripSealed ? stripSealedSuffix(name).name : name)) {
      out.push(join(dir, name));
    }
  }
  for (const child of readDirSafe(dir, true)) {
    walkRecursive(join(dir, child), stripSealed, out);
  }
}

function stripSealedSuffix(name: string): { name: string; sealed: boolean } {
  return name.endsWith(SEALED_SUFFIX)
    ? { name: name.slice(0, -SEALED_SUFFIX.length), sealed: true }
    : { name, sealed: false };
}

/**
 * Never throws. `<slug>/<session>.jsonl` at depth one, plus the sidecar dirs to
 * arbitrary depth — some transcripts nest under `subagents/workflows/`.
 */
function walkRoot(root: string, stripSealed: boolean): string[] {
  const found: string[] = [];
  for (const slug of readDirSafe(root, true)) {
    const slugDir = join(root, slug);
    for (const name of readDirSafe(slugDir, false)) {
      const stem = stripSealed ? stripSealedSuffix(name).name : name;
      if (stem.endsWith('.jsonl')) found.push(join(slugDir, name));
    }
    for (const session of readDirSafe(slugDir, true)) {
      for (const sub of SESSION_SUBDIRS) {
        walkRecursive(join(slugDir, session, sub), stripSealed, found);
      }
    }
  }
  return found;
}

/** Sorted, for a deterministic pass order. */
export function discover(sourceRoot: string, archiveRoot: string): DiscoveredEntry[] {
  const entries = new Map<string, DiscoveredEntry>();

  for (const sourcePath of walkRoot(sourceRoot, false)) {
    const relPath = relativeUnder(sourceRoot, sourcePath);
    if (relPath === undefined) continue;
    entries.set(relPath, {
      relPath,
      sourcePath,
      archivePath: join(archiveRoot, relPath),
      presence: 'source-only',
      sealed: false,
    });
  }

  for (const found of walkRoot(archiveRoot, true)) {
    const { sealed } = stripSealedSuffix(found);
    // Key on the LOGICAL name so a sealed file stays in the union.
    const archivePath = sealed ? found.slice(0, -SEALED_SUFFIX.length) : found;
    const relPath = relativeUnder(archiveRoot, archivePath);
    if (relPath === undefined) continue;
    const sourcePath = join(sourceRoot, relPath);
    const existing = entries.get(relPath);
    if (existing === undefined) {
      entries.set(relPath, {
        relPath,
        sourcePath,
        archivePath,
        presence: 'archive-only',
        sealed,
      });
    } else {
      existing.presence = 'both';
      // Sticky, so readdir order cannot pick between a plain/sealed pair.
      existing.sealed ||= sealed;
    }
  }

  return [...entries.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
}
