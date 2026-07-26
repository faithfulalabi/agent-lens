// AC1 (drift never crashes, never silently drops) + AC2 (orphan activity gets an
// honest synthetic trace) for Task 2.3. Fixtures are hand-written envelopes
// shaped from the empirical payload keys in research/ — Task 1.7's golden
// fixtures do not exist yet, and golden replay is Task 2.6.

import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { normalize } from '../normalizer.js';
import { ingestEnvelope } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';
import { ingestHealth, upsertSpan } from '../../db/index.js';
import {
  freshDb,
  hookEnvelope,
  first,
  only,
  spans,
  traces,
  rawEvents,
  tagsOf,
  attrsOf,
  SESSION,
  TS,
} from './fixtures.js';

let db: DatabaseSync;
let bc: Broadcaster;

beforeEach(() => {
  db = freshDb();
  bc = new Broadcaster();
});

/** UserPromptSubmit -> Stop: one completed turn, the precondition for orphans. */
function completedTurn(promptId = 'p1'): void {
  normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: promptId }));
  normalize(db, hookEnvelope('Stop', {}, { ts: '2026-07-26T00:10:00.000Z' }));
}

describe('AC1 — version drift degrades visibly and never wedges ingest', () => {
  it('an unknown hook yields a degraded span and a degraded archive row', () => {
    const env = hookEnvelope('SomeFutureHook_v3', { novel_field: 'value' });
    expect(() => ingestEnvelope(db, bc, env)).not.toThrow();

    const span = only(spans(db), (r) => r.span_type === 'generic');
    expect(span.name).toBe('SomeFutureHook_v3');
    expect(span.status).toBe('unknown');
    // Membership, not equality: the tag union re-sorts.
    expect(tagsOf(span)).toContain('degraded');
    expect(attrsOf(span)).toMatchObject({ novel_field: 'value' });

    const raw = first(rawEvents(db));
    expect(raw.status).toBe('degraded');
    expect(raw.error).toMatch(/unknown hook SomeFutureHook_v3/);
  });

  it('extra fields on a KNOWN hook are stashed in attrs and stay processed', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    const env = hookEnvelope(
      'PreToolUse',
      {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        prompt_id: 'p1',
        cwd: '/proj',
        future_field_a: 'kept',
        nested: { depth: { value: 7 } },
      },
      { tool_use_id: 'toolu_1', prompt_id: 'p1' },
    );
    ingestEnvelope(db, bc, env);

    const span = only(spans(db), (r) => r.id === 'toolu_1');
    // Exactly the unrecognized keys, values intact — known/common keys excluded.
    expect(attrsOf(span)).toEqual({
      future_field_a: 'kept',
      nested: { depth: { value: 7 } },
    });
    // Known columns unaffected by the overflow.
    expect(span.name).toBe('Bash');
    expect(span.status).toBe('running');
    expect(span.input_payload_id).toBeTruthy();
    // Extra fields are preservation, not degradation.
    expect(first(rawEvents(db)).status).toBe('processed');
  });

  it('tags and attrs survive later upserts, including Task 2.4 stamps', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    // Post arrives first: span opens tagged synthetic_open with a drift key.
    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { stdout: 'ok' }, drift_a: 1, prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );
    // Simulate Task 2.4 stamping the pricing version onto the same row.
    db.exec(`UPDATE spans SET attrs = json_set(attrs, '$.pricing_version', 'v1')`);
    // A late Pre adds a second drift key, an empty tag list, and no attrs of note.
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { command: 'ls' }, drift_b: 2, prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );

    const span = only(spans(db), (r) => r.id === 'toolu_1');
    expect(attrsOf(span)).toEqual({ drift_a: 1, pricing_version: 'v1', drift_b: 2 });
    expect(tagsOf(span)).toContain('synthetic_open');
    // Terminal-status guard: the late open must not revert a closed span.
    expect(span.status).toBe('ok');
  });

  it('a null-valued drift key cannot delete an already-stashed key', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', keep_me: 'here', prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );
    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', keep_me: null, prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );

    // json_patch treats an explicit null as a delete; overflowAttrs omits nulls.
    expect(attrsOf(only(spans(db), (r) => r.id === 'toolu_1'))).toEqual({
      keep_me: 'here',
    });
  });

  it('a projection failure dead-letters and rolls back instead of throwing', () => {
    db.exec('DROP TABLE spans');
    const env = hookEnvelope(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: { command: 'ls' }, prompt_id: 'p1' },
      { tool_use_id: 'toolu_1', prompt_id: 'p1' },
    );

    let result!: ReturnType<typeof ingestEnvelope>;
    expect(() => {
      result = ingestEnvelope(db, bc, env);
    }).not.toThrow();
    expect(result).toEqual({ inserted: true, seq: 1, deadLettered: true });

    const raw = first(rawEvents(db));
    expect(raw.status).toBe('dead_letter');
    expect(String(raw.error)).toMatch(/no such table: spans/);
    // The rollback held: nothing the failed projection wrote survived.
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM traces').get()).toEqual({ n: 0 });
  });

  it('ingestHealth counts the archive by status', () => {
    ingestEnvelope(db, bc, hookEnvelope('SessionStart', { cwd: '/proj' }));
    ingestEnvelope(db, bc, hookEnvelope('SomeFutureHook_v3', { a: 1 }));
    ingestEnvelope(db, bc, hookEnvelope('SessionEnd', {}), 'dead_letter');

    expect(ingestHealth(db)).toEqual({ processed: 1, degraded: 1, dead_letter: 1 });
  });
});

