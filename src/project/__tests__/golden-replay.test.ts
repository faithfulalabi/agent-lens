// The golden-replay harness, ported in FORM from plan 001's
// `capture/__tests__/golden-replay.test.ts`: replay a fixed corpus, snapshot the
// result, and FAIL rather than write when a snapshot is missing.
//
// The corpus is real, scrubbed `.jsonl` — `fixtures/scrubbed/*/transcripts/` —
// instead of hook envelopes. That is the whole substance of the change: v2
// projects transcripts, so the certification corpus has to be transcripts.
//
// ★ NO `AGENT_LENS_UPDATE_SNAPSHOTS` AND NO UPDATE SCRIPT, deliberately. Plan
// 001's `npm run snapshots:update` set that variable, which made its
// `snapshotReviewed()` return `true` unconditionally and PERMANENTLY disarmed
// the anti-skip gate for anyone who ran it once; `projector-version.test.ts:6-10`
// cites it as the cautionary tale for why it has no escape hatch of its own.
//
// Regenerating one is: delete the file, run the suite. The run WRITES the
// snapshot and still FAILS, on the presence sample taken before any test ran —
// so the artifact is on disk to review while the suite stays red until it is
// committed. Writing and passing is the thing that cannot happen; writing and
// failing is how a diff gets reviewed without a command that skips the review.
//
// ★ THE FIXTURE SET IS PINNED BY SET EQUALITY, not merely discovered. The
// per-fixture gate below guards each snapshot; it cannot guard fixture-set
// COMPLETENESS. That job belonged to `capture/__tests__/golden-fixtures.test.ts`,
// the "all four scrubbed sets or none" ledger, which this cutover deletes — and
// without a replacement a `describe.each` over a silently shrunk corpus passes
// green over nothing.
//
// Spills resolve `missing` here on every machine, deterministically rather than
// accidentally: the declared paths name `/home/USER/…`, and
// `fixtures/scrubbed/*/tool-results/` is gitignored (up to 10 MB per file), so
// those bytes are absent from a clean clone by design. Spill RESOLUTION is
// covered by `transcript/__tests__/spill.test.ts` and `db/__tests__/write.test.ts`.

import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectionEnv } from '../../corpus/env.js';
import { foldArchive } from '../../db/freshness.js';
import { projectSession } from '../../db/write.js';
import { openCache, seedIndexRow } from '../../db/__tests__/fixtures/index.js';
import { projectionSnapshot } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `<repo>/fixtures/scrubbed`, resolved the way `PROJECT_FIXTURE_DIR` is. */
const CORPUS_ROOT = join(HERE, '..', '..', '..', 'fixtures', 'scrubbed');

const SNAPSHOT_ROOT = join(HERE, '__snapshots__', 'golden');

/** The parent transcript every capture set stores under `transcripts/`. */
const PARENT = 'parent.jsonl';

/** Task 1.7's four signed-off capture sets. A SET, never a lower bound. */
const EXPECTED_IDS = ['compaction', 'large-output', 'multi-turn', 'subagent'];

function discover(): string[] {
  if (!existsSync(CORPUS_ROOT)) return [];
  return readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(CORPUS_ROOT, entry.name, 'transcripts', PARENT)),
    )
    .map((entry) => entry.name)
    .sort();
}

const fixtures = discover();

function snapshotPathFor(id: string): string {
  return join(SNAPSHOT_ROOT, `${id}.json`);
}

/**
 * Snapshot presence sampled ONCE, before any test runs.
 *
 * Load-bearing: vitest silently WRITES a missing file snapshot and passes, so a
 * later `existsSync` would observe the file this very run created and the guard
 * would be vacuous. There is no CI in this repo, so this is the only thing
 * standing between a deleted snapshot and a green suite.
 */
const snapshotPresentAtStart = new Map(fixtures.map((id) => [id, existsSync(snapshotPathFor(id))]));

/**
 * Project one capture set through the production env and serialize the result.
 *
 * The set is copied into the ARCHIVE MIRROR's layout first — `<stem>.jsonl`
 * beside `<stem>/subagents/` — because that is the shape `foldArchive` folds and
 * `readSidecars` walks. A capture set stores the same tree as
 * `transcripts/parent.jsonl` beside `transcripts/subagents/`, so without the copy
 * the sidecar join finds nothing and the sub-agent half of the corpus is never
 * exercised.
 */
function replay(id: string): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-lens-golden-'));
  try {
    cpSync(join(CORPUS_ROOT, id, 'transcripts'), join(root, id), { recursive: true });
    const archivePath = join(root, `${id}.jsonl`);
    renameSync(join(root, id, PARENT), archivePath);

    const db = openCache();
    try {
      seedIndexRow(db, archivePath, { id });
      const fold = foldArchive(archivePath);
      if (fold === undefined) throw new Error(`no bytes to fold at ${archivePath}`);
      projectSession(db, id, createProjectionEnv(), fold);
      return projectionSnapshot(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the corpus itself is pinned, not merely discovered', () => {
  it('holds exactly the four signed-off capture sets', () => {
    expect(
      fixtures,
      'the scrubbed capture sets changed. Adding one is a deliberate act: extend ' +
        'EXPECTED_IDS and commit its reviewed snapshot. Losing one silently is what ' +
        'this assertion exists to stop.',
    ).toEqual(EXPECTED_IDS);
  });
});

describe.each(fixtures)('golden replay — %s', (id) => {
  it('matches its committed projection snapshot', async () => {
    await expect(replay(id)).toMatchFileSnapshot(snapshotPathFor(id));
    // AFTER the comparison, and read off the sample taken at module load, so it
    // reports what was COMMITTED rather than the file the line above may have
    // just written. This is the anti-skip gate: a fixture with no reviewed
    // snapshot fails here, having left the artifact on disk to be reviewed.
    expect(
      snapshotPresentAtStart.get(id),
      `no committed snapshot for ${id} — ${snapshotPathFor(id)} was just written; ` +
        'review the diff and commit it',
    ).toBe(true);
  });
});

describe('the harness leaks no wall clock', () => {
  it('two replays milliseconds apart are byte-identical', () => {
    const before = replay('multi-turn');
    // Burn until the wall clock's ISO string advances, so this is a real claim
    // rather than a fast-machine artifact.
    const mark = new Date().toISOString();
    while (new Date().toISOString() === mark) {
      /* spin */
    }
    expect(replay('multi-turn')).toBe(before);
  });

  it('and the projection is not empty, so that claim is about something', () => {
    // Non-vacuity: two empty snapshots are byte-identical too.
    const snapshot = JSON.parse(replay('subagent')) as {
      sessions: unknown[];
      turns: unknown[];
      events: unknown[];
    };
    expect(snapshot.turns.length).toBeGreaterThan(0);
    expect(snapshot.events.length).toBeGreaterThan(0);
    // The sidecar rows the mirrored layout is what makes reachable.
    expect(snapshot.sessions.length).toBeGreaterThan(1);
  });
});
