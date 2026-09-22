// Task 7.5 — the spill drain, on its own.
//
// Every fixture is SYNTHETIC and projects through the real pipeline, so the rows
// the drain reads are the rows the projector actually writes. The env is the
// production one (`createSpillIndexEnv`) unless an arm needs a stub to observe
// a call count or to break a clause.

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { createArchiveReader } from '../../archive/read.js';
import { createSpillIndexEnv } from '../../corpus/watch.js';
import { foldArchive } from '../freshness.js';
import { searchEvents, type EventContentRow } from '../read.js';
import { indexSpills, SPILL_INDEX_MAX_BYTES, type SpillIndexEnv } from '../spill-index.js';
import { projectSession } from '../write.js';
import {
  countOf,
  fileEnv,
  ftsIntegrityCheck,
  humanLine,
  openCache,
  seedIndexRow,
  sessionRow,
  spillMarker,
  toolCallLine,
  toolResultLine,
  writeFile,
  writeTranscript,
} from './fixtures/index.js';

let sandbox: Sandbox | undefined;
const open: DatabaseSync[] = [];

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  if (sandbox !== undefined) cleanup(sandbox);
  sandbox = undefined;
});

const TS = (seconds: number): string =>
  new Date(Date.UTC(2026, 8, 22, 9, 0, seconds)).toISOString();

interface Planted {
  db: DatabaseSync;
  id: string;
  path: string;
  bodies: string[];
}

/**
 * One session, `count` spilled Bash results, every body really on disk under the
 * archive mirror. Body `i` carries `zzbody<i>`.
 */
function plantSpills(count = 1, name = 'spills'): Planted {
  const db = openCache();
  open.push(db);
  const path = join(sb().archiveRoot, `${name}.jsonl`);
  const dir = path.slice(0, -'.jsonl'.length);
  const records: unknown[] = [humanLine('spill a few', TS(0))];
  const bodies: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const call = `toolu_s${i}`;
    records.push(toolCallLine(call, 'Bash', TS(1 + 2 * i)));
    records.push(toolResultLine(call, spillMarker(`/gone/tool-results/s${i}.txt`), TS(2 + 2 * i)));
    bodies.push(writeFile(join(dir, 'tool-results', `s${i}.txt`), `body ${i} says zzbody${i}`));
  }
  writeTranscript(path, records);
  const id = seedIndexRow(db, path);
  projectSession(db, id, fileEnv(), foldArchive(path)!);
  return { db, id, path, bodies };
}

function env(db: DatabaseSync): SpillIndexEnv {
  return createSpillIndexEnv(db, createArchiveReader(), [sb().archiveRoot, sb().sourceRoot]);
}

function spillRows(db: DatabaseSync): { event_id: string; spill_path: string }[] {
  return db
    .prepare('SELECT event_id, spill_path FROM spill_fts ORDER BY rowid')
    .all() as unknown as { event_id: string; spill_path: string }[];
}

function find(db: DatabaseSync, q: string): string[] {
  return searchEvents(db, { q, limit: 50 }).map((hit) => hit.event_id);
}

function spillIntegrityCheck(db: DatabaseSync): void {
  db.exec(`INSERT INTO spill_fts(spill_fts, rank) VALUES('integrity-check', 1)`);
}

describe('indexSpills indexes each body once', () => {
  it('writes one row per spill and makes the body searchable', () => {
    const { db, id } = plantSpills(2);
    expect(find(db, 'zzbody1')).toEqual([]);

    const report = indexSpills(db, env(db));

    expect(report).toEqual({ indexed: 2, removed: 0, skipped: [] });
    expect(spillRows(db).map((row) => row.event_id)).toEqual(['toolu_s0', 'toolu_s1']);
    expect(find(db, 'zzbody1')).toEqual(['toolu_s1']);
    // The projection is untouched: the drain writes one table and no other.
    expect(sessionRow(db, id).projection_state).toBe('ready');
  });

  it('is idempotent: a second pass writes nothing and reads no body', () => {
    const { db } = plantSpills(2);
    indexSpills(db, env(db));

    let resolved = 0;
    const real = env(db);
    const counted: SpillIndexEnv = {
      resolve: (row, field) => {
        resolved += 1;
        return real.resolve(row, field);
      },
      locate: real.locate,
    };

    expect(indexSpills(db, counted)).toEqual({ indexed: 0, removed: 0, skipped: [] });
    expect(resolved).toBe(0);
    expect(spillRows(db)).toHaveLength(2);
  });
});

describe('AC3 — a body that is not there is skipped by path, never a throw', () => {
  it('skips a body gone before its first index, and indexes it once restored', () => {
    const { db, bodies } = plantSpills(1);
    const [body] = bodies;
    rmSync(body!);

    const first = indexSpills(db, env(db));
    expect(first.indexed).toBe(0);
    expect(first.skipped).toHaveLength(1);
    expect(first.skipped[0]).toMatch(/s0\.txt$/);
    expect(spillRows(db)).toEqual([]);

    writeFile(body!, 'body 0 is back with zzbody0');
    expect(indexSpills(db, env(db))).toEqual({ indexed: 1, removed: 0, skipped: [] });
    expect(find(db, 'zzbody0')).toEqual(['toolu_s0']);
  });

  it('a resolver that throws is a skip, and the projection is left exactly as it was (AC4, Test 8)', () => {
    const { db, id } = plantSpills(1);
    const before = db.prepare('SELECT * FROM events ORDER BY seq').all();
    const throwing: SpillIndexEnv = {
      resolve: () => {
        throw new Error('boom');
      },
      locate: () => undefined,
    };

    let report: ReturnType<typeof indexSpills> | undefined;
    expect(() => (report = indexSpills(db, throwing))).not.toThrow();
    expect(report!.skipped).toHaveLength(1);
    expect(sessionRow(db, id).projection_state).toBe('ready');
    expect(db.prepare('SELECT * FROM events ORDER BY seq').all()).toEqual(before);
  });
});

