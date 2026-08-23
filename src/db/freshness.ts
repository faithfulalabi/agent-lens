// The Tier-B freshness gate. Every read of a projected session passes through
// `ensureProjected`, which is what makes whole-file reprojection affordable and
// therefore what makes a live tail byte-identical to the cold path.
//
// THE KEY FOLDS THE WHOLE SESSION DIRECTORY, never the parent transcript alone.
// Measured live: a parent went 2,240 s with no write while 10 of its sidecars
// grew by 3.24 MB, and 11 of 16 sessions that own sidecars show over 600 s of
// the same silence. A parent-only stat answers "fresh" for all of it, so every
// sub-agent row on screen freezes for as long as the parent stays quiet.
//
// IT FOLDS THE ARCHIVE, never `~/.claude/projects`. The archive is what the
// projector reads, so a fingerprint taken from the source describes a file
// nobody projected — and it stops existing entirely once Claude Code expires
// the original, measured at 41 days.

import type { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { statSafe } from '../archive/paths.js';
import { PROJECTOR_VERSION } from '../transcript/version.js';
import { SCHEMA_VERSION } from './schema.js';
import { projectSession, type ProjectionEnv } from './write.js';

/** One session tree, folded. The three parts of the live-tail epoch string. */
export interface ArchiveFold {
  mtime_ms: number;
  size: number;
  /**
   * `.jsonl` transcripts under the session directory — what the data model's
   * epoch string counts, not every file in the tree. The other kinds
   * (`agent-*.meta.json`, `tool-results/*.txt`) still move `mtime_ms` and
   * `size`, so they still invalidate; they are simply not this number.
   */
  sidecar_count: number;
}

const TRANSCRIPT_EXT = '.jsonl';

/**
 * Fold `max(child mtime)` and `sum(child size)` over a transcript and every file
 * below its sibling directory. `undefined` when the transcript itself is gone.
 */
export function foldArchive(archivePath: string): ArchiveFold | undefined {
  const parent = statSafe(archivePath);
  if (parent === undefined) return undefined;

  const fold: ArchiveFold = {
    mtime_ms: Math.floor(parent.mtimeMs),
    size: parent.size,
    sidecar_count: 0,
  };
  // The sibling directory IS this path with its extension removed, so no path
  // math happens here and nothing else is ever derived from `archive_path`. A
  // sidecar's own path has no such directory, so the walk finds nothing and the
  // fold degrades to a plain stat — one code path, no parent/sidecar branch.
  if (archivePath.endsWith(TRANSCRIPT_EXT)) {
    walk(archivePath.slice(0, -TRANSCRIPT_EXT.length), fold);
  }
  return fold;
}

/** One `readdir` per directory, one `stat` per file, no path read twice. */
function walk(dir: string, fold: ArchiveFold): void {
  // ponytail: CEILING — this walks the tree on every cache hit, so a session
  // that accumulates thousands of sidecars degrades the hit path linearly. The
  // corpus maximum today is 98 children at 0.299 ms median. Upgrade path: stat
  // the directory itself first and skip the walk while its own mtime has not
  // moved. Correct on APFS and ext4, not portable to every filesystem, which is
  // why it is not what ships.
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, fold);
      continue;
    }
    if (!entry.isFile()) continue;

    const stat = statSafe(path);
    if (stat === undefined) continue;
    fold.mtime_ms = Math.max(fold.mtime_ms, Math.floor(stat.mtimeMs));
    fold.size += stat.size;
    if (entry.name.endsWith(TRANSCRIPT_EXT)) fold.sidecar_count += 1;
  }
}

/**
 * The live-tail epoch, `'<mtime_ms>:<size>:<sidecar_count>'`. Its third part is
 * the child count; the DB gate's third part is `projector_version`. Two
 * different triples, deliberately.
 */
export function fingerprint(fold: ArchiveFold): string {
  return `${fold.mtime_ms}:${fold.size}:${fold.sidecar_count}`;
}

/**
 * Seed the two version keys the health and drift reports read. They are a
 * REPORT, never a gate: the gate is the per-row `projector_version` stamp.
 */
export function seedMeta(db: DatabaseSync): void {
  const write = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  write.run('schema_version', String(SCHEMA_VERSION));
  write.run('projector_version', String(PROJECTOR_VERSION));
}

/** What the gate did. `unindexed` means the corpus sweep has not seen the file. */
export type ProjectionOutcome = 'hit' | 'projected' | 'unindexed' | 'failed';

interface GateRow {
  archive_path: string;
  projected_mtime_ms: number | null;
  projected_size: number | null;
  projector_version: number | null;
}

const GATE_SQL = `SELECT archive_path, projected_mtime_ms, projected_size, projector_version
  FROM sessions WHERE id = ?`;

/**
 * The gate every read passes. A hit reprojects nothing; any one of the three
 * stamped parts differing reprojects the whole file.
 */
export function ensureProjected(
  db: DatabaseSync,
  id: string,
  env: ProjectionEnv,
): ProjectionOutcome {
  const row = db.prepare(GATE_SQL).get(id) as GateRow | undefined;
  if (row === undefined) {
    // Creating the Tier-A row belongs to the corpus sweep. Nothing here
    // fabricates a session out of a stat.
    seedMeta(db);
    return 'unindexed';
  }

  const fold = foldArchive(row.archive_path);
  if (fold === undefined) return 'failed';

  // ALL THREE, never two of three: a two-part comparison is how a projection
  // outlives the projector that produced it.
  if (
    row.projected_mtime_ms === fold.mtime_ms &&
    row.projected_size === fold.size &&
    row.projector_version === PROJECTOR_VERSION
  ) {
    return 'hit';
  }

  seedMeta(db);
  try {
    projectSession(db, id, env, fold);
  } catch {
    // The rethrow is `projectSession`'s contract for a direct caller. A read
    // must not die because one session is unprojectable.
    return 'failed';
  }
  return 'projected';
}
