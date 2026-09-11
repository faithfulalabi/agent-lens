// `agent-lens rebuild`, both shapes.
//
// ★ THE MUTATION CONTROL IS THE POINT OF THIS FILE. The Why this task was
// written from says `rebuild <id>` "is a single deleteSessionProjection()", and
// that describes a TRAP: the delete leaves `projection_state = 'ready'` with the
// freshness stamp intact, so the gate answers `'hit'` and writes nothing, and
// the session is permanently empty. The control arm below builds exactly that
// state and asserts the damage, right beside the real command's green arm.
//
// Everything is driven through the exported command function rather than a
// spawn: `archive.test.ts` already owns the process-exit-code harness, and it is
// extended there for these four commands rather than duplicated here.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  cleanup,
  makeSandbox,
  pinSandboxEnv,
  runMain,
  SLUG,
  snapshotTreeSafe,
  type Sandbox,
} from '../../archive/__tests__/fixtures.js';
import { createProjectionEnv } from '../../corpus/env.js';
import { createCorpusSweep } from '../../corpus/watch.js';
import { humanLine } from '../../db/__tests__/fixtures/index.js';
import { ensureProjectedFold } from '../../db/freshness.js';
import { CACHE_DB_FILE, CACHE_LOCK_FILE, openDb } from '../../db/open.js';
import {
  readEventCount,
  readHealthCounts,
  readTurns,
  readWarmableIds,
  searchEvents,
} from '../../db/read.js';
import { deleteSessionProjection } from '../../db/write.js';
import { EXIT_INCOMPLETE, EXIT_OK } from '../commands/archive.js';
import { parseSessionId, rebuild } from '../commands/rebuild.js';

const IDS = ['aaaaaaaa-1111-4111-8111-rb0000000001', 'aaaaaaaa-1111-4111-8111-rb0000000002'];

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

/** One archived transcript in the mirror's `<slug>/<stem>.jsonl` layout. */
function seedArchive(s: Sandbox, id: string, lines = 3): string {
  const slug = join(s.archiveRoot, SLUG);
  mkdirSync(slug, { recursive: true });
  const path = join(slug, `${id}.jsonl`);
  const body = Array.from({ length: lines }, (_, i) =>
    JSON.stringify(
      humanLine(
        `rebuildable line ${i} of ${id}`,
        new Date(Date.UTC(2026, 7, 14, 9, 0, Math.min(i, 59))).toISOString(),
      ),
    ),
  ).join('\n');
  writeFileSync(path, `${body}\n`);
  return path;
}

function argsFor(s: Sandbox, extra: string[] = []): string[] {
  return [...extra, `--dataDir=${s.dataDir}`, `--transcriptRoot=${s.sourceRoot}`];
}

/** Index AND project the sandbox, the way a real boot sweep would. */
function seedCache(s: Sandbox): void {
  const opened = openDb({ dataDir: s.dataDir });
  try {
    createCorpusSweep({
      db: opened.db,
      dataDir: s.dataDir,
      transcriptRoot: s.sourceRoot,
    }).tick();
  } finally {
    opened.close();
  }
}

/** Reads the sandbox cache through a handle of its own, then closes it. */
function withCache<T>(s: Sandbox, read: (db: DatabaseSync) => T): T {
  const opened = openDb({ dataDir: s.dataDir });
  try {
    return read(opened.db);
  } finally {
    opened.close();
  }
}

