// Task 5.0 Test 16 — the seeder is the prerequisite for every other read test,
// so it is verified first: it must write through the REAL writers (so the
// fixture is indistinguishable from ingested data), produce non-zero rollups,
// leave at least one genuinely NULL `est_cost`, and converge on a re-seed.

import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { SEED_EPOCH, seedInto, type SeedManifest } from '../seed.js';
import { freshDb, type Row } from '../../capture/__tests__/fixtures.js';

let db: DatabaseSync;
beforeEach(() => {
  db = freshDb();
});

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const rows = (sql: string): Row[] => db.prepare(sql).all() as Row[];

/**
 * Every projection row, ordered, for an idempotency diff.
 *
 * `target` defaults to the suite's own handle. Task 5.2a passes a second one so
 * two independently seeded databases can be compared row for row.
 */
function snapshot(target: DatabaseSync = db): Record<string, Row[]> {
  const from = (sql: string): Row[] => target.prepare(sql).all() as Row[];
  return {
    sessions: from('SELECT * FROM sessions ORDER BY id'),
    traces: from('SELECT * FROM traces ORDER BY id'),
    spans: from('SELECT * FROM spans ORDER BY id'),
    messages: from('SELECT * FROM messages ORDER BY id'),
    payloads: from('SELECT id, byte_size, mime_hint FROM payloads ORDER BY id'),
  };
}

describe('seedFixtureDb / seedInto', () => {
  let manifest: SeedManifest;
  beforeEach(() => {
    manifest = seedInto(db, { sessions: 3, tracesPerSession: 2, spansPerTrace: 3 });
  });

  it('writes the requested row counts through the real writers', () => {
    expect(count('sessions')).toBe(3);
    expect(count('traces')).toBe(6);
    expect(count('spans')).toBe(18);
    expect(count('messages')).toBe(12);
    expect(manifest.counts).toEqual({
      sessions: 3,
      traces: 6,
      spans: 18,
      messages: 12,
    });
    expect(manifest.sessionIds).toEqual(['seed-s0', 'seed-s1', 'seed-s2']);
    expect(manifest.traceIds).toContain('seed-s0:1');
    expect(manifest.spanIds).toContain('seed-s0:1:sp0');
  });

  it('computes rollups, so the precomputed columns are non-zero', () => {
    for (const session of rows('SELECT * FROM sessions')) {
      expect(Number(session.total_tokens)).toBeGreaterThan(0);
      expect(Number(session.trace_count)).toBe(2);
    }
    for (const trace of rows('SELECT * FROM traces')) {
      expect(Number(trace.total_tokens)).toBeGreaterThan(0);
      // Two non-root spans per trace, both `tool_call`.
      expect(Number(trace.tool_call_count)).toBe(2);
    }
  });

  it('leaves at least one span with a genuinely NULL est_cost (unknown model)', () => {
    const unpriced = rows('SELECT id, est_cost, tokens_in FROM spans WHERE est_cost IS NULL');
    expect(unpriced.length).toBeGreaterThan(0);
    const target = rows(
      `SELECT id, est_cost, tokens_in, model FROM spans WHERE id = '${manifest.unpricedSpanId}'`,
    )[0]!;
    expect(target.est_cost).toBeNull();
    // Tokens ARE recorded — this is "unpriced", not "no usage".
    expect(Number(target.tokens_in)).toBeGreaterThan(0);
  });

  it('leaves the null-strip fixtures the mappers need: open span, live session', () => {
    const open = rows(
      `SELECT ended_at, output_payload_id FROM spans WHERE id = '${manifest.openSpanId}'`,
    )[0]!;
    expect(open.ended_at).toBeNull();
    expect(open.output_payload_id).toBeNull();

    const root = rows(
      `SELECT parent_span_id FROM spans WHERE id = '${manifest.rootSpanId}'`,
    )[0]!;
    expect(root.parent_span_id).toBeNull();

    const liveSession = rows(
      `SELECT ended_at, git_branch, model, transcript_path FROM sessions WHERE id = '${manifest.liveSessionId}'`,
    )[0]!;
    expect(liveSession.ended_at).toBeNull();
    expect(liveSession.git_branch).toBeNull();
    expect(liveSession.model).toBeNull();
    expect(liveSession.transcript_path).toBeNull();

    const liveTrace = rows(
      `SELECT ended_at FROM traces WHERE id = '${manifest.liveTraceId}'`,
    )[0]!;
    expect(liveTrace.ended_at).toBeNull();
  });

  it('spans two distinct projects, so the project filter has something to filter', () => {
    expect(manifest.projects.length).toBeGreaterThanOrEqual(2);
    const distinct = rows('SELECT DISTINCT project_path FROM sessions');
    expect(distinct).toHaveLength(manifest.projects.length);
  });

  it('is idempotent: a second seed converges instead of doubling', () => {
    const before = snapshot();
    const second = seedInto(db, { sessions: 3, tracesPerSession: 2, spansPerTrace: 3 });
    expect(snapshot()).toEqual(before);
    expect(second.counts).toEqual(manifest.counts);
    expect(count('spans')).toBe(18);
  });
});

