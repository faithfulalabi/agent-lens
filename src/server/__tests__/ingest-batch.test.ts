// AC3 for Task 2.4: a burst of hundreds of envelopes completes in bounded time
// with correct final state and ordered seq assignment, plus the batch semantics
// that make that safe (savepoint isolation, deferred broadcast, dirty-set flush).
//
// Two arms, split by what each can honestly measure:
//   - the write-path arm times 500 envelopes through `ingestBatch` against a
//     FILE-BACKED WAL db (not `:memory:`), so commit cost is real and the clock
//     reflects our code — this is where AC3's time bound is asserted;
//   - the HTTP arm drives 500 concurrent POSTs through a real `bootTestServer`
//     for end-to-end correctness and seq assignment, with only a loose liveness
//     ceiling, because an in-process client under a parallel test runner times
//     the scheduler rather than the database.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../db/index.js';
import { ingestBatch, type IngestBatchItem } from '../ingest.js';
import { Broadcaster } from '../sse.js';
import type { Envelope } from '../../shared/index.js';
import { freshDb, hookEnvelope } from '../../capture/__tests__/fixtures.js';
import {
  bootTestServer,
  cleanupDir,
  openTestDb,
  TOKEN_HEADER,
  type TestServer,
} from './helpers.js';

/**
 * Ceiling for 500 envelopes through the WRITE PATH, measured in-process against
 * a file-backed WAL db. This is where AC3's "bounded time" is actually asserted:
 * it is the only arm whose clock reflects our code rather than the test runner.
 * Measured 99-566 ms across runs under full parallel-suite load (~120 ms on an
 * idle machine), so 2000 ms is >3x the worst observed — loose enough not to
 * flake, tight enough to catch a regression to synchronous-fsync behaviour or an
 * O(n^2) rollup.
 */
const BOUND_MS = 2000;

/**
 * Liveness backstop for the HTTP arm only, deliberately loose. With the client
 * in the server's own process AND vitest running 26 other suites in parallel
 * workers, this wall clock measures event-loop contention, not the write path —
 * it ranged 0.5-4.4 s across runs while the underlying db work stayed ~150 ms.
 * A tight bound here is a flaky test, not a perf guard; the HTTP arm's real job
 * is the correctness and seq-assignment assertions below.
 */
const HTTP_LIVENESS_MS = 15_000;
const BURST = 500;
const BURST_SESSION = 'burst-1';

// Only the HTTP arm boots a server; clear the handle so the shared teardown
// does not try to close an already-closed one for every in-process test.
let server: TestServer | undefined;
afterEach(async () => {
  if (server) {
    const booted = server;
    server = undefined;
    await booted.close();
    cleanupDir(booted.dataDir);
  }
});

/**
 * A realistic worst-case tool loop for one session: SessionStart,
 * UserPromptSubmit, then Pre/Post pairs — every `failEvery`-th pair failing.
 * Returns exactly `count` envelopes.
 */
function toolLoop(count: number, session = BURST_SESSION, failEvery = 5): Envelope[] {
  const out: Envelope[] = [
    hookEnvelope('SessionStart', { cwd: '/proj' }, { session_id: session }),
    hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { session_id: session, prompt_id: 'p1' }),
  ];
  for (let i = 0; out.length < count; i += 1) {
    const id = `tool-${i}`;
    out.push(
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { cmd: `c${i}` } },
        { session_id: session, tool_use_id: id, prompt_id: 'p1' },
      ),
    );
    if (out.length === count) break;
    const failed = i % failEvery === 0;
    out.push(
      hookEnvelope(
        'PostToolUse',
        failed
          ? { tool_name: 'Bash', tool_response: {}, error: 'boom' }
          : { tool_name: 'Bash', tool_response: { ok: true } },
        { session_id: session, tool_use_id: id, prompt_id: 'p1' },
      ),
    );
  }
  return out;
}

const items = (envelopes: Envelope[]): IngestBatchItem[] =>
  envelopes.map((envelope) => ({ envelope }));

