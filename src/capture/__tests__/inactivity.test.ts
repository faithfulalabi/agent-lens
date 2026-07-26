// AC3: a session that just goes silent must degrade visibly (`interrupted`, open
// spans `unknown`) and come back to life the moment it speaks again. `now` is
// injected, so there are no fake timers anywhere in here.

import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { ingestEnvelope } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';
import { sweepInactive, DEFAULT_TIMEOUT_MS } from '../inactivity.js';
import {
  freshDb,
  hookEnvelope,
  first,
  only,
  sessions,
  spans,
  traces,
  SESSION,
} from './fixtures.js';

let db: DatabaseSync;
let bc: Broadcaster;

beforeEach(() => {
  db = freshDb();
  bc = new Broadcaster();
});

const MINUTE = 60 * 1000;

/** Latest arrival the sweep will measure staleness against. */
function lastActivity(): number {
  const row = db
    .prepare('SELECT MAX(received_at) AS at FROM raw_events')
    .get() as { at: string };
  return Date.parse(row.at);
}

/** A live session with one live turn and one still-running tool span. */
function liveSessionWithOpenSpan(): void {
  ingestEnvelope(db, bc, hookEnvelope('SessionStart', { cwd: '/proj' }));
  ingestEnvelope(
    db,
    bc,
    hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }),
  );
  ingestEnvelope(
    db,
    bc,
    hookEnvelope(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: { command: 'sleep 999' }, prompt_id: 'p1' },
      { tool_use_id: 'toolu_1', prompt_id: 'p1' },
    ),
  );
}

describe('sweepInactive — AC3: silence degrades, activity revives', () => {
  it('marks a silent session interrupted and closes its open spans unknown', () => {
    liveSessionWithOpenSpan();
    const now = new Date(lastActivity() + 31 * MINUTE);

    const result = sweepInactive(db, { now, timeoutMs: DEFAULT_TIMEOUT_MS });

    expect(result).toEqual({ interruptedTraces: 1, closedSpans: 1 });
    expect(first(traces(db)).status).toBe('interrupted');
    expect(first(sessions(db)).status).toBe('interrupted');
    const span = only(spans(db), (r) => r.id === 'toolu_1');
    expect(span.status).toBe('unknown');
    expect(span.ended_at).toBe(now.toISOString());
  });

  it('leaves a session that is merely quiet alone', () => {
    liveSessionWithOpenSpan();
    const before = JSON.stringify({ t: traces(db), s: sessions(db), p: spans(db) });

    const result = sweepInactive(db, {
      now: new Date(lastActivity() + 5 * MINUTE),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    expect(result).toEqual({ interruptedTraces: 0, closedSpans: 0 });
    expect(JSON.stringify({ t: traces(db), s: sessions(db), p: spans(db) })).toBe(before);
  });

  it('is idempotent: a second pass finds nothing left to interrupt', () => {
    liveSessionWithOpenSpan();
    const now = new Date(lastActivity() + 31 * MINUTE);
    sweepInactive(db, { now, timeoutMs: DEFAULT_TIMEOUT_MS });
    const after = JSON.stringify({ t: traces(db), s: sessions(db), p: spans(db) });

    const second = sweepInactive(db, {
      now: new Date(now.getTime() + MINUTE),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    expect(second).toEqual({ interruptedTraces: 0, closedSpans: 0 });
    expect(JSON.stringify({ t: traces(db), s: sessions(db), p: spans(db) })).toBe(after);
  });

  it('a new event revives the session and turn, leaving closed turns alone', () => {
    // Turn 1 completes, turn 2 is live with an open span when silence hits.
    ingestEnvelope(db, bc, hookEnvelope('SessionStart', { cwd: '/proj' }));
    ingestEnvelope(
      db,
      bc,
      hookEnvelope('UserPromptSubmit', { prompt: 'one' }, { prompt_id: 'p1' }),
    );
    ingestEnvelope(db, bc, hookEnvelope('Stop', {}, { ts: '2026-07-26T00:01:00.000Z' }));
    ingestEnvelope(
      db,
      bc,
      hookEnvelope('UserPromptSubmit', { prompt: 'two' }, { prompt_id: 'p2' }),
    );
    ingestEnvelope(
      db,
      bc,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', prompt_id: 'p2' },
        { tool_use_id: 'toolu_2', prompt_id: 'p2' },
      ),
    );
    sweepInactive(db, {
      now: new Date(lastActivity() + 31 * MINUTE),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    expect(only(traces(db), (r) => r.id === `${SESSION}:2`).status).toBe('interrupted');

    // The session speaks again.
    ingestEnvelope(
      db,
      bc,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { stdout: 'ok' }, prompt_id: 'p2' },
        { tool_use_id: 'toolu_2', prompt_id: 'p2', ts: '2026-07-26T01:00:00.000Z' },
      ),
    );

    expect(only(traces(db), (r) => r.id === `${SESSION}:2`).status).toBe('live');
    expect(first(sessions(db)).status).toBe('live');
    expect(only(spans(db), (r) => r.id === 'toolu_2').status).toBe('ok');
    // The turn that legitimately finished before the timeout is untouched.
    const closed = only(traces(db), (r) => r.id === `${SESSION}:1`);
    expect(closed.status).toBe('complete');
    expect(closed.ended_at).toBe('2026-07-26T00:01:00.000Z');
  });

  it('sweeps only the stale session when several are open', () => {
    liveSessionWithOpenSpan();
    ingestEnvelope(
      db,
      bc,
      hookEnvelope('SessionStart', { cwd: '/other' }, { session_id: 'sess-2' }),
    );
    // Pin arrival times: the ingests above all land in the same millisecond, and
    // staleness is exactly what this test needs to differ between them.
    const setArrival = db.prepare(
      'UPDATE raw_events SET received_at = ? WHERE session_id = ?',
    );
    setArrival.run('2026-01-01T00:00:00.000Z', SESSION);
    setArrival.run('2026-01-01T01:00:00.000Z', 'sess-2');

    const result = sweepInactive(db, {
      now: new Date('2026-01-01T01:05:00.000Z'),
      timeoutMs: 10 * MINUTE,
    });

    expect(result.interruptedTraces).toBe(1);
    expect(only(sessions(db), (r) => r.id === SESSION).status).toBe('interrupted');
    expect(only(sessions(db), (r) => r.id === 'sess-2').status).toBe('live');
  });
});
