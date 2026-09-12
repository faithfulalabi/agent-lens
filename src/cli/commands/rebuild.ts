// `agent-lens rebuild [session-id]` — the disposable half of the durability
// contract, made visible on the command line. Nothing here can lose data:
// cache.db is a projection of the archive, and the archive is untouched.
//
// ★ A BARE `deleteSessionProjection()` IS A BUG, NOT A REBUILD. It removes the
// events, turns and FTS rows and leaves `projection_state = 'ready'` with the
// freshness stamp intact (`db/write.ts:137-144`), so the gate then answers
// `'hit'` and writes NOTHING — the session is permanently empty
// (`server/__tests__/warm.test.ts:15-20`). The single-session path below follows
// `api.ts:566-587` instead: gate first, then delete AND reproject from the fold
// the gate already took.
//
// TWO SHAPES, ONE INVARIANT — the cache file is never unlinked under a live
// handle. The whole-cache path takes the cache lock BEFORE removing anything,
// exactly as `db/open.ts:96-128` does, because unlinking under another process's
// handle forks the database silently: its writes keep succeeding and are lost on
// close.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, resolveDataDir } from '../../archive/index.js';
import { createProjectionEnv } from '../../corpus/env.js';
import { ensureProjectedFold } from '../../db/freshness.js';
import { CACHE_DB_FILE, CACHE_LOCK_FILE, DbLockedError, openDb } from '../../db/open.js';
import { readEventCount } from '../../db/read.js';
import { deleteSessionProjection, projectSession } from '../../db/write.js';
import { EXIT_INCOMPLETE, EXIT_OK, parseStringFlag } from './archive.js';

/**
 * The one positional argument, at any index — the contract `parsePruneArgs`
 * (`prune.ts:90-118`) honours. `--dataDir value` is consumed by position and
 * never inspected, so a `-`-prefixed value is not misread as a flag or an id.
 */
export function parseSessionId(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      // ponytail: rebuild's one value flag, spelled here as well as in the
      // COMMANDS table on purpose (no shared parser near a destructive
      // command's walk) — a second value flag must be added in both places.
      if (arg === '--dataDir') i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

/** Removes cache.db and its two siblings, under the cache lock. */
function rebuildCache(dataDir: string): number {
  const lockPath = join(dataDir, CACHE_LOCK_FILE);
  const lock = acquireLock(dataDir, undefined, lockPath);
  if (lock.state.state === 'held') {
    const pid = lock.state.holder_pid ?? 'unknown';
    console.error(
      `agent-lens is already running (pid ${pid}) — stop it before rebuilding the cache`,
    );
    return EXIT_INCOMPLETE;
  }

  try {
    const cachePath = join(dataDir, CACHE_DB_FILE);
    const removed: string[] = [];
    // ONE call site over a loop, matching `db/open.ts:125`. `force` is
    // load-bearing: a cleanly closed cache has no `-wal`/`-shm` to remove.
    for (const suffix of ['', '-wal', '-shm']) {
      const target = cachePath + suffix;
      if (existsSync(target)) removed.push(target);
      rmSync(target, { force: true });
    }

    if (removed.length === 0) {
      console.log(`agent-lens rebuild: no cache at ${cachePath} — the next start builds one`);
      return EXIT_OK;
    }
    console.log(`agent-lens rebuild: removed ${removed.length} file(s)`);
    for (const path of removed) console.log(`  ${path}`);
    console.log('  the next `agent-lens start` re-indexes the archive and reprojects on read');
    return EXIT_OK;
  } finally {
    lock.release();
  }
}

/** Forces one session's projection, following `api.ts`'s reproject route. */
function rebuildSession(dataDir: string, id: string): number {
  const opened = openDb({ dataDir });
  try {
    const env = createProjectionEnv();
    const started = Date.now();
    const gate = ensureProjectedFold(opened.db, id, env);

    if (gate.outcome === 'unindexed') {
      console.error(`agent-lens rebuild: ${id} is not indexed — run \`agent-lens start\` first`);
      return EXIT_INCOMPLETE;
    }
    if (gate.outcome === 'failed' || gate.fold === undefined) {
      console.error(`agent-lens rebuild: ${id} has no readable archived bytes`);
      return EXIT_INCOMPLETE;
    }
    // A miss already rebuilt from these same bytes (`api.ts:562-565`), so doing
    // it twice would only cost. A hit changed nothing, so the rebuild is here.
    if (gate.outcome === 'hit') {
      deleteSessionProjection(opened.db, id);
      projectSession(opened.db, id, env, gate.fold);
    }

    const events = readEventCount(opened.db, id);
    // took_ms is a DIAGNOSTIC, pinned to nothing. The in-repo 45 ms figure is
    // superseded by `db/write.ts:161-165` — p50 15.9 ms, max 135.7 ms over 312
    // sessions — which `server/warm.ts:74` already treats as authoritative.
    console.log(`agent-lens rebuild: ${id} — ${events} events, took_ms ${Date.now() - started}`);
    return EXIT_OK;
  } finally {
    opened.close();
  }
}

/**
 * `main` has no try/catch, so an escaping throw is an unhandled rejection and an
 * ugly stack. Every failure leaves here as one clean line and a 1.
 */
export async function rebuild(args: string[] = []): Promise<number> {
  try {
    const dataDir = resolveDataDir(parseStringFlag(args, 'dataDir'));
    const id = parseSessionId(args);
    return id === undefined ? rebuildCache(dataDir) : rebuildSession(dataDir, id);
  } catch (error) {
    if (error instanceof DbLockedError) {
      console.error(`${error.message} — stop it, or reproject from the running UI instead`);
      return EXIT_INCOMPLETE;
    }
    console.error(`agent-lens rebuild: ${String((error as Error).message ?? error)}`);
    return EXIT_INCOMPLETE;
  }
}
