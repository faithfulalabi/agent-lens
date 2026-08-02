// The certification harness (Task 2.6a): one canonical serialization of "the
// projection", one fixture loader, one ingest driver. Test-only in intent — but
// `tsconfig.node.json` includes all of `src` with no `__tests__` exclude, so this
// file IS compiled into `dist`. It must stay build-clean and dependency-light.
//
// Everything here exists so that four different assertions can compare
// projections without each re-deriving what a projection is:
//   - golden replay        (golden-replay.test.ts)  — fixture vs. committed file
//   - kill-collector e2e   (kill-collector.test.ts) — killed run vs. control run
//   - idempotency          (idempotency.property.test.ts) — replay/resume/mix
//   - Phase 3 / Task 4.3, which inherit the same definition.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../../shared/index.js';
import type { Envelope } from '../../shared/index.js';
import { ingestHealth } from '../../db/index.js';
import { BATCH_SIZE, ingestBatch, isValidEnvelopeShape } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';

/**
 * Repo root, resolved from this file (`<root>/src/capture/__tests__/golden.ts`).
 * Source-relative on purpose: the compiled copy under `dist/` resolves to `dist`
 * and finds no fixtures, which is correct — nothing is meant to run it from there.
 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where the four hand-authored 2.6a seed fixtures live. */
const SEED_ROOT = join(repoRoot, 'src', 'capture', '__tests__', 'fixtures', 'golden');

/** Where Task 1.7's captured-and-scrubbed fixture sets land. */
const SCRUBBED_ROOT = join(repoRoot, 'fixtures', 'scrubbed');

/** Directory holding the committed projection snapshots. */
export const SNAPSHOT_ROOT = join(
  repoRoot,
  'src',
  'capture',
  '__tests__',
  '__snapshots__',
  'golden',
);

/** The file every fixture directory must contain: one Envelope JSON per line. */
const ENVELOPES_FILE = 'envelopes.jsonl';

// --- Fixture discovery -----------------------------------------------------

/** Where a fixture came from. Part of its id, so the two roots cannot collide. */
export type FixtureOrigin = 'seed' | 'scrubbed';

/** One discovered golden fixture directory. */
export interface GoldenFixture {
  /** `seed` (hand-authored, 2.6a) or `scrubbed` (captured, Task 1.7). */
  origin: FixtureOrigin;
  /** Directory name, e.g. `multi-turn`. */
  name: string;
  /** `${origin}/${name}` — unique across roots (both roots define `multi-turn`). */
  id: string;
  /** Absolute path to the fixture directory. */
  dir: string;
}

/**
 * Every fixture directory under either root, sorted by id.
 *
 * Both roots are scanned deliberately: the seed set proves the harness works
 * today, and `fixtures/scrubbed/*` is picked up automatically the moment Task
 * 1.7's capture sessions land — at which point the manifest guard in
 * `golden-replay.test.ts` goes RED until someone reviews the generated
 * snapshots. That is the anti-silent-skip contract; see also
 * `golden-fixtures.test.ts`, which owns the complementary "all four sets or
 * none" ledger over the same directory.
 */
export function discoverGoldenFixtures(): GoldenFixture[] {
  const found: GoldenFixture[] = [
    ...fixturesUnder('seed', SEED_ROOT),
    ...fixturesUnder('scrubbed', SCRUBBED_ROOT),
  ];
  return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function fixturesUnder(origin: FixtureOrigin, root: string): GoldenFixture[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, ENVELOPES_FILE)))
    .map((entry) => ({
      origin,
      name: entry.name,
      id: `${origin}/${entry.name}`,
      dir: join(root, entry.name),
    }));
}

/** Absolute path of a fixture's committed projection snapshot. */
export function snapshotPathFor(fixture: GoldenFixture): string {
  return join(SNAPSHOT_ROOT, `${fixture.origin}-${fixture.name}.json`);
}

/**
 * Read a fixture directory's `envelopes.jsonl`. Lines are validated with the
 * PRODUCTION shape guard, so a malformed fixture fails loudly at load rather
 * than dead-lettering quietly into a green snapshot.
 *
 * `#` lines are skipped. Task 1.7's captured files never contain them; the seed
 * fixtures use them to carry their provenance label, which JSONL has nowhere
 * else to put.
 */
