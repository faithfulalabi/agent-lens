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
  eventRow,
  fileEnv,
  ftsIntegrityCheck,
  humanLine,
  jsonl,
  machineryLine,
  nextUuid,
  openCache,
  parseJsonl,
  seedIndexRow,
  seedSessionRow,
  seedSidecarRow,
  sessionRow,
  spillMarker,
  subagentsDirOf,
  toolCallLine,
  toolResultLine,
  writeFile,
  writeSidecarMeta,
  writeSidecarTranscript,
  writeTranscript,
} from './fixtures/index.js';
import {
  deleteSessionProjection,
  projectSession,
  recomputeSessionRollups,
  recomputeSubagentRollups,
  upsertSessionIndex,
} from '../write.js';
import { estimateCost } from '../../shared/pricing.js';
import { foldArchive } from '../freshness.js';
import { searchEvents } from '../read.js';
import { INLINE_MAX, PREVIEW_MAX } from '../../project/tools.js';

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

  it('stores the fold key a machinery turn was stamped with (Task 5.1)', () => {
    // The one end-to-end limb of the fold: `pipeline.ts` computes the key,
    // `write.ts` binds it and `read.ts` selects it. Every earlier fixture leaves
    // the column null, so without a NON-null value the round trip is untested.
    const db = cache();
    const { path } = plant('fold', [
      humanLine('launch an agent', TS(0)),
      toolCallLine('toolu_agent', 'Agent', TS(1)),
      toolResultLine('toolu_agent', 'launched in the background', TS(2)),
      machineryLine(
        '<task-notification>\n<tool-use-id>toolu_agent</tool-use-id>\n<status>done</status>',
        TS(3),
      ),
    ]);
    const id = seedIndexRow(db, path);

    project(db, id, path);

    const stored = db
      .prepare(`SELECT seq, kind, parent_event_id FROM turns WHERE session_id = ? ORDER BY seq`)
      .all(id) as { seq: number; kind: string; parent_event_id: string | null }[];

    expect(stored.map((turn) => turn.kind)).toEqual(['human', 'task_notification']);
    expect(stored[0]?.parent_event_id).toBeNull();
    expect(stored[1]?.parent_event_id).toBe('toolu_agent');
    // Non-vacuity: the id it stores is a real `Agent` row on the same session.
    expect(
      (db.prepare('SELECT name FROM events WHERE id = ?').get('toolu_agent') as { name: string })
        .name,
    ).toBe('Agent');
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
      const stored = eventRow(db, event.id);
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
    // Exactly `{}`, so `unresolved_spills` is omitted at zero too.
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

  it('a claude-opus-5 session is priced, and at the published rate (Task 0.8b)', () => {
    const db = cache();
    const { path } = plant('opus5', [
      humanLine('go', TS(0)),
      toolCallLine('toolu_o5', 'Grep', TS(1), 'claude-opus-5', {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 8000,
      }),
      toolResultLine('toolu_o5', 'ok', TS(2)),
    ]);
    const id = seedIndexRow(db, path);

    project(db, id, path);

    // $5 in / $25 out / $0.50 cache read / $6.25 cache write per MTok:
    // (1000*5 + 2000*25 + 4000*0.5 + 8000*6.25) / 1e6 = 0.107
    const cost = sessionRow(db, id).est_cost as number | null;
    expect(cost).not.toBeNull();
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(0.107, 10);
  });
});

describe('the folded model reaches the row (Task 0.13)', () => {
  /** The line the harness manufactures on an auth expiry. It names no model. */
  function syntheticLine(ts: string): Record<string, unknown> {
    return {
      type: 'assistant',
      uuid: nextUuid(),
      timestamp: ts,
      cwd: CWD,
      gitBranch: 'main',
      version: '2.1.212',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Login expired · Please run /login' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      error: 'authentication_failed',
      isApiErrorMessage: true,
    };
  }

  it('writes the model that did the work, not the marker on the last line', () => {
    const db = cache();
    const { path } = plant('lastsynthetic', [
      humanLine('go', TS(0)),
      toolCallLine('toolu_real', 'Grep', TS(1), 'claude-opus-5'),
      toolResultLine('toolu_real', 'ok', TS(2)),
      syntheticLine(TS(3)),
    ]);
    const id = seedIndexRow(db, path);

    project(db, id, path);

    // The only end-to-end cover of the header-to-column bind: the pipeline
    // suite opens no database and can assert a projection, never a row.
    expect(sessionRow(db, id).model).toBe('claude-opus-5');
  });

  it('leaves model and est_cost NULL when the marker is all the file names', () => {
    const db = cache();
    const { path } = plant('allsynthetic', [humanLine('go', TS(0)), syntheticLine(TS(1))]);
    const id = seedIndexRow(db, path);

    // `ready` first: NULL is also this column's default, so a session that
    // never projected would satisfy both assertions below for free.
    expect(project(db, id, path)).toBe('ready');
    const row = sessionRow(db, id);

    expect(row.model).toBeNull();
    // NULL is "nothing priceable ran", and it is never 0 — see the column note.
    expect(row.est_cost).toBeNull();
  });
});