describe('AC2 — orphan activity synthesizes an honestly-labelled trace', () => {
  it('a promptless Notification after Stop opens a system_resume trace', () => {
    completedTurn();
    normalize(db, hookEnvelope('Notification', { message: 'resumed' }));
    normalize(
      db,
      hookEnvelope('PreToolUse', { tool_name: 'Bash' }, { tool_use_id: 'toolu_late' }),
    );

    const rows = traces(db);
    expect(rows).toHaveLength(2);
    const resumed = only(rows, (r) => r.id === `${SESSION}:2`);
    expect(resumed.trigger).toBe('system_resume');
    expect(resumed.status).toBe('live');
    // Both the notification span and the later tool span land on the new turn.
    for (const span of spans(db)) expect(span.trace_id).toBe(`${SESSION}:2`);
  });

  it('a resumed SessionStart labels later orphan activity system_resume', () => {
    // Ingested (not normalized directly) so the raw archive backs the lookback.
    ingestEnvelope(
      db,
      bc,
      hookEnvelope('SessionStart', { cwd: '/proj', source: 'resume' }),
    );
    // SessionStart must not burn a turn_seq on an empty trace.
    expect(traces(db)).toHaveLength(0);

    ingestEnvelope(
      db,
      bc,
      hookEnvelope('PreToolUse', { tool_name: 'Bash' }, { tool_use_id: 'toolu_1' }),
    );

    const trace = first(traces(db));
    expect(trace.id).toBe(`${SESSION}:1`);
    expect(trace.trigger).toBe('system_resume');
  });

  it('compaction hooks with no open trace open a compaction trace', () => {
    completedTurn();
    normalize(db, hookEnvelope('PreCompact', { trigger: 'manual' }));
    normalize(db, hookEnvelope('PostCompact', { trigger: 'manual', compact_summary: 's' }));

    const compaction = only(traces(db), (r) => r.trigger === 'compaction');
    expect(compaction.id).toBe(`${SESSION}:2`);
    const compactSpans = spans(db).filter((r) => r.trace_id === `${SESSION}:2`);
    expect(compactSpans.map((r) => r.name).sort()).toEqual(['PostCompact', 'PreCompact']);
  });

  it('prompt_id wins: a late Post for a completed turn stays on that turn', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { command: 'ls' }, prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );
    normalize(db, hookEnvelope('Stop', {}, { ts: '2026-07-26T00:10:00.000Z' }));
    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { stdout: 'ok' }, prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1', ts: '2026-07-26T00:11:00.000Z' },
      ),
    );

    // The correlator is authoritative: no new trace, and the pair stays together.
    expect(traces(db)).toHaveLength(1);
    const span = only(spans(db), (r) => r.id === 'toolu_1');
    expect(span.trace_id).toBe(`${SESSION}:1`);
    expect(span.status).toBe('ok');
  });

  it('promptless post-Stop activity does synthesize a new trace', () => {
    completedTurn();
    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { stdout: 'ok' } },
        { tool_use_id: 'toolu_orphan', ts: '2026-07-26T00:11:00.000Z' },
      ),
    );

    const rows = traces(db);
    expect(rows).toHaveLength(2);
    const original = only(rows, (r) => r.id === `${SESSION}:1`);
    expect(original.status).toBe('complete');
    expect(original.ended_at).toBe('2026-07-26T00:10:00.000Z');
    expect(only(spans(db), (r) => r.id === 'toolu_orphan').trace_id).toBe(`${SESSION}:2`);
  });

  it('rollup inputs stay partitioned: no orphan span pollutes the closed turn', () => {
    completedTurn();
    normalize(db, hookEnvelope('Notification', { message: 'resumed' }));
    normalize(db, hookEnvelope('PreCompact', { trigger: 'auto' }));
    normalize(
      db,
      hookEnvelope('PostToolUse', { tool_name: 'Bash' }, { tool_use_id: 'toolu_orphan' }),
    );

    const byTrace = db
      .prepare('SELECT trace_id, COUNT(*) AS n FROM spans GROUP BY trace_id')
      .all() as unknown as { trace_id: string; n: number }[];
    // Zero promptless post-Stop spans on the completed turn.
    expect(byTrace.find((r) => r.trace_id === `${SESSION}:1`)).toBeUndefined();
    expect(byTrace).toEqual([{ trace_id: `${SESSION}:2`, n: 3 }]);

    // turn_seq stays contiguous, and the closed turn is untouched.
    expect(traces(db).map((r) => r.turn_seq)).toEqual([1, 2]);
    const original = only(traces(db), (r) => r.id === `${SESSION}:1`);
    expect(original.status).toBe('complete');
    expect(original.ended_at).toBe('2026-07-26T00:10:00.000Z');
  });

  it('activity during a live turn attaches to it with no spurious synthesis', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope('PreToolUse', { tool_name: 'Bash' }, { tool_use_id: 'toolu_1' }),
    );
    normalize(db, hookEnvelope('Notification', { message: 'thinking' }));

    expect(traces(db)).toHaveLength(1);
    for (const span of spans(db)) expect(span.trace_id).toBe(`${SESSION}:1`);
  });
});

