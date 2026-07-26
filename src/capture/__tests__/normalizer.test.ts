import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../db/migrate.js';
import { ensurePromptTraceMap } from '../../db/index.js';
import { makeEnvelope } from '../../shared/index.js';
import type { Envelope } from '../../shared/index.js';
import { normalize, mapToolStatus } from '../normalizer.js';
import { ingestEnvelope } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';

// In-memory migrated DB per test (migrate.test conventions) + the prompt→trace
// side-table `openDb` would create. The normalizer assumes it runs inside a
// transaction; these tests call it directly (single implicit txn is fine).

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  ensurePromptTraceMap(db);
  return db;
}

const SESSION = 'sess-1';
const TS = '2026-07-26T00:00:00.000Z';

/**
 * Build a hook envelope with a deterministic id from its correlators. Real
 * hook payloads carry `tool_use_id`/`prompt_id` as payload fields (tracer
 * findings Q5), so mirror them into `raw_payload` — that's what the normalizer
 * reads for span/trace identity.
 */
function hookEnvelope(
  hook_name: string,
  raw_payload: Record<string, unknown>,
  overrides: Partial<{ tool_use_id: string; prompt_id: string; ts: string }> = {},
): Envelope {
  const payload: Record<string, unknown> = { ...raw_payload };
  if (overrides.tool_use_id !== undefined) payload.tool_use_id = overrides.tool_use_id;
  if (overrides.prompt_id !== undefined) payload.prompt_id = overrides.prompt_id;
  return makeEnvelope({
    source: 'hook',
    session_id: SESSION,
    hook_name,
    raw_payload: payload,
    ts: overrides.ts ?? TS,
    tool_use_id: overrides.tool_use_id,
    prompt_id: overrides.prompt_id,
  });
}

type Row = Record<string, unknown>;

const sessions = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM sessions').all() as Row[];
const traces = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM traces').all() as Row[];
const spans = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM spans').all() as Row[];
const payloads = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM payloads').all() as Row[];

/** First row, asserted present — keeps strict-null tests terse. */
function first(rows: Row[]): Row {
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]!;
}

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
  const rawEvents = (db: DatabaseSync): Row[] =>
    db.prepare('SELECT * FROM raw_events').all() as Row[];

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

  it('archives even an unknown hook without throwing', () => {
    const db = freshDb();
    const bc = new Broadcaster();
    const env = hookEnvelope('WeirdHook', { anything: true });
    expect(() => ingestEnvelope(db, bc, env)).not.toThrow();
    const rawRows = rawEvents(db);
    expect(rawRows).toHaveLength(1);
    expect(first(rawRows).status).toBe('processed');
  });
});
