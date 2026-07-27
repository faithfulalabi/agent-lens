// Task 2.6a — AC1 (golden replay) + AC3 (a single, reviewable snapshot-update
// path). Every fixture discovered under `src/capture/__tests__/fixtures/golden/`
// (2.6a's hand-authored seeds) or `fixtures/scrubbed/` (Task 1.7's captures) is
// replayed through the real ingest funnel and compared against a committed
// projection snapshot.
//
// ## Updating snapshots
//
//     npm run snapshots:update
//
// That is the ONLY supported way to regenerate them. It rewrites the files in
// `__snapshots__/golden/`, so an intentional schema change lands as a reviewable
// line diff in the PR. Never hand-edit a snapshot.
//
// ## Timestamp policy (AC1's "modulo timestamps")
//
// Nothing is masked. Every `sessions`/`traces`/`spans` timestamp is the frozen
// `envelope.ts` from the fixture file and is asserted verbatim; the only
// wall-clock and arrival-order values in the pipeline (`raw_events.received_at`,
// `spans_lite.seq`) are excluded by column, and `payloads.content` is excluded
// because `payloads.id` is its sha256. `projectionSnapshot`'s docstring carries
// the full rationale, and "the serializer leaks no wall clock" is itself
// asserted below rather than left as prose.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, getFileInfo, resolveConfig } from 'prettier';
import { freshDb } from './fixtures.js';
import {
  discoverGoldenFixtures,
  ingestFixture,
  loadFixtureEnvelopes,
  projectionSnapshot,
  repoRoot,
  snapshotPathFor,
  type GoldenFixture,
} from './golden.js';

const fixtures = discoverGoldenFixtures();

/**
 * Snapshot presence sampled ONCE, before any test runs.
 *
 * Load-bearing: outside CI vitest silently WRITES a missing file snapshot and
 * passes, so a later `existsSync` would observe the file this very run created
 * and the guard would be vacuous. There is no CI in this repo (`.github/` does
 * not exist), so this in-file guard is the only thing standing between a deleted
 * snapshot and a green suite.
 */
const snapshotPresentAtStart = new Map(fixtures.map((f) => [f.id, existsSync(snapshotPathFor(f))]));

/** Set only by `npm run snapshots:update`. */
const UPDATING = process.env.AGENT_LENS_UPDATE_SNAPSHOTS === '1';

/**
 * Has this fixture's snapshot been committed and therefore reviewed?
 *
 * Always true while `npm run snapshots:update` is running: writing a snapshot for
 * a brand-new fixture is exactly that command's job, and failing the run it was
 * asked to perform would just mean typing it twice. Every other invocation —
 * `npm test`, a bare `vitest` — enforces it.
 */
function snapshotReviewed(id: string): boolean {
  return UPDATING || snapshotPresentAtStart.get(id) === true;
}

/** Replay one fixture through the production funnel and serialize the result. */
function replay(fixture: GoldenFixture): string {
  const envelopes = loadFixtureEnvelopes(fixture.dir);
  const db = freshDb();
  try {
    ingestFixture(db, envelopes);
    return projectionSnapshot(db, {
      fixture: fixture.id,
      envelopeCount: envelopes.length,
    });
  } finally {
    db.close();
  }
}

describe.each(fixtures)('golden replay — $id (AC1)', (fixture) => {
  it('matches its committed projection snapshot', async () => {
    expect(
      snapshotReviewed(fixture.id),
      `no committed snapshot for ${fixture.id} — run \`npm run snapshots:update\` and review the diff`,
    ).toBe(true);
    await expect(replay(fixture)).toMatchFileSnapshot(snapshotPathFor(fixture));
  });
});

