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
  'turns',
];

const EXPECTED_INDEXES = [
  'idx_events_child',
  'idx_events_session_seq',
  'idx_events_slow',
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

describe('★ the full column set of all four tables, as SET EQUALITY (AC2)', () => {
  it.each([
    ['sessions', SESSIONS_COLUMNS, 51],
    ['turns', TURNS_COLUMNS, 19],
    ['events', EVENTS_COLUMNS, 37],
    ['meta', META_COLUMNS, 2],
  ])('%s has exactly its declared columns', (table, expected, count) => {
    const columns = columnNames(freshDb(), table);

    expect(columns).toHaveLength(count);
    expect([...columns].sort()).toEqual([...expected].sort());
  });

  it('sessions keeps file_size — the half of the invalidation key a stray \\ eats', () => {
    // The single assertion that separates the escaped literal from the raw one.
    const columns = columnNames(freshDb(), 'sessions');
    expect(columns).toContain('file_mtime_ms');
    expect(columns).toContain('file_size');
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
      expect(columns).toHaveLength(50);
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
