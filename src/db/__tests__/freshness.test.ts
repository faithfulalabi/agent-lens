// AC3, AC4, AC9 — the gate, the fold, and the version stamp.
//
// The hit path's cost is asserted ALGORITHMICALLY: one `readdir` per directory,
// one `stat` per file, no path read twice. The same fold measured minutes apart
// under different CPU load moves 1.7x at the max with no code change, so a
// wall-clock ceiling would test the machine. The wall clock is printed as a
// diagnostic and never asserted.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { PROJECTOR_VERSION } from '../../transcript/version.js';
import {
  ensureProjected,
  fingerprint,
  foldArchive,
  seedMeta,
  type ArchiveFold,
} from '../freshness.js';
import { projectSession } from '../write.js';
import {
  fileEnv,
  freezeMtime,
  humanLine,
  mtimeMsOf,
  openCache,
  seedIndexRow,
  sessionRow,
  toolCallLine,
  toolResultLine,
  writeFile,
  writeTranscript,
} from './fixtures/index.js';

// The real implementations still run; only the call lists are new. This is what
// makes the hit path's algorithm assertable without a clock.
vi.mock('node:fs', { spy: true });

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
  vi.clearAllMocks();
});

const TS = (seconds: number): string =>
  new Date(Date.UTC(2026, 7, 14, 9, 0, seconds)).toISOString();

const SESSION_RECORDS: readonly unknown[] = [
  humanLine('do the thing', TS(0)),
  toolCallLine('toolu_one', 'Grep', TS(1)),
  toolResultLine('toolu_one', 'found three matches', TS(2)),
];

interface Tree {
  parent: string;
  dir: string;
  sidecars: string[];
}

/** A parent transcript plus the three sidecar kinds that share its directory. */
function plantTree(name = 'session', sidecarCount = 1): Tree {
  const parent = join(sb().archiveRoot, `${name}.jsonl`);
  writeTranscript(parent, SESSION_RECORDS);
  const dir = parent.slice(0, -'.jsonl'.length);

  const sidecars: string[] = [];
  for (let index = 0; index < sidecarCount; index += 1) {
    sidecars.push(
      writeFile(join(dir, 'subagents', `agent-${index}.jsonl`), `{"type":"user","n":${index}}\n`),
    );
  }
  writeFile(join(dir, 'subagents', 'agent-0.meta.json'), '{"agentType":"Explore"}');
  writeFile(join(dir, 'tool-results', 'b1a2c3d4.txt'), 'spilled output');
  return { parent, dir, sidecars };
}

function projectOnce(db: DatabaseSync, id: string, parent: string): void {
  projectSession(db, id, fileEnv(), foldArchive(parent)!);
}

/** What a parent-only invalidation key would have compared. */
function parentOnlyKey(path: string): string {
  const stat = statSync(path);
  return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
}

describe('foldArchive folds the whole session directory (AC4)', () => {
  it('takes max(child mtime) and sum(child size) across every kind of sidecar', () => {
    const { parent, dir } = plantTree('folded', 3);
    const fold = foldArchive(parent)!;

    const parentStat = statSync(parent);
    let expectedSize = parentStat.size;
    let expectedMtime = Math.floor(parentStat.mtimeMs);
    for (const path of [
      join(dir, 'subagents', 'agent-0.jsonl'),
      join(dir, 'subagents', 'agent-1.jsonl'),
      join(dir, 'subagents', 'agent-2.jsonl'),
      join(dir, 'subagents', 'agent-0.meta.json'),
      join(dir, 'tool-results', 'b1a2c3d4.txt'),
    ]) {
      const stat = statSync(path);
      expectedSize += stat.size;
      expectedMtime = Math.max(expectedMtime, Math.floor(stat.mtimeMs));
    }

    expect(fold.size).toBe(expectedSize);
    expect(fold.mtime_ms).toBe(expectedMtime);
    // The counted part is the `.jsonl` transcripts, which is what the live-tail
    // epoch string names. The other two kinds still move mtime and size.
    expect(fold.sidecar_count).toBe(3);
  });

  it('degrades to a plain stat for a path with no sibling directory', () => {
    const { dir } = plantTree('lonely');
    const sidecar = join(dir, 'subagents', 'agent-0.jsonl');
    const fold = foldArchive(sidecar)!;

    expect(fold.sidecar_count).toBe(0);
    expect(fold.size).toBe(statSync(sidecar).size);
  });

  it('answers undefined when the transcript itself is gone', () => {
    expect(foldArchive(join(sb().archiveRoot, 'never-existed.jsonl'))).toBeUndefined();
  });

  it('fingerprint is the live-tail epoch string', () => {
    const fold: ArchiveFold = { mtime_ms: 12, size: 34, sidecar_count: 5 };
    expect(fingerprint(fold)).toBe('12:34:5');
  });
});