describe('manifest guard (AC1 — anti-silent-skip)', () => {
  // Complements `golden-fixtures.test.ts`, which owns the "all four scrubbed sets
  // or none" ledger and prints the PENDING CAPTURE banner. This guard owns the
  // other half: whatever fixture directories exist must each have a reviewed,
  // committed snapshot. When Task 1.7 adds fixtures/scrubbed/{multi-turn,
  // large-output,subagent,compaction}/ this test goes RED — deliberately not
  // `it.skipIf`, because an acceptance criterion that skips itself is worse than
  // no test at all.
  it('discovers a non-empty seed set', () => {
    expect(fixtures.filter((f) => f.origin === 'seed').map((f) => f.name)).toEqual([
      'drift',
      'multi-turn',
      'orphan-resume',
      'tool-error-denied',
    ]);
  });

  it('has a committed snapshot for every discovered fixture', () => {
    const missing = fixtures.filter((f) => !snapshotReviewed(f.id)).map((f) => f.id);
    expect(
      missing,
      'new fixture directories have no reviewed snapshot — run `npm run snapshots:update`',
    ).toEqual([]);
  });

  it('gives each fixture a distinct snapshot path across both roots', () => {
    // `multi-turn` exists under BOTH roots once Task 1.7 lands, so the id (and
    // therefore the snapshot filename) is origin-prefixed. Without that, the
    // captured fixture would silently overwrite the seed's snapshot.
    const paths = fixtures.map(snapshotPathFor);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('timestamp policy is asserted, not just documented (AC1)', () => {
  const fixture = fixtures.find((f) => f.id === 'seed/multi-turn')!;

  it('two replays milliseconds apart produce byte-identical snapshots', () => {
    const before = replay(fixture);
    // Burn until the wall clock's ISO string actually advances, so "no wall clock
    // leaked into the serializer" is a real claim and not a fast-machine artifact.
    const mark = new Date().toISOString();
    while (new Date().toISOString() === mark) {
      /* spin */
    }
    expect(replay(fixture)).toBe(before);
  });

  it('but raw_events.received_at genuinely differs — the exclusion is load-bearing', () => {
    // The negative arm. If `received_at` were included, the test above could not
    // pass; if it were secretly constant, excluding it would be decoration.
    const envelopes = loadFixtureEnvelopes(fixture.dir);
    const receivedAt = (): string => {
      const db = freshDb();
      try {
        ingestFixture(db, envelopes);
        return (db.prepare('SELECT MIN(received_at) AS t FROM raw_events').get() as { t: string })
          .t;
      } finally {
        db.close();
      }
    };
    const first = receivedAt();
    while (new Date().toISOString() === first) {
      /* spin */
    }
    expect(receivedAt()).not.toBe(first);
  });
});

describe('the update path produces a reviewable diff (AC3)', () => {
  const fixture = fixtures.find((f) => f.id === 'seed/drift')!;

  it('a one-envelope change moves a handful of lines, not the whole file', () => {
    const envelopes = loadFixtureEnvelopes(fixture.dir);
    const baseline = replay(fixture).split('\n');

    // Hand-edit one envelope. This is NOT simulating a normalizer change (the
    // envelope's `event_id` is left alone, so it still names the old hook) — it is
    // the cheapest way to perturb the projection by a known small amount. What is
    // under test is the ARTIFACT: does a small delta produce a small, readable diff?
    const mutated = envelopes.map((env) =>
      env.hook_name === 'AnotherUnknownHook' ? { ...env, hook_name: 'AThirdUnknownHook_v2' } : env,
    );
    const db = freshDb();
    let after: string[];
    try {
      ingestFixture(db, mutated);
      after = projectionSnapshot(db, {
        fixture: fixture.id,
        envelopeCount: mutated.length,
      }).split('\n');
    } finally {
      db.close();
    }

    // Pretty-printed, so the artifact is line-diffable at all.
    expect(baseline.length).toBeGreaterThan(50);
    const changed = countChangedLines(baseline, after);
    expect(changed).toBeGreaterThan(0);
    // A localized edit stays localized: a minified blob would score 100%.
    expect(changed / baseline.length).toBeLessThan(0.15);
    expect(after.join('\n')).toContain('AThirdUnknownHook_v2');
  });

  it('`npm run snapshots:update` is wired to this file', () => {
    // AC3 is "a single command". The script's target must not drift away from the
    // test that owns the snapshots; the rest of AC3 (README prose) is a reviewer
    // checklist item, not a test.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['snapshots:update']).toContain('golden-replay.test.ts');
  });
});

describe('.prettierignore protects the committed snapshots (AC1/AC3)', () => {
  const committed = fixtures
    .filter((f) => snapshotPresentAtStart.get(f.id) === true)
    .map(snapshotPathFor);

  it('excludes every committed snapshot from `npm run format`', async () => {
    const formatted: string[] = [];
    for (const path of committed) {
      const info = await getFileInfo(path, {
        ignorePath: join(repoRoot, '.prettierignore'),
        resolveConfig: true,
      });
      if (info.ignored !== true) formatted.push(path);
    }
    expect(formatted).toEqual([]);
  });

  it('and that exclusion is load-bearing — Prettier rewrites at least one', async () => {
    // Without this arm the ignore entry could quietly become decorative. The
    // concrete case is a one-element `tags` array, which Prettier's JSON printer
    // collapses onto a single line; since `toMatchFileSnapshot` compares raw
    // content, that alone reds the suite. Asserted over the set rather than one
    // named file, so editing a fixture cannot make the check vacuous by accident.
    const rewritten: string[] = [];
    for (const path of committed) {
      const raw = readFileSync(path, 'utf8');
      const options = await resolveConfig(path);
      if ((await format(raw, { ...options, filepath: path })) !== raw) rewritten.push(path);
    }
    expect(rewritten.length).toBeGreaterThan(0);
  });
});

/** Number of positions where two line arrays differ (length delta included). */
function countChangedLines(a: string[], b: string[]): number {
  let changed = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) changed += 1;
  }
  return changed;
}
