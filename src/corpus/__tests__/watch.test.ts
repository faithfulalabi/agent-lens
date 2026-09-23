// AC3, AC4 and AC5 — the exclusion holds through a whole sweep, the watch is a
// poll, and the two waves are separable.
//
// Nothing here pins a corpus count: every tree is built by the test that reads
// it, and the real-archive arms live in `corpus.test.ts` behind `runIt`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { createArchiveReader } from '../../archive/read.js';
import { foldArchive } from '../../db/freshness.js';
import { readSidecars } from '../../db/sidecars.js';
import { recomputeSubagentRollups } from '../../db/write.js';
import { linkSubagents } from '../../project/subagents.js';
import { DriftCounter } from '../../transcript/drift.js';
import {
  countingReader,
  humanLine,
  jsonl,
  newReaderLog,
  openCache,
  spillMarker,
  toolCallLine,
  toolResultLine,
  type ReaderLog,
} from '../../db/__tests__/fixtures/index.js';
import {
  conservationOf,
  createCorpusSweep,
  emptyReport,
  startCorpusSweep,
  type CorpusSweep,
  type SweepOptions,
  type SweepReport,
} from '../watch.js';
import {
  buildTree,
  cleanup,
  CWD,
  makeSandbox,
  OTHER,
  PARENT,
  sessionRecords,
  SLUG,
  writeSealedSession,
  writeSession,
  writeSidecar,
  writeToolResult,
  WF_DIR,
  type Sandbox,
} from './fixtures.js';

const JOURNAL_REL = `${SLUG}/${PARENT}/subagents/workflows/${WF_DIR}/journal.jsonl`;

let sandbox: Sandbox;
let db: DatabaseSync;
let sweeps: CorpusSweep[];

function sweep(overrides: Partial<SweepOptions> = {}): CorpusSweep & { bind(): CorpusSweep } {
  const made = createCorpusSweep({
    db,
    dataDir: sandbox.dataDir,
    transcriptRoot: sandbox.sourceRoot,
    ...overrides,
  });
  sweeps.push(made);
  return made;
}

function rows(): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM sessions ORDER BY rowid').all() as unknown as Record<
    string,
    unknown
  >[];
}

function row(id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
}

function childrenOf(id: string): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM sessions WHERE parent_session_id = ?')
    .all(id) as unknown as Record<string, unknown>[];
}

/** What `sub_tool_call_count` must equal: every child's own PLUS its own sub. */
function subSumOf(id: string): number {
  return childrenOf(id).reduce(
    (total, entry) =>
      total + Number(entry['tool_call_count']) + Number(entry['sub_tool_call_count']),
    0,
  );
}

function metaValue(key: string): string | undefined {
  const found = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    { value: string } | undefined;
  return found?.value;
}

beforeEach(() => {
  sandbox = makeSandbox();
  db = openCache();
  sweeps = [];
  buildTree(sandbox);
});

afterEach(() => {
  for (const made of sweeps) made.close();
  db.close();
  cleanup(sandbox);
});

describe('AC3 — no sessions row is ever created for the journal', () => {
  it('creates none, on a full sweep', () => {
    sweep().tick();
    const found = db
      .prepare(`SELECT count(*) AS n FROM sessions WHERE archive_path LIKE '%journal.jsonl'`)
      .get() as { n: number };
    expect(found.n).toBe(0);
  });

  it('does not read it, on any of three ticks over an unchanged tree', () => {
    const log: ReaderLog = newReaderLog();
    const made = sweep({ reader: countingReader(log) });

    made.tick();
    made.tick();
    made.tick();

    const touched = [...log.reads.map((entry) => entry.path), ...log.sizes];
    expect(touched.filter((path) => path.endsWith('journal.jsonl'))).toEqual([]);
    expect(touched.length, 'the reader was used at all').toBeGreaterThan(0);
  });

  it('still indexes the sibling agent transcripts in the same wf_ directory', () => {
    sweep().tick();

    const wf = row('wfchild');
    expect(wf).toBeDefined();
    expect(wf?.['started_at']).toBeTruthy();
    expect(wf?.['last_activity_at']).toBeTruthy();
    expect(wf?.['project_path']).toBe(CWD);
    // …and it is parented by path, so it never enters idx_sessions_recent.
    expect(wf?.['parent_session_id']).toBe(PARENT);
  });

  it('leaves the wf_ sidecar outside what readSidecars can claim', () => {
    // Hand-off #3: a `wf_*` meta carries no `toolUseId`, so 3.3's join cannot
    // reach it and the sweep is its only producer.
    const parentPath = join(sandbox.archiveRoot, SLUG, `${PARENT}.jsonl`);
    const found = readSidecars(
      parentPath,
      join(sandbox.sourceRoot, SLUG, `${PARENT}.jsonl`),
      new Set(['call-1', 'call-4']),
    );
    expect(found.map((entry) => entry.agent_id)).toEqual(['child1']);
    expect(linkSubagents([], found, new Map(), new DriftCounter())).toEqual([]);
  });
});

