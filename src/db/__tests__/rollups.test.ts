import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  recordSpanUsage,
  recomputeTraceRollup,
  recomputeSessionRollup,
  recomputeRollups,
} from '../rollups.js';
import { normalize } from '../../capture/normalizer.js';
import { PRICING_TABLE, PRICING_VERSION } from '../../shared/index.js';
import {
  at,
  freshDb,
  hookEnvelope,
  only,
  attrsOf,
  SESSION,
  type Row,
} from '../../capture/__tests__/fixtures.js';

const OPUS = 'claude-opus-4-8';
const RATE = PRICING_TABLE[OPUS]!;

let db: DatabaseSync;
beforeEach(() => {
  db = freshDb();
});

/** Read the single trace row for a turn. */
function trace(id: string): Row {
  return db.prepare('SELECT * FROM traces WHERE id = ?').get(id) as Row;
}

function session(id = SESSION): Row {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row;
}

function span(id: string): Row {
  return db.prepare('SELECT * FROM spans WHERE id = ?').get(id) as Row;
}

/** A Pre/Post tool pair on prompt `p1`, closing with the given status payload. */
function toolPair(
  toolUseId: string,
  opts: { start: number; end: number; fail?: boolean } = { start: 1, end: 2 },
): void {
  normalize(
    db,
    hookEnvelope(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: { cmd: `run ${toolUseId}` } },
      { tool_use_id: toolUseId, prompt_id: 'p1', ts: at(opts.start) },
    ),
  );
  normalize(
    db,
    hookEnvelope(
      'PostToolUse',
      opts.fail
        ? { tool_name: 'Bash', tool_response: {}, error: 'boom' }
        : { tool_name: 'Bash', tool_response: { ok: true } },
      { tool_use_id: toolUseId, prompt_id: 'p1', ts: at(opts.end) },
    ),
  );
}

describe('rollups — AC1: empty-parent guard (the COALESCE regression test)', () => {
  // Runs first on purpose: without COALESCE on every SET target this throws
  // `NOT NULL constraint failed` on the SECOND envelope of every session, and
  // every other assertion in this file becomes noise.
  it('leaves a trace with zero spans at all-zero without throwing', () => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'hi' }, { prompt_id: 'p1' }));

    expect(() => recomputeTraceRollup(db, `${SESSION}:1`)).not.toThrow();
    expect(() => recomputeSessionRollup(db, SESSION)).not.toThrow();

    const t = trace(`${SESSION}:1`);
    for (const col of [
      'tokens_in',
      'tokens_out',
      'tokens_cache_read',
      'tokens_cache_write',
      'total_tokens',
      'est_cost',
      'tool_call_count',
      'error_count',
      'duration_ms',
    ]) {
      expect(t[col], col).toBe(0);
    }
    const s = session();
    expect(s.total_tokens).toBe(0);
    expect(s.est_cost).toBe(0);
    expect(s.trace_count).toBe(1);
  });

  it('handles a still-running span with no ended_at (the duration_ms arm)', () => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'hi' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: {} },
        { tool_use_id: 't-open', prompt_id: 'p1', ts: at(1) },
      ),
    );

    expect(() => recomputeRollups(db, [`${SESSION}:1`], [SESSION])).not.toThrow();
    const t = trace(`${SESSION}:1`);
    expect(t.duration_ms).toBe(0);
    expect(t.tool_call_count).toBe(1);
    expect(t.total_tokens).toBe(0);
  });
});

