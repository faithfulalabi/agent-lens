// The spill drain on its own. Fixtures project through the real pipeline, and the
// env is the production one unless a case needs a stub.

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { resolveArchiveRoot } from '../../archive/paths.js';
import { createArchiveReader } from '../../archive/read.js';
import { createCorpusSweep, createSpillIndexEnv } from '../../corpus/watch.js';
import { foldArchive } from '../freshness.js';
import { readHealthCounts, searchEvents } from '../read.js';
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

/** One session, `count` spilled Bash results; body `i` is on disk and carries `zzbody<i>`. */
function plantSpills(count = 1): { db: DatabaseSync; id: string; bodies: string[] } {
  const db = openCache();
  open.push(db);
  const path = join(sb().archiveRoot, 'spills.jsonl');
  const dir = path.slice(0, -'.jsonl'.length);
  const records: unknown[] = [humanLine('spill a few', TS(0))];
  const bodies: string[] = [];
  for (let i = 0; i < count; i += 1) {
    records.push(toolCallLine(`toolu_s${i}`, 'Bash', TS(1 + 2 * i)));
    records.push(
      toolResultLine(`toolu_s${i}`, spillMarker(`/gone/tool-results/s${i}.txt`), TS(2 + 2 * i)),
    );
    bodies.push(writeFile(join(dir, 'tool-results', `s${i}.txt`), `body ${i} says zzbody${i}`));
  }
  writeTranscript(path, records);
  const id = seedIndexRow(db, path);
  projectSession(db, id, fileEnv(), foldArchive(path)!);
  return { db, id, bodies };
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

describe('indexSpills', () => {
  it('indexes each body once: a second pass writes nothing and reads no body', () => {
    const { db, id } = plantSpills(2);
    expect(indexSpills(db, env(db))).toEqual({ indexed: 2, removed: 0, skipped: [] });
    expect(spillRows(db).map((row) => row.event_id)).toEqual(['toolu_s0', 'toolu_s1']);
    expect(sessionRow(db, id).projection_state).toBe('ready');

    let resolved = 0;
    const real = env(db);
    const counted: SpillIndexEnv = {
      locate: real.locate,
      resolve: (row, field) => {
        resolved += 1;
        return real.resolve(row, field);
      },
    };
    expect(indexSpills(db, counted)).toEqual({ indexed: 0, removed: 0, skipped: [] });
    expect(resolved).toBe(0);
  });

  it('skips a body gone before its first index by path, and indexes it once restored', () => {
    const { db, bodies } = plantSpills(1);
    rmSync(bodies[0]!);

    const first = indexSpills(db, env(db));
    expect(first.indexed).toBe(0);
    expect(first.skipped).toEqual([expect.stringMatching(/s0\.txt$/)]);

    writeFile(bodies[0]!, 'body 0 is back with zzbody0');
    expect(indexSpills(db, env(db))).toEqual({ indexed: 1, removed: 0, skipped: [] });
    expect(find(db, 'zzbody0')).toEqual(['toolu_s0']);
  });

  it('a resolver that throws is a skip, and the projection is left exactly as it was', () => {
    const { db, id } = plantSpills(1);
    const before = db.prepare('SELECT * FROM events ORDER BY seq').all();
    const throwing: SpillIndexEnv = {
      resolve: () => {
        throw new Error('boom');
      },
      locate: () => undefined,
    };

    expect(indexSpills(db, throwing).skipped).toHaveLength(1);
    expect(sessionRow(db, id).projection_state).toBe('ready');
    expect(db.prepare('SELECT * FROM events ORDER BY seq').all()).toEqual(before);
  });

  it('reconciles away a row whose events row is gone or no longer points at the body', () => {
    const { db, id } = plantSpills(2);
    indexSpills(db, env(db));

    db.prepare(`DELETE FROM events WHERE id = 'toolu_s0'`).run();
    db.prepare(`UPDATE events SET spill_path = '/elsewhere/s1.txt' WHERE id = 'toolu_s1'`).run();

    // The moved pointer is a new identity; the mirror arm re-anchors its basename.
    expect(indexSpills(db, env(db))).toMatchObject({ removed: 2, indexed: 1 });
    expect(spillRows(db)).toEqual([{ event_id: 'toolu_s1', spill_path: '/elsewhere/s1.txt' }]);
    expect(find(db, 'zzbody0')).toEqual([]);
    expect(countOf(db, 'events', id)).toBeGreaterThan(0);
  });

  it('skips a body over the cap by path, whether declared (unread) or measured', () => {
    const { db } = plantSpills(2);
    const real = env(db);
    const resolvedIds: string[] = [];
    const huge: SpillIndexEnv = {
      locate: real.locate,
      resolve: (row, field) => {
        resolvedIds.push(row.id);
        return { ...real.resolve(row, field), byte_size: SPILL_INDEX_MAX_BYTES + 1 };
      },
    };
    db.prepare(`UPDATE events SET spill_bytes = ? WHERE id = 'toolu_s0'`).run(
      SPILL_INDEX_MAX_BYTES + 1,
    );

    expect(indexSpills(db, huge)).toMatchObject({
      indexed: 0,
      skipped: [expect.any(String), expect.any(String)],
    });
    expect(resolvedIds).toEqual(['toolu_s1']);
    expect(spillRows(db)).toEqual([]);
  });

  it('past its deadline: the reconcile still runs whole, and one body is indexed per pass', () => {
    const { db, bodies } = plantSpills(3);
    indexSpills(db, env(db));
    rmSync(bodies[0]!);
    rmSync(bodies[1]!);
    const late = { now: () => 10_000, startedAt: 0, deadlineMs: 250 };
    expect(indexSpills(db, env(db), late)).toMatchObject({ indexed: 0, removed: 2 });

    db.exec('DELETE FROM spill_fts');
    writeFile(bodies[0]!, 'zzbody0 again');
    writeFile(bodies[1]!, 'zzbody1 again');
    const perPass = [1, 2, 3, 4].map(() => indexSpills(db, env(db), late).indexed);
    expect(perPass).toEqual([1, 1, 1, 0]);
  });
});

// Test 11: a diagnostic over the REAL archive, not a pin. Opt-in; reads
// `AGENT_LENS_DIR` (else `~/.agent-lens`) into an in-memory db.
describe.runIf(process.env['AGENT_LENS_REAL_CORPUS'] === '1')(
  'the spill drain over the real corpus',
  () => {
    it('prints the first-drain and warm-pass costs', () => {
      const dataDir = process.env['AGENT_LENS_DIR'] ?? join(homedir(), '.agent-lens');
      const sourceRoot = join(homedir(), '.claude', 'projects');
      const db = openCache();
      open.push(db);
      const sweep = createCorpusSweep({
        db,
        dataDir,
        transcriptRoot: sourceRoot,
        wave2DeadlineMs: Number.MAX_SAFE_INTEGER,
      });
      sweep.wave1();
      sweep.wave2();
      sweep.close();
      db.exec('DELETE FROM spill_fts'); // wave 2 drained too; time the first drain alone
      const before = readHealthCounts(db).db_bytes;
      const spillEnv = createSpillIndexEnv(db, createArchiveReader(), [
        resolveArchiveRoot(dataDir),
        sourceRoot,
      ]);

      const timed = (): [ReturnType<typeof indexSpills>, string] => {
        const started = performance.now();
        const report = indexSpills(db, spillEnv);
        return [report, (performance.now() - started).toFixed(2)];
      };
      const [first, firstMs] = timed();
      const bytes = db
        .prepare('SELECT coalesce(sum(length(CAST(text AS BLOB))), 0) AS n FROM spill_fts')
        .get();
      const [warm, warmMs] = timed();
      console.log(
        `[diagnostic] ${dataDir}: first drain ${JSON.stringify(first)} in ${firstMs} ms;` +
          ` ${JSON.stringify(bytes)} bytes; warm pass ${warmMs} ms;` +
          ` db_bytes delta ${readHealthCounts(db).db_bytes - before}`,
      );

      expect(warm).toMatchObject({ indexed: 0, removed: 0 });
      expect(() => ftsIntegrityCheck(db)).not.toThrow();
    }, 600_000);
  },
);
