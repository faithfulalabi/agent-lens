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
import { upsertSessionIndex, type ProjectionEnv } from '../../write.js';

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