describe('rollups — AC1: fixture session totals match hand-computed literals', () => {
  it('mid-session: three tool calls (one failing) and two priced spans', () => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj', model: OPUS }));
    normalize(
      db,
      hookEnvelope('UserPromptSubmit', { prompt: 'do it' }, { prompt_id: 'p1' }),
    );
    toolPair('t-1', { start: 1, end: 2 });
    toolPair('t-2', { start: 2, end: 4 });
    toolPair('t-3', { start: 4, end: 6, fail: true });

    recordSpanUsage(db, 't-1', {
      model: OPUS,
      tokens_in: 1000,
      tokens_out: 200,
      cache_read: 5000,
      cache_write: 300,
    });
    recordSpanUsage(db, 't-2', {
      model: OPUS,
      tokens_in: 400,
      tokens_out: 100,
      cache_read: 0,
      cache_write: 0,
    });

    recomputeRollups(db, [`${SESSION}:1`], [SESSION]);

    // Hand-computed: in 1000+400, out 200+100, cache_read 5000+0, write 300+0.
    const t = trace(`${SESSION}:1`);
    expect(t.tokens_in).toBe(1400);
    expect(t.tokens_out).toBe(300);
    expect(t.tokens_cache_read).toBe(5000);
    expect(t.tokens_cache_write).toBe(300);
    expect(t.total_tokens).toBe(1700);
    expect(t.tool_call_count).toBe(3);
    expect(t.error_count).toBe(1);
    // Turn still open, so duration runs to the latest span close (t=6s).
    expect(t.duration_ms).toBe(6000);

    const expectedCost =
      (1400 * RATE.input + 300 * RATE.output + 5000 * RATE.cache_read + 300 * RATE.cache_write) /
      1_000_000;
    expect(t.est_cost as number).toBeCloseTo(expectedCost, 10);

    const s = session();
    expect(s.tokens_in).toBe(1400);
    expect(s.tokens_out).toBe(300);
    expect(s.tokens_cache_read).toBe(5000);
    expect(s.tokens_cache_write).toBe(300);
    expect(s.total_tokens).toBe(1700);
    expect(s.tool_call_count).toBe(3);
    expect(s.error_count).toBe(1);
    expect(s.trace_count).toBe(1);
    expect(s.status).toBe('live');
    expect(s.ended_at).toBeNull();
    expect(s.est_cost as number).toBeCloseTo(expectedCost, 10);
  });

  it('finalized: two turns sum to the session, both traces closed', () => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj', model: OPUS }));
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'one' }, { prompt_id: 'p1' }));
    toolPair('t-1', { start: 1, end: 2 });
    recordSpanUsage(db, 't-1', { model: OPUS, tokens_in: 1000, tokens_out: 200 });
    normalize(db, hookEnvelope('Stop', {}, { ts: at(3) }));

    // Turn two, its own prompt_id so it opens trace :2.
    normalize(
      db,
      hookEnvelope('UserPromptSubmit', { prompt: 'two' }, { prompt_id: 'p2', ts: at(10) }),
    );
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Read', tool_input: {} },
        { tool_use_id: 't-9', prompt_id: 'p2', ts: at(11) },
      ),
    );
    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Read', tool_response: {}, error: 'nope' },
        { tool_use_id: 't-9', prompt_id: 'p2', ts: at(13) },
      ),
    );
    recordSpanUsage(db, 't-9', { model: OPUS, tokens_in: 50, tokens_out: 7 });
    normalize(db, hookEnvelope('SessionEnd', {}, { ts: at(20) }));

    recomputeRollups(db, [`${SESSION}:1`, `${SESSION}:2`], [SESSION]);

    const t1 = trace(`${SESSION}:1`);
    expect(t1.status).toBe('complete');
    expect(t1.total_tokens).toBe(1200);
    expect(t1.tool_call_count).toBe(1);
    expect(t1.error_count).toBe(0);
    expect(t1.duration_ms).toBe(3000); // started 0s, Stop at 3s

    const t2 = trace(`${SESSION}:2`);
    expect(t2.total_tokens).toBe(57);
    expect(t2.tool_call_count).toBe(1);
    expect(t2.error_count).toBe(1);
    expect(t2.duration_ms).toBe(3000); // started 10s, last span close 13s

    const s = session();
    expect(s.status).toBe('complete');
    expect(s.ended_at).toBe(at(20));
    expect(s.trace_count).toBe(2);
    expect(s.tokens_in).toBe(1050);
    expect(s.tokens_out).toBe(207);
    expect(s.total_tokens).toBe(1257);
    expect(s.error_count).toBe(1);
    expect(s.tool_call_count).toBe(2);
    expect(s.est_cost as number).toBeCloseTo(
      (t1.est_cost as number) + (t2.est_cost as number),
      10,
    );
  });
});

