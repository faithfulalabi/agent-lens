// AC4: dead-lettering is only safe if it is reversible. These tests take the
// exact state a broken parser leaves behind — raw rows archived, projection never
// run — and prove that reprocessing after the "fix" heals the trace.

import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { ingestEnvelope } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';
import { ingestHealth } from '../../db/index.js';
import { reprocessDeadLetters } from '../reprocess.js';
import {
  freshDb,
  hookEnvelope,
  only,
  spans,
  rawEvents,
  tagsOf,
  SESSION,
} from './fixtures.js';

let db: DatabaseSync;
let bc: Broadcaster;

beforeEach(() => {
  db = freshDb();
  bc = new Broadcaster();
});

const PRE = hookEnvelope(
  'PreToolUse',
  { tool_name: 'Bash', tool_input: { command: 'ls' }, prompt_id: 'p1' },
  { tool_use_id: 'toolu_1', prompt_id: 'p1', ts: '2026-07-26T00:00:01.000Z' },
);
const POST = hookEnvelope(
  'PostToolUse',
  { tool_name: 'Bash', tool_response: { stdout: 'files' }, prompt_id: 'p1' },
  { tool_use_id: 'toolu_1', prompt_id: 'p1', ts: '2026-07-26T00:00:02.000Z' },
);

/**
 * A healthy prompt turn, then a Pre/Post pair archived WITHOUT projection —
 * `status:'dead_letter'` is the existing skip-the-normalizer mode, i.e. exactly
 * what a broken parser leaves behind.
 */
function brokenParserState(): void {
  ingestEnvelope(
    db,
    bc,
    hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }),
  );
  ingestEnvelope(db, bc, PRE, 'dead_letter');
  ingestEnvelope(db, bc, POST, 'dead_letter');
}

describe('reprocessDeadLetters — AC4: a parser fix heals the trace', () => {
  it('replays dead letters into real spans and drops the counter', () => {
    brokenParserState();
    expect(ingestHealth(db)).toEqual({ processed: 1, degraded: 0, dead_letter: 2 });
    expect(spans(db)).toHaveLength(0);

    const result = reprocessDeadLetters(db);

    expect(result).toEqual({ attempted: 2, healed: 2, failed: 0 });
    expect(ingestHealth(db)).toEqual({ processed: 3, degraded: 0, dead_letter: 0 });

    const span = only(spans(db), (r) => r.id === 'toolu_1');
    expect(span.trace_id).toBe(`${SESSION}:1`);
    expect(span.status).toBe('ok');
    expect(span.input_payload_id).toBeTruthy();
    expect(span.output_payload_id).toBeTruthy();
    for (const row of rawEvents(db)) expect(row.error).toBeNull();
  });

  it('heals to the same span even when the Post replays first', () => {
    brokenParserState();
    // Force the Post to sort ahead of the Pre, so the close replays before the
    // open. Only the terminal-status guard in upsertSpan makes this converge.
    db.prepare('UPDATE raw_events SET received_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      POST.event_id,
    );

    expect(reprocessDeadLetters(db)).toEqual({ attempted: 2, healed: 2, failed: 0 });

    const span = only(spans(db), (r) => r.id === 'toolu_1');
    expect(span.status).toBe('ok');
    expect(span.ended_at).toBe('2026-07-26T00:00:02.000Z');
    // `started_at` is insert-only, so a Post-first replay opens the span at the
    // close time — and says so, via the tag, rather than pretending otherwise.
    expect(tagsOf(span)).toContain('synthetic_open');
  });

  it('keeps a still-failing row dead, with a refreshed error and no partial rows', () => {
    brokenParserState();
    const tracesBefore = db.prepare('SELECT * FROM traces').all();
    db.exec('DROP TABLE spans');

    const result = reprocessDeadLetters(db);

    expect(result).toEqual({ attempted: 2, healed: 0, failed: 2 });
    expect(ingestHealth(db)).toEqual({ processed: 1, degraded: 0, dead_letter: 2 });
    for (const row of rawEvents(db).filter((r) => r.status === 'dead_letter')) {
      expect(String(row.error)).toMatch(/no such table: spans/);
    }
    // Rolled back cleanly — no half-written projection leaked.
    expect(db.prepare('SELECT * FROM traces').all()).toEqual(tracesBefore);
  });

  it('is idempotent: a second pass after a heal is a no-op', () => {
    brokenParserState();
    reprocessDeadLetters(db);
    const after = JSON.stringify({ raw: rawEvents(db), spans: spans(db) });

    expect(reprocessDeadLetters(db)).toEqual({ attempted: 0, healed: 0, failed: 0 });
    expect(JSON.stringify({ raw: rawEvents(db), spans: spans(db) })).toBe(after);
  });

  it('replaying an unknown hook heals the row but keeps it flagged degraded', () => {
    ingestEnvelope(
      db,
      bc,
      hookEnvelope('SomeFutureHook_v3', { a: 1 }),
      'dead_letter',
    );

    expect(reprocessDeadLetters(db)).toEqual({ attempted: 1, healed: 1, failed: 0 });
    expect(ingestHealth(db)).toEqual({ processed: 0, degraded: 1, dead_letter: 0 });
    expect(spans(db)).toHaveLength(1);
  });

  it('leaves boundary garbage that is not JSON dead, without throwing', () => {
    db.prepare(
      `INSERT INTO raw_events (id, session_id, source, hook_name, received_at, status, error, raw)
       VALUES ('garbage', 'unknown', 'hook', 'unknown', '2026-07-26T00:00:00.000Z',
               'dead_letter', 'invalid json', '{"event_id": ')`,
    ).run();

    let result!: ReturnType<typeof reprocessDeadLetters>;
    expect(() => {
      result = reprocessDeadLetters(db);
    }).not.toThrow();

    expect(result).toEqual({ attempted: 1, healed: 0, failed: 1 });
    const row = only(rawEvents(db), (r) => r.id === 'garbage');
    expect(row.status).toBe('dead_letter');
    expect(String(row.error)).toMatch(/JSON/i);
  });
});
