// AC2 and AC3 — the walk returns only what moved, classifies everything it saw,
// and never lets a file out without naming it.
//
// No count in this file is a corpus cardinality. Every tree here is built by the
// test that reads it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { foldArchive } from '../../db/freshness.js';
import { projectSession, upsertSessionIndex } from '../../db/write.js';
import { openCache } from '../../db/__tests__/fixtures/index.js';
import { createProjectionEnv } from '../env.js';
import { classifyCorpusPath, decodeProjectDir, projectSlugOf, rowIdOf } from '../paths.js';
import { scanCorpus, type ScanResult } from '../scan.js';
import {
  cleanup,
  CWD,
  makeSandbox,
  sessionRecords,
  SLUG,
  writeJournal,
  writeSealedSession,
  writeSession,
  writeSidecar,
  writeToolResult,
  type Sandbox,
} from './fixtures.js';

const PARENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const WF_DIR = 'wf_18e7ec0c-db9';

let sandbox: Sandbox;
let db: DatabaseSync;

/** Two sessions, one plain sidecar, one `wf_*` pair, a journal, a tool result. */
function buildTree(): void {
  writeSession(
    sandbox,
    PARENT,
    sessionRecords('call-1', '2026-08-20T10:00:00.000Z', '2026-08-20T10:05:00.000Z'),
  );
  writeSession(
    sandbox,
    OTHER,
    sessionRecords('call-2', '2026-08-20T09:00:00.000Z', '2026-08-20T09:05:00.000Z'),
  );
  writeSidecar(
    sandbox,
    PARENT,
    'child1',
    sessionRecords('call-3', '2026-08-20T10:01:00.000Z', '2026-08-20T10:02:00.000Z'),
    { toolUseId: 'call-1' },
  );
  writeSidecar(
    sandbox,
    PARENT,
    'wfchild',
    sessionRecords('call-4', '2026-08-20T10:03:00.000Z', '2026-08-20T10:04:00.000Z'),
    { workflowDir: WF_DIR },
  );
  writeJournal(sandbox, PARENT, WF_DIR);
  writeToolResult(sandbox, PARENT, 'b011o0n');
}

function scan(): ScanResult {
  return scanCorpus(db, sandbox.archiveRoot, sandbox.sourceRoot);
}

/** The Tier-A write wave 1 makes, reduced to what the diff keys on. */
function indexAll(result: ScanResult): void {
  for (const entry of result.changed) {
    upsertSessionIndex(db, {
      id: rowIdOf(entry.relPath),
      source_path: entry.sourcePath,
      archive_path: entry.archivePath,
      file_mtime_ms: entry.fold.mtime_ms,
      file_size: entry.fold.size,
      project_path: CWD,
      started_at: '2026-08-20T09:00:00.000Z',
      last_activity_at: '2026-08-20T10:05:00.000Z',
    });
  }
}

function conserved(result: ScanResult): { walked: number; accounted: number } {
  return {
    walked: result.walked,
    accounted:
      result.changed.length +
      result.unchanged +
      result.deferred +
      result.ignored +
      result.excluded.length +
      result.unkeyable.length,
  };
}

beforeEach(() => {
  sandbox = makeSandbox();
  db = openCache();
  buildTree();
});

afterEach(() => {
  db.close();
  cleanup(sandbox);
});

