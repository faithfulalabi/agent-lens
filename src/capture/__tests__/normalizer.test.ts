import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { normalize, mapToolStatus } from '../normalizer.js';
import { makeEnvelope } from '../../shared/index.js';
import type { Envelope } from '../../shared/index.js';
import { ingestEnvelope } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';
import {
  freshDb,
  hookEnvelope,
  first,
  sessions,
  traces,
  spans,
  payloads,
  rawEvents,
  SESSION,
  TS,
} from './fixtures.js';

describe('normalizer — AC1: each hook type projects the expected rows', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });

  it('SessionStart opens a live session', () => {
    normalize(
      db,
      hookEnvelope('SessionStart', {
        cwd: '/proj',
        model: 'claude-opus-4-8',
        transcript_path: '/t.jsonl',
      }),
    );
    const rows = sessions(db);
    expect(rows).toHaveLength(1);
    const s = first(rows);
    expect(s.id).toBe(SESSION);
    expect(s.status).toBe('live');
    expect(s.project_path).toBe('/proj');
    expect(s.model).toBe('claude-opus-4-8');
  });

  it('SessionEnd closes the session complete with ended_at', () => {
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
    normalize(db, hookEnvelope('SessionEnd', {}, { ts: '2026-07-26T01:00:00.000Z' }));
    const rows = sessions(db);
    expect(rows).toHaveLength(1);
    const s = first(rows);
    expect(s.status).toBe('complete');
    expect(s.ended_at).toBe('2026-07-26T01:00:00.000Z');
    // project_path from SessionStart is preserved (COALESCE), not clobbered.
    expect(s.project_path).toBe('/proj');
  });

  it('UserPromptSubmit opens a trace keyed {session}:{turn_seq}', () => {
    normalize(
      db,
      hookEnvelope('UserPromptSubmit', { prompt: 'do the thing' }, { prompt_id: 'p1' }),
    );
    const rows = traces(db);
    expect(rows).toHaveLength(1);
    const t = first(rows);
    expect(t.id).toBe(`${SESSION}:1`);
    expect(t.turn_seq).toBe(1);
    expect(t.trigger).toBe('user_prompt');
    expect(t.prompt_preview).toBe('do the thing');
    expect(t.status).toBe('live');
  });

  it('PreToolUse opens a running tool span keyed by tool_use_id', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { command: 'ls' }, prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );
    const rows = spans(db);
    expect(rows).toHaveLength(1);
    const sp = first(rows);
    expect(sp.id).toBe('toolu_1');
    expect(sp.span_type).toBe('tool_call');
    expect(sp.name).toBe('Bash');
    expect(sp.status).toBe('running');
    expect(sp.input_payload_id).toBeTruthy();
    expect(sp.output_payload_id).toBeNull();
    expect(sp.trace_id).toBe(`${SESSION}:1`);
  });

  it('PostToolUse closes the tool span ok with output payload', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        {
          tool_name: 'Bash',
          tool_response: { stdout: 'ok', interrupted: false },
          prompt_id: 'p1',
        },
        { tool_use_id: 'toolu_1', prompt_id: 'p1' },
      ),
    );
    const rows = spans(db);
    expect(rows).toHaveLength(1);
    const sp = first(rows);
    expect(sp.status).toBe('ok');
    expect(sp.ended_at).toBe(TS);
    expect(sp.output_payload_id).toBeTruthy();
  });

  it('SubagentStart/Stop open+close a subagent span keyed by agent_id', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose', prompt_id: 'p1' }),
    );
    const opened = spans(db);
    expect(opened).toHaveLength(1);
    const started = first(opened);
    expect(started.id).toBe('a1');
    expect(started.span_type).toBe('subagent');
    expect(started.status).toBe('running');

    normalize(
      db,
      hookEnvelope('SubagentStop', { agent_id: 'a1', agent_type: 'general-purpose', prompt_id: 'p1' }),
    );
    const closed = spans(db);
    expect(closed).toHaveLength(1);
    const stopped = first(closed);
    expect(stopped.status).toBe('ok');
    expect(stopped.ended_at).toBe(TS);
  });

  it('Stop closes the active trace complete', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(db, hookEnvelope('Stop', {}, { ts: '2026-07-26T02:00:00.000Z' }));
    const rows = traces(db);
    expect(rows).toHaveLength(1);
    const t = first(rows);
    expect(t.status).toBe('complete');
    expect(t.ended_at).toBe('2026-07-26T02:00:00.000Z');
  });

  it('PreCompact and PostCompact each record a generic span', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(db, hookEnvelope('PreCompact', { trigger: 'manual', prompt_id: 'p1' }));
    normalize(db, hookEnvelope('PostCompact', { compact_summary: 's', prompt_id: 'p1' }));
    const generic = spans(db).filter((r) => r.span_type === 'generic');
    expect(generic.map((r) => r.name).sort()).toEqual(['PostCompact', 'PreCompact']);
    for (const g of generic) expect(g.status).toBe('ok');
  });

  it('an unknown hook degrades to a generic span and never throws', () => {
    expect(() =>
      normalize(db, hookEnvelope('SomeFutureHook', { foo: 'bar' })),
    ).not.toThrow();
    const rows = spans(db).filter((r) => r.span_type === 'generic');
    expect(rows).toHaveLength(1);
    const generic = first(rows);
    expect(generic.name).toBe('SomeFutureHook');
    expect(generic.status).toBe('unknown');
  });

  it('a non-object raw_payload is tolerated (never throws)', () => {
    const env = { ...hookEnvelope('SessionStart', {}), raw_payload: 'oops' };
    expect(() => normalize(db, env)).not.toThrow();
    expect(sessions(db)).toHaveLength(1);
  });
});

