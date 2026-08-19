// AC1, AC2, AC5, AC6, AC7, AC8 — the write path.
//
// Every fixture here is SYNTHETIC. `subagents/workflows/**/journal.jsonl` is the
// only archived file that projects headerless, it is excluded upstream by the
// corpus sweep, and it is barred from the tombstone arms: an excluded file
// cannot be the witness for the path that exists because it was excluded.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { runPipeline } from '../../project/pipeline.js';
import { DriftCounter } from '../../transcript/drift.js';
import { PROJECTOR_VERSION } from '../../transcript/version.js';
import {
  countOf,
  CWD,
  fileEnv,
  ftsIntegrityCheck,
  humanLine,
  jsonl,
  machineryLine,
  openCache,
  parseJsonl,
  seedIndexRow,
  sessionRow,
  spillMarker,
  toolCallLine,
  toolResultLine,
  writeFile,
  writeTranscript,
} from './fixtures/index.js';
import {
  deleteSessionProjection,
  projectSession,
  recomputeSessionRollups,
  upsertSessionIndex,
} from '../write.js';
import { foldArchive } from '../freshness.js';

let sandbox: Sandbox | undefined;
const open: DatabaseSync[] = [];

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

function cache(): DatabaseSync {
  const db = openCache();
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  if (sandbox !== undefined) cleanup(sandbox);
  sandbox = undefined;
});

/** A transcript under the sandbox archive, plus the fold the caller must supply. */
function plant(name: string, records: readonly unknown[]): { path: string; dir: string } {
  const path = join(sb().archiveRoot, `${name}.jsonl`);
  writeTranscript(path, records);
  return { path, dir: path.slice(0, -'.jsonl'.length) };
}

function project(db: DatabaseSync, id: string, path: string, env = fileEnv()): string {
  return projectSession(db, id, env, foldArchive(path)!);
}

const TS = (seconds: number): string =>
  new Date(Date.UTC(2026, 7, 14, 9, 0, seconds)).toISOString();

/** A session with one human turn and one answered tool call. */
function simpleSession(callId = 'toolu_one'): readonly unknown[] {
  return [
    humanLine('do the thing', TS(0)),
    toolCallLine(callId, 'Grep', TS(1)),
    toolResultLine(callId, 'found three matches', TS(2)),
  ];
}