describe('AC2 — a warm scan returns only what moved', () => {
  it('returns the empty set once every row is indexed', () => {
    const cold = scan();
    expect(cold.changed.length).toBeGreaterThan(0);
    indexAll(cold);

    const warm = scan();
    expect(warm.changed).toEqual([]);
    expect(warm.unchanged).toBe(cold.changed.length);
  });

  it('returns exactly the one file whose mtime moved', () => {
    indexAll(scan());

    const path = join(sandbox.archiveRoot, SLUG, `${OTHER}.jsonl`);
    const ahead = statSync(path).mtimeMs / 1000 + 3600;
    utimesSync(path, ahead, ahead);

    const warm = scan();
    expect(warm.changed.map((entry) => entry.relPath)).toEqual([`${SLUG}/${OTHER}.jsonl`]);
  });

  it('returns exactly the one file whose size moved at an unchanged mtime', () => {
    indexAll(scan());

    const path = join(sandbox.archiveRoot, SLUG, `${OTHER}.jsonl`);
    const before = statSync(path);
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ type: 'mode' }) + '\n');
    utimesSync(path, before.mtimeMs / 1000, before.mtimeMs / 1000);

    const warm = scan();
    expect(warm.changed.map((entry) => entry.relPath)).toEqual([`${SLUG}/${OTHER}.jsonl`]);
  });

  it('reports a parent changed when only its sidecar grew — the fold is the key', () => {
    indexAll(scan());

    const sidecar = join(sandbox.archiveRoot, SLUG, PARENT, 'subagents', 'agent-child1.jsonl');
    writeFileSync(sidecar, readFileSync(sidecar, 'utf8') + JSON.stringify({ type: 'mode' }) + '\n');

    // A parent's own stat never moved; only the fold saw this.
    const changed = scan().changed.map((entry) => entry.relPath);
    expect(changed).toContain(`${SLUG}/${PARENT}.jsonl`);
  });
});

describe('AC2 — a cold scan leaves nothing unclassified', () => {
  it('accounts for every walked file exactly once', () => {
    const cold = scan();
    const { walked, accounted } = conserved(cold);
    expect(accounted, `walked ${walked}, accounted ${accounted}`).toBe(walked);
    expect(walked).toBeGreaterThan(0);
  });

  it('puts exactly the journal in the excluded set', () => {
    expect(scan().excluded).toEqual([
      `${SLUG}/${PARENT}/subagents/workflows/${WF_DIR}/journal.jsonl`,
    ]);
  });

  it('classifies every changed entry as a session or a sidecar, never anything else', () => {
    for (const entry of scan().changed) {
      expect(['session', 'sidecar']).toContain(entry.kind);
      expect(classifyCorpusPath(entry.relPath)).toBe(entry.kind);
    }
  });

  it('keeps the invariant while the tree grows a kind it has never seen', () => {
    // A `.md` under a session directory: not a transcript, not a sidecar, not
    // ruled out — the arm that would go missing if `ignored` stopped counting.
    writeFileSync(join(sandbox.archiveRoot, SLUG, PARENT, 'subagents', 'notes.md'), 'x');

    const result = scan();
    expect(conserved(result).accounted).toBe(result.walked);
    expect(result.changed.map((entry) => entry.relPath)).not.toContain(
      `${SLUG}/${PARENT}/subagents/notes.md`,
    );
  });
});

describe('AC2/AC1 — a sealed session and its hot twin are one entry', () => {
  it('keys both on the logical path and yields exactly one changed entry', () => {
    const sealedId = 'dddddddd-4444-4444-8444-dddddddddddd';
    const logical = writeSealedSession(
      sandbox,
      sealedId,
      sessionRecords('call-9', '2026-08-20T08:00:00.000Z', '2026-08-20T08:05:00.000Z'),
    );

    const entries = scan().changed.filter((entry) => entry.archivePath === logical);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sealed).toBe(true);
    expect(entries[0]?.relPath).toBe(`${SLUG}/${sealedId}.jsonl`);

    // The same bytes hot as well: still one entry, still the logical key.
    writeSession(
      sandbox,
      sealedId,
      sessionRecords('call-9', '2026-08-20T08:00:00.000Z', '2026-08-20T08:05:00.000Z'),
    );
    const both = scan().changed.filter((entry) => entry.archivePath === logical);
    expect(both).toHaveLength(1);
  });
});