describe('normalizer — AC2: Pre→Post correlation yields one span', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });

  it('Pre then Post sharing a tool_use_id collapse to one ok span with I/O', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { command: 'ls' }, prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1', ts: '2026-07-26T00:00:00.000Z' },
      ),
    );
    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: { stdout: 'files' }, prompt_id: 'p1' },
        { tool_use_id: 'toolu_1', prompt_id: 'p1', ts: '2026-07-26T00:00:05.000Z' },
      ),
    );

    const rows = spans(db);
    expect(rows).toHaveLength(1);
    const sp = first(rows);
    expect(sp.id).toBe('toolu_1');
    expect(sp.status).toBe('ok');
    expect(sp.started_at).toBe('2026-07-26T00:00:00.000Z');
    expect(sp.ended_at).toBe('2026-07-26T00:00:05.000Z');
    expect(sp.input_payload_id).toBeTruthy();
    expect(sp.output_payload_id).toBeTruthy();
  });

  it('Pre then PostToolUseFailure maps the same span to error', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(
      db,
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { command: 'boom' }, prompt_id: 'p1' },
        { tool_use_id: 'toolu_2', prompt_id: 'p1' },
      ),
    );
    normalize(
      db,
      hookEnvelope(
        'PostToolUseFailure',
        { tool_name: 'Bash', error: 'nonzero exit', prompt_id: 'p1' },
        { tool_use_id: 'toolu_2', prompt_id: 'p1' },
      ),
    );

    const rows = spans(db);
    expect(rows).toHaveLength(1);
    const sp = first(rows);
    expect(sp.id).toBe('toolu_2');
    expect(sp.status).toBe('error');
  });
});

describe('normalizer — mapToolStatus (denied synthetic; TODO task-1.7)', () => {
  it('maps ok / error / denied outcomes', () => {
    expect(mapToolStatus({ tool_response: { stdout: 'x' } })).toBe('ok');
    expect(mapToolStatus({ error: 'boom' })).toBe('error');
    expect(mapToolStatus({ tool_response: { interrupted: true } })).toBe('error');
    // Synthetic deny payload — the real field is frozen against Task 1.7 fixtures.
    expect(mapToolStatus({ permissionDecision: 'deny' })).toBe('denied');
    expect(mapToolStatus({ permission_denied: true })).toBe('denied');
  });
});