describe('projectSession is one unit of work (AC1)', () => {
  it('a throw mid-insert leaves zero rows and no freshness stamp', () => {
    const db = cache();
    const { path } = plant('atomic', simpleSession('toolu_boom'));
    const id = seedIndexRow(db, path);

    // The blocker: another session already owns this event id, so the insert of
    // the projection's own tool_call row throws AFTER the turns are in.
    db.prepare(
      `INSERT INTO events (id, session_id, turn_id, seq, kind, ts, block_index,
         src_offset, src_len, raw_type)
       VALUES ('toolu_boom', 'other-session', 't', 0, 'tool_call', ?, 0, 0, 1, 'assistant')`,
    ).run(TS(0));

    expect(() => project(db, id, path)).toThrow();

    expect(countOf(db, 'turns', id)).toBe(0);
    expect(countOf(db, 'events', id)).toBe(0);
    expect(sessionRow(db, id).projected_mtime_ms).toBeNull();
    expect(sessionRow(db, id).projected_size).toBeNull();
    // The other session's row is untouched: the rollback is scoped, not a purge.
    expect(countOf(db, 'events', 'other-session')).toBe(1);
  });

  it('mutation control: the same statements without the savepoint leave rows behind', () => {
    const db = cache();
    const { path } = plant('control', simpleSession('toolu_boom'));
    const id = seedIndexRow(db, path);

    deleteSessionProjection(db, id);
    db.prepare(
      `INSERT INTO turns (id, session_id, seq, kind, title, started_at, first_seq, last_seq)
       VALUES (?, ?, 0, 'human', 'do the thing', ?, 0, 0)`,
    ).run(`${id}:0`, id, TS(0));
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (id, session_id, turn_id, seq, kind, ts, block_index,
             src_offset, src_len, raw_type)
           VALUES (?, ?, ?, 0, 'tool_call', ?, 0, 0, 1, 'assistant')`,
        )
        .run(`${id}:0`, id, `${id}:0`, TS(0)),
    ).not.toThrow();

    // Un-savepointed, the turn survives its own failed unit — which is the state
    // the arm above proves `projectSession` never reaches.
    expect(countOf(db, 'turns', id)).toBe(1);
  });

  it('the savepoint composes inside a caller transaction', () => {
    const db = cache();
    const { path } = plant('nested', simpleSession('toolu_boom'));
    const id = seedIndexRow(db, path);
    db.prepare(
      `INSERT INTO events (id, session_id, turn_id, seq, kind, ts, block_index,
         src_offset, src_len, raw_type)
       VALUES ('toolu_boom', 'other-session', 't', 0, 'tool_call', ?, 0, 0, 1, 'assistant')`,
    ).run(TS(0));

    db.exec('BEGIN');
    db.prepare(`INSERT INTO meta (key, value) VALUES ('caller_own_row', 'kept')`).run();
    expect(() => project(db, id, path)).toThrow();
    db.exec('COMMIT');

    // The inner unit rolled back; the outer transaction still committed its own.
    expect(db.isTransaction).toBe(false);
    expect(countOf(db, 'turns', id)).toBe(0);
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'caller_own_row'`).get()).toEqual({
      value: 'kept',
    });
  });

  it('a successful projection writes turns, events and the freshness stamp', () => {
    const db = cache();
    const { path } = plant('happy', simpleSession());
    const id = seedIndexRow(db, path);

    expect(project(db, id, path)).toBe('ready');

    const fold = foldArchive(path)!;
    const row = sessionRow(db, id);
    expect(countOf(db, 'turns', id)).toBe(1);
    expect(countOf(db, 'events', id)).toBeGreaterThan(0);
    expect(row.projected_mtime_ms).toBe(fold.mtime_ms);
    expect(row.projected_size).toBe(fold.size);
    expect(row.projector_version).toBe(PROJECTOR_VERSION);
    expect(row.projection_state).toBe('ready');
    expect(row.projected_at).not.toBeNull();
  });

  it('every projected field lands in the column that carries its name', () => {
    // The events insert binds 33 columns POSITIONALLY. A wrong count throws, but
    // a wrong ORDER is silent, so the round trip is asserted rather than read.
    const db = cache();
    const records = simpleSession();
    const { path } = plant('roundtrip', records);
    const id = seedIndexRow(db, path);
    project(db, id, path);

    const { lines, drift } = parseJsonl(jsonl(records));
    const expected = runPipeline(lines, { session_id: id, drift });

    for (const event of expected.events) {
      const stored = db.prepare('SELECT * FROM events WHERE id = ?').get(event.id) as Record<
        string,
        unknown
      >;
      for (const [column, value] of Object.entries(event)) {
        // `output_storage`, `spill_path` and `text` are this task's to resolve;
        // every other column must survive the trip byte for byte.
        if (['output_storage', 'spill_path', 'text'].includes(column)) continue;
        expect(stored[column] ?? undefined, `${event.id}.${column}`).toStrictEqual(value);
      }
    }
  });
});