describe('the anti-silence contract — nothing leaves the sweep unnamed', () => {
  it('conserves every walked file across the whole sweep', () => {
    const report = sweep().tick();
    const { walked, accounted } = conservationOf(report);
    expect(accounted, `walked ${walked}, accounted ${accounted}`).toBe(walked);
    expect(walked).toBeGreaterThan(0);
    expect(report.excluded).toEqual([JOURNAL_REL]);
  });

  it('conserves them again on a warm tick, where everything is unchanged', () => {
    const made = sweep();
    made.tick();
    const warm = made.tick();
    expect(conservationOf(warm).accounted).toBe(warm.walked);
    expect(warm.indexed).toBe(0);
    expect(warm.unchanged).toBeGreaterThan(0);
  });

  it('names a transcript with no timestamps by PATH, and does not index it', () => {
    // Forced drop path: every line is a control line, so the two NOT NULL
    // timestamps have no producer. The slug seed cannot rescue them — only
    // `project_path` has a seed — so the file must be reported, never dropped.
    const rel = `${SLUG}/eeeeeeee-5555-4555-8555-eeeeeeeeeeee.jsonl`;
    writeFileSync(
      join(sandbox.archiveRoot, rel),
      jsonl([
        { type: 'mode', mode: 'default' },
        { type: 'mode', mode: 'plan' },
      ]),
    );

    const report = sweep().tick();
    expect(report.envelope_incomplete).toContain(rel);
    expect(row('eeeeeeee-5555-4555-8555-eeeeeeeeeeee')).toBeUndefined();
    expect(conservationOf(report).accounted).toBe(report.walked);
  });

  it('mutation control: dropping one list from the sum breaks the invariant', () => {
    const report: SweepReport = {
      ...emptyReport(),
      walked: 4,
      indexed: 1,
      ignored: 1,
      excluded: ['a/journal.jsonl'],
      envelope_incomplete: ['b/x.jsonl'],
    };
    expect(conservationOf(report).accounted).toBe(report.walked);

    // The `report.push(...)` replaced by a bare `continue`, expressed as the sum
    // that would then be taken. It must NOT balance.
    const mutated =
      report.indexed + report.deferred + report.unchanged + report.ignored + report.excluded.length;
    expect(mutated).not.toBe(report.walked);
  });
});

