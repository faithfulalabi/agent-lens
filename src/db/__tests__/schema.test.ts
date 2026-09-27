// Tests 1, 2, 3 and 13 — the DDL survived the transport, and `events_fts` is
// wired rather than merely declared.
//
// Test 2 is the load-bearing one and it is not ceremony. A bare backslash at end
// of line inside a template literal is a LineContinuation: it folds two spec
// lines into one `--` comment and ships `sessions` with 50 columns and no
// `file_size`, half the Tier-B invalidation key. Both forms produce an IDENTICAL
// sqlite_master name set, so Test 1's containment is provably blind to it. And
// the spec lives in `internal_docs/`, which is globally gitignored — no test can
// ever diff this module against its source. Column-level set equality is the
// only durable guard there will be.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { SCHEMA_DDL, SCHEMA_VERSION } from '../schema.js';
import { SPILL_FTS_COLUMNS } from './fixtures/shapes.js';

let sandbox: Sandbox | undefined;
let db: DatabaseSync | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

/** A file-backed database, because `:memory:` reports `journal_mode` as `memory`. */
function freshDb(): DatabaseSync {
  db = new DatabaseSync(join(sb().root, 'schema-probe.db'));
  db.exec(SCHEMA_DDL);
  return db;
}

afterEach(() => {
  if (db?.isOpen === true) db.close();
  db = undefined;
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

const DB_DIR = resolve(import.meta.dirname, '..');

/** Every object the DDL declares. FTS5 adds four shadow tables of its own. */
const EXPECTED_TABLES = [
  'events',
  'events_fts',
  'events_fts_config',
  'events_fts_data',
  'events_fts_docsize',
  'events_fts_idx',
  'meta',
  'sessions',
  // A PLAIN FTS5 table, so a fifth shadow table (`_content`) too.
  'spill_fts',
  'spill_fts_config',
  'spill_fts_content',
  'spill_fts_data',
  'spill_fts_docsize',
  'spill_fts_idx',
  'turns',
];

const EXPECTED_INDEXES = [
  'idx_events_child',
  'idx_events_session_seq',
  'idx_events_slow',
  'idx_events_spill',
  'idx_events_turn',
  'idx_sessions_parent',
  'idx_sessions_project',
  'idx_sessions_recent',
  'idx_turns_session_seq',
];

// Written out by hand, on purpose. Deriving these from the DDL would compare the
// string against itself and catch nothing.
const SESSIONS_COLUMNS = [
  'id',
  'source_path',
  'source_mtime_ms',
  'source_size',
  'source_head_sha256',
  'source_state',
  'archive_path',
  'archive_size',
  'archive_sha256',
  'archive_state',
  'archived_at',
  'sealed_at',
  'file_mtime_ms',
  'file_size',
  'project_path',
  'git_branch',
  'model',
  'models',
  'harness_version',
  'title',
  'preview',
  'started_at',
  'last_activity_at',
  'turn_count',
  'tool_call_count',
  'error_count',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
  'agent_count',
  'sub_tool_call_count',
  'sub_error_count',
  'sub_tokens_in',
  'sub_tokens_out',
  'sub_tokens_cache_read',
  'sub_tokens_cache_write',
  'sub_est_cost',
  'sub_models',
  'rollup_state',
  'parent_session_id',
  'spawned_by_event_id',
  'agent_type',
  'agent_description',
  'spawn_depth',
  'projected_mtime_ms',
  'projected_size',
  'projector_version',
  'projected_at',
  'projection_state',
  'projection_error',
  'drift_json',
];

const TURNS_COLUMNS = [
  'id',
  'session_id',
  'seq',
  'kind',
  'parent_event_id',
  'title',
  'started_at',
  'ended_at',
  'duration_ms',
  'duration_source',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
  'tool_call_count',
  'error_count',
  'first_seq',
  'last_seq',
];

const EVENTS_COLUMNS = [
  'id',
  'session_id',
  'turn_id',
  'seq',
  'kind',
  'ts',
  'request_id',
  'block_index',
  'name',
  'status',
  'duration_ms',
  'duration_source',
  'input',
  'input_bytes',
  'input_storage',
  'text',
  'text_bytes',
  'output_storage',
  'spill_path',
  'spill_bytes',
  'src_offset',
  'src_len',
  'result_offset',
  'result_len',
  'result_block',
  'model',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'est_cost',
  'child_session_id',
  'agent_type',
  'agent_status',
  'raw_type',
  'raw_subtype',
  'attrs',
];

const META_COLUMNS = ['key', 'value'];

function objectNames(handle: DatabaseSync, type: 'table' | 'index'): string[] {
  return handle
    .prepare('SELECT name FROM sqlite_master WHERE type = ?')
    .all(type)
    .map((row) => String((row as { name: unknown }).name))
    .sort();
}

function columnNames(handle: DatabaseSync, table: string): string[] {
  return handle
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all(table)
    .map((row) => String((row as { name: unknown }).name));
}

describe('the v2 DDL survives the transport (AC1)', () => {
  it('execs and creates every declared object, at the declared version', () => {
    const handle = freshDb();

    // Containment, the house rule: Phase 4 extends this set.
    expect(objectNames(handle, 'table')).toEqual(expect.arrayContaining(EXPECTED_TABLES));
    expect(objectNames(handle, 'index')).toEqual(expect.arrayContaining(EXPECTED_INDEXES));

    expect(handle.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(handle.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });

  it('exports SCHEMA_DDL and SCHEMA_VERSION, and nothing else', async () => {
    // Set equality, so a helper quietly exported later reds here rather than
    // accreting into what is meant to be two frozen values.
    const module = await import('../schema.js');
    expect(Object.keys(module).sort()).toEqual(['SCHEMA_DDL', 'SCHEMA_VERSION']);
  });

  it('carries no migration runner, and creates no migrations tree at all', () => {
    // Task 4.5 deleted `src/db/migrations/` and `db/migrate.ts`, so the scope
    // this test used to carve out is gone: there is no second tree to be scoped
    // AWAY from, and the assertion is now simply that neither exists.
    for (const file of ['schema.ts', 'open.ts']) {
      expect(readFileSync(join(DB_DIR, file), 'utf8')).not.toMatch(/from\s+'\.[^']*migrat/);
    }
    expect(existsSync(join(DB_DIR, 'migrations'))).toBe(false);
    expect(existsSync(join(DB_DIR, 'migrate.ts'))).toBe(false);
  });
});

describe('★ the full column set of every table, as SET EQUALITY (AC2)', () => {
  it.each([
    ['sessions', SESSIONS_COLUMNS, 53],
    ['turns', TURNS_COLUMNS, 19],
    ['events', EVENTS_COLUMNS, 37],
    ['meta', META_COLUMNS, 2],
    // `PRAGMA table_info` lists an FTS5 table's DECLARED columns.
    ['spill_fts', SPILL_FTS_COLUMNS, 5],
  ])('%s has exactly its declared columns', (table, expected, count) => {
    const columns = columnNames(freshDb(), table);

    expect(columns).toHaveLength(count);
    expect([...columns].sort()).toEqual([...expected].sort());
  });

  it('the guard reds on the LineContinuation, and Test 1 stays green through it', () => {
    // The control, driving the SAME helpers with the string an UNESCAPED source
    // would have evaluated to: a backslash before a newline is eaten along with
    // the newline, folding spec:75-76 into one comment. Without this the set
    // equality above could be softened and nothing would notice.
    const eaten = new DatabaseSync(join(sb().root, 'unescaped-probe.db'));
    try {
      eaten.exec(SCHEMA_DDL.replace(/\\\n/g, ''));

      const columns = columnNames(eaten, 'sessions');
      expect(columns).toHaveLength(52);
      expect(columns).not.toContain('file_size');
      expect([...columns].sort()).not.toEqual([...SESSIONS_COLUMNS].sort());

      // …and the containment assertion in Test 1 passes over the very same
      // database, which is the whole reason AC2 exists.
      expect(objectNames(eaten, 'table')).toEqual(expect.arrayContaining(EXPECTED_TABLES));
      expect(objectNames(eaten, 'index')).toEqual(expect.arrayContaining(EXPECTED_INDEXES));
      expect(columnNames(eaten, 'turns')).toHaveLength(19);
      expect(columnNames(eaten, 'events')).toHaveLength(37);
    } finally {
      eaten.close();
    }
  });
});

// Hand-transcribed from main @ d5c66d1 BEFORE the task 0.12 comment edits, with
// every `--` comment removed. Not a snapshot, on purpose: a snapshot captured
// after the edit records the post-edit DDL and `vitest -u` re-baselines it,
// while the column sets above compare NAMES only — a TEXT→INTEGER flip or a
// dropped DEFAULT passes both. Same independent-oracle doctrine as the column
// lists: written out by hand, checked against the pre-edit bytes.
const STATEMENTS_AT_D5C66D1 = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;
PRAGMA user_version = 1;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_mtime_ms INTEGER,
  source_size INTEGER,
  source_head_sha256 TEXT,
  source_state TEXT NOT NULL DEFAULT 'present',
  archive_path TEXT NOT NULL,
  archive_size INTEGER NOT NULL DEFAULT 0,
  archive_sha256 TEXT,
  archive_state TEXT NOT NULL DEFAULT 'hot',
  archived_at TEXT,
  sealed_at TEXT,
  file_mtime_ms INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  project_path TEXT NOT NULL,
  git_branch TEXT,
  model TEXT,
  harness_version TEXT,
  title TEXT,
  preview TEXT,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  est_cost REAL,
  agent_count INTEGER NOT NULL DEFAULT 0,
  sub_tool_call_count INTEGER NOT NULL DEFAULT 0,
  sub_error_count INTEGER NOT NULL DEFAULT 0,
  sub_tokens_in INTEGER NOT NULL DEFAULT 0,
  sub_tokens_out INTEGER NOT NULL DEFAULT 0,
  sub_tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  sub_tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  sub_est_cost REAL,
  rollup_state TEXT NOT NULL DEFAULT 'own',
  parent_session_id TEXT,
  spawned_by_event_id TEXT,
  agent_type TEXT,
  agent_description TEXT,
  spawn_depth INTEGER,
  projected_mtime_ms INTEGER,
  projected_size INTEGER,
  projector_version INTEGER,
  projected_at TEXT,
  projection_state TEXT NOT NULL DEFAULT 'none',
  projection_error TEXT,
  drift_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_sessions_recent ON sessions(last_activity_at DESC, id DESC)
  WHERE parent_session_id IS NULL;
CREATE INDEX idx_sessions_project ON sessions(project_path, last_activity_at DESC, id DESC)
  WHERE parent_session_id IS NULL;
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  parent_event_id TEXT,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  duration_source TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  est_cost REAL,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_turns_session_seq ON turns(session_id, seq);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ts TEXT NOT NULL,
  request_id TEXT,
  block_index INTEGER,
  name TEXT,
  status TEXT,
  duration_ms INTEGER,
  duration_source TEXT,
  input TEXT,
  input_bytes INTEGER,
  input_storage TEXT,
  text TEXT,
  text_bytes INTEGER,
  output_storage TEXT,
  spill_path TEXT,
  spill_bytes INTEGER,
  src_offset INTEGER NOT NULL,
  src_len INTEGER NOT NULL,
  result_offset INTEGER,
  result_len INTEGER,
  result_block INTEGER,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  est_cost REAL,
  child_session_id TEXT,
  agent_type TEXT,
  agent_status TEXT,
  raw_type TEXT NOT NULL,
  raw_subtype TEXT,
  attrs TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX idx_events_session_seq ON events(session_id, seq);
CREATE INDEX idx_events_turn ON events(turn_id, seq);
CREATE INDEX idx_events_slow ON events(session_id, kind, duration_ms DESC);
CREATE INDEX idx_events_child ON events(child_session_id)
  WHERE child_session_id IS NOT NULL;

CREATE VIRTUAL TABLE events_fts USING fts5(
  text,
  input,
  content='events',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// Kept SEPARATE so the d5c66d1 oracle above stays byte-for-byte the pre-0.12 claim.
const STATEMENTS_ADDED_AT_7_5 = `
CREATE VIRTUAL TABLE spill_fts USING fts5(
  event_id UNINDEXED,
  session_id UNINDEXED,
  spill_path UNINDEXED,
  text,
  input UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE INDEX idx_events_spill ON events(session_id) WHERE output_storage = 'spill';
`;

function statementsAt75(): string {
  const bumped = STATEMENTS_AT_D5C66D1.replace(
    'PRAGMA user_version = 1;',
    'PRAGMA user_version = 2;',
  );
  // Non-vacuity: a replace that matched nothing would compare the OLD version.
  expect(bumped).not.toBe(STATEMENTS_AT_D5C66D1);
  return bumped + STATEMENTS_ADDED_AT_7_5;
}

// Task 0.17: version 3 and the two model-list columns on `sessions`, applied as
// replaces over the 7.5 oracle so the frozen constants above stay untouched.
function statementsAt017(): string {
  const at75 = statementsAt75();
  const bumped = at75.replace('PRAGMA user_version = 2;', 'PRAGMA user_version = 3;');
  expect(bumped).not.toBe(at75);
  // `  model TEXT,\n` also occurs in `events`; replace() hits the FIRST, which is `sessions`.
  const withModels = bumped.replace(
    '  model TEXT,\n',
    "  model TEXT,\n  models TEXT NOT NULL DEFAULT '[]',\n",
  );
  expect(withModels).not.toBe(bumped);
  expect(withModels.match(/^ {2}models TEXT/gm)).toHaveLength(1);
  const withSubModels = withModels.replace(
    '  sub_est_cost REAL,\n',
    "  sub_est_cost REAL,\n  sub_models TEXT NOT NULL DEFAULT '[]',\n",
  );
  expect(withSubModels).not.toBe(withModels);
  return withSubModels;
}

/** Drops every `--` comment, collapses whitespace. No `--` exists in a literal. */
function withoutComments(ddl: string): string {
  return ddl
    .split('\n')
    .map((line) => {
      const cut = line.indexOf('--');
      return cut === -1 ? line : line.slice(0, cut);
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The lines of one CREATE TABLE body, from the opening line to its bare `);`. */
function tableLines(table: string): string[] {
  const lines = SCHEMA_DDL.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`CREATE TABLE ${table} (`));
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > start && line.trim() === ');');
  return lines.slice(start, end);
}

/** A column's declaration line plus its trailing comment-only lines. */
function columnBlock(table: string, column: string): string {
  const lines = tableLines(table);
  const start = lines.findIndex((line) => new RegExp(`^\\s+${column}\\s`).test(line));
  expect(start).toBeGreaterThan(-1);
  let end = start + 1;
  while (lines[end]?.trimStart().startsWith('--') === true) end += 1;
  return lines.slice(start, end).join('\n');
}

// The nine columns the task 0.12 audit flagged: at least one declared value has
// zero rows in the dev corpus. Live columns carry no marker by design — that is
// what keeps the comment-only equality above meaningful.
const AUDITED_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['sessions', 'source_state'],
  ['sessions', 'archive_state'],
  ['sessions', 'projection_state'],
  ['turns', 'kind'],
  ['events', 'kind'],
  ['events', 'duration_source'],
  ['events', 'input_storage'],
  ['events', 'output_storage'],
  ['events', 'agent_status'],
];

describe('task 0.12 audited comments only — the statements did not move, and 7.5 added exactly two (AC5)', () => {
  it('the DDL, stripped of comments, equals main @ d5c66d1 plus the 7.5 statements exactly', () => {
    expect(withoutComments(SCHEMA_DDL)).toBe(withoutComments(statementsAt017()));
  });

  it('the version bump is SCHEMA_VERSION itself, so the two sites cannot drift', () => {
    // A mismatch between the two sites would recreate cache.db on every open.
    expect(SCHEMA_DDL).toContain(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    expect(SCHEMA_VERSION).toBe(3);
  });
});

describe('task 0.12 measurement markers landed at the declared lines (AC4)', () => {
  it.each(AUDITED_COLUMNS)('%s.%s carries a dated MEASURED marker', (table, column) => {
    expect(columnBlock(table, column)).toMatch(/MEASURED 2026-/);
  });

  it('live columns stay untouched — no marker outside the audited nine', () => {
    for (const [table, column] of [
      ['sessions', 'rollup_state'],
      ['turns', 'duration_source'],
      ['events', 'status'],
    ] as const) {
      expect(columnBlock(table, column)).not.toMatch(/MEASURED 2026-/);
    }
  });
});

describe('events_fts is wired, not merely declared (AC7)', () => {
  it('an external-content insert round-trips through MATCH', () => {
    // The assertion `payloads_fts` never had: migration 001 created it, nothing
    // populated it, and no test could tell the difference. Population itself is
    // Task 3.5's; this proves the shadow tables and the content='events' mapping.
    const handle = freshDb();
    handle
      .prepare(
        `INSERT INTO events (id, session_id, turn_id, seq, kind, ts, src_offset, src_len,
           raw_type, text, input)
         VALUES ('e1', 's1', 's1:0', 0, 'text', '2026-08-14T00:00:00.000Z', 0, 10,
           'assistant', ?, ?)`,
      )
      .run('the archive keeps everything forever', '{"pattern":"unlikelytoken"}');

    handle.exec(
      "INSERT INTO events_fts(rowid, text, input) SELECT rowid, text, input FROM events WHERE id = 'e1'",
    );

    const matched = handle
      .prepare('SELECT rowid FROM events_fts WHERE events_fts MATCH ?')
      .all('forever');
    expect(matched).toHaveLength(1);

    // The second column is indexed too, and an unrelated term still misses.
    expect(
      handle.prepare('SELECT rowid FROM events_fts WHERE events_fts MATCH ?').all('unlikelytoken'),
    ).toHaveLength(1);
    expect(
      handle.prepare('SELECT rowid FROM events_fts WHERE events_fts MATCH ?').all('absentword'),
    ).toEqual([]);
  });
});