describe('the fold invalidates where a parent-only key does not (AC4)', () => {
  // The recorded shape, as FIXTURE inputs: the parent went 1,814 s with no
  // write while 11 sidecars grew by 3.76 MB, three of them within 3 seconds.
  // The live numbers have since moved — 2,240 s / 10 sidecars / 3.24 MB is
  // today's closest analogue — so they are built here and never asserted
  // against the corpus.
  const SILENCE_MS = 1814 * 1000;
  const SIDECARS = 11;
  const GROWTH_BYTES = 3_760_000;

  /** Grow every sidecar and age them past a parent that was never written. */
  function growSidecars(tree: Tree): void {
    const silentSince = mtimeMsOf(tree.parent);
    const chunk = 'x'.repeat(Math.floor(GROWTH_BYTES / SIDECARS));
    for (const [index, sidecar] of tree.sidecars.entries()) {
      appendFileSync(sidecar, chunk);
      // Three of them land inside one 3-second window, as measured.
      freezeMtime(sidecar, silentSince + SILENCE_MS + (index < 3 ? index * 1000 : index * 60_000));
    }
    // The parent itself was never written, so its own stat must not move.
    freezeMtime(tree.parent, silentSince);
  }

  it('a sidecar that grows behind a silent parent reprojects', () => {
    const db = cache();
    const tree = plantTree('silent-parent', SIDECARS);
    const id = seedIndexRow(db, tree.parent);
    projectOnce(db, id, tree.parent);
    expect(ensureProjected(db, id, fileEnv())).toBe('hit');

    const parentBefore = parentOnlyKey(tree.parent);
    growSidecars(tree);

    expect(ensureProjected(db, id, fileEnv())).toBe('projected');
    // The control, over the SAME tree: a parent-only key never moved, so the
    // fold is demonstrably what caught this and nothing else could have.
    expect(parentOnlyKey(tree.parent)).toBe(parentBefore);
  });

  it('a parent-only control over the same tree never notices', () => {
    const tree = plantTree('control', SIDECARS);
    const parentBefore = parentOnlyKey(tree.parent);
    const foldBefore = fingerprint(foldArchive(tree.parent)!);

    growSidecars(tree);

    expect(parentOnlyKey(tree.parent)).toBe(parentBefore);
    expect(fingerprint(foldArchive(tree.parent)!)).not.toBe(foldBefore);
  });
});

describe('freshness compares against the ARCHIVE, never the source (AC4)', () => {
  it('a source that grows does not invalidate the projection', () => {
    const db = cache();
    const { parent } = plantTree('archive-wins');
    const source = writeTranscript(join(sb().sourceRoot, 'archive-wins.jsonl'), SESSION_RECORDS);
    const id = seedIndexRow(db, parent, { source_path: source });
    projectOnce(db, id, parent);

    appendFileSync(source, '{"type":"user","only-in-the-source":true}\n');

    expect(ensureProjected(db, id, fileEnv())).toBe('hit');
  });

  it('an expired source leaves the gate answering from the archive', () => {
    const db = cache();
    const { parent } = plantTree('source-expired');
    const source = writeTranscript(join(sb().sourceRoot, 'source-expired.jsonl'), SESSION_RECORDS);
    const id = seedIndexRow(db, parent, { source_path: source });
    projectOnce(db, id, parent);

    rmSync(source);
    db.prepare(`UPDATE sessions SET source_state = 'expired' WHERE id = ?`).run(id);

    expect(ensureProjected(db, id, fileEnv())).toBe('hit');
  });
});

