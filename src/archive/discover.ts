// Discovery: a UNION of two recursive walks — the source tree and the archive
// tree — keyed on the mapped relative path.
//
// WHY THE ARCHIVE WALK IS NOT OPTIONAL. Discovery keyed only on the source tree
// can never produce `source_state='expired'`: a file whose source is gone is
// never enumerated, so `statSync(sourcePath)` is never called on it and the
// `absent => expired` branch only fires on the same-pass readdir->stat race. A
// file that expires *between* two passes would be silently forgotten forever,
// and task 1.2's seal trigger ("seal only when the source disappears") would
// almost never fire.
//
// WHY THE `.zst` STRIP IS NOT OPTIONAL EITHER. `spec/data-model-v2.md:580-584`
// fixes sealed names as `<id>.jsonl.zst` / `<id>.txt.zst`. Without stripping the
// suffix before keying, a sealed file drops out of the union entirely: the
// durable `expired` trigger stops re-firing for it and — far worse — if the
// source ever reappears (backup restore, reused slug, re-imaged machine) the
// union reads "source yes / archive no" and we write a fresh `<name>.jsonl` from
// byte 0 beside the existing `<name>.jsonl.zst`, double-generating the same
// logical file in the system of record. This module never reads, writes or
// decompresses a `.zst`; it only refuses to be blind to one.
//
// NOT a port of `tailer.ts`'s `scanTranscriptRoot`, which is depth EXACTLY one
// and deliberately skips `subagents/` and `tool-results/` to avoid double-
// *ingesting* sidechain lines. That reasoning is about ingestion and inverts for
// archival: those files expire too, and 25 of them live one level deeper still
// (`<session>/subagents/workflows/wf_*/agent-*.jsonl`), which any fixed-depth
// walk silently misses.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relativeUnder } from './paths.js';

/** Directories under a session that hold expiring sidecars, walked recursively. */
const SESSION_SUBDIRS = ['subagents', 'tool-results'] as const;

/** The four kinds that expire. `<slug>/memory/*.md` and `sessions-index.json` are not among them. */
const ALLOWED_SUFFIXES = ['.jsonl', '.meta.json', '.txt'] as const;

/** The sealed-file suffix owned by task 1.2. Stripped before keying, never read. */
const SEALED_SUFFIX = '.zst';

/** One logical file, as seen by either walk or both. */
export interface DiscoveredEntry {
  /** The key: the path relative to whichever root, identical on both sides. */
  relPath: string;
  sourcePath: string;
  /** The LOGICAL archive path. When `sealed`, the file on disk is this + `.zst`. */
  archivePath: string;
  presence: 'both' | 'source-only' | 'archive-only';
  sealed: boolean;
}

/** Directory entries of one kind, or `[]` when the directory is unreadable. */
function readDirSafe(dir: string, wantDirs: boolean): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (wantDirs ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** True when the (already `.zst`-stripped) name is one of the four kinds. */
function isAllowed(name: string): boolean {
  return ALLOWED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Every allowlisted file under `dir`, at any depth, as absolute paths. */
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

/** `agent-x.jsonl.zst` -> `{ name: 'agent-x.jsonl', sealed: true }`. */
function stripSealedSuffix(name: string): { name: string; sealed: boolean } {
  return name.endsWith(SEALED_SUFFIX)
    ? { name: name.slice(0, -SEALED_SUFFIX.length), sealed: true }
    : { name, sealed: false };
}

/**
 * Every in-scope file under one root:
 *   `<slug>/<session>.jsonl`                 (depth exactly one)
 *   `<slug>/<session>/subagents/**`          (recursive)
 *   `<slug>/<session>/tool-results/**`       (recursive)
 * Never throws — an unreadable project must not stop the other eleven from being
 * protected.
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

/**
 * The union of both walks, keyed on the mapped relative path and sorted for a
 * deterministic pass order.
 */
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
      // Sticky: if BOTH `<name>.jsonl` and `<name>.jsonl.zst` somehow exist, the
      // readdir order must not decide which one we believe. Treating the pair as
      // sealed is the non-destructive reading — `mirror.ts` then appends to
      // neither, and the anomaly surfaces instead of being extended.
      existing.sealed ||= sealed;
    }
  }

  return [...entries.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
}
