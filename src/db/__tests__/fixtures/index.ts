// Fixture plumbing for the db write + freshness suites. Everything is
// synthesized: no arm here reads `~/.agent-lens/archive`, and the corpus suite
// that does folds directories only.
//
// The generic halves are IMPORTED, not copied — `offsetLines` from the
// transcript suite and `makeSandbox`/`cleanup` from the archive suite. A
// cross-tree import from `__tests__/` is safe on both standing guards: the
// one-door scan filters `__tests__/` before it looks, and the projector hash
// excludes it from the digest.
//
// The `ParsedLine[]` builder computes `byte_length` with `Buffer.byteLength`
// EXCLUDING the newline, which is the rule the corpus sweep must follow when it
// becomes the only production producer of that field.

import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createArchiveReader, type ArchiveReader } from '../../../archive/read.js';
import { DriftCounter } from '../../../transcript/drift.js';
import { classifyLine, type ParsedLine } from '../../../transcript/line.js';
import type { ResolveEnv } from '../../../transcript/spill.js';
import { offsetLines } from '../../../transcript/__tests__/fixtures.js';
import { applyConnectionPragmas } from '../../open.js';
import { SCHEMA_DDL } from '../../schema.js';
import { readSidecars } from '../../sidecars.js';
import { upsertSessionIndex, upsertSidecarIndex, type ProjectionEnv } from '../../write.js';

export const SESSION_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
export const CWD = '/Users/dev/proj';
const TRANSCRIPT_EXT = '.jsonl';

/** A cache with the schema applied. In memory: the lock guards a data dir, and
 *  these suites need neither one. Pragmas are re-applied because every open
 *  must, per `open.ts`. */
export function openCache(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyConnectionPragmas(db);
  db.exec(SCHEMA_DDL);
  return db;
}

let serial = 0;

/** Deterministic within a run, distinct across lines. */
export function nextUuid(): string {
  serial += 1;
  const tail = String(serial).padStart(8, '0');
  return `${tail}-1111-4111-8111-${tail}0000`;
}

function envelope(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    uuid: nextUuid(),
    parentUuid: null,
    sessionId: SESSION_ID,
    version: '2.1.212',
    cwd: CWD,
    gitBranch: 'main',
    ...fields,
  };
}

/** A human prompt. `origin.kind` is what `isHumanPrompt` reads first. */
export function humanLine(text: string, ts: string): Record<string, unknown> {
  return envelope({
    type: 'user',
    timestamp: ts,
    promptId: `p-${serial}`,
    origin: { kind: 'human' },
    message: { role: 'user', content: text },
  });
}

/**
 * A user line the harness wrote, not a person. It carries its own prompt group,
 * because that is the one variable turn segmentation moves on, and no `origin`,
 * because that is what makes it machinery rather than a prompt.
 */
export function machineryLine(text: string, ts: string): Record<string, unknown> {
  return envelope({
    type: 'user',
    timestamp: ts,
    promptId: `m-${serial}`,
    message: { role: 'user', content: text },
  });
}

/** An assistant line carrying one `tool_use` block. */
export function toolCallLine(
  callId: string,
  name: string,
  ts: string,
  model = 'claude-sonnet-5',
): Record<string, unknown> {
  return envelope({
    type: 'assistant',
    timestamp: ts,
    requestId: `req-${serial}`,
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id: callId, name, input: { pattern: 'x' } }],
    },
  });
}

/** The result half. `extra` carries the structured spill pointer when there is one. */
export function toolResultLine(
  callId: string,
  content: string,
  ts: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return envelope({
    type: 'user',
    timestamp: ts,
    ...extra,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content }] },
  });
}

/** The harness's spill marker, at index 0 exactly as it writes it. */
export function spillMarker(path: string, kb = 59.4): string {
  return `<persisted-output>\nOutput too large (${kb}KB). Full output saved to: ${path}\ntail`;
}

/** JSONL bytes, newline-terminated. */
export function jsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

/** Every line classified through ONE counter, the way a real read does it. */
export function parseJsonl(text: string): { lines: ParsedLine[]; drift: DriftCounter } {
  const drift = new DriftCounter();
  const lines = offsetLines(text).map((entry) =>
    classifyLine(JSON.parse(entry.text), {
      byteOffset: entry.byteOffset,
      byteLength: entry.byteLength,
      drift,
    }),
  );
  return { lines, drift };
}

export function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A transcript plus its sibling session directory. Returns the transcript path. */
export function writeTranscript(path: string, records: readonly unknown[]): string {
  return writeFile(path, jsonl(records));
}