describe('AC4 — watching is a poll, and no fs.watch call site exists in src/', () => {
  const SRC_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);
  const WATCH_CALLEES = new Set(['watch', 'watchFile', 'unwatchFile']);

  /** Every non-test `.ts` under `src/`, repo-relative with forward slashes. */
  function sourceFiles(): string[] {
    return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .map((name) => name.split('\\').join('/'))
      .filter((name) => !name.endsWith('.test.ts') && !name.includes('__tests__/'))
      .sort();
  }

  /** Local names bound to `node:fs` exports, plus namespace imports. */
  function fsBindings(source: ts.SourceFile): {
    named: Map<string, string>;
    namespaces: Set<string>;
  } {
    const named = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier) || !FS_MODULES.has(specifier.text)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else
        for (const element of bindings.elements) {
          named.set(element.name.text, (element.propertyName ?? element.name).text);
        }
    }
    return { named, namespaces };
  }

  /**
   * Every CALL whose callee resolves to `node:fs`'s watcher family.
   *
   * ★ AN AST SCAN, NEVER A GREP. `corpus/watch.ts:3` names `fs.watch` in a doc
   * comment explaining why this codebase does not use it — a text search is born
   * red on the very comment that records the decision.
   */
  function watchSites(file: string, text = readFileSync(join(SRC_DIR, file), 'utf8')): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
    const { named, namespaces } = fsBindings(source);
    const sites: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const target = node.expression;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (ts.isIdentifier(target)) {
          const imported = named.get(target.text);
          if (imported !== undefined && WATCH_CALLEES.has(imported)) {
            sites.push(`${file}:${line}:${imported}`);
          }
        } else if (
          ts.isPropertyAccessExpression(target) &&
          ts.isIdentifier(target.expression) &&
          namespaces.has(target.expression.text) &&
          WATCH_CALLEES.has(target.name.text)
        ) {
          sites.push(`${file}:${line}:${target.name.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return sites;
  }

  /**
   * Every watcher call site under `src/`.
   *
   * The substring pre-filter narrows WHAT IS PARSED and decides nothing: a call
   * to `watch`/`watchFile` must contain the substring, so a file without it
   * cannot hold one. The candidate count is asserted below, so the filter can
   * never quietly empty the scan — which is the failure mode a pre-filter has.
   */
  function allWatchSites(): { sites: string[]; candidates: string[] } {
    const candidates: string[] = [];
    const sites: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(SRC_DIR, file), 'utf8');
      if (!text.includes('watch')) continue;
      candidates.push(file);
      sites.push(...watchSites(file, text));
    }
    return { sites, candidates };
  }

  it('finds zero fs.watch / fs.watchFile call sites', () => {
    const { sites, candidates } = allWatchSites();
    expect(
      sites,
      'recursive fs.watch is platform-divergent and event-lossy. The sweep polls.',
    ).toEqual([]);
    // Not vacuous: the tailer's doc comment guarantees at least one candidate.
    expect(candidates, 'the pre-filter kept nothing — the scan is vacuous').not.toEqual([]);
  });

  it('mutation control: the scanner reds on a real call site', () => {
    const fixture = `import { watch } from 'node:fs';\nwatch('/tmp', () => {});\n`;
    expect(watchSites('fixture.ts', fixture)).toEqual(['fixture.ts:2:watch']);

    const namespaced = `import * as fs from 'node:fs';\nfs.watchFile('/tmp', () => {});\n`;
    expect(watchSites('fixture.ts', namespaced)).toEqual(['fixture.ts:2:watchFile']);
  });

  it('the doc comment naming fs.watch is present, and does NOT red the scan', () => {
    // The false positive a grep would trip on, asserted so the AST requirement
    // cannot be quietly downgraded later. Re-pointed from the deleted
    // `capture/tailer.ts` to the module under test, which carries the same
    // mention and — like the original — no call site.
    const watcher = readFileSync(join(SRC_DIR, 'corpus/watch.ts'), 'utf8');
    expect(watcher).toContain('fs.watch');
    expect(watchSites('corpus/watch.ts', watcher)).toEqual([]);
  });
});

describe('AC4 — the interval is 1 Hz, unref`d, and close() clears it', () => {
  it('binds setInterval at 1000 ms, ticks once per period, and stops on close', () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(globalThis, 'setInterval');
      const made = startCorpusSweep({
        db,
        dataDir: sandbox.dataDir,
        transcriptRoot: sandbox.sourceRoot,
      });
      sweeps.push(made);

      expect(spy.mock.calls[0]?.[1]).toBe(1000);

      const before = made.report();
      vi.advanceTimersByTime(3000);
      const after = made.report();
      expect(after).not.toBe(before);

      made.close();
      const stopped = made.report();
      vi.advanceTimersByTime(5000);
      expect(made.report()).toBe(stopped);
    } finally {
      vi.useRealTimers();
    }
  });

  it('picks up a file appended between ticks, on the next tick', () => {
    const made = sweep();
    made.tick();

    const path = join(sandbox.archiveRoot, SLUG, `${OTHER}.jsonl`);
    const before = row(OTHER)!;
    writeFileSync(
      path,
      readFileSync(path, 'utf8') +
        jsonl(sessionRecords('call-late', '2026-08-20T11:00:00.000Z', '2026-08-20T11:01:00.000Z')),
    );
    const ahead = statSync(path).mtimeMs / 1000 + 60;
    utimesSync(path, ahead, ahead);

    const report = made.tick();
    const after = row(OTHER)!;
    expect(Number(after['file_size'])).toBeGreaterThan(Number(before['file_size']));
    expect(Number(after['file_mtime_ms'])).toBeGreaterThan(Number(before['file_mtime_ms']));
    expect(report.indexed).toBe(1);
  });
});

