// Shared capture-test fixtures: a migrated in-memory DB, an envelope factory,
// and row readers. Lifted out of `normalizer.test.ts` so the resilience,
// inactivity, and reprocess suites all build state the same way.

import { expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../db/migrate.js';
import { ensurePromptTraceMap } from '../../db/index.js';
import { makeEnvelope } from '../../shared/index.js';
import type { Envelope } from '../../shared/index.js';

export const SESSION = 'sess-1';
export const TS = '2026-07-26T00:00:00.000Z';

/**
 * ISO timestamp `seconds` after the fixture epoch {@link TS}. The one way to
 * build a ts-spaced envelope sequence, so the rollup tests, the golden seed
 * fixtures, and Task 2.6's property generator all space events identically.
 */
export function at(seconds: number): string {
  return new Date(Date.parse(TS) + seconds * 1000).toISOString();
}

/**
 * In-memory migrated DB per test (migrate.test conventions) plus the
 * prompt→trace side-table `openDb` would create. The normalizer assumes it runs
 * inside a transaction; direct calls rely on SQLite's implicit per-statement one.
 */
export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  ensurePromptTraceMap(db);
  return db;
}

/**
 * Build a hook envelope with a deterministic id from its correlators. Real hook
 * payloads carry `tool_use_id`/`prompt_id` as payload fields (tracer findings
 * Q5), so mirror them into `raw_payload` — that's what the normalizer reads for
 * span/trace identity.
 */
export function hookEnvelope(
  hook_name: string,
  raw_payload: Record<string, unknown>,
  overrides: Partial<{
    tool_use_id: string;
    prompt_id: string;
    ts: string;
    session_id: string;
  }> = {},
): Envelope {
  const payload: Record<string, unknown> = { ...raw_payload };
  if (overrides.tool_use_id !== undefined) payload.tool_use_id = overrides.tool_use_id;
  if (overrides.prompt_id !== undefined) payload.prompt_id = overrides.prompt_id;
  return makeEnvelope({
    source: 'hook',
    session_id: overrides.session_id ?? SESSION,
    hook_name,
    raw_payload: payload,
    ts: overrides.ts ?? TS,
    tool_use_id: overrides.tool_use_id,
    prompt_id: overrides.prompt_id,
  });
}

/**
 * A transcript-sourced envelope, as the tailer builds one. Promoted out of
 * `normalizer.test.ts` for Task 3.2, whose merge suites all need it.
 *
 * The line's `uuid` and the envelope's are kept in lockstep deliberately: the
 * event id is `{session}:transcript:{uuid}` and the `parentUuid` ancestor walk
 * looks lines up by exactly that key, so a fixture where the two disagree would
 * make correlation silently unresolvable.
 */
export function transcriptEnvelope(
  payload: Record<string, unknown>,
  overrides: {
    session_id?: string;
    ts?: string;
    uuid?: string;
    line_offset?: number;
  } = {},
): Envelope {
  const uuid =
    overrides.uuid ?? (typeof payload.uuid === 'string' ? payload.uuid : 'line-1');
  const line = { ...payload, uuid };
  const session_id = overrides.session_id ?? SESSION;
  return makeEnvelope({
    source: 'transcript',
    session_id,
    file_identity: `/private/tmp/projects/proj/${session_id}.jsonl`,
    line_offset: overrides.line_offset ?? 0,
    line: JSON.stringify(line),
    uuid,
    raw_payload: line,
    ts: overrides.ts ?? TS,
  });
}

/**
 * A `user` transcript line carrying a `tool_result` block AND the line's
 * `toolUseResult` mirror — the shape every merge output-side test needs.
 *
 * Both surfaces on purpose: the truncation gate reads `toolUseResult` (the
 * transcript's byte-identical copy of the hook's `tool_response`), while the
 * content and the text marker live on the `tool_result` block. A fixture that
 * set the harness fields on the hook envelope alone would leave the gate blind.
 */
export function toolResultLine(input: {
  tool_use_id: string;
  /** The `tool_result` block's content — usually the rendered output string. */
  content: unknown;
  /** The line's `toolUseResult`; omit to model a build that emits none. */
  toolUseResult?: unknown;
  is_error?: boolean;
  uuid?: string;
  promptId?: string;
  parentUuid?: string;
  cwd?: string;
}): Record<string, unknown> {
  const block: Record<string, unknown> = {
    type: 'tool_result',
    tool_use_id: input.tool_use_id,
    content: input.content,
  };
  if (input.is_error !== undefined) block.is_error = input.is_error;
  const line: Record<string, unknown> = {
    type: 'user',
    uuid: input.uuid ?? 'line-result',
    cwd: input.cwd ?? '/proj',
    message: { role: 'user', content: [block] },
  };
  if (input.toolUseResult !== undefined) line.toolUseResult = input.toolUseResult;
  if (input.promptId !== undefined) line.promptId = input.promptId;
  if (input.parentUuid !== undefined) line.parentUuid = input.parentUuid;
  return line;
}

export type Row = Record<string, unknown>;

export const sessions = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM sessions').all() as Row[];
export const traces = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM traces ORDER BY turn_seq').all() as Row[];
export const spans = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM spans').all() as Row[];
export const payloads = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM payloads').all() as Row[];
export const messages = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM messages ORDER BY trace_id, seq').all() as Row[];
export const rawEvents = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM raw_events').all() as Row[];

/** First row, asserted present — keeps strict-null tests terse. */
export function first(rows: Row[]): Row {
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]!;
}

/** The single row matching a predicate, asserted unique. */
export function only(rows: Row[], match: (row: Row) => boolean): Row {
  const hits = rows.filter(match);
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

/** Parse a span's `tags` JSON column as a set (the union does not keep order). */
export function tagsOf(row: Row): string[] {
  return JSON.parse(String(row.tags)) as string[];
}

/** Parse a span's `attrs` JSON column. */
export function attrsOf(row: Row): Record<string, unknown> {
  return JSON.parse(String(row.attrs)) as Record<string, unknown>;
}