/** The sibling `<stem>/` directory — the same slice `foldArchive` takes. */
export function sessionDirOf(archivePath: string): string {
  return archivePath.slice(0, -TRANSCRIPT_EXT.length);
}

/** Where the harness puts a session's sub-agent transcripts. */
export function subagentsDirOf(archivePath: string): string {
  return join(sessionDirOf(archivePath), 'subagents');
}

/** One `agent-<id>.jsonl`, under `dir`. Raw text so an over-long line is writable. */
export function writeSidecarTranscript(
  dir: string,
  agentId: string,
  content: readonly unknown[] | string,
): string {
  const text = typeof content === 'string' ? content : jsonl(content);
  return writeFile(join(dir, `agent-${agentId}.jsonl`), text);
}

/** Its `agent-<id>.meta.json` sibling — written separately, so a test can omit it. */
export function writeSidecarMeta(
  dir: string,
  agentId: string,
  meta: Record<string, unknown>,
): string {
  return writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
}

/** Every path the sidecar resolver opened, and how many bytes each read returned. */
export interface ReaderLog {
  reads: { path: string; bytes: number }[];
  sizes: string[];
}

export function newReaderLog(): ReaderLog {
  return { reads: [], sizes: [] };
}

/** Distinct paths the resolver read bytes from, in first-touch order. */
export function readPaths(log: ReaderLog, suffix = ''): string[] {
  return [...new Set(log.reads.map((entry) => entry.path))].filter((path) => path.endsWith(suffix));
}

export function bytesRead(log: ReaderLog, path: string): number {
  return log.reads
    .filter((entry) => entry.path === path)
    .reduce((total, entry) => total + entry.bytes, 0);
}

/** The real reader, wrapped. The behaviour under test is the production one. */
export function countingReader(log: ReaderLog, inner = createArchiveReader()): ArchiveReader {
  return {
    read: (path, offset, length) => {
      const buf = inner.read(path, offset, length);
      log.reads.push({ path, bytes: buf.length });
      return buf;
    },
    size: (path) => {
      log.sizes.push(path);
      return inner.size(path);
    },
    stats: () => inner.stats(),
  };
}