describe('AC5 — wave 1 is the first-paint contract', () => {
  it('indexes newest-first', () => {
    // PARENT is newer than OTHER, so it must land first.
    sweep().wave1();
    const order = rows().map((entry) => String(entry['id']));
    expect(order.indexOf(PARENT)).toBeLessThan(order.indexOf(OTHER));
  });

  it('leaves every row readable at rollup_state=own before wave 2 touches it', () => {
    sweep().wave1();
    const all = rows();
    expect(all.length).toBeGreaterThan(0);
    for (const entry of all) {
      expect(entry['rollup_state']).toBe('own');
      expect(entry['projection_state']).toBe('none');
      expect(entry['started_at']).toBeTruthy();
      expect(entry['last_activity_at']).toBeTruthy();
      expect(entry['project_path']).toBeTruthy();
    }
  });

  it('sets index_built_at once the queue drains, and projects_root with it', () => {
    const made = sweep();
    expect(metaValue('index_built_at')).toBeUndefined();

    made.wave1();
    const built = metaValue('index_built_at');
    expect(built).toBeDefined();
    expect(Number.isNaN(Date.parse(built!))).toBe(false);
    expect(metaValue('projects_root')).toBe(sandbox.sourceRoot);

    // A second sweep over an unchanged tree indexes nothing, so it must not
    // restamp the moment the index was actually built.
    made.wave1();
    expect(metaValue('index_built_at')).toBe(built);
  });

  it('does NOT set index_built_at while a file is still unaccounted for', () => {
    writeFileSync(
      join(sandbox.archiveRoot, SLUG, 'ffffffff-6666-4666-8666-ffffffffffff.jsonl'),
      jsonl([{ type: 'mode', mode: 'default' }]),
    );
    const report = sweep().wave1();
    expect(report.envelope_incomplete.length).toBeGreaterThan(0);
    expect(metaValue('index_built_at')).toBeUndefined();
  });
});

describe('AC5 — wave 2 folds the tree and flips exactly what it folded', () => {
  it('projects, rolls up transitively, and never re-runs wave 1', () => {
    const made = sweep();
    made.wave1();

    const second = made.wave2();
    // Wave 2 walks nothing: a non-zero `walked` would mean it re-ran wave 1.
    expect(second.walked).toBe(0);
    expect(second.indexed).toBe(0);

    const parent = row(PARENT)!;
    expect(parent['rollup_state']).toBe('complete');
    expect(parent['projection_state']).toBe('ready');

    const child = row('child1')!;
    expect(child['parent_session_id']).toBe(PARENT);
    expect(Number(parent['sub_tool_call_count'])).toBe(subSumOf(PARENT));
    expect(Number(parent['agent_count'])).toBe(childrenOf(PARENT).length);
  });

  it('leaves an untouched sibling at rollup_state=own', () => {
    const made = sweep({ wave2DeadlineMs: 0 });
    made.wave1();
    made.wave2();

    const complete = rows().filter((entry) => entry['rollup_state'] === 'complete');
    const own = rows().filter((entry) => entry['rollup_state'] === 'own');
    expect(complete).toHaveLength(1);
    expect(own.length).toBeGreaterThan(0);
  });

  it('checks the deadline BETWEEN trees, and never inside one', () => {
    // A clock that jumps a full period on every read, so the deadline is always
    // already blown after the first tree.
    let clock = 0;
    const made = sweep({ wave2DeadlineMs: 10, now: () => (clock += 1000) });
    made.wave1();
    made.wave2();

    const complete = rows().filter((entry) => entry['rollup_state'] === 'complete');
    // Exactly one tree, and it is WHOLE: the crossing tree is never abandoned
    // half-projected, because the check is between trees.
    expect(complete).toHaveLength(1);
    expect(complete[0]?.['projection_state']).toBe('ready');
  });

  it('resumes at the next unprocessed root on the following tick', () => {
    const made = sweep({ wave2DeadlineMs: 0 });
    made.wave1();

    made.wave2();
    const first = rows().filter((entry) => entry['rollup_state'] === 'complete');
    expect(first).toHaveLength(1);

    made.wave2();
    const second = rows().filter((entry) => entry['rollup_state'] === 'complete');
    expect(second).toHaveLength(2);
    // The first root is not re-projected: its stamp is unchanged.
    expect(second[0]?.['projected_at']).toBe(first[0]?.['projected_at']);
  });

  it('a count budget of 4 would admit every tree in one tick — the unit is a TREE', () => {
    // The mutation control for the deadline. A count of 4 processes both trees
    // here in one pass, where the deadline stops after one; on the real corpus
    // the same count admits a 2.1 s synchronous tick against a 1 Hz period.
    const made = sweep({ wave2DeadlineMs: 0 });
    made.wave1();
    made.wave2();
    expect(rows().filter((entry) => entry['rollup_state'] === 'complete')).toHaveLength(1);

    const counted = sweep({ wave2DeadlineMs: Number.MAX_SAFE_INTEGER });
    counted.wave2();
    expect(rows().filter((entry) => entry['rollup_state'] === 'complete').length).toBeGreaterThan(
      1,
    );
  });
});