describe('mixed-model pricing: the session is the sum of its parts (Task 0.14)', () => {
  /** An assistant tool call CARRYING USAGE, under an explicit model. */
  function pricedCallLine(
    callId: string,
    model: string,
    usage: Record<string, number>,
    ts: string,
  ): Record<string, unknown> {
    return toolCallLine(callId, 'Grep', ts, model, usage);
  }

  /** Haiku spends 1M input, Sonnet 1M output: every one-rate answer is wrong. */
  function mixedSession(): readonly unknown[] {
    return [
      humanLine('one', TS(0)),
      pricedCallLine(
        'toolu_h',
        'claude-haiku-4-5',
        { input_tokens: 1_000_000, output_tokens: 0 },
        TS(1),
      ),
      toolResultLine('toolu_h', 'ok', TS(2)),
      humanLine('two', TS(3)),
      pricedCallLine(
        'toolu_s',
        'claude-sonnet-5',
        { input_tokens: 0, output_tokens: 1_000_000 },
        TS(4),
      ),
      toolResultLine('toolu_s', 'ok', TS(5)),
    ];
  }

  it('★ prices each model at its own rate, never total_tokens × one rate (AC1)', () => {
    const db = cache();
    const { path } = plant('mixed', mixedSession());
    const id = seedIndexRow(db, path);

    project(db, id, path);

    // Haiku: 1M input × $1/1M = $1. Sonnet: 1M output × $15/1M = $15.
    expect(sessionRow(db, id).est_cost).toBe(16);
    // The fixture is chosen so BOTH single-model answers provably differ:
    // haiku over the whole total is $6 (1M×1 + 1M×5), sonnet is $18 (1M×3 +
    // 1M×15). A single-model fixture passes under either implementation.
    expect(sessionRow(db, id).est_cost).not.toBe(6);
    expect(sessionRow(db, id).est_cost).not.toBe(18);
    // Task 0.13's folded model is untouched — informational, no longer priced.
    expect(sessionRow(db, id).model).not.toBeNull();
  });

  it('writes model and est_cost onto the event, and est_cost onto its turn (AC2)', () => {
    const db = cache();
    const { path } = plant('percall', mixedSession());
    const id = seedIndexRow(db, path);

    project(db, id, path);

    const events = db
      .prepare(
        `SELECT model, est_cost FROM events
         WHERE session_id = ? AND model IS NOT NULL ORDER BY seq`,
      )
      .all(id) as { model: string; est_cost: number }[];
    expect(events).toEqual([
      { model: 'claude-haiku-4-5', est_cost: 1 },
      { model: 'claude-sonnet-5', est_cost: 15 },
    ]);
    // …and on no other row: the stamp is the token stamp, first of group only.
    const priced = db
      .prepare('SELECT count(*) AS n FROM events WHERE session_id = ? AND est_cost IS NOT NULL')
      .get(id) as { n: number };
    expect(priced.n).toBe(2);

    const turns = db
      .prepare('SELECT est_cost FROM turns WHERE session_id = ? ORDER BY seq')
      .all(id) as { est_cost: number | null }[];
    expect(turns).toEqual([{ est_cost: 1 }, { est_cost: 15 }]);
  });

  it('★ a real-but-unpriceable part makes the roll-up NULL, never a low number (AC3)', () => {
    const db = cache();
    const { path } = plant('partial', [
      humanLine('go', TS(0)),
      pricedCallLine(
        'toolu_p',
        'claude-sonnet-5',
        { input_tokens: 1000, output_tokens: 2000 },
        TS(1),
      ),
      toolResultLine('toolu_p', 'ok', TS(2)),
      humanLine('again', TS(3)),
      // Real, non-zero spend under a model with no rate: the exact case a
      // naive SUM would silently drop, presenting $0.033 as the whole truth.
      pricedCallLine(
        'toolu_u',
        'a-model-nobody-has-priced',
        { input_tokens: 500, output_tokens: 100 },
        TS(4),
      ),
      toolResultLine('toolu_u', 'ok', TS(5)),
    ]);
    const id = seedIndexRow(db, path);

    project(db, id, path);

    const turns = db
      .prepare('SELECT est_cost FROM turns WHERE session_id = ? ORDER BY seq')
      .all(id) as { est_cost: number | null }[];
    // The priced turn keeps its own real number; only the sums go NULL.
    expect(turns[0]!.est_cost).toBe(
      estimateCost('claude-sonnet-5', { tokens_in: 1000, tokens_out: 2000 }),
    );
    expect(turns[1]!.est_cost).toBeNull();
    expect(sessionRow(db, id).est_cost).toBeNull();
  });

  it('a zero-token part never blocks the sum, and an all-zero turn stays NULL (AC3)', () => {
    const db = cache();
    const { path } = plant('zeropart', [
      humanLine('go', TS(0)),
      pricedCallLine(
        'toolu_p',
        'claude-sonnet-5',
        { input_tokens: 1000, output_tokens: 2000 },
        TS(1),
      ),
      toolResultLine('toolu_p', 'ok', TS(2)),
      // The harness's zero-usage placeholder rides inside the priced turn…
      {
        type: 'assistant',
        uuid: nextUuid(),
        timestamp: TS(3),
        cwd: CWD,
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Login expired' }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      // …and a human-only turn follows: NULL cost, zero tokens, never a 0.
      humanLine('still there?', TS(4)),
    ]);
    const id = seedIndexRow(db, path);

    project(db, id, path);

    // Blocking on ANY null est_cost — the naive spelling — would answer NULL
    // here; the zero-token guard is what keeps the priced turn's number.
    expect(sessionRow(db, id).est_cost).toBe(
      estimateCost('claude-sonnet-5', { tokens_in: 1000, tokens_out: 2000 }),
    );
    const trailing = db
      .prepare('SELECT est_cost FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 1')
      .get(id) as { est_cost: number | null };
    expect(trailing.est_cost).toBeNull();
  });
});

describe('sub_est_cost follows the same rule: real spend blocks, zero spend never does', () => {
  it('★ an unpriced child with real tokens makes the parent NULL, not a low sum', () => {
    const db = cache();
    const parent = seedSessionRow(db, { id: 'parent-1' });
    seedSidecarRow(db, parent, { id: 'kid-priced', est_cost: 1.5 });
    // Defaults carry real token counts; est_cost null is a missing price.
    seedSidecarRow(db, parent, { id: 'kid-unpriced', est_cost: null });

    recomputeSubagentRollups(db, parent);

    // The pre-0.14 SQL COALESCEd the unpriced child to a confident $0 and
    // answered 1.5 — the exact silent under-report AC3 forbids.
    expect(sessionRow(db, parent).sub_est_cost).toBeNull();
  });

  it('a zero-token unpriced child never blocks, and an all-null tree stays NULL', () => {
    const db = cache();
    const parent = seedSessionRow(db, { id: 'parent-2' });
    seedSidecarRow(db, parent, { id: 'kid-real', est_cost: 1.5 });
    seedSidecarRow(db, parent, {
      id: 'kid-empty',
      est_cost: null,
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    });

    recomputeSubagentRollups(db, parent);
    expect(sessionRow(db, parent).sub_est_cost).toBe(1.5);

    const bare = seedSessionRow(db, { id: 'parent-3' });
    seedSidecarRow(db, bare, {
      id: 'kid-only-empty',
      est_cost: null,
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    });
    recomputeSubagentRollups(db, bare);
    expect(sessionRow(db, bare).sub_est_cost).toBeNull();
  });

  it('a grandchild the child could not price blocks the parent too', () => {
    const db = cache();
    const parent = seedSessionRow(db, { id: 'parent-4' });
    seedSidecarRow(db, parent, {
      id: 'kid-blocked',
      est_cost: 2.0,
      tokens_in: 10,
      tokens_out: 10,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    });
    // The child's own sub-tree moved real tokens it could not price: its
    // sub_est_cost NULL is a missing price, not an absence of descendants.
    db.prepare('UPDATE sessions SET sub_tokens_in = 500 WHERE id = ?').run('kid-blocked');

    recomputeSubagentRollups(db, parent);
    expect(sessionRow(db, parent).sub_est_cost).toBeNull();
  });
});

describe('a sidecar IS a sessions row (Task 3.3 AC1, AC2, AC3)', () => {
  /** The launch result text, exactly as the harness writes it. */
  function launched(agentId: string): string {
    return `Async agent launched successfully.\nagentId: ${agentId}`;
  }

  /** An `Agent` call answered by a background launch that names `agentId`. */
  function asyncAgent(callId: string, agentId: string, at: number): readonly unknown[] {
    return [
      toolCallLine(callId, 'Agent', TS(at)),
      toolResultLine(callId, launched(agentId), TS(at + 1), {
        toolUseResult: { isAsync: true, agentId },
      }),
    ];
  }

  /** The sub-agent's own transcript: three stamped lines that all carry a cwd. */
  function sidecarRecords(from: number, to: number): readonly unknown[] {
    return [
      humanLine('the brief', TS(from)),
      machineryLine('working', TS(from + 1)),
      machineryLine('done', TS(to)),
    ];
  }

  /** A parent that launched one sub-agent, with the sidecar pair on disk. */
  function linkedSession(name = 'linked'): { db: DatabaseSync; id: string; path: string } {
    const db = cache();
    const { path, dir } = plant(name, [
      humanLine('go', TS(0)),
      ...asyncAgent('toolu_agent', 'A1', 1),
    ]);
    const subagents = join(dir, 'subagents');
    writeSidecarTranscript(subagents, 'A1', sidecarRecords(10, 250));
    writeSidecarMeta(subagents, 'A1', {
      agentType: 'Explore',
      description: 'look around',
      toolUseId: 'toolu_agent',
      spawnDepth: 1,
    });

    // Anchored to the sandbox, because the fixture default is an unrelated fake
    // path and the derivation would then be asserted against nothing real.
    const id = seedIndexRow(db, path, { source_path: join(sb().sourceRoot, `${name}.jsonl`) });
    project(db, id, path);
    return { db, id, path };
  }

  it('the sidecar row carries the parentage, the linkage and a real source path', () => {
    const { db, id, path } = linkedSession();
    const row = sessionRow(db, 'A1');

    expect(row.parent_session_id).toBe(id);
    expect(row.spawned_by_event_id).toBe('toolu_agent');
    expect(row.agent_type).toBe('Explore');
    expect(row.agent_description).toBe('look around');
    expect(row.spawn_depth).toBe(1);
    expect(row.project_path).toBe(CWD);
    expect(row.started_at).toBe(TS(10));
    expect(row.last_activity_at).toBe(TS(250));
    expect(row.source_path).toBe(join(sb().sourceRoot, 'linked', 'subagents', 'agent-A1.jsonl'));
    expect(row.archive_path).toBe(
      join(path.slice(0, -'.jsonl'.length), 'subagents', 'agent-A1.jsonl'),
    );
  });

  it('the spawning event points at it, and no other event does', () => {
    const { db, id } = linkedSession();
    const linked = db
      .prepare('SELECT id, child_session_id, agent_type FROM events WHERE session_id = ?')
      .all(id) as { id: string; child_session_id: string | null; agent_type: string | null }[];

    expect(linked.filter((row) => row.child_session_id !== null)).toEqual([
      { id: 'toolu_agent', child_session_id: 'A1', agent_type: 'Explore' },
    ]);
    expect(linked.length).toBeGreaterThan(1);
  });

  it('the span is the sub-agent’s own, stamped sidecar_span', () => {
    const { db } = linkedSession();
    const row = eventRow(db, 'toolu_agent');

    expect(row.duration_source).toBe('sidecar_span');
    // TS(10) -> TS(250), and never the 1,000 ms handshake it replaced. The
    // property, never a literal: the measured launch gap ranges 40–3,263 ms.
    expect(row.duration_ms).toBe(240_000);
    expect(row.duration_ms).not.toBe(1_000);
  });

  it('a session with no sidecars keeps every Agent row on elapsed', () => {
    const db = cache();
    const { path } = plant('nosidecars', [
      humanLine('go', TS(0)),
      ...asyncAgent('toolu_a', 'X', 1),
    ]);
    const id = seedIndexRow(db, path);
    project(db, id, path);

    const row = eventRow(db, 'toolu_a');
    expect(row.duration_source).toBe('elapsed');
    expect(row.child_session_id).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });

  it('a SYNCHRONOUS Agent call links too', () => {
    // 41 of 258 measured `Agent` calls carry no launch marker at all, so a
    // linker gated on the launch would drop every one of them.
    const db = cache();
    const { path, dir } = plant('sync', [
      humanLine('go', TS(0)),
      toolCallLine('toolu_sync', 'Agent', TS(1)),
      toolResultLine('toolu_sync', 'answered inline', TS(2)),
    ]);
    writeSidecarTranscript(join(dir, 'subagents'), 'S1', sidecarRecords(10, 250));
    writeSidecarMeta(join(dir, 'subagents'), 'S1', { toolUseId: 'toolu_sync' });
    const id = seedIndexRow(db, path);

    project(db, id, path);

    expect(sessionRow(db, 'S1').parent_session_id).toBe(id);
    expect(String(sessionRow(db, id).drift_json)).not.toContain('sidecar_agent_id_mismatch');
  });

  it('a DISAGREEING agent id still links, and the mismatch reaches drift_json', () => {
    // The objection-2 regression: this reds if the writer serializes the
    // pipeline's drift SNAPSHOT instead of re-serializing its own live counter
    // after the link.
    const db = cache();
    const { path, dir } = plant('mismatch', [
      humanLine('go', TS(0)),
      ...asyncAgent('toolu_agent', 'SOMEONEELSE', 1),
    ]);
    writeSidecarTranscript(join(dir, 'subagents'), 'ONDISK', sidecarRecords(10, 250));
    writeSidecarMeta(join(dir, 'subagents'), 'ONDISK', { toolUseId: 'toolu_agent' });
    const id = seedIndexRow(db, path);

    project(db, id, path);

    expect(sessionRow(db, 'ONDISK').parent_session_id).toBe(id);
    const drift = JSON.parse(String(sessionRow(db, id).drift_json)) as Record<string, unknown>;
    expect(drift['sidecar_agent_id_mismatch']).toBe(1);
    expect(Object.keys(drift)).toStrictEqual([...Object.keys(drift)].sort());
  });

  const MALFORMED: readonly [string, Record<string, unknown> | undefined, readonly unknown[]][] = [
    // The exact shape of all 12 measured `wf_*` metas.
    [
      'a keyless workflow meta',
      { agentType: 'workflow-subagent', spawnDepth: 1 },
      [humanLine('brief', TS(10)), machineryLine('done', TS(20))],
    ],
    [
      'end lines with no cwd',
      { toolUseId: 'toolu_agent' },
      [
        { type: 'user', uuid: 'aaaa2222-1111-4111-8111-aaaa22220000', timestamp: TS(10) },
        { type: 'user', uuid: 'bbbb2222-1111-4111-8111-bbbb22220000', timestamp: TS(20) },
      ],
    ],
    [
      'end lines with no timestamp',
      { toolUseId: 'toolu_agent' },
      [
        { type: 'user', uuid: 'cccc2222-1111-4111-8111-cccc22220000', cwd: CWD },
        { type: 'user', uuid: 'dddd2222-1111-4111-8111-dddd22220000', cwd: CWD },
      ],
    ],
    [
      'no sibling meta at all',
      undefined,
      [humanLine('brief', TS(10)), machineryLine('done', TS(20))],
    ],
  ];

  it.each(MALFORMED)('%s links nothing and leaves the PARENT ready', (name, meta, records) => {
    const db = cache();
    const { path, dir } = plant(`bad-${name.replaceAll(' ', '-')}`, [
      humanLine('go', TS(0)),
      ...asyncAgent('toolu_agent', 'A1', 1),
    ]);
    writeSidecarTranscript(join(dir, 'subagents'), 'A1', records);
    if (meta !== undefined) writeSidecarMeta(join(dir, 'subagents'), 'A1', meta);
    const id = seedIndexRow(db, path);

    expect(() => project(db, id, path)).not.toThrow();

    // Removing the NOT NULL gate makes this row `failed`: the NULL bind throws
    // inside the savepoint and one malformed sub-agent takes out the session.
    expect(sessionRow(db, id).projection_state).toBe('ready');
    expect(sessionRow(db, 'A1')).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    expect(String(sessionRow(db, id).drift_json)).not.toContain('sidecar');
  });

  it('depth 3 projects through the same function, with no depth named anywhere', () => {
    // Depth 3 is UNWITNESSED in the corpus (1 x253, 2 x17), so this is synthetic
    // — and all three generations share ONE flat `subagents/` directory, which
    // is what the enclosing-directory walk resolves at every level.
    const db = cache();
    const { path, dir } = plant('deep', [
      humanLine('go', TS(0)),
      ...asyncAgent('toolu_d1', 'A1', 1),
    ]);
    const subagents = subagentsDirOf(path);
    expect(subagents).toBe(join(dir, 'subagents'));

    writeSidecarTranscript(subagents, 'A1', [
      humanLine('depth two', TS(10)),
      ...asyncAgent('toolu_d2', 'B1', 11),
      machineryLine('done', TS(100)),
    ]);
    writeSidecarMeta(subagents, 'A1', {
      agentType: 'Explore',
      toolUseId: 'toolu_d1',
      spawnDepth: 1,
    });
    writeSidecarTranscript(subagents, 'B1', sidecarRecords(20, 80));
    writeSidecarMeta(subagents, 'B1', {
      agentType: 'Explore',
      toolUseId: 'toolu_d2',
      spawnDepth: 2,
    });

    const id = seedIndexRow(db, path, { source_path: join(sb().sourceRoot, 'deep.jsonl') });
    project(db, id, path);
    // The SAME call, over the child's own row, then over the grandchild's.
    project(db, 'A1', sessionRow(db, 'A1').archive_path as string);
    project(db, 'B1', sessionRow(db, 'B1').archive_path as string);

    expect(sessionRow(db, 'A1').parent_session_id).toBe(id);
    expect(sessionRow(db, 'B1').parent_session_id).toBe('A1');
    expect(sessionRow(db, 'B1').spawn_depth).toBe(2);
    expect(sessionRow(db, 'B1').projection_state).toBe('ready');

    const chain = db
      .prepare(
        `SELECT session_id, id, child_session_id FROM events
         WHERE child_session_id IS NOT NULL ORDER BY session_id`,
      )
      .all() as { session_id: string; id: string; child_session_id: string }[];
    expect(chain).toEqual([
      { session_id: 'A1', id: 'toolu_d2', child_session_id: 'B1' },
      { session_id: id, id: 'toolu_d1', child_session_id: 'A1' },
    ]);
  });

  it('reprojecting the parent twice writes the same rows and keeps FTS intact', () => {
    const { db, id, path } = linkedSession('idempotent');
    const before = sessionRow(db, 'A1');

    project(db, id, path);

    expect(sessionRow(db, 'A1')).toStrictEqual(before);
    expect(db.prepare(`SELECT count(*) AS n FROM sessions`).get()).toEqual({ n: 2 });
    expect(countOf(db, 'events', id)).toBeGreaterThan(0);
    expect(() => ftsIntegrityCheck(db)).not.toThrow();
  });

  it('linking a child never touches the child’s own Tier-B stamp', () => {
    const { db, id, path } = linkedSession('restamp');
    project(db, 'A1', sessionRow(db, 'A1').archive_path as string);
    const projectedAt = sessionRow(db, 'A1').projected_at;
    expect(projectedAt).not.toBeNull();

    project(db, id, path);

    // The parent re-linked the child; the child's projection is still valid.
    expect(sessionRow(db, 'A1').projected_at).toBe(projectedAt);
    expect(sessionRow(db, 'A1').projection_state).toBe('ready');
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

// --- AC2: tool output is searchable, and exactly where the line falls ---------
//
// ★ THIS TEST GOES THROUGH THE PROJECTOR ON PURPOSE. `read.test.ts` seeds rows
// with raw SQL, so a search test there can only prove FTS5 indexes a string the
// test handed it. AC2 is a claim about the PROJECTOR — that a Bash result body
// reaches `events.text` — and the two arms that fail are decided inside
// `storeOutput`, a function no seed helper ever calls.
//
// ★ AC2 IS NARROWED, AND THIS IS THE DURABLE RECORD OF WHERE. Measured over the
// archive: 17,838 of 17,897 `tool_result` blocks inline whole, 59 spill, 0 land
// over the preview cap. A spilled body is WHOLLY unsearchable and that is
// deliberate at both ends — the projector cannot reach a filesystem and the
// writer keeps `text` NULL on every spill row. The arms below assert what the
// code does TODAY, so the day that policy changes this reds without the AC
// moving. Indexing spilled bodies is filed as its own task.

describe('AC2 — a token that appears only in tool output is found by q', () => {
  const INLINE_TOKEN = 'zzinlinetoken';
  const HEAD_TOKEN = 'zzheadtoken';
  const TAIL_TOKEN = 'zztailtoken';
  const SPILL_TOKEN = 'zzspilltoken';

  /** Over `INLINE_MAX`, with `HEAD_TOKEN` inside the 8 KB head and `TAIL_TOKEN` past it. */
  function oversizedResult(): string {
    const filler = 'filler '.repeat(Math.ceil(INLINE_MAX / 'filler '.length) + 1);
    return `${HEAD_TOKEN} ${filler} ${TAIL_TOKEN}`;
  }

  /** All three storage clauses in one projected session, the spill really on disk. */
  function threeArms(): { db: DatabaseSync; id: string } {
    const db = cache();
    const { path, dir } = plant('ac2-arms', [
      humanLine('search my tool output', TS(0)),
      toolCallLine('toolu_inline', 'Bash', TS(1)),
      toolResultLine('toolu_inline', `the build failed: ${INLINE_TOKEN} in the log`, TS(2)),
      toolCallLine('toolu_big', 'Bash', TS(3)),
      toolResultLine('toolu_big', oversizedResult(), TS(4)),
      toolCallLine('toolu_spilled', 'Bash', TS(5)),
      toolResultLine('toolu_spilled', spillMarker('/gone/tool-results/spilled.txt'), TS(6)),
    ]);
    // Really on disk, under the session root the harness mirrors `tool-results/`
    // into. A marker the probe cannot confirm lands `'missing'`, not `'spill'`.
    writeFile(join(dir, 'tool-results', 'spilled.txt'), `body says ${SPILL_TOKEN}`);

    const id = seedIndexRow(db, path);
    project(db, id, path);
    return { db, id };
  }

  function find(db: DatabaseSync, q: string): string[] {
    return searchEvents(db, { q, limit: 50 }).map((hit) => hit.event_id);
  }

  it('(a) inline: a Bash result body is indexed, with a snippet that marks the term', () => {
    const { db } = threeArms();
    expect(eventRow(db, 'toolu_inline').output_storage).toBe('inline');

    const hits = searchEvents(db, { q: INLINE_TOKEN, limit: 50 });
    expect(hits.map((hit) => hit.event_id)).toEqual(['toolu_inline']);
    expect(hits[0]!.snippet).toContain(`<mark>${INLINE_TOKEN}</mark>`);
  });

  it('(b) preview cap: the 8 KB head is searchable and everything past the cut is not', () => {
    const { db } = threeArms();
    const row = eventRow(db, 'toolu_big');
    expect(row.output_storage).toBe('line_ref');
    expect(Buffer.byteLength(row.text as string, 'utf8')).toBeLessThanOrEqual(PREVIEW_MAX);

    expect(find(db, HEAD_TOKEN)).toEqual(['toolu_big']);
    expect(find(db, TAIL_TOKEN)).toEqual([]);
  });

  it('(c) spill: the body is on disk, the row keeps no text, and q finds nothing', () => {
    const { db } = threeArms();
    const row = eventRow(db, 'toolu_spilled');

    // Resolved, so this is the spill clause and not the `missing` one.
    expect(row.output_storage).toBe('spill');
    expect(row.spill_path).not.toBeNull();
    expect(row.text).toBeNull();

    // The gap AC2 is narrowed around: the bytes exist and search cannot see them.
    expect(find(db, SPILL_TOKEN)).toEqual([]);
  });

  it('non-vacuity: the three arms really did take three different clauses', () => {
    const { db, id } = threeArms();
    const clauses = (
      db
        .prepare(
          `SELECT output_storage FROM events
            WHERE session_id = ? AND kind = 'tool_call' ORDER BY seq`,
        )
        .all(id) as { output_storage: string }[]
    ).map((r) => r.output_storage);

    expect(clauses).toEqual(['inline', 'line_ref', 'spill']);
  });
});