describe('deleteSessionProjection runs the FTS delete idiom first (AC2)', () => {
  /** The inverted order: the rows are gone before the idiom that de-indexes them. */
  function invertedDrop(db: DatabaseSync, id: string): void {
    db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
    db.prepare(
      `INSERT INTO events_fts(events_fts, rowid, text, input)
         SELECT 'delete', rowid, text, input FROM events WHERE session_id = ?`,
    ).run(id);
    db.prepare('DELETE FROM turns WHERE session_id = ?').run(id);
  }

  it('three drop/reproject cycles keep the index intact', () => {
    const db = cache();
    const { path } = plant('cycles', simpleSession());
    const id = seedIndexRow(db, path);

    // Projected BEFORE the first drop, and that is part of the criterion: from
    // an empty index the inverted arm below answers ok at cycle 1 and only
    // throws from cycle 2, so a fixture that skips this tests a weaker claim.
    project(db, id, path);
    expect(() => ftsIntegrityCheck(db)).not.toThrow();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      project(db, id, path);
      expect(() => ftsIntegrityCheck(db), `cycle ${cycle}`).not.toThrow();
    }
  });

  it('mutation control: the inverted order corrupts the index on the FIRST cycle', () => {
    const db = cache();
    const { path } = plant('inverted', simpleSession());
    const id = seedIndexRow(db, path);

    project(db, id, path);
    expect(() => ftsIntegrityCheck(db)).not.toThrow();

    invertedDrop(db, id);
    project(db, id, path);

    expect(() => ftsIntegrityCheck(db)).toThrow(/database disk image is malformed/);
  });
});

describe('projectSession resolves the spill half of the seam (AC5)', () => {
  const DECLARED_SIZE = 123456;
  const SPILL_BODY = 'the whole output, on disk and never read by this task';

  function spillFixture(): { db: DatabaseSync; id: string; path: string; probed: string[] } {
    const db = cache();
    const { path, dir } = plant('spills', [
      humanLine('spill one, lose one, keep one', TS(0)),
      toolCallLine('toolu_pointer', 'Grep', TS(1)),
      toolResultLine('toolu_pointer', spillMarker('/gone/tool-results/b1a2c3d4.txt'), TS(2), {
        toolUseResult: {
          persistedOutputPath: '/gone/tool-results/b1a2c3d4.txt',
          persistedOutputSize: DECLARED_SIZE,
        },
      }),
      toolCallLine('toolu_marker', 'Bash', TS(3)),
      toolResultLine('toolu_marker', spillMarker('/gone/tool-results/vanished.txt'), TS(4)),
      toolCallLine('toolu_plain', 'Read', TS(5)),
      toolResultLine('toolu_plain', 'a small answer', TS(6)),
    ]);
    // Only the pointer arm's spill is really on disk, under the session root the
    // harness mirrors `tool-results/` into.
    writeFile(join(dir, 'tool-results', 'b1a2c3d4.txt'), SPILL_BODY);

    const id = seedIndexRow(db, path);
    const probed: string[] = [];
    project(db, id, path, fileEnv({ probed }));
    return { db, id, path, probed };
  }

  function eventRow(db: DatabaseSync, id: string): Record<string, unknown> {
    return db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown>;
  }

  it('a resolved claim carries the probed path and the declared size', () => {
    const { db, path } = spillFixture();
    const row = eventRow(db, 'toolu_pointer');

    expect(row.output_storage).toBe('spill');
    // The drafted shape discarded this payload and left the column NULL.
    expect(row.spill_path).toBe(
      join(path.slice(0, -'.jsonl'.length), 'tool-results', 'b1a2c3d4.txt'),
    );
    expect(row.spill_bytes).toBe(DECLARED_SIZE);
  });

  it('a claim the probe cannot reach lands as missing with both columns NULL', () => {
    const { db } = spillFixture();
    const row = eventRow(db, 'toolu_marker');

    expect(row.output_storage).toBe('missing');
    expect(row.spill_path).toBeNull();
    expect(row.spill_bytes).toBeNull();
  });

  it('a result that claimed nothing is left exactly as the projector emitted it', () => {
    const { db } = spillFixture();
    const row = eventRow(db, 'toolu_plain');

    expect(row.output_storage).toBe('inline');
    expect(row.text).toBe('a small answer');
    expect(row.spill_path).toBeNull();
  });

  it('no row carries a path the probe never confirmed', () => {
    const { db, id, probed } = spillFixture();
    const paths = (
      db
        .prepare('SELECT spill_path FROM events WHERE session_id = ? AND spill_path IS NOT NULL')
        .all(id) as { spill_path: string }[]
    ).map((row) => row.spill_path);

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(probed).toContain(path);
  });

  it('text stays NULL on both spill rows and the spill file is never opened', () => {
    const { db, id } = spillFixture();

    expect(eventRow(db, 'toolu_pointer').text).toBeNull();
    expect(eventRow(db, 'toolu_marker').text).toBeNull();
    // An arm that read the file to fill `text` would land its bytes somewhere in
    // the projection; nothing but the boolean probe touches that file.
    const all = db.prepare('SELECT * FROM events WHERE session_id = ?').all(id);
    expect(JSON.stringify(all)).not.toContain(SPILL_BODY);
  });
});