describe('rollups — AC1: replay idempotency proves recompute-over-delta', () => {
  it('re-projecting every envelope leaves byte-identical rollups', () => {
    const envelopes = [
      hookEnvelope('SessionStart', { cwd: '/proj', model: OPUS }),
      hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }),
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { cmd: 'ls' } },
        { tool_use_id: 't-1', prompt_id: 'p1', ts: at(1) },
      ),
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { ok: true } },
        { tool_use_id: 't-1', prompt_id: 'p1', ts: at(2) },
      ),
      hookEnvelope('Stop', {}, { ts: at(3) }),
    ];
    for (const env of envelopes) normalize(db, env);
    recordSpanUsage(db, 't-1', { model: OPUS, tokens_in: 900, tokens_out: 90 });
    recomputeRollups(db, [`${SESSION}:1`], [SESSION]);

    const before = JSON.stringify({ t: trace(`${SESSION}:1`), s: session() });

    // Second projection pass, bypassing the raw-event dedupe entirely: this is
    // what a transcript re-merge or a dead-letter reprocess actually does.
    // `count = count + 1` delta arithmetic doubles every counter here.
    for (const env of envelopes) normalize(db, env);
    recordSpanUsage(db, 't-1', { model: OPUS, tokens_in: 900, tokens_out: 90 });
    recomputeRollups(db, [`${SESSION}:1`], [SESSION]);

    expect(JSON.stringify({ t: trace(`${SESSION}:1`), s: session() })).toBe(before);
    expect(trace(`${SESSION}:1`).tool_call_count).toBe(1);
    expect(session().trace_count).toBe(1);
  });
});

describe('rollups — AC1: duration_ms is clamped at zero', () => {
  it('an out-of-order Stop before started_at cannot produce a negative duration', () => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
    normalize(
      db,
      hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1', ts: at(10) }),
    );
    // Task 2.3 tolerates an out-of-order Stop; unclamped this yields -8000.
    normalize(db, hookEnvelope('Stop', {}, { ts: at(2) }));

    recomputeTraceRollup(db, `${SESSION}:1`);
    expect(trace(`${SESSION}:1`).duration_ms).toBe(0);
  });
});

describe('recordSpanUsage — AC2: null cost for unknown model, version stamped', () => {
  beforeEach(() => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }));
    toolPair('t-1', { start: 1, end: 2 });
    toolPair('t-2', { start: 2, end: 3 });
  });

  it('unknown model leaves est_cost NULL and flags pricing_status', () => {
    recordSpanUsage(db, 't-1', {
      model: 'totally-unknown-9',
      tokens_in: 1000,
      tokens_out: 1000,
    });
    const row = span('t-1');
    expect(row.est_cost).toBeNull();
    const attrs = attrsOf(row);
    expect(attrs.pricing_version).toBe(PRICING_VERSION);
    expect(attrs.pricing_status).toBe('unknown_model');
  });

  it('known model prices the span and carries no pricing_status', () => {
    recordSpanUsage(db, 't-1', { model: OPUS, tokens_in: 1000, tokens_out: 1000 });
    const row = span('t-1');
    expect(row.est_cost as number).toBeGreaterThan(0);
    const attrs = attrsOf(row);
    expect(attrs.pricing_version).toBe(PRICING_VERSION);
    expect(attrs.pricing_status).toBeUndefined();
  });

  it('repricing an unknown span with a known model clears the stale status', () => {
    recordSpanUsage(db, 't-1', { model: 'totally-unknown-9', tokens_in: 10 });
    expect(attrsOf(span('t-1')).pricing_status).toBe('unknown_model');
    recordSpanUsage(db, 't-1', { model: OPUS, tokens_in: 10 });
    expect(attrsOf(span('t-1')).pricing_status).toBeUndefined();
    expect(span('t-1').est_cost as number).toBeGreaterThan(0);
  });

  it('preserves pre-existing attrs keys through the json_set merge', () => {
    // The normalizer stashes harness-drift keys in attrs; pricing must not eat them.
    db.prepare(`UPDATE spans SET attrs = json_set(attrs, '$.drift_key', 'kept') WHERE id = ?`).run(
      't-1',
    );
    recordSpanUsage(db, 't-1', { model: OPUS, tokens_in: 1 });
    const attrs = attrsOf(span('t-1'));
    expect(attrs.drift_key).toBe('kept');
    expect(attrs.pricing_version).toBe(PRICING_VERSION);
  });

  it('records the pricing model on the span row', () => {
    recordSpanUsage(db, 't-1', { model: 'claude-opus-4-8-20260101', tokens_in: 1 });
    expect(span('t-1').model).toBe('claude-opus-4-8-20260101');
  });
});

