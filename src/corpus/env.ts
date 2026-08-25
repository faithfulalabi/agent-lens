// The production `ProjectionEnv` — the first one in the repo. Every read a
// projection needs, and nothing else.
//
// EVERY BYTE COMES THROUGH `createArchiveReader`, never a direct `openSync`.
// That is what makes a sealed session project identically to a hot one, and it
// is also why `src/corpus/` adds no row to `fs-write-sites.test.ts`'s open
// manifest: the one reviewed open lives in `archive/read.ts` already.

import { existsSync } from 'node:fs';
import { createArchiveReader, type ArchiveReader } from '../archive/read.js';
import { readSidecars } from '../db/sidecars.js';
import type { ProjectionEnv } from '../db/write.js';
import { DriftCounter } from '../transcript/drift.js';
import { classifyLine, type ParsedLine } from '../transcript/line.js';
import type { ResolveEnv } from '../transcript/spill.js';
import { sessionDirOf } from './paths.js';

/**
 * Split a transcript into classified lines carrying BYTE offsets.
 *
 * ★ `Buffer.byteLength`, EXCLUDING the newline, then `+ 1` for it. This is the
 * only production producer of `events.src_len`, which is `NOT NULL`, and one
 * 4-byte emoji desynchronises every offset after it if the count comes from
 * `String.length`. The arithmetic is `offsetLines`', verbatim, so the offsets a
 * classifier sees in production are the offsets it sees under test.
 *
 * One counter, shared, returned with the lines: `noteLine` and `noteUnknownType`
 * fire here while `noteUnknownBlock` fires inside `runPipeline`, so returning
 * the lines alone would drop two of the three drift buckets.
 */
function readLines(
  reader: ArchiveReader,
  archivePath: string,
): { lines: readonly ParsedLine[]; drift: DriftCounter } {
  const text = reader.read(archivePath, 0, reader.size(archivePath)).toString('utf8');
  const drift = new DriftCounter();
  const lines: ParsedLine[] = [];

  let byteOffset = 0;
  for (const line of text.split('\n')) {
    const byteLength = Buffer.byteLength(line, 'utf8');
    // A line that is not JSON throws, `projectSession` rethrows, and the sweep
    // records the path under `projection_failed`. Loud beats a silent gap in the
    // offsets, which is what skipping it would leave behind.
    if (line !== '') {
      lines.push(classifyLine(JSON.parse(line), { byteOffset, byteLength, drift }));
    }
    byteOffset += byteLength + 1;
  }
  return { lines, drift };
}

/**
 * The three reads `projectSession` needs, over the real archive.
 *
 * `reader` is shared with the sidecar resolver so one sealed frame is
 * decompressed once per pass rather than once per child.
 */
export function createProjectionEnv(reader: ArchiveReader = createArchiveReader()): ProjectionEnv {
  return {
    readLines: (archivePath) => readLines(reader, archivePath),

    spillEnv: (archivePath): ResolveEnv => ({
      // The `.zst` limb is required, not defensive: a spilled tool result that
      // has been sealed exists only under that name, and probing the logical
      // path alone reports every sealed spill missing.
      exists: (path) => existsSync(path) || existsSync(`${path}.zst`),
      sessionRoot: sessionDirOf(archivePath),
    }),

    sidecars: (archivePath, sourcePath, toolUseIds) =>
      readSidecars(archivePath, sourcePath, toolUseIds, reader),
  };
}