describe('What-clause coverage — synthetic_open and finalization', () => {
  it('a Post with no prior Pre is tagged synthetic_open with the close as start', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { stdout: 'ok' }, prompt_id: 'p1' },
        { tool_use_id: 'toolu_orphan', prompt_id: 'p1', ts: '2026-07-26T00:05:00.000Z' },
      ),
    );

    const span = only(spans(db), (r) => r.id === 'toolu_orphan');
    expect(tagsOf(span)).toEqual(['synthetic_open']);
    expect(span.started_at).toBe('2026-07-26T00:05:00.000Z');
  });

  it('a matched Pre -> Post pair is not tagged synthetic_open', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );
    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { stdout: 'ok' }, prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );

    expect(tagsOf(only(spans(db), (r) => r.id === 'toolu_1'))).toEqual([]);
  });

  it('Stop closes still-running spans as unknown', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );
    normalize(db, hookEnvelope('Stop', {}, { ts: '2026-07-26T00:10:00.000Z' }));

    const span = only(spans(db), (r) => r.id === 'toolu_1');
    expect(span.status).toBe('unknown');
    expect(span.ended_at).toBe('2026-07-26T00:10:00.000Z');
  });

  it('SessionEnd closes still-running spans across every live trace', () => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );
    normalize(db, hookEnvelope('SessionEnd', {}, { ts: '2026-07-26T01:00:00.000Z' }));

    const span = only(spans(db), (r) => r.id === 'toolu_1');
    expect(span.status).toBe('unknown');
    expect(span.ended_at).toBe('2026-07-26T01:00:00.000Z');
  });

  it('a raw upsert of an already-closed span keeps its terminal status', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    const base = {
      id: 'toolu_1',
      trace_id: `${SESSION}:1`,
      span_type: 'tool_call' as const,
      name: 'Bash',
      started_at: TS,
      source: 'hook' as const,
    };
    upsertSpan(db, { ...base, status: 'error', ended_at: TS });
    upsertSpan(db, { ...base, status: 'running' });
    expect(only(spans(db), (r) => r.id === 'toolu_1').status).toBe('error');
    // A different terminal status still wins — only `running` is refused.
    upsertSpan(db, { ...base, status: 'ok', ended_at: TS });
    expect(only(spans(db), (r) => r.id === 'toolu_1').status).toBe('ok');
  });
});