async function runRebuild(args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (msg?: unknown) => void lines.push(String(msg));
  console.error = (msg?: unknown) => void lines.push(String(msg));
  try {
    return { code: await rebuild(args), out: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe('parseSessionId — one positional, first position only', () => {
  it.each([
    [[], undefined],
    [['abc'], 'abc'],
    [['abc', '--dataDir=/x'], 'abc'],
    [['--dataDir=/x'], undefined],
    // The value of a leading flag is never mistaken for the id.
    [['--dataDir', '/x'], undefined],
    [['--verify'], undefined],
  ])('%j -> %s', (args, expected) => {
    expect(parseSessionId(args)).toBe(expected);
  });
});

describe('task 0.6 — a misplaced session id is refused, and the cache survives', () => {
  // ★ `parseSessionId` reads `args[0]` and nothing else, on purpose. Its blind
  // spot is destructive: `rebuild --dataDir=/x abc` gives `args[0]` a leading
  // `-`, so the id is dropped, `rebuild.ts:116` takes the WHOLE-CACHE branch and
  // `rmSync`s cache.db, `-wal` and `-shm`. `positional: 'first'` refuses the
  // invocation instead — the parser is left exactly as it is (OQ6).
  it.each([
    ['id after a flag, = form', (s: Sandbox) => ['rebuild', `--dataDir=${s.dataDir}`, 'abc']],
    ['id after a flag, space form', (s: Sandbox) => ['rebuild', '--dataDir', s.dataDir, 'abc']],
  ])('%s exits 1 and leaves the cache on disk', async (_name, argvOf) => {
    const s = sb();
    seedArchive(s, IDS[0]!);
    seedCache(s);
    expect(existsSync(join(s.dataDir, CACHE_DB_FILE)), 'the fixture builds a cache').toBe(true);
    const before = snapshotTreeSafe(s.dataDir);
    const restore = pinSandboxEnv(s);

    try {
      const { code, err } = await runMain(argvOf(s));

      // Asserted BEFORE the exit code: the damage is the point. Nothing ran,
      // so the whole tree is untouched — not just cache.db.
      expect([...snapshotTreeSafe(s.dataDir).keys()].sort()).toEqual([...before.keys()].sort());
      expect(code).toBe(EXIT_INCOMPLETE);
      expect(err).toContain('abc');
    } finally {
      restore();
    }
  });

  it('the id in first position still reaches the command', async () => {
    const s = sb();
    seedArchive(s, IDS[0]!);
    seedCache(s);
    const restore = pinSandboxEnv(s);

    try {
      const { code, err } = await runMain(['rebuild', 'abc', `--dataDir=${s.dataDir}`]);

      // Unchanged from today: the validator accepts, and the session lookup
      // is what refuses. Same code, entirely different reason.
      expect(code).toBe(EXIT_INCOMPLETE);
      expect(err).toContain('is not indexed');
      expect(existsSync(join(s.dataDir, CACHE_DB_FILE))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('1 + 2 — the whole-cache rebuild, and the lock that refuses it (AC1)', () => {
  it('removes cache.db, -wal and -shm, and the next open recreates the schema', async () => {
    const s = sb();
    seedArchive(s, IDS[0]!);
    seedCache(s);
    const cachePath = join(s.dataDir, CACHE_DB_FILE);
    expect(existsSync(cachePath), 'the fixture should have built a cache').toBe(true);

    const { code, out } = await runRebuild(argsFor(s));

    expect(code).toBe(EXIT_OK);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(existsSync(cachePath + suffix), suffix).toBe(false);
    }
    expect(out).toContain(cachePath);

    // The projection is disposable, and this is what that means: a fresh open
    // rebuilds an empty, valid schema with nothing lost from the archive.
    expect(withCache(s, readHealthCounts).sessions_indexed).toBe(0);
    expect(existsSync(join(s.archiveRoot, SLUG, `${IDS[0]!}.jsonl`))).toBe(true);
  });

  it('a held cache lock refuses, exits 1, and deletes nothing', async () => {
    const s = sb();
    seedArchive(s, IDS[0]!);
    seedCache(s);
    const cachePath = join(s.dataDir, CACHE_DB_FILE);
    // pid 1 is alive and is not us, so the lock reads as genuinely held.
    writeFileSync(
      join(s.dataDir, CACHE_LOCK_FILE),
      JSON.stringify({ pid: 1, started_at: Date.now(), hostname: hostname() }),
      { mode: 0o600 },
    );
    const before = snapshotTreeSafe(s.dataDir);

    const { code, out } = await runRebuild(argsFor(s));

    expect(code).toBe(EXIT_INCOMPLETE);
    expect(out).toMatch(/already running \(pid 1\)/);
    expect(existsSync(cachePath)).toBe(true);
    // The invariant `db/open.ts:1-8` states: nothing is unlinked under a handle
    // another process may hold.
    const after = snapshotTreeSafe(s.dataDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('an empty data dir is not an error — there is simply no cache to drop', async () => {
    const s = sb();
    const { code, out } = await runRebuild(argsFor(s));

    expect(code).toBe(EXIT_OK);
    expect(out).toContain('no cache at');
  });
});

describe('3 + 4 — the single-session rebuild (AC1)', () => {
  it('repopulates events, turns and FTS, and leaves the row warm', async () => {
    const s = sb();
    seedArchive(s, IDS[0]!);
    seedCache(s);
    const id = IDS[0]!;

    // Non-vacuity: the sweep really projected it, so "still populated" below is
    // not a green over a fixture that was never anything else.
    expect(withCache(s, (db) => readEventCount(db, id))).toBeGreaterThan(0);

    const { code, out } = await runRebuild(argsFor(s, [id]));

    expect(code).toBe(EXIT_OK);
    expect(out).toContain(id);
    withCache(s, (db) => {
      expect(readEventCount(db, id)).toBeGreaterThan(0);
      expect(readTurns(db, id).length).toBeGreaterThan(0);
      // FTS is rebuilt too — a delete that skipped the index would leave the
      // shadow rows behind and this hit would be a phantom or a throw.
      expect(searchEvents(db, { q: 'rebuildable', limit: 10 }).length).toBeGreaterThan(0);
      // `'ready'` at the CURRENT projector version, stated the way the warm
      // reader states it: a stale or unprojected row would be warmable.
      expect(readWarmableIds(db)).not.toContain(id);
    });
  });

  it('★ MUTATION CONTROL: deleting the projection alone strands the session forever', async () => {
    const s = sb();
    seedArchive(s, IDS[0]!);
    seedCache(s);
    const id = IDS[0]!;

    const opened = openDb({ dataDir: s.dataDir });
    try {
      // The trap the Why describes, built by hand.
      deleteSessionProjection(opened.db, id);
      expect(readEventCount(opened.db, id)).toBe(0);

      // The gate says `'hit'` — the stamp still matches — so it writes NOTHING,
      // and no amount of re-reading brings the events back.
      const gate = ensureProjectedFold(opened.db, id, createProjectionEnv());
      expect(gate.outcome).toBe('hit');
      expect(readEventCount(opened.db, id)).toBe(0);
      // …and the warm queue cannot rescue it either: the row is not warmable.
      expect(readWarmableIds(opened.db)).not.toContain(id);
    } finally {
      opened.close();
    }

    // The real command, over the same stranded row, is what repairs it.
    expect((await runRebuild(argsFor(s, [id]))).code).toBe(EXIT_OK);
    expect(withCache(s, (db) => readEventCount(db, id))).toBeGreaterThan(0);
  });

  it('an unknown session id exits 1 and leaves every other row alone', async () => {
    const s = sb();
    seedArchive(s, IDS[0]!);
    seedArchive(s, IDS[1]!);
    seedCache(s);
    const before = withCache(s, readHealthCounts);

    const { code, out } = await runRebuild(argsFor(s, ['no-such-session']));

    expect(code).toBe(EXIT_INCOMPLETE);
    expect(out).toContain('not indexed');
    expect(withCache(s, readHealthCounts)).toEqual(before);
  });
});

describe('5 — took_ms is a diagnostic, pinned to nothing (AC1, re-worded)', () => {
  it('prints a measured number and asserts no bound on it', async () => {
    // `corpus/__tests__/corpus.test.ts:4-9`'s rule: assert the property, print
    // the number. The 45 ms figure this task inherited traces to ~26 sessions
    // and is superseded by `db/write.ts:161-165` — p50 15.9 ms, max 135.7 ms
    // over 312 — so any bound asserted here would flake on the real corpus.
    const s = sb();
    seedArchive(s, IDS[0]!);
    seedCache(s);

    const { out } = await runRebuild(argsFor(s, [IDS[0]!]));

    const took = /took_ms (\d+)/.exec(out);
    expect(took, out).not.toBeNull();
    expect(Number(took![1])).toBeGreaterThanOrEqual(0);
    console.log(`[diagnostic] single-session rebuild took_ms ${took![1]}`);
  });
});
