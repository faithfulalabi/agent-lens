// Task 5.0 Test 16 — the seeder is the prerequisite for every other read test,
// so it is verified first: it must write through the REAL writers (so the
// fixture is indistinguishable from ingested data), produce non-zero rollups,
// leave at least one genuinely NULL `est_cost`, and converge on a re-seed.

import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { seedInto, type SeedManifest } from '../seed.js';
import { freshDb, type Row } from '../../capture/__tests__/fixtures.js';

let db: DatabaseSync;
beforeEach(() => {
  db = freshDb();
});

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const rows = (sql: string): Row[] => db.prepare(sql).all() as Row[];

/** Every projection row, ordered, for an idempotency diff. */
function snapshot(): Record<string, Row[]> {
  return {
    sessions: rows('SELECT * FROM sessions ORDER BY id'),
    traces: rows('SELECT * FROM traces ORDER BY id'),
    spans: rows('SELECT * FROM spans ORDER BY id'),
    messages: rows('SELECT * FROM messages ORDER BY id'),
    payloads: rows('SELECT id, byte_size, mime_hint FROM payloads ORDER BY id'),
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
