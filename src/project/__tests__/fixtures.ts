// Fixture loading for the Task 3.1 suites. Only the directory binding and the
// read are new: `FIXTURE_DIR` in `src/transcript/__tests__/fixtures.ts` is
// hard-bound to that tree, so `classifyFixture` can never reach this one. The
// generic halves — `offsetLines`, `archiveJsonlFiles`, `ctx` — are IMPORTED, not
// copied, and a cross-tree import from `__tests__/` is safe on both standing
// guards: the one-door scan filters `__tests__/` before it looks, and the
// projector hash excludes it from the digest.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DriftCounter } from '../../transcript/drift.js';
import { classifyLine, type ParsedLine } from '../../transcript/line.js';
import { offsetLines, type OffsetLine } from '../../transcript/__tests__/fixtures.js';

export const PROJECT_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Raw bytes, so a test can slice `[src_offset, src_offset + src_len)` itself. */
export function projectFixtureBytes(name: string): Buffer {
  return readFileSync(join(PROJECT_FIXTURE_DIR, name));
}

/** Every line of a fixture, classified, sharing one `DriftCounter`. */
export function classifyProjectFixture(name: string): {
  lines: ParsedLine[];
  drift: DriftCounter;
  offsets: OffsetLine[];
} {
  const drift = new DriftCounter();
  const offsets = offsetLines(projectFixtureBytes(name).toString('utf8'));
  const lines = offsets.map((entry) =>
    classifyLine(JSON.parse(entry.text), {
      byteOffset: entry.byteOffset,
      byteLength: entry.byteLength,
      drift,
    }),
  );
  return { lines, drift, offsets };
}