describe('AC5 — the wave-2 fixpoint reaches depth 2', () => {
  it('rolls a grandchild`s totals all the way to the top-level parent', () => {
    // A grandchild lives in the SAME flat `subagents/` listing, joined by its
    // parent sidecar`s own Agent call — fact 6`s shape.
    writeSidecar(
      sandbox,
      PARENT,
      'child1',
      sessionRecords('call-3', '2026-08-20T10:01:00.000Z', '2026-08-20T10:02:00.000Z').concat(
        sessionRecords('call-5', '2026-08-20T10:01:30.000Z', '2026-08-20T10:01:40.000Z'),
      ),
      { toolUseId: 'call-1' },
    );
    writeSidecar(
      sandbox,
      PARENT,
      'grand1',
      sessionRecords('call-6', '2026-08-20T10:01:31.000Z', '2026-08-20T10:01:39.000Z'),
      { toolUseId: 'call-5' },
    );

    const made = sweep();
    made.tick();

    const parent = row(PARENT)!;
    const child = row('child1')!;
    const grand = row('grand1')!;
    expect(grand['parent_session_id']).toBe('child1');
    expect(Number(child['sub_tool_call_count'])).toBe(subSumOf('child1'));
    expect(Number(parent['sub_tool_call_count'])).toBe(subSumOf(PARENT));

    // TRANSITIVE: the grandchild reaches the top. A direct-children-only sum
    // would stop at the children's OWN totals, which is strictly smaller.
    const directOnly = childrenOf(PARENT).reduce(
      (total, entry) => total + Number(entry['tool_call_count']),
      0,
    );
    expect(Number(parent['sub_tool_call_count'])).toBeGreaterThan(directOnly);
    expect(Number(parent['agent_count'])).toBeGreaterThan(childrenOf(PARENT).length);
    expect(parent['rollup_state']).toBe('complete');
  });
});

describe('BLOCKING 1 — a sealed session is indexed, projected and completed', () => {
  const SEALED = 'dddddddd-4444-4444-8444-dddddddddddd';

  function writeSealed(): string {
    return writeSealedSession(
      sandbox,
      SEALED,
      sessionRecords('call-s', '2026-08-20T08:00:00.000Z', '2026-08-20T08:05:00.000Z'),
    );
  }

  it('folds the sealed logical path from its physical .zst', () => {
    const logical = writeSealed();
    const fold = foldArchive(logical);
    expect(fold).toBeDefined();
    expect(fold!.size).toBe(statSync(`${logical}.zst`).size);
    expect(fold!.mtime_ms).toBe(Math.floor(statSync(`${logical}.zst`).mtimeMs));
  });

  it('indexes it, projects it, and reaches rollup_state=complete', () => {
    writeSealed();
    const report = sweep().tick();

    const sealedRow = row(SEALED)!;
    expect(sealedRow['project_path']).toBe(CWD);
    expect(sealedRow['started_at']).toBeTruthy();
    expect(sealedRow['last_activity_at']).toBeTruthy();
    expect(sealedRow['projection_state']).toBe('ready');
    expect(sealedRow['rollup_state']).toBe('complete');
    expect(report.projection_failed).toEqual([]);
  });

  it('links a SEALED sidecar too — the same limb, one fix', () => {
    writeSidecar(
      sandbox,
      PARENT,
      'sealedkid',
      sessionRecords('call-7', '2026-08-20T10:02:10.000Z', '2026-08-20T10:02:20.000Z'),
      { toolUseId: 'call-1', sealed: true },
    );

    const parentPath = join(sandbox.archiveRoot, SLUG, `${PARENT}.jsonl`);
    const found = readSidecars(
      parentPath,
      join(sandbox.sourceRoot, SLUG, `${PARENT}.jsonl`),
      new Set(['call-1']),
      createArchiveReader(),
    );
    expect(found.map((entry) => entry.agent_id).sort()).toEqual(['child1', 'sealedkid']);
  });
});