describe('seedInto — degenerate sizes still produce the null fixtures', () => {
  it('works with a single session, trace, and span', () => {
    const manifest = seedInto(db, { sessions: 1, tracesPerSession: 1, spansPerTrace: 1 });
    expect(count('sessions')).toBe(1);
    expect(count('spans')).toBe(1);
    expect(manifest.liveSessionId).toBe('seed-s0');
    expect(manifest.unpricedSpanId).toBe('seed-s0:1:sp0');
    // The one span is both the trace root and the open span.
    expect(manifest.openSpanId).toBe('seed-s0:1:sp0');
    expect(
      rows("SELECT est_cost FROM spans WHERE id = 'seed-s0:1:sp0'")[0]!.est_cost,
    ).toBeNull();
  });
});

/*
 * Task 5.2a — the two additive options. Both default to what this seeder has
 * always written, which is the property Test 10 of that task plan asserts
 * directly: everything above this comment is unchanged and still green.
 */

describe('seedInto — the additive options default to the original behaviour', () => {
  it('writes byte-identical rows whether the new options are omitted or defaulted', () => {
    const withoutOptions = seedInto(db, { sessions: 3, tracesPerSession: 2, spansPerTrace: 3 });

    const other = freshDb();
    const asDefaulted = seedInto(other, {
      sessions: 3,
      tracesPerSession: 2,
      spansPerTrace: 3,
      nowAnchor: undefined,
      variants: false,
    });

    expect(snapshot(other)).toEqual(snapshot());
    expect(asDefaulted.counts).toEqual(withoutOptions.counts);
  });

  it('still anchors at SEED_EPOCH when no anchor is given', () => {
    seedInto(db, { sessions: 3 });
    const first = rows("SELECT started_at FROM sessions WHERE id = 'seed-s0'")[0]!;
    expect(first.started_at).toBe(SEED_EPOCH);
  });

  it('leaves every session at full capture and every span unfailed by default', () => {
    seedInto(db, { sessions: 3 });
    expect(rows("SELECT id FROM sessions WHERE capture_mode <> 'full'")).toHaveLength(0);
    expect(rows("SELECT id FROM spans WHERE status IN ('error', 'denied')")).toHaveLength(0);
    expect(rows('SELECT id FROM sessions WHERE error_count > 0')).toHaveLength(0);
  });
});

describe('seedInto — nowAnchor slides the fixture into a real time range', () => {
  it('lands the newest session on the anchor, so a 3-day window contains it', () => {
    const anchor = new Date('2026-07-29T12:00:00.000Z');
    seedInto(db, { sessions: 300, nowAnchor: anchor });

    const newest = rows('SELECT id, started_at FROM sessions ORDER BY started_at DESC LIMIT 1')[0]!;
    expect(newest.id).toBe('seed-s299');
    expect(newest.started_at).toBe(anchor.toISOString());

    // The whole point: without the anchor these 300 sessions sit in 2026-07-01
    // to 07-13 and a range measured back from `now` catches none of them.
    const threeDaysBack = new Date(anchor.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const inRange = rows(
      `SELECT id FROM sessions WHERE started_at >= '${threeDaysBack}' AND started_at <= '${anchor.toISOString()}'`,
    );
    expect(inRange.length).toBeGreaterThan(0);
    expect(inRange.length).toBe(73); // 72 hours of hourly starts, plus the anchor itself.
  });

  it('keeps the one-hour stride and the ordering the read API sorts on', () => {
    const anchor = new Date('2026-07-29T12:00:00.000Z');
    seedInto(db, { sessions: 3, nowAnchor: anchor });
    const starts = rows('SELECT started_at FROM sessions ORDER BY id').map((r) =>
      Date.parse(String(r.started_at)),
    );
    expect(starts[1]! - starts[0]!).toBe(3600 * 1000);
    expect(starts[2]! - starts[1]!).toBe(3600 * 1000);
    expect(starts[2]!).toBe(anchor.getTime());
  });
});

describe('seedInto — variants produces the shapes the fixture otherwise lacks', () => {
  it('adds exactly one transcript_only session and at least one error', () => {
    seedInto(db, { sessions: 5, variants: true });

    const degraded = rows("SELECT id FROM sessions WHERE capture_mode = 'transcript_only'");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.id).toBe('seed-s0');

    const failedSpans = rows("SELECT id FROM spans WHERE status = 'error'");
    expect(failedSpans.length).toBeGreaterThan(0);

    const withErrors = rows('SELECT id, error_count FROM sessions WHERE error_count > 0');
    expect(withErrors.length).toBeGreaterThan(0);
    expect(Number(withErrors[0]!.error_count)).toBeGreaterThan(0);
  });

  it('combines with nowAnchor without either option disturbing the other', () => {
    const anchor = new Date('2026-07-29T12:00:00.000Z');
    seedInto(db, { sessions: 5, nowAnchor: anchor, variants: true });
    expect(rows("SELECT started_at FROM sessions WHERE id = 'seed-s4'")[0]!.started_at).toBe(
      anchor.toISOString(),
    );
    expect(rows("SELECT id FROM sessions WHERE capture_mode = 'transcript_only'")).toHaveLength(1);
  });
});