/** Restore a file's mtime, so a test can grow a sidecar without touching the parent. */
export function freezeMtime(path: string, mtimeMs: number): void {
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

export function mtimeMsOf(path: string): number {
  return Math.floor(statSync(path).mtimeMs);
}

export interface EnvOptions {
  /** Overrides the spill probe. The default answers for real files only. */
  exists?: (path: string) => boolean;
  /** Records every path the probe was asked about. */
  probed?: string[];
  /** The reader the sidecar resolver preads through. Wrap it to count. */
  reader?: ArchiveReader;
}

/**
 * A `ProjectionEnv` over real files. `sessionRoot` is the sibling directory,
 * which is where the harness mirrors `tool-results/`.
 *
 * `sidecars` drives the REAL resolver, so every arm that projects through this
 * env exercises the enclosing-directory walk rather than a stub of it.
 */
export function fileEnv(options: EnvOptions = {}): ProjectionEnv {
  const probe = options.exists ?? existsSync;
  const reader = options.reader ?? createArchiveReader();
  return {
    readLines: (archivePath) => parseJsonl(readFileSync(archivePath, 'utf8')),
    spillEnv: (archivePath): ResolveEnv => ({
      exists: (path) => {
        options.probed?.push(path);
        return probe(path);
      },
      sessionRoot: sessionDirOf(archivePath),
    }),
    sidecars: (archivePath, sourcePath, toolUseIds) =>
      readSidecars(archivePath, sourcePath, toolUseIds, reader),
  };
}

export interface SeedOverrides {
  id?: string;
  source_path?: string;
  project_path?: string;
  started_at?: string;
  last_activity_at?: string;
}

/** The Tier-A row the corpus sweep would have written, with the fold's numbers. */
export function seedIndexRow(
  db: DatabaseSync,
  archivePath: string,
  overrides: SeedOverrides = {},
): string {
  const id = overrides.id ?? SESSION_ID;
  const stat = statSync(archivePath);
  upsertSessionIndex(db, {
    id,
    source_path: overrides.source_path ?? join('/Users/dev/.claude/projects', `${id}.jsonl`),
    archive_path: archivePath,
    file_mtime_ms: Math.floor(stat.mtimeMs),
    file_size: stat.size,
    project_path: overrides.project_path ?? CWD,
    started_at: overrides.started_at ?? '2026-08-14T09:00:00.000Z',
    last_activity_at: overrides.last_activity_at ?? '2026-08-14T09:00:00.000Z',
  });
  return id;
}

/** `integrity-check` at rank 1 — the SOLE detector of a desynchronised index. */
export function ftsIntegrityCheck(db: DatabaseSync): void {
  db.exec(`INSERT INTO events_fts(events_fts, rank) VALUES('integrity-check', 1)`);
}

export function countOf(db: DatabaseSync, table: string, id: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(id) as {
    n: number;
  };
  return row.n;
}

export function sessionRow(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
}

// --- Read-layer seeds ------------------------------------------------------
// The read suites need populated `sessions`/`turns`/`events` rows and no
// transcript at all: a list query reads precomputed columns, so making one go
// through a real projection would test the projector instead.

/** Every column `db/read.ts` selects that `upsertSessionIndex` does not write. */
const SEED_HEADER_SQL = `UPDATE sessions SET
    git_branch = :git_branch, model = :model, harness_version = :harness_version,
    title = :title, preview = :preview,
    turn_count = :turn_count, tool_call_count = :tool_call_count, error_count = :error_count,
    tokens_in = :tokens_in, tokens_out = :tokens_out,
    tokens_cache_read = :tokens_cache_read, tokens_cache_write = :tokens_cache_write,
    est_cost = :est_cost, drift_json = :drift_json,
    projection_state = :projection_state, projection_error = :projection_error,
    projector_version = :projector_version, projected_at = :projected_at
  WHERE id = :id`;

export interface SessionSeed extends SeedOverrides {
  git_branch?: string | null;
  model?: string | null;
  harness_version?: string | null;
  title?: string | null;
  preview?: string | null;
  turn_count?: number;
  tool_call_count?: number;
  error_count?: number;
  tokens_in?: number;
  tokens_out?: number;
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  est_cost?: number | null;
  drift_json?: string;
  projection_state?: string;
  projection_error?: string | null;
  projector_version?: number | null;
  projected_at?: string | null;
}

/** A fully populated top-level `sessions` row. No file is touched. */
export function seedSessionRow(db: DatabaseSync, seed: SessionSeed = {}): string {
  const id = seed.id ?? SESSION_ID;
  const last_activity_at = seed.last_activity_at ?? '2026-08-14T09:00:00.000Z';
  upsertSessionIndex(db, {
    id,
    source_path: seed.source_path ?? join('/Users/dev/.claude/projects', `${id}.jsonl`),
    archive_path: join('/Users/dev/.agent-lens/archive', `${id}.jsonl`),
    file_mtime_ms: 1_760_000_000_000,
    file_size: 4096,
    project_path: seed.project_path ?? CWD,
    started_at: seed.started_at ?? last_activity_at,
    last_activity_at,
  });
  db.prepare(SEED_HEADER_SQL).run({
    id,
    git_branch: seed.git_branch ?? 'main',
    model: seed.model ?? 'claude-sonnet-5',
    harness_version: seed.harness_version ?? '2.1.212',
    title: seed.title ?? `title of ${id}`,
    preview: seed.preview ?? `preview of ${id}`,
    turn_count: seed.turn_count ?? 3,
    tool_call_count: seed.tool_call_count ?? 7,
    error_count: seed.error_count ?? 0,
    tokens_in: seed.tokens_in ?? 100,
    tokens_out: seed.tokens_out ?? 200,
    tokens_cache_read: seed.tokens_cache_read ?? 300,
    tokens_cache_write: seed.tokens_cache_write ?? 400,
    est_cost: seed.est_cost ?? null,
    drift_json: seed.drift_json ?? '{}',
    projection_state: seed.projection_state ?? 'ready',
    projection_error: seed.projection_error ?? null,
    projector_version: seed.projector_version ?? 1,
    projected_at: seed.projected_at ?? '2026-08-14T09:05:00.000Z',
  });
  return id;
}

/** The same, as a sub-agent of `parent_id`. Goes through the production upsert. */
export function seedSidecarRow(
  db: DatabaseSync,
  parent_id: string,
  seed: SessionSeed = {},
): string {
  const id = seedSessionRow(db, seed);
  const last_activity_at = seed.last_activity_at ?? '2026-08-14T09:00:00.000Z';
  upsertSidecarIndex(db, {
    id,
    source_path: seed.source_path ?? join('/Users/dev/.claude/projects', `${id}.jsonl`),
    archive_path: join('/Users/dev/.agent-lens/archive', `${id}.jsonl`),
    file_mtime_ms: 1_760_000_000_000,
    file_size: 2048,
    project_path: seed.project_path ?? CWD,
    started_at: seed.started_at ?? last_activity_at,
    last_activity_at,
    parent_session_id: parent_id,
    spawned_by_event_id: `toolu_${id}`,
    agent_type: 'Explore',
    agent_description: 'a sub-agent',
    spawn_depth: 1,
  });
  return id;
}

const SEED_TURN_SQL = `INSERT INTO turns
    (id, session_id, seq, kind, title, started_at, ended_at, duration_ms, duration_source,
     tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, est_cost,
     tool_call_count, error_count, first_seq, last_seq)
  VALUES (:id, :session_id, :seq, :kind, :title, :started_at, :ended_at, :duration_ms,
     :duration_source, :tokens_in, :tokens_out, :tokens_cache_read, :tokens_cache_write,
     :est_cost, :tool_call_count, :error_count, :first_seq, :last_seq)`;

const SEED_EVENT_SQL = `INSERT INTO events
    (id, session_id, turn_id, seq, kind, ts, request_id, block_index, name, status,
     duration_ms, duration_source, input, input_bytes, input_storage, text, text_bytes,
     output_storage, spill_path, spill_bytes, src_offset, src_len, result_offset,
     result_len, result_block, model, tokens_in, tokens_out, tokens_cache_read,
     tokens_cache_write, est_cost, child_session_id, agent_type, agent_status,
     raw_type, raw_subtype)
  VALUES (:id, :session_id, :turn_id, :seq, :kind, :ts, :request_id, :block_index, :name,
     :status, :duration_ms, :duration_source, :input, :input_bytes, :input_storage, :text,
     :text_bytes, :output_storage, :spill_path, :spill_bytes, :src_offset, :src_len,
     :result_offset, :result_len, :result_block, :model, :tokens_in, :tokens_out,
     :tokens_cache_read, :tokens_cache_write, :est_cost, :child_session_id, :agent_type,
     :agent_status, :raw_type, :raw_subtype)`;

export interface TurnSeed {
  seq: number;
  kind?: string;
  title?: string;
  first_seq?: number;
  last_seq?: number;
}

export interface EventSeed {
  id: string;
  seq: number;
  turn_seq?: number;
  kind?: string;
  name?: string | null;
  text?: string | null;
  input?: string | null;
  child_session_id?: string | null;
}

/**
 * Tier-B rows for one session, plus the FTS index over them. Mirrors the order
 * `write.ts` uses: events first, then `events_fts` from the events table.
 */
export function seedProjection(
  db: DatabaseSync,
  session_id: string,
  content: { turns?: readonly TurnSeed[]; events?: readonly EventSeed[] } = {},
): void {
  for (const turn of content.turns ?? []) {
    db.prepare(SEED_TURN_SQL).run({
      id: `${session_id}:${turn.seq}`,
      session_id,
      seq: turn.seq,
      kind: turn.kind ?? 'human',
      title: turn.title ?? `turn ${turn.seq}`,
      started_at: '2026-08-14T09:00:00.000Z',
      ended_at: '2026-08-14T09:01:00.000Z',
      duration_ms: 60_000,
      duration_source: 'derived',
      tokens_in: 10,
      tokens_out: 20,
      tokens_cache_read: 30,
      tokens_cache_write: 40,
      est_cost: null,
      tool_call_count: 1,
      error_count: 0,
      first_seq: turn.first_seq ?? turn.seq,
      last_seq: turn.last_seq ?? turn.seq,
    });
  }

  for (const event of content.events ?? []) {
    const input = event.input ?? null;
    const text = event.text ?? null;
    db.prepare(SEED_EVENT_SQL).run({
      id: event.id,
      session_id,
      turn_id: `${session_id}:${event.turn_seq ?? 1}`,
      seq: event.seq,
      kind: event.kind ?? 'text',
      ts: '2026-08-14T09:00:00.000Z',
      request_id: 'req-1',
      block_index: 0,
      name: event.name ?? null,
      status: null,
      duration_ms: null,
      duration_source: null,
      input,
      input_bytes: input === null ? null : input.length,
      input_storage: input === null ? 'absent' : 'inline',
      text,
      text_bytes: text === null ? null : text.length,
      output_storage: text === null ? 'absent' : 'inline',
      spill_path: null,
      spill_bytes: null,
      src_offset: event.seq * 100,
      src_len: 100,
      result_offset: null,
      result_len: null,
      result_block: null,
      model: 'claude-sonnet-5',
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_write: null,
      est_cost: null,
      child_session_id: event.child_session_id ?? null,
      agent_type: null,
      agent_status: null,
      raw_type: 'assistant',
      raw_subtype: null,
    });
  }

  db.prepare(
    `INSERT INTO events_fts(rowid, text, input)
       SELECT rowid, text, input FROM events WHERE session_id = ?`,
  ).run(session_id);
}