describe('normalizer — AC3: identical payload content dedups to one row', () => {
  it('two spans with byte-identical tool_response share one payload row', () => {
    const db = freshDb();
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));

    const response = { stdout: 'identical bytes', interrupted: false };
    for (const id of ['toolu_a', 'toolu_b']) {
      normalize(
        db,
        hookEnvelope(
          'PostToolUse',
          { tool_name: 'Bash', tool_response: response, prompt_id: 'p1' },
          { tool_use_id: id, prompt_id: 'p1' },
        ),
      );
    }

    const sp = spans(db);
    expect(sp).toHaveLength(2);
    // Both output payload ids equal (= sha256 of the same content).
    expect(sp[0]!.output_payload_id).toBe(sp[1]!.output_payload_id);
    // Only one physical payload row for that content.
    const outputIds = new Set(sp.map((r) => r.output_payload_id));
    const rows = payloads(db).filter((p) => outputIds.has(p.id));
    expect(rows).toHaveLength(1);
  });
});

describe('normalizer — AC4: every processed envelope archives + is idempotent', () => {
  it('records a raw_event status=processed and re-ingest adds no rows', () => {
    const db = freshDb();
    const bc = new Broadcaster();
    const env = hookEnvelope(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: { command: 'ls' }, prompt_id: 'p1' },
      { tool_use_id: 'toolu_1', prompt_id: 'p1' },
    );

    const firstIngest = ingestEnvelope(db, bc, env);
    expect(firstIngest.inserted).toBe(true);

    const rawRows = rawEvents(db);
    expect(rawRows).toHaveLength(1);
    const raw = first(rawRows);
    expect(raw.id).toBe(env.event_id);
    expect(raw.status).toBe('processed');

    const spansAfterFirst = spans(db).length;

    // Re-ingest the identical envelope: no new raw row, no duplicate span.
    const second = ingestEnvelope(db, bc, env);
    expect(second.inserted).toBe(false);
    expect(rawEvents(db)).toHaveLength(1);
    expect(spans(db)).toHaveLength(spansAfterFirst);
  });

  it('archives even an unknown hook without throwing, flagged degraded', () => {
    const db = freshDb();
    const bc = new Broadcaster();
    const env = hookEnvelope('WeirdHook', { anything: true });
    expect(() => ingestEnvelope(db, bc, env)).not.toThrow();
    const rawRows = rawEvents(db);
    expect(rawRows).toHaveLength(1);
    // Task 2.3: an unrecognized hook is a visible degradation, not a clean pass.
    expect(first(rawRows).status).toBe('degraded');
  });
});

describe('normalizer — post-Stop attachment (Task 2.3 regression)', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });

  it('promptless activity after Stop never lands on the completed trace', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(db, hookEnvelope('Stop', {}, { ts: '2026-07-26T02:00:00.000Z' }));
    normalize(
      db,
      hookEnvelope('PreToolUse', { tool_name: 'Bash' }, { tool_use_id: 'toolu_late' }),
    );

    const rows = traces(db);
    expect(rows).toHaveLength(2);
    expect(first(rows).status).toBe('complete');
    expect(rows[1]!.id).toBe(`${SESSION}:2`);
    expect(rows[1]!.status).toBe('live');
    const span = first(spans(db));
    expect(span.trace_id).toBe(`${SESSION}:2`);
  });

  it('a Stop with no live trace is a no-op, not a second close', () => {
    normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id: 'p1' }));
    normalize(db, hookEnvelope('Stop', {}, { ts: '2026-07-26T02:00:00.000Z' }));
    normalize(db, hookEnvelope('Stop', {}, { ts: '2026-07-26T03:00:00.000Z' }));

    const rows = traces(db);
    expect(rows).toHaveLength(1);
    expect(first(rows).ended_at).toBe('2026-07-26T02:00:00.000Z');
  });
});

