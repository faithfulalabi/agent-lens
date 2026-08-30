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
import type { DatabaseSync } from 'node:sqlite';
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

/**
 * Columns whose value comes from the checkout rather than from the transcript:
 * absolute paths, the filesystem clock, and the projector stamp
 * `projector-version.test.ts` already owns. Including any of them would make a
 * committed snapshot machine-specific and therefore un-reviewable.
 */
const VOLATILE_COLUMNS = new Set([
  'source_path',
  'archive_path',
  'file_mtime_ms',
  'projected_mtime_ms',
  'projected_at',
  'projector_version',
]);

type Row = Record<string, unknown>;

function rows(db: DatabaseSync, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

/**
 * The whole projection as canonical, line-diffable JSON — the successor to plan
 * 001's `capture/__tests__/golden.ts:projectionSnapshot`, over the three v2
 * tables. Every table is ordered by a stable key, never by rowid.
 */
export function projectionSnapshot(db: DatabaseSync): string {
  const strip = (row: Row): Row =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !VOLATILE_COLUMNS.has(key)));
  const snapshot = {
    sessions: rows(db, 'SELECT * FROM sessions ORDER BY id').map(strip),
    turns: rows(db, 'SELECT * FROM turns ORDER BY session_id, seq'),
    events: rows(db, 'SELECT * FROM events ORDER BY session_id, seq'),
  };
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