export function loadFixtureEnvelopes(dir: string): Envelope[] {
  const path = join(dir, ENVELOPES_FILE);
  const envelopes: Envelope[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${path}:${i + 1} is not JSON: ${(err as Error).message}`);
    }
    if (!isValidEnvelopeShape(parsed)) {
      throw new Error(`${path}:${i + 1} is not a valid envelope`);
    }
    envelopes.push(parsed);
  });
  if (envelopes.length === 0) throw new Error(`${path} contains no envelopes`);
  return envelopes;
}

// --- Ingest driver ---------------------------------------------------------

/**
 * Drive envelopes through the REAL production funnel — `ingestBatch`, chunked at
 * `BATCH_SIZE`, exactly as spool replay does — rather than calling `normalize`
 * directly. A golden test that skipped the funnel would certify the normalizer,
 * not the pipeline.
 */
export function ingestFixture(db: DatabaseSync, envelopes: readonly Envelope[]): void {
  const broadcaster = new Broadcaster();
  for (let i = 0; i < envelopes.length; i += BATCH_SIZE) {
    ingestBatch(
      db,
      broadcaster,
      envelopes.slice(i, i + BATCH_SIZE).map((envelope) => ({ envelope })),
    );
  }
}

// --- Projection snapshot ---------------------------------------------------

/** Knobs for {@link projectionSnapshot}. */
export interface SnapshotOptions {
  /** Fixture id, emitted as a header so a snapshot names what produced it. */
  fixture?: string;
  /** How many envelopes were fed in, emitted as a header. */
  envelopeCount?: number;
  /**
   * Rewrite every `archive[].source` to `"*"`.
   *
   * Required by — and ONLY by — the run-equivalence comparisons (kill-collector,
   * P2, P3). `replaySpool` re-stamps `source:'spool_replay'` on every envelope it
   * recovers and `insertRawEvent` is `DO NOTHING` on conflict, so the archive
   * legitimately records HOW an event reached us and must differ between a
   * never-down run and a spooled one.
   *
   * This rewrites `archive[].source` ONLY, never `spans.source`. Those were the
   * same claim while every normalizer call site wrote the hard-coded literal
   * `'hook'`; Task 3.2's merge made them different, since a span the transcript
   * creates is `'transcript'` and a hook span it enriches keeps `'hook'`. The
   * projection is still genuinely identical across the runs these comparisons
   * make — all of them are hook-only — which is the claim Phase 2 AC5 makes.
   * Never set for a golden snapshot, where the transport IS part of the record.
   */
  normalizeSource?: boolean;
}

type Row = Record<string, unknown>;

/**
 * Serialize the whole projection as canonical, line-diffable JSON.
 *
 * **Row ordering is the frozen ordering rule applied to the harness itself.**
 * Every table is ordered by a stable key — never `rowid`, never `spans_lite.seq`
 * — because collector arrival order is explicitly untrustworthy
 * (`research/tracer-bullet-findings.md` Q6, :252-254: "the normalizer MUST order
 * by a stable key (`ts` / `prompt_id` / `turn_seq`), never by collector arrival
 * `seq`"). A snapshot ordered by arrival would freeze precisely the thing that
 * rule forbids trusting.
 *
 * **Timestamp-normalization policy — what makes byte-for-byte achievable AND
 * non-vacuous.** Every timestamp on `sessions`/`traces`/`spans` is
 * `envelope.ts`, threaded through the normalizer verbatim, and fixture `ts`
 * values are frozen in the committed `.jsonl`. They are therefore asserted
 * VERBATIM — no masking, no placeholders. Same for `traces.duration_ms`, which
 * is arithmetic over them. The exclusions below are the only wall-clock or
 * arrival-order values in the pipeline, and each is excluded by column rather
 * than masked by regex:
 *   - `raw_events.received_at` — the sole wall-clock column the projection path
 *     writes; its one consumer is the inactivity sweep, not the projection.
 *   - `raw_events.raw` — the fixture file itself; it would double the snapshot.
 *   - `payloads.content` — `payloads.id` IS `sha256(content)`, so identity is
 *     already asserted, and a large-output fixture would inline 30 KB blobs.
 *   - `spans_lite` entirely — `seq` is collector arrival order.
 * `spans.attrs` is re-serialized through `canonicalJson` and `spans.tags` is
 * parsed-sorted-reserialized, because `json_patch` key order and the
 * `json_group_array`+`UNION` tag order are SQLite implementation details, not
 * contract.
 */
export function projectionSnapshot(db: DatabaseSync, opts: SnapshotOptions = {}): string {
  const snapshot: Record<string, unknown> = {};
  if (opts.fixture !== undefined) snapshot.fixture = opts.fixture;
  if (opts.envelopeCount !== undefined) snapshot.envelope_count = opts.envelopeCount;
  snapshot.health = ingestHealth(db);
  snapshot.sessions = all(db, 'SELECT * FROM sessions ORDER BY id');
  snapshot.traces = all(db, 'SELECT * FROM traces ORDER BY session_id, turn_seq');
  snapshot.spans = all(db, 'SELECT * FROM spans ORDER BY trace_id, started_at, id').map(
    normalizeSpan,
  );
  snapshot.payloads = all(db, 'SELECT id, byte_size, mime_hint FROM payloads ORDER BY id');
  snapshot.messages = all(db, 'SELECT * FROM messages ORDER BY trace_id, seq');
  snapshot.archive = all(
    db,
    `SELECT id, session_id, source, hook_name, status, error
     FROM raw_events ORDER BY id`,
  ).map((row) => (opts.normalizeSource === true ? { ...row, source: '*' } : row));

  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function all(db: DatabaseSync, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

/**
 * Canonicalize the two SQLite-implementation-detail columns on a span row. The
 * spread keeps the table's column order, and both keys are overwritten in place,
 * so the snapshot's field order still mirrors the schema.
 */
function normalizeSpan(row: Row): Row {
  return {
    ...row,
    tags: (JSON.parse(String(row.tags)) as string[]).sort(),
    attrs: JSON.parse(canonicalJson(JSON.parse(String(row.attrs)))) as unknown,
  };
}