describe('the reconcile re-probes every indexed row', () => {
  it('removes the row once its body is deleted, and search stops finding it', () => {
    const { db, bodies } = plantSpills(1);
    indexSpills(db, env(db));
    expect(find(db, 'zzbody0')).toEqual(['toolu_s0']);

    rmSync(bodies[0]!);
    // Nothing reprojected: the events row still says `spill`.
    expect(db.prepare(`SELECT output_storage FROM events WHERE id = 'toolu_s0'`).get()).toEqual({
      output_storage: 'spill',
    });

    const report = indexSpills(db, env(db));
    expect(report.removed).toBe(1);
    expect(spillRows(db)).toEqual([]);
    expect(find(db, 'zzbody0')).toEqual([]);
    expect(() => spillIntegrityCheck(db)).not.toThrow();
  });

  it('mutation control: a locator that never says gone leaves the row and the hit', () => {
    const { db, bodies } = plantSpills(1);
    indexSpills(db, env(db));
    rmSync(bodies[0]!);

    // The same reconcile with the probe clause neutralised.
    const blind: SpillIndexEnv = { ...env(db), locate: () => '/pretend/it/is/there.txt' };
    expect(indexSpills(db, blind).removed).toBe(0);
    expect(find(db, 'zzbody0')).toEqual(['toolu_s0']);
  });

  it('removes the row when its events row is gone, or no longer points at the body', () => {
    const { db, id } = plantSpills(2);
    indexSpills(db, env(db));

    db.prepare(`DELETE FROM events WHERE id = 'toolu_s0'`).run();
    db.prepare(`UPDATE events SET spill_path = '/elsewhere/s1.txt' WHERE id = 'toolu_s1'`).run();

    const report = indexSpills(db, env(db));
    expect(report.removed).toBe(2);
    // The moved pointer is a NEW identity. The mirror arm re-anchors its
    // basename under the archive, so the same body is indexed again under it.
    expect(report.indexed).toBe(1);
    expect(spillRows(db)).toEqual([{ event_id: 'toolu_s1', spill_path: '/elsewhere/s1.txt' }]);
    expect(find(db, 'zzbody1')).toEqual(['toolu_s1']);
    expect(find(db, 'zzbody0')).toEqual([]);
    expect(countOf(db, 'events', id)).toBeGreaterThan(0);
  });

  it('survives three delete/re-index cycles with both FTS tables intact', () => {
    const { db, bodies } = plantSpills(1);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(indexSpills(db, env(db)).indexed).toBe(1);
      rmSync(bodies[0]!);
      expect(indexSpills(db, env(db)).removed).toBe(1);
      writeFile(bodies[0]!, `body 0 says zzbody0, cycle ${cycle}`);
    }
    expect(indexSpills(db, env(db)).indexed).toBe(1);
    expect(spillRows(db)).toHaveLength(1);
    expect(() => spillIntegrityCheck(db)).not.toThrow();
    expect(() => ftsIntegrityCheck(db)).not.toThrow();
  });
});

describe('the per-body cap and the shared deadline', () => {
  it('skips a body over the cap by path, whether declared or measured', () => {
    const { db } = plantSpills(2);
    const real = env(db);
    const resolvedIds: string[] = [];
    const huge: SpillIndexEnv = {
      locate: real.locate,
      resolve: (row: EventContentRow, field) => {
        resolvedIds.push(row.id);
        const body = real.resolve(row, field);
        return { ...body, byte_size: SPILL_INDEX_MAX_BYTES + 1 };
      },
    };
    // A DECLARED size over the cap rules s0 out before any read.
    db.prepare(`UPDATE events SET spill_bytes = ? WHERE id = 'toolu_s0'`).run(
      SPILL_INDEX_MAX_BYTES + 1,
    );

    const report = indexSpills(db, huge);
    expect(report.indexed).toBe(0);
    expect(report.skipped).toHaveLength(2);
    expect(resolvedIds).toEqual(['toolu_s1']);
    expect(spillRows(db)).toEqual([]);
  });

  it('a pass already past its deadline indexes exactly one body, and the reconcile still runs whole', () => {
    const { db, bodies } = plantSpills(3);
    indexSpills(db, env(db));
    // Remove two indexed rows' bodies, and add nothing: the reconcile is not budgeted.
    rmSync(bodies[0]!);
    rmSync(bodies[1]!);
    const late = { now: () => 10_000, startedAt: 0, deadlineMs: 250 };
    expect(indexSpills(db, env(db), late)).toMatchObject({ indexed: 0, removed: 2 });

    // Three fresh candidates, a blown deadline: one per pass, never zero.
    db.exec('DELETE FROM spill_fts');
    writeFile(bodies[0]!, 'zzbody0 again');
    writeFile(bodies[1]!, 'zzbody1 again');
    expect(indexSpills(db, env(db), late).indexed).toBe(1);
    expect(indexSpills(db, env(db), late).indexed).toBe(1);
    expect(indexSpills(db, env(db), late).indexed).toBe(1);
    expect(indexSpills(db, env(db), late).indexed).toBe(0);
    expect(spillRows(db)).toHaveLength(3);
  });
});
