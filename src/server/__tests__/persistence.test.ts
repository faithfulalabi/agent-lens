// Restart persistence, for a cache.db that is explicitly disposable.
//
// What survives a restart is TIER A — the session index the corpus sweep builds
// from the archive. Tier B is lazy and rebuilt on demand, and the whole file is
// deleted outright on a `SCHEMA_VERSION` bump, so "the rows are still there" is
// only interesting when nothing re-derived them: the second boot runs with the
// sweep OFF, and the session is listed anyway.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DB_FILE } from '../../db/open.js';
import { bootTestServer, cleanupDir, listedIds } from './helpers.js';

let dataDir: string;

afterEach(() => {
  if (dataDir) cleanupDir(dataDir);
});

const SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** One archived transcript, in the mirror's `<slug>/<stem>.jsonl` layout. */
function seedArchive(dir: string): void {
  const slug = join(dir, 'archive', '-Users-dev-proj');
  mkdirSync(slug, { recursive: true });
  const line = {
    type: 'user',
    uuid: '11111111-1111-4111-8111-111111111111',
    parentUuid: null,
    sessionId: SESSION,
    version: '2.1.212',
    cwd: '/Users/dev/proj',
    gitBranch: 'main',
    timestamp: '2026-08-14T09:00:00.000Z',
    promptId: 'p1',
    origin: { kind: 'human' },
    message: { role: 'user', content: 'hello' },
  };
  writeFileSync(join(slug, `${SESSION}.jsonl`), `${JSON.stringify(line)}\n`);
}

describe('restart persistence', () => {
  it('keeps the swept session index across close + reopen on the same data dir', async () => {
    const first = await bootTestServer({ sweepIntervalMs: 0 });
    dataDir = first.dataDir;
    seedArchive(dataDir);
    // One pass, driven rather than timed: the assertion is about what persists,
    // not about how long a 1 Hz interval takes to fire.
    expect(await listedIds(first)).toEqual([]);
    await first.close();

    const swept = await bootTestServer({ dataDir, sweepIntervalMs: 60_000 });
    expect(await listedIds(swept)).toEqual([SESSION]);
    await swept.close();

    expect(existsSync(join(dataDir, CACHE_DB_FILE))).toBe(true);

    // The sweep is OFF here, so nothing re-derives the row. It is listed because
    // it was persisted, which is the whole claim.
    const second = await bootTestServer({ dataDir, sweepIntervalMs: 0 });
    try {
      expect(await listedIds(second)).toEqual([SESSION]);
    } finally {
      await second.close();
    }
  });
});