describe('normalizer — transcript envelopes (Task 3.1, scoped guard)', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });

  /** A transcript-sourced envelope, as the tailer builds one. */
  function transcriptEnvelope(
    payload: Record<string, unknown>,
    overrides: { session_id?: string; ts?: string; uuid?: string } = {},
  ): Envelope {
    return makeEnvelope({
      source: 'transcript',
      session_id: overrides.session_id ?? SESSION,
      file_identity: '/private/tmp/projects/proj/sess-1.jsonl',
      line_offset: 0,
      line: JSON.stringify(payload),
      uuid: overrides.uuid ?? 'line-1',
      raw_payload: payload,
      ts: overrides.ts ?? TS,
    });
  }

  it('revives an interrupted session — the guard is NOT a top-of-function return', () => {
    // Goes RED if the transcript branch is placed ahead of `reviveSession`: a
    // session the sweep interrupted would stay interrupted forever while its
    // transcript is visibly growing.
    normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
    db.prepare(`UPDATE sessions SET status = 'interrupted' WHERE id = ?`).run(SESSION);

    normalize(db, transcriptEnvelope({ type: 'assistant', cwd: '/proj' }));
    expect(first(sessions(db)).status).toBe('live');
  });

  it('creates a taggable session row from a cwd-carrying line', () => {
    // Task 3.3 (parallel with 3.2) needs this row to exist; without it its AC1
    // is unreachable until 3.2 lands.
    normalize(db, transcriptEnvelope({ type: 'assistant', cwd: '/Users/dev/proj' }));

    const rows = sessions(db);
    expect(rows).toHaveLength(1);
    expect(first(rows)).toMatchObject({
      id: SESSION,
      project_path: '/Users/dev/proj',
      capture_mode: 'transcript_only',
      status: 'live',
      started_at: TS,
    });
  });

  it('never clobbers a hook-created session', () => {
    // Goes RED if `upsertSession` is used instead of insert-if-absent: its
    // conflict clause sets `status = excluded.status`, resurrecting a completed
    // session to `live` on any late transcript line.
    normalize(db, hookEnvelope('SessionStart', { cwd: '/real/proj' }));
    normalize(db, hookEnvelope('SessionEnd', {}, { ts: '2026-07-26T05:00:00.000Z' }));
    expect(first(sessions(db)).status).toBe('complete');

    normalize(
      db,
      transcriptEnvelope(
        { type: 'assistant', cwd: '/wrong/proj' },
        { ts: '2026-07-26T06:00:00.000Z' },
      ),
    );

    expect(first(sessions(db))).toMatchObject({
      project_path: '/real/proj',
      capture_mode: 'full',
      status: 'complete',
    });
  });

  it('projects no traces and no spans, and never counts as drift', () => {
    // Guards the scoped early return against regressing into the `genericSpan`
    // default branch, which would mint a degraded span for every line.
    const verdict = normalize(db, transcriptEnvelope({ type: 'assistant', cwd: '/proj' }));
    expect(verdict.degraded).toBe(false);
    expect(traces(db)).toHaveLength(0);
    expect(spans(db)).toHaveLength(0);
  });

  it('creates no session row from cwd-less lines', () => {
    // Pins the `cwd` gate: a row minted with `project_path:'unknown'` could
    // never be repaired, because `upsertSession` does not update that column.
    normalize(db, transcriptEnvelope({ type: 'file-history-snapshot', messageId: 'm1' }));
    expect(sessions(db)).toHaveLength(0);
  });

  it('lets the first hook repair a transcript_only label', () => {
    // Goes RED without `setCaptureMode`: `upsertSession`'s ON CONFLICT list
    // omits `capture_mode`, so the tailer winning the race would mislabel the
    // session forever and pre-empt Task 3.3's upgrade path.
    normalize(db, transcriptEnvelope({ type: 'assistant', cwd: '/Users/dev/proj' }));
    expect(first(sessions(db)).capture_mode).toBe('transcript_only');

    normalize(
      db,
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', cwd: '/Users/dev/proj' },
        { tool_use_id: 'toolu_1', ts: '2026-07-26T07:00:00.000Z' },
      ),
    );

    expect(first(sessions(db))).toMatchObject({
      capture_mode: 'full',
      project_path: '/Users/dev/proj',
      started_at: TS,
    });
  });
});