describe('every NOT NULL column has a stated value, and project_path is READ (AC6)', () => {
  function notNullNoDefault(db: DatabaseSync): string[] {
    return (
      db.prepare(`SELECT name, "notnull", dflt_value FROM pragma_table_info('sessions')`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    )
      .filter((column) => column.notnull === 1 && column.dflt_value === null)
      .map((column) => column.name)
      .sort();
  }

  it('the Tier-A write supplies every NOT-NULL-no-default column', () => {
    const db = cache();
    const { path } = plant('notnull', simpleSession());
    const id = seedIndexRow(db, path);

    // Read at runtime, so a column added later fails this test rather than
    // production.
    const columns = notNullNoDefault(db);
    expect(columns).toStrictEqual([
      'archive_path',
      'file_mtime_ms',
      'file_size',
      'last_activity_at',
      'project_path',
      'source_path',
      'started_at',
    ]);

    const row = sessionRow(db, id);
    for (const column of columns) expect(row[column], column).not.toBeNull();
  });

  it('a projection with no cwd leaves the seeded project_path in place', () => {
    const db = cache();
    // No `cwd` on any line, and no `origin`/`promptId` either: a bare uuid line.
    const { path } = plant('nocwd', [
      {
        type: 'assistant',
        uuid: 'aaaa1111-1111-4111-8111-aaaa11110000',
        timestamp: TS(0),
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    ]);
    const id = seedIndexRow(db, path, { project_path: '/seeded/by/the/sweep' });

    expect(project(db, id, path)).toBe('ready');
    expect(sessionRow(db, id).project_path).toBe('/seeded/by/the/sweep');
  });

  it('a projection that folds a cwd overwrites it', () => {
    const db = cache();
    const { path } = plant('withcwd', simpleSession());
    const id = seedIndexRow(db, path, { project_path: '/seeded/by/the/sweep' });

    project(db, id, path);
    expect(sessionRow(db, id).project_path).toBe(CWD);
  });

  it('mutation control: a NULL project_path is refused by the column itself', () => {
    const db = cache();
    const { path } = plant('nullpath', simpleSession());
    const id = seedIndexRow(db, path);

    expect(() =>
      db.prepare('UPDATE sessions SET project_path = NULL WHERE id = ?').run(id),
    ).toThrow(/NOT NULL constraint failed: sessions.project_path/);
  });

  it('neither module derives anything from archive_path', () => {
    // The encoded-directory to cwd decoder belongs to the corpus sweep and must
    // exist in exactly one place.
    for (const module of ['freshness.ts', 'write.ts']) {
      const source = readFileSync(join(import.meta.dirname, '..', module), 'utf8');
      expect(source, module).not.toMatch(/\bbasename\s*\(/);
      expect(source, module).not.toMatch(/\bdirname\s*\(/);
    }
  });
});

describe('a headerless file is tombstoned, never deleted (AC6)', () => {
  const ARMS: readonly [string, readonly unknown[]][] = [
    [
      'timestamps but zero events',
      [
        { type: 'ai-title', timestamp: TS(0), title: 'a summary-only file' },
        { type: 'file-history-snapshot', timestamp: TS(1), snapshot: {} },
      ],
    ],
    [
      'uuid lines but no top-level timestamp',
      [
        {
          type: 'assistant',
          uuid: 'bbbb1111-1111-4111-8111-bbbb11110000',
          message: { role: 'assistant', content: [{ type: 'text', text: 'no clock here' }] },
        },
      ],
    ],
  ];

  it.each(ARMS)('%s tombstones the row', (name, records) => {
    const db = cache();
    const { path } = plant(`tomb-${name.replaceAll(' ', '-')}`, records);
    const id = seedIndexRow(db, path);

    expect(project(db, id, path)).toBe('empty');

    const row = sessionRow(db, id);
    // The row is PRESENT — deleting it would make two writers own it from
    // opposite directions, and the sweep would re-create it on the next pass.
    expect(row).toBeDefined();
    expect(row.projection_state).toBe('empty');
    expect(countOf(db, 'turns', id)).toBe(0);
    expect(countOf(db, 'events', id)).toBe(0);
    // Stamped, so the sweep does not re-read the file on every request.
    expect(row.projected_mtime_ms).toBe(foldArchive(path)!.mtime_ms);
    expect(row.projector_version).toBe(PROJECTOR_VERSION);
    for (const column of ['project_path', 'started_at', 'last_activity_at']) {
      expect(row[column], column).not.toBeNull();
    }
  });
});

describe('drift_json carries what BOTH stages counted (AC7)', () => {
  const DRIFTY: readonly unknown[] = [
    humanLine('go', TS(0)),
    {
      type: 'assistant',
      uuid: 'cccc1111-1111-4111-8111-cccc11110000',
      timestamp: TS(1),
      cwd: CWD,
      unmeasuredTopLevelField: 'surprise',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    },
    {
      type: 'a-record-type-nobody-has-measured',
      uuid: 'dddd1111-1111-4111-8111-dddd11110000',
      timestamp: TS(2),
      cwd: CWD,
    },
  ];

  it('an unknown field and an unknown record type both land in the column', () => {
    const db = cache();
    const { path } = plant('drift', DRIFTY);
    const id = seedIndexRow(db, path);

    project(db, id, path);

    const drift = JSON.parse(String(sessionRow(db, id).drift_json)) as Record<string, unknown>;
    expect(drift).toHaveProperty('unknown_top_level_fields');
    expect(drift).toHaveProperty('unknown_line_types');
  });

  it('mutation control: a fresh counter into runPipeline reports nothing', () => {
    // The drafted seam kept the read's counter to itself. `noteLine` and
    // `noteUnknownType` fire during the read, so a fresh counter here loses both
    // buckets and ships the column empty — the payloads_fts failure, again.
    const { lines } = parseJsonl(jsonl(DRIFTY));
    const fresh = runPipeline(lines, { session_id: 'x', drift: new DriftCounter() });
    expect(fresh.drift).toBe('{}');
  });

  it('a clean session stays exactly {}', () => {
    const db = cache();
    const { path } = plant('clean', simpleSession());
    const id = seedIndexRow(db, path);

    project(db, id, path);
    expect(sessionRow(db, id).drift_json).toBe('{}');
  });

  it('unresolved_spills is a drift key, omitted at zero, and sorted last', () => {
    const db = cache();
    const { path, dir } = plant('unresolved', [
      humanLine('two spills, one lost', TS(0)),
      {
        type: 'assistant',
        uuid: 'eeee1111-1111-4111-8111-eeee11110000',
        timestamp: TS(1),
        cwd: CWD,
        unmeasuredTopLevelField: 'surprise',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_ok', name: 'Grep', input: {} },
            { type: 'tool_use', id: 'toolu_lost', name: 'Bash', input: {} },
          ],
        },
      },
      toolResultLine('toolu_ok', spillMarker('/gone/tool-results/here.txt'), TS(2)),
      toolResultLine('toolu_lost', spillMarker('/gone/tool-results/lost.txt'), TS(3)),
    ]);
    writeFile(join(dir, 'tool-results', 'here.txt'), 'present');
    const id = seedIndexRow(db, path);

    project(db, id, path);

    const raw = String(sessionRow(db, id).drift_json);
    const drift = JSON.parse(raw) as Record<string, unknown>;
    expect(drift['unresolved_spills']).toBe(1);
    expect(Object.keys(drift)).toStrictEqual([...Object.keys(drift)].sort());
    // A column would have shifted the one-door ordinals for no reason.
    expect(readFileSync(join(import.meta.dirname, '..', 'schema.ts'), 'utf8')).not.toContain(
      'unresolved_spills',
    );
  });

  it('a session with no missing spill omits the key entirely', () => {
    const db = cache();
    const { path } = plant('nospills', simpleSession());
    const id = seedIndexRow(db, path);

    project(db, id, path);
    expect(String(sessionRow(db, id).drift_json)).not.toContain('unresolved_spills');
  });
});

describe('recomputeSessionRollups (AC8)', () => {
  it('turn_count counts HUMAN turns only', () => {
    const db = cache();
    const { path } = plant('rollups', [
      humanLine('one', TS(0)),
      toolCallLine('toolu_a', 'Grep', TS(1)),
      toolResultLine('toolu_a', 'ok', TS(2)),
      // A machinery turn: the harness wrote it, so it opens a turn of its own
      // and must NOT be counted as a human prompt.
      machineryLine('<task-notification>\n<status>done</status>', TS(3)),
      humanLine('two', TS(4)),
    ]);
    const id = seedIndexRow(db, path);

    project(db, id, path);

    const allTurns = (
      db.prepare('SELECT count(*) AS n FROM turns WHERE session_id = ?').get(id) as { n: number }
    ).n;
    const humanTurns = (
      db
        .prepare(`SELECT count(*) AS n FROM turns WHERE session_id = ? AND kind = 'human'`)
        .get(id) as { n: number }
    ).n;

    expect(sessionRow(db, id).turn_count).toBe(humanTurns);
    // The plain count over the same fixture is larger, which is what the ~19x
    // over-count in the measured session looks like in miniature.
    expect(allTurns).toBeGreaterThan(humanTurns);
  });

  it('a session with zero turns survives every aggregate', () => {
    const db = cache();
    const { path } = plant('noturns', simpleSession());
    const id = seedIndexRow(db, path);

    // No turns at all: SUM and COUNT both answer NULL into NOT NULL columns
    // unless every aggregate is COALESCEd.
    expect(() => recomputeSessionRollups(db, id)).not.toThrow();
    const row = sessionRow(db, id);
    for (const column of [
      'turn_count',
      'tool_call_count',
      'error_count',
      'tokens_in',
      'tokens_out',
      'tokens_cache_read',
      'tokens_cache_write',
    ]) {
      expect(row[column], column).toBe(0);
    }
  });

  it('est_cost is NULL for an unpriceable model, never 0', () => {
    const db = cache();
    const { path } = plant('unpriceable', [
      humanLine('go', TS(0)),
      toolCallLine('toolu_x', 'Grep', TS(1), 'a-model-nobody-has-priced'),
      toolResultLine('toolu_x', 'ok', TS(2)),
    ]);
    const id = seedIndexRow(db, path);

    project(db, id, path);
    expect(sessionRow(db, id).est_cost).toBeNull();
  });

  it('est_cost is a real number for a priced model', () => {
    const db = cache();
    const { path } = plant('priced', simpleSession());
    const id = seedIndexRow(db, path);

    project(db, id, path);
    expect(typeof sessionRow(db, id).est_cost).toBe('number');
  });
});

describe('upsertSessionIndex is the Tier-A writer', () => {
  it('re-upserting a projected row leaves the Tier-B stamp alone', () => {
    const db = cache();
    const { path } = plant('upsert', simpleSession());
    const id = seedIndexRow(db, path);
    project(db, id, path);

    upsertSessionIndex(db, {
      id,
      source_path: '/moved/elsewhere.jsonl',
      archive_path: path,
      file_mtime_ms: 42,
      file_size: 43,
      project_path: '/re/swept',
      started_at: '2026-08-14T09:00:00.000Z',
      last_activity_at: '2026-08-14T09:09:00.000Z',
    });

    const row = sessionRow(db, id);
    expect(row.source_path).toBe('/moved/elsewhere.jsonl');
    expect(row.file_mtime_ms).toBe(42);
    expect(row.projector_version).toBe(PROJECTOR_VERSION);
    expect(row.projection_state).toBe('ready');
  });
});