describe('AC3 — the journal is excluded by path, before it is opened', () => {
  it('never appears in the changed set, on any pass', () => {
    const cold = scan();
    indexAll(cold);
    const warm = scan();

    for (const result of [cold, warm]) {
      expect(result.changed.map((entry) => entry.relPath)).not.toContain(
        `${SLUG}/${PARENT}/subagents/workflows/${WF_DIR}/journal.jsonl`,
      );
    }
  });

  it('still lets its sibling agent transcripts through, and defers the rest', () => {
    const result = scan();
    const rels = result.changed.map((entry) => entry.relPath);
    // The `wf_*` sidecar has no `toolUseId`, so the sweep is its only producer.
    expect(rels).toContain(`${SLUG}/${PARENT}/subagents/workflows/${WF_DIR}/agent-wfchild.jsonl`);
    // An ordinary sidecar IS indexed — by `readSidecars` at projection time.
    expect(rels).not.toContain(`${SLUG}/${PARENT}/subagents/agent-child1.jsonl`);
    expect(result.deferred).toBeGreaterThan(0);
  });

  it('mutation control: a naive recursive .jsonl walker creates the row this ruling prevents', () => {
    const journal = join(
      sandbox.archiveRoot,
      SLUG,
      PARENT,
      'subagents',
      'workflows',
      WF_DIR,
      'journal.jsonl',
    );
    const rel = `${SLUG}/${PARENT}/subagents/workflows/${WF_DIR}/journal.jsonl`;

    // What a walker with no classifier does. The three NOT NULL columns have no
    // producer in this file, so it must FABRICATE all three to insert at all —
    // which is the impossible state the exclusion removes rather than encodes.
    const fold = foldArchive(journal)!;
    upsertSessionIndex(db, {
      id: rowIdOf(rel),
      source_path: join(sandbox.sourceRoot, rel),
      archive_path: journal,
      file_mtime_ms: fold.mtime_ms,
      file_size: fold.size,
      project_path: decodeProjectDir(projectSlugOf(rel)),
      started_at: '1970-01-01T00:00:00.000Z',
      last_activity_at: '1970-01-01T00:00:00.000Z',
    });

    expect(rowCount(db, 'journal.jsonl')).toBe(1);
    expect(projectSession(db, rowIdOf(rel), createProjectionEnv(), fold)).toBe('empty');

    const row = db
      .prepare('SELECT projection_state FROM sessions WHERE id = ?')
      .get(rowIdOf(rel)) as { projection_state: string };
    expect(row.projection_state).toBe('empty');

    // …and the real scan, with the classifier, creates no such row at all.
    const swept = openCache();
    for (const entry of scanCorpus(swept, sandbox.archiveRoot, sandbox.sourceRoot).changed) {
      expect(entry.relPath).not.toContain('journal.jsonl');
    }
    expect(rowCount(swept, 'journal.jsonl')).toBe(0);
    swept.close();
  });
});

describe('AC3 — excluded from indexing is NOT excluded from the tree', () => {
  it('foldArchive still sums the journal bytes into its parent', () => {
    const parentPath = join(sandbox.archiveRoot, SLUG, `${PARENT}.jsonl`);
    const journal = join(
      sandbox.archiveRoot,
      SLUG,
      PARENT,
      'subagents',
      'workflows',
      WF_DIR,
      'journal.jsonl',
    );

    const before = foldArchive(parentPath)!;
    const journalBytes = statSync(journal).size;
    expect(journalBytes).toBeGreaterThan(0);

    rmSync(journal);
    const after = foldArchive(parentPath)!;

    expect(after.size).toBe(before.size - journalBytes);
    expect(after.mtime_ms).toBeLessThanOrEqual(before.mtime_ms);
  });
});

function rowCount(handle: DatabaseSync, suffix: string): number {
  const row = handle
    .prepare(`SELECT count(*) AS n FROM sessions WHERE archive_path LIKE '%' || ?`)
    .get(suffix) as { n: number };
  return row.n;
}