describe('ensureProjected is the gate every read passes (AC3)', () => {
  function projected(): { db: DatabaseSync; id: string; parent: string } {
    const db = cache();
    const { parent } = plantTree('gate');
    const id = seedIndexRow(db, parent);
    projectOnce(db, id, parent);
    return { db, id, parent };
  }

  const PARTS = ['projected_mtime_ms', 'projected_size', 'projector_version'] as const;

  it.each(PARTS)('perturbing %s alone is a miss', (column) => {
    const { db, id } = projected();
    db.prepare(`UPDATE sessions SET ${column} = ${column} - 1 WHERE id = ?`).run(id);

    expect(ensureProjected(db, id, fileEnv())).toBe('projected');
    // The reprojection rewrote the part that was perturbed.
    expect(sessionRow(db, id)[column]).not.toBeNull();
  });

  it('perturbing none is a hit, and the hit reprojects nothing', () => {
    const { db, id } = projected();
    const before = sessionRow(db, id);

    expect(ensureProjected(db, id, fileEnv())).toBe('hit');

    expect(sessionRow(db, id).projected_at).toBe(before.projected_at);
  });

  it('a session with no row is unindexed and is never fabricated from a stat', () => {
    const db = cache();
    plantTree('nobody');

    expect(ensureProjected(db, 'no-such-session', fileEnv())).toBe('unindexed');
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('a vanished archive file fails rather than reprojecting from nothing', () => {
    const { db, id, parent } = projected();
    rmSync(parent);

    expect(ensureProjected(db, id, fileEnv())).toBe('failed');
  });

  it('a read never dies because one session is unprojectable', () => {
    const { db, id } = projected();
    const broken = {
      readLines: () => {
        throw new Error('the archive line is torn');
      },
      spillEnv: () => ({ exists: () => false }),
      sidecars: () => [],
    };
    db.prepare('UPDATE sessions SET projected_size = projected_size - 1 WHERE id = ?').run(id);

    expect(ensureProjected(db, id, broken)).toBe('failed');
    expect(sessionRow(db, id).projection_state).toBe('failed');
  });
});

describe('the hit path costs one readdir per directory and one stat per file (AC3)', () => {
  it('reads no path twice', () => {
    const db = cache();
    const { parent, dir } = plantTree('counted');
    const id = seedIndexRow(db, parent);
    projectOnce(db, id, parent);

    vi.clearAllMocks();
    const started = performance.now();
    expect(ensureProjected(db, id, fileEnv())).toBe('hit');
    const elapsed = performance.now() - started;

    const readdirPaths = vi.mocked(readdirSync).mock.calls.map((call) => String(call[0]));
    const statPaths = vi.mocked(statSync).mock.calls.map((call) => String(call[0]));

    expect(readdirPaths.sort()).toStrictEqual(
      [dir, join(dir, 'subagents'), join(dir, 'tool-results')].sort(),
    );
    expect(statPaths.sort()).toStrictEqual(
      [
        parent,
        join(dir, 'subagents', 'agent-0.jsonl'),
        join(dir, 'subagents', 'agent-0.meta.json'),
        join(dir, 'tool-results', 'b1a2c3d4.txt'),
      ].sort(),
    );
    // An implementation that re-stats the parent inside the walk reds here.
    expect(new Set(statPaths).size).toBe(statPaths.length);
    expect(new Set(readdirPaths).size).toBe(readdirPaths.length);

    // DIAGNOSTIC ONLY. Never asserted: the same fold moves 1.7x at the max
    // between two runs minutes apart with no code change.
    console.log(`[diagnostic] ensureProjected hit: ${elapsed.toFixed(3)} ms`);
  });
});

describe('the version gate is per row and lazy (AC9)', () => {
  it('a row stamped at PROJECTOR_VERSION - 1 reprojects and rewrites the stamp', () => {
    const db = cache();
    const { parent } = plantTree('versioned');
    const id = seedIndexRow(db, parent);
    projectOnce(db, id, parent);
    db.prepare('UPDATE sessions SET projector_version = ? WHERE id = ?').run(
      PROJECTOR_VERSION - 1,
      id,
    );

    expect(ensureProjected(db, id, fileEnv())).toBe('projected');
    expect(sessionRow(db, id).projector_version).toBe(PROJECTOR_VERSION);
  });

  it('seedMeta writes both version keys', () => {
    const db = cache();
    seedMeta(db);

    const keys = (
      db.prepare('SELECT key, value FROM meta ORDER BY key').all() as {
        key: string;
        value: string;
      }[]
    ).map((row) => row.key);
    expect(keys).toStrictEqual(['projector_version', 'schema_version']);
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'projector_version'`).get()).toEqual({
      value: String(PROJECTOR_VERSION),
    });
  });

  it('the gate seeds meta on the miss path and leaves the hit path alone', () => {
    const db = cache();
    const { parent } = plantTree('meta-seed');
    const id = seedIndexRow(db, parent);

    expect(ensureProjected(db, id, fileEnv())).toBe('projected');
    expect(db.prepare('SELECT count(*) AS n FROM meta').get()).toEqual({ n: 2 });

    db.prepare('DELETE FROM meta').run();
    expect(ensureProjected(db, id, fileEnv())).toBe('hit');
    expect(db.prepare('SELECT count(*) AS n FROM meta').get()).toEqual({ n: 0 });
  });
});
