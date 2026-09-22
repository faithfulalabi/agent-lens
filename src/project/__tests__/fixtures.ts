// Fixture loading for the Task 3.1 suites. Only the directory binding and the
// read are new: `FIXTURE_DIR` in `src/transcript/__tests__/fixtures.ts` is
// hard-bound to that tree, so `classifyFixture` can never reach this one. The
// generic halves — `classifyText`, `archiveJsonlFiles`, `ctx` — are IMPORTED, not
// copied, and a cross-tree import from `__tests__/` is safe on both standing
// guards: the one-door scan filters `__tests__/` before it looks, and the
// projector hash excludes it from the digest.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { contentBlocks } from '../../transcript/blocks.js';
import type { DriftCounter } from '../../transcript/drift.js';
import type { ParsedLine } from '../../transcript/line.js';
import { classifyText } from '../../transcript/__tests__/fixtures.js';
import { runPipeline, type ProjectedEvent, type Projection } from '../pipeline.js';

export const PROJECT_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Raw bytes, so a test can slice `[src_offset, src_offset + src_len)` itself. */
export function projectFixtureBytes(name: string): Buffer {
  return readFileSync(join(PROJECT_FIXTURE_DIR, name));
}

/** Every line of a fixture, classified, sharing one `DriftCounter`. */
export function classifyProjectFixture(name: string): ReturnType<typeof classifyText> {
  return classifyText(projectFixtureBytes(name).toString('utf8'));
}

export const SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** One fixture, classified and projected through one counter, as production does. */
export function project(
  name: string,
  session = SESSION,
): Projection & { lines: ParsedLine[]; drifter: DriftCounter } {
  const { lines, drift } = classifyProjectFixture(name);
  return { ...runPipeline(lines, { session_id: session, drift }), lines, drifter: drift };
}

/** The one row a test is about, by the id the fixture gave its `tool_use`. */
export function callAt(result: Projection, id: string): ProjectedEvent {
  const event = result.events.find((candidate) => candidate.id === id);
  if (event === undefined) throw new Error(`no tool call ${id}`);
  return event;
}

/** `units - toolResultUnits + blocklessUuidLines` — the whole accounting rule. */
export function census(lines: readonly ParsedLine[]): {
  units: number;
  toolResults: number;
  blockless: number;
} {
  let units = 0;
  let toolResults = 0;
  let blockless = 0;
  for (const line of lines) {
    if (line.uuid === undefined) continue;
    const blocks = contentBlocks(line);
    units += blocks.length;
    toolResults += blocks.filter((block) => block.kind === 'tool_result').length;
    if (blocks.length === 0) blockless += 1;
  }
  return { units, toolResults, blockless };
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