describe('rollups — AC2: NULL span costs are skipped, never counted as free', () => {
  beforeEach(() => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: 'p1' }));
    toolPair('t-1', { start: 1, end: 2 });
    toolPair('t-2', { start: 2, end: 3 });
  });

  it('a priced + an unpriced span rolls up to only the priced cost', () => {
    recordSpanUsage(db, 't-1', { model: OPUS, tokens_in: 1000, tokens_out: 500 });
    recordSpanUsage(db, 't-2', { model: 'totally-unknown-9', tokens_in: 9000, tokens_out: 9000 });

    recomputeRollups(db, [`${SESSION}:1`], [SESSION]);

    const pricedOnly = (1000 * RATE.input + 500 * RATE.output) / 1_000_000;
    expect(trace(`${SESSION}:1`).est_cost as number).toBeCloseTo(pricedOnly, 10);
    expect(session().est_cost as number).toBeCloseTo(pricedOnly, 10);
    // Tokens still count for the unpriced span — only the money is unknown.
    expect(trace(`${SESSION}:1`).total_tokens).toBe(1000 + 500 + 9000 + 9000);
  });

  it('an entirely unpriced trace rolls up to 0 without throwing', () => {
    recordSpanUsage(db, 't-1', { model: 'totally-unknown-9', tokens_in: 10 });
    recordSpanUsage(db, 't-2', { model: 'totally-unknown-9', tokens_in: 20 });

    expect(() => recomputeRollups(db, [`${SESSION}:1`], [SESSION])).not.toThrow();
    expect(trace(`${SESSION}:1`).est_cost).toBe(0);
    expect(trace(`${SESSION}:1`).total_tokens).toBe(30);
  });
});

describe('rollups — dirty-set flush touches only the named parents', () => {
  it('recomputes one trace without bleeding into a sibling', () => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'a' }, { prompt_id: 'p1' }));
    toolPair('t-1', { start: 1, end: 2 });
    normalize(db, hookEnvelope('Stop', {}, { ts: at(3) }));
    normalize(
      db,
      hookEnvelope('UserPromptSubmit', { prompt: 'b' }, { prompt_id: 'p2', ts: at(4) }),
    );

    recomputeTraceRollup(db, `${SESSION}:1`);

    expect(trace(`${SESSION}:1`).tool_call_count).toBe(1);
    // :2 was never flushed, so it keeps its insert-time defaults.
    expect(trace(`${SESSION}:2`).tool_call_count).toBe(0);
    expect(trace(`${SESSION}:2`).duration_ms).toBe(0);

    const traces = db.prepare('SELECT * FROM traces ORDER BY turn_seq').all() as Row[];
    expect(only(traces, (r) => r.id === `${SESSION}:1`).tool_call_count).toBe(1);
  });
});