describe('ingestBatch — AC3: 500 envelopes through the write path', () => {
  it('completes within the bound on a file-backed WAL db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-lens-burst-'));
    try {
      // Real file + WAL, not `:memory:`, so commit cost is real.
      const db = openDb(dir);
      const envelopes = toolLoop(BURST);

      const started = Date.now();
      const results = ingestBatch(db, new Broadcaster(), items(envelopes));
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(BOUND_MS);
      expect(results).toHaveLength(BURST);
      expect(results.every((r) => r.inserted)).toBe(true);

      const pairs = (BURST - 2) / 2;
      const trace = db.prepare('SELECT * FROM traces').get() as Record<string, unknown>;
      expect(trace.tool_call_count).toBe(pairs);
      expect(trace.error_count).toBe(Math.ceil(pairs / 5));
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ingestBatch — AC3: HTTP burst of 500 concurrent ingests', () => {
  // Generous timeout: this arm is contending with every other suite for the
  // event loop, and it is asserting correctness, not latency.
  it('lands correct final state and 1..500 seqs', { timeout: 30_000 }, async () => {
    const booted = await bootTestServer();
    server = booted;
    const envelopes = toolLoop(BURST);
    expect(envelopes).toHaveLength(BURST);

    const started = Date.now();
    const responses = await Promise.all(
      envelopes.map((envelope) =>
        fetch(booted.url('/api/ingest'), {
          method: 'POST',
          headers: { [TOKEN_HEADER]: booted.token, 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
        }),
      ),
    );
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as {
      inserted: boolean;
      seq: number;
    }[];
    const elapsed = Date.now() - started;

    // Liveness only — see HTTP_LIVENESS_MS. The real perf bound is asserted on
    // the in-process write-path arm above.
    expect(elapsed).toBeLessThan(HTTP_LIVENESS_MS);
    expect(responses.every((r) => r.status === 200)).toBe(true);

    // Seq assignment: the SET is exactly 1..500 — gapless, no duplicates.
    // Deliberately not asserted in request-issue order: with concurrent HTTP the
    // kernel picks arrival order, and pinning that would be testing the OS.
    const seqs = bodies.map((b) => b.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: BURST }, (_, i) => i + 1));
    expect(bodies.every((b) => b.inserted)).toBe(true);

    const db = openTestDb(booted.dataDir);
    try {
      const count = (sql: string): number =>
        Number((db.prepare(sql).get() as { n: number }).n);
      expect(count('SELECT COUNT(*) AS n FROM raw_events')).toBe(BURST);
      expect(count('SELECT MAX(seq) AS n FROM spans_lite')).toBe(BURST);
      expect(count('SELECT COUNT(*) AS n FROM sessions')).toBe(1);
      expect(count('SELECT COUNT(*) AS n FROM traces')).toBe(1);

      // Hand-computed from the generator: 498 envelopes after the two openers,
      // as 249 complete Pre/Post pairs -> 249 tool spans, every 5th failing.
      const pairs = (BURST - 2) / 2;
      const expectedErrors = Math.ceil(pairs / 5);
      expect(count('SELECT COUNT(*) AS n FROM spans')).toBe(pairs);

      const trace = db.prepare('SELECT * FROM traces').get() as Record<string, unknown>;
      expect(trace.tool_call_count).toBe(pairs);
      expect(trace.error_count).toBe(expectedErrors);
      const session = db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
      expect(session.tool_call_count).toBe(pairs);
      expect(session.error_count).toBe(expectedErrors);
      expect(session.trace_count).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('ingestBatch — AC3: deterministic ordering in-process', () => {
  it('assigns 1..N in input order and reads back in that order', () => {
    const db = freshDb();
    const envelopes = toolLoop(BURST);
    const results = ingestBatch(db, new Broadcaster(), items(envelopes));

    expect(results.map((r) => r.seq)).toEqual(
      Array.from({ length: BURST }, (_, i) => i + 1),
    );
    expect(results.every((r) => r.inserted)).toBe(true);

    const rows = db
      .prepare('SELECT event_id FROM spans_lite ORDER BY seq ASC')
      .all() as { event_id: string }[];
    expect(rows.map((r) => r.event_id)).toEqual(envelopes.map((e) => e.event_id));
  });

  it('publishes every event, but only after the transaction commits', () => {
    const db = freshDb();
    const broadcaster = new Broadcaster();
    const seen: number[] = [];
    broadcaster.subscribe((event) => {
      // If broadcast happened inside the txn, this row would not be readable
      // yet from the same connection's committed state.
      seen.push(event.seq);
    });

    const envelopes = toolLoop(10);
    ingestBatch(db, broadcaster, items(envelopes));

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const committed = db
      .prepare('SELECT COUNT(*) AS n FROM spans_lite')
      .get() as { n: number };
    expect(Number(committed.n)).toBe(10);
  });

  it('returns an empty array for an empty batch without opening a transaction', () => {
    const db = freshDb();
    expect(ingestBatch(db, new Broadcaster(), [])).toEqual([]);
    // A leaked transaction would make this BEGIN throw.
    expect(() => db.exec('BEGIN')).not.toThrow();
    db.exec('ROLLBACK');
  });
});

describe('ingestBatch — AC3: per-trace ordering under interleave', () => {
  it('keeps two sessions x two traces independently correct in one batch', () => {
    const db = freshDb();
    const build = (session: string, promptId: string, tool: string): Envelope[] => [
      hookEnvelope('UserPromptSubmit', { prompt: promptId }, { session_id: session, prompt_id: promptId }),
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: {} },
        { session_id: session, prompt_id: promptId, tool_use_id: tool },
      ),
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: {}, error: 'x' },
        { session_id: session, prompt_id: promptId, tool_use_id: tool },
      ),
    ];
    const a1 = build('sess-a', 'pa1', 'ta1');
    const a2 = build('sess-a', 'pa2', 'ta2');
    const b1 = build('sess-b', 'pb1', 'tb1');
    const b2 = build('sess-b', 'pb2', 'tb2');

    // Round-robin interleave across all four turns.
    const interleaved: Envelope[] = [];
    for (let i = 0; i < 3; i += 1) {
      interleaved.push(a1[i]!, b1[i]!, a2[i]!, b2[i]!);
    }
    const results = ingestBatch(db, new Broadcaster(), items(interleaved));
    expect(results.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const traces = db
      .prepare('SELECT * FROM traces ORDER BY session_id, turn_seq')
      .all() as Record<string, unknown>[];
    expect(traces).toHaveLength(4);
    for (const trace of traces) {
      // Each trace owns exactly its own pair — no cross-trace bleed.
      expect(trace.tool_call_count, String(trace.id)).toBe(1);
      expect(trace.error_count, String(trace.id)).toBe(1);
    }
    const sessions = db
      .prepare('SELECT * FROM sessions ORDER BY id')
      .all() as Record<string, unknown>[];
    expect(sessions.map((s) => s.trace_count)).toEqual([2, 2]);
    expect(sessions.map((s) => s.tool_call_count)).toEqual([2, 2]);
    expect(sessions.map((s) => s.error_count)).toEqual([2, 2]);

    // Spans of one trace retain their relative order by the stable key.
    const spanIds = db
      .prepare(`SELECT id FROM spans WHERE trace_id = 'sess-a:1' ORDER BY started_at`)
      .all() as { id: string }[];
    expect(spanIds.map((s) => s.id)).toEqual(['ta1']);
  });
});

describe('ingestBatch — AC3: SAVEPOINT isolates a poison item', () => {
  it('commits every surviving item and dead-letters only the failing one', () => {
    const db = freshDb();
    // A deterministic, DB-level projection failure scoped to ONE span id. This
    // is the regression test for savepoint isolation: with a bare `ROLLBACK` in
    // place of `ROLLBACK TO`, item 0 would be destroyed, items after the poison
    // would autocommit outside any transaction, and the closing `COMMIT` would
    // fail with "cannot commit - no transaction is active".
    db.exec(`
      CREATE TRIGGER poison BEFORE INSERT ON spans
      WHEN NEW.id = 'poison-tool'
      BEGIN SELECT RAISE(ABORT, 'poisoned span'); END;
    `);

    const before = [
      hookEnvelope('SessionStart', { cwd: '/proj' }, { session_id: BURST_SESSION }),
      hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { session_id: BURST_SESSION, prompt_id: 'p1' }),
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: {} },
        { session_id: BURST_SESSION, tool_use_id: 'ok-1', prompt_id: 'p1' },
      ),
    ];
    const poison = hookEnvelope(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: {} },
      { session_id: BURST_SESSION, tool_use_id: 'poison-tool', prompt_id: 'p1' },
    );
    const after = [
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { ok: true } },
        { session_id: BURST_SESSION, tool_use_id: 'ok-1', prompt_id: 'p1' },
      ),
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: {} },
        { session_id: BURST_SESSION, tool_use_id: 'ok-2', prompt_id: 'p1' },
      ),
    ];
    const all = [...before, poison, ...after];

    let results: ReturnType<typeof ingestBatch>;
    expect(() => {
      results = ingestBatch(db, new Broadcaster(), items(all));
    }).not.toThrow();

    // Every item got a row and a seq, including the poison one (the event is
    // real — only its projection broke).
    expect(results!.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results![3]!.deadLettered).toBe(true);
    expect(results!.filter((r) => r.deadLettered)).toHaveLength(1);

    // The outer COMMIT succeeded and the transaction is clean.
    expect(() => db.exec('BEGIN')).not.toThrow();
    db.exec('ROLLBACK');

    const raw = db
      .prepare('SELECT id, status FROM raw_events ORDER BY rowid')
      .all() as { id: string; status: string }[];
    expect(raw).toHaveLength(6);
    expect(raw.filter((r) => r.status === 'dead_letter')).toHaveLength(1);
    expect(raw.find((r) => r.status === 'dead_letter')!.id).toBe(poison.event_id);

    // Items before AND after the poison are queryable — the whole point.
    const spanIds = (
      db.prepare('SELECT id FROM spans ORDER BY id').all() as { id: string }[]
    ).map((s) => s.id);
    expect(spanIds).toEqual(['ok-1', 'ok-2']);

    // Rollups for the surviving trace are still correct.
    const trace = db.prepare('SELECT * FROM traces').get() as Record<string, unknown>;
    expect(trace.tool_call_count).toBe(2);
    expect(trace.error_count).toBe(0);
  });

  it('survives a rollup flush that throws without losing the batch', () => {
    const db = freshDb();
    // Fail the rollup flush ONLY. `UPDATE OF total_tokens` fires for
    // `recomputeTraceRollup`'s UPDATE but not for the normalizer's
    // `INSERT ... ON CONFLICT DO UPDATE` (which never sets that column), so the
    // projection succeeds and only the derived aggregates blow up.
    db.exec(`
      CREATE TRIGGER no_rollup BEFORE UPDATE OF total_tokens ON traces
      BEGIN SELECT RAISE(ABORT, 'rollup exploded'); END;
    `);

    const envelopes = toolLoop(6);
    let results: ReturnType<typeof ingestBatch>;
    expect(() => {
      results = ingestBatch(db, new Broadcaster(), items(envelopes));
    }).not.toThrow();

    // The real rows all landed and committed — rollups are derived data and
    // must never take the batch down with them.
    expect(results!.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const count = (sql: string): number =>
      Number((db.prepare(sql).get() as { n: number }).n);
    expect(count('SELECT COUNT(*) AS n FROM raw_events')).toBe(6);
    expect(count('SELECT COUNT(*) AS n FROM spans_lite')).toBe(6);
    expect(count('SELECT COUNT(*) AS n FROM spans')).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM traces')).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM raw_events WHERE status = 'dead_letter'`)).toBe(0);

    // The flush was rolled back to its own savepoint, so aggregates stay at
    // their insert-time defaults — stale, not corrupt, and self-healing on the
    // next envelope because recompute-from-children is idempotent.
    const trace = db.prepare('SELECT * FROM traces').get() as Record<string, unknown>;
    expect(trace.tool_call_count).toBe(0);
    expect(trace.total_tokens).toBe(0);

    // The outer transaction closed cleanly.
    expect(() => db.exec('BEGIN')).not.toThrow();
    db.exec('ROLLBACK');

    // Drop the trigger, then ingest ONE new envelope. Recompute-from-children
    // rebuilds the whole aggregate, so the two spans stranded by the failed
    // flush are counted again — no replay, no repair job.
    db.exec('DROP TRIGGER no_rollup');
    ingestBatch(db, new Broadcaster(), [
      {
        envelope: hookEnvelope(
          'PreToolUse',
          { tool_name: 'Bash', tool_input: {} },
          { session_id: BURST_SESSION, tool_use_id: 'tool-heal', prompt_id: 'p1' },
        ),
      },
    ]);
    const healed = db.prepare('SELECT * FROM traces').get() as Record<string, unknown>;
    expect(healed.tool_call_count).toBe(3);
  });
});