describe('recomputeSubagentRollups is a recompute, not delta arithmetic', () => {
  it('is idempotent, and gives a childless session zeros rather than NULLs', () => {
    const made = sweep();
    made.tick();

    const shape = (id: string): string =>
      JSON.stringify(
        db
          .prepare(
            `SELECT agent_count, sub_tool_call_count, sub_error_count, sub_tokens_in,
                    sub_tokens_out, sub_tokens_cache_read, sub_tokens_cache_write, sub_est_cost
               FROM sessions WHERE id = ?`,
          )
          .get(id),
      );

    const before = shape(PARENT);
    recomputeSubagentRollups(db, PARENT);
    recomputeSubagentRollups(db, PARENT);
    recomputeSubagentRollups(db, PARENT);
    expect(shape(PARENT)).toBe(before);

    // OTHER has no children at all: the COALESCE limb must give 0, and the
    // nullable cost column must stay NULL rather than claim a confident zero.
    const childless = db
      .prepare('SELECT agent_count, sub_tokens_in, sub_est_cost FROM sessions WHERE id = ?')
      .get(OTHER) as { agent_count: number; sub_tokens_in: number; sub_est_cost: number | null };
    expect(childless.agent_count).toBe(0);
    expect(childless.sub_tokens_in).toBe(0);
    expect(childless.sub_est_cost).toBeNull();
  });
});

describe('hand-off #1 — events.src_len is never NULL and never 0', () => {
  it('projects through the production env and slices every event back out of the bytes', () => {
    sweep().tick();

    const bad = db
      .prepare('SELECT count(*) AS n FROM events WHERE src_len IS NULL OR src_len <= 0')
      .get() as { n: number };
    expect(bad.n).toBe(0);

    const events = db
      .prepare('SELECT session_id, src_offset, src_len FROM events')
      .all() as unknown as { session_id: string; src_offset: number; src_len: number }[];
    expect(events.length).toBeGreaterThan(0);

    const reader = createArchiveReader();
    for (const event of events) {
      const archivePath = (
        db.prepare('SELECT archive_path FROM sessions WHERE id = ?').get(event.session_id) as {
          archive_path: string;
        }
      ).archive_path;
      const slice = reader.read(archivePath, event.src_offset, event.src_len).toString('utf8');
      expect(() => JSON.parse(slice) as unknown).not.toThrow();
    }
  });
});

describe('task 7.5 — wave 2 drains the spill index at its tail', () => {
  const SPILLER = 'cccccccc-3333-4333-8333-cccccccccccc';

  /** A top-level session with two spilled Bash results, both bodies mirrored. */
  function plantSpiller(): string[] {
    const at = (s: number): string => new Date(Date.UTC(2026, 7, 20, 11, 0, s)).toISOString();
    writeSession(sandbox, SPILLER, [
      humanLine('spill twice', at(0)),
      ...['w0', 'w1'].flatMap((name, i) => [
        toolCallLine(`toolu_${name}`, 'Bash', at(1 + 2 * i)),
        toolResultLine(
          `toolu_${name}`,
          spillMarker(`/gone/tool-results/${name}.txt`),
          at(2 + 2 * i),
        ),
      ]),
    ]);
    return [
      writeToolResult(sandbox, SPILLER, 'w0', 'zzwatchzero'),
      writeToolResult(sandbox, SPILLER, 'w1', 'zzwatchone'),
    ];
  }

  const spillCount = (): unknown => db.prepare('SELECT count(*) AS n FROM spill_fts').get();

  it('reports indexed, removed and skipped-by-path — outside the conservation sum', () => {
    const bodies = plantSpiller();
    const made = sweep();
    made.wave1();
    expect(made.wave2()).toMatchObject({
      spills_indexed: 2,
      spills_removed: 0,
      spills_skipped: [],
    });

    rmSync(bodies[0]!);
    expect(made.wave2()).toMatchObject({
      spills_indexed: 0,
      spills_removed: 1,
      spills_skipped: [expect.stringMatching(/w0\.txt$/)],
    });
    expect(spillCount()).toEqual({ n: 1 });

    const { walked, accounted } = conservationOf(made.tick());
    expect(accounted).toBe(walked);
  });

  it("shares wave 2's deadline: one body per pass once it is blown, never zero", () => {
    plantSpiller();
    const warm = sweep();
    warm.wave1();
    warm.wave2();
    db.exec('DELETE FROM spill_fts');

    let clock = 0;
    const late = sweep({ wave2DeadlineMs: 10, now: () => (clock += 1000) });
    expect([1, 2, 3].map(() => late.wave2().spills_indexed)).toEqual([1, 1, 0]);
    expect(spillCount()).toEqual({ n: 2 });
  });
});
