import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, type ServerHandle } from '../start.js';
import { readConfig } from '../config.js';
import { CACHE_DB_FILE } from '../../db/open.js';
import { cleanupDir } from './helpers.js';

// Every `startServer` here bypasses `bootTestServer` and therefore its hermetic
// defaults, so each passes `sweepIntervalMs: 0` explicitly. Without it the first
// sweep tick walks the DEVELOPER'S real `~/.agent-lens/archive` before binding —
// hundreds of files on a working machine. The assertion below pins that, rather
// than leaving it to a code reading.

const handles: ServerHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (handles.length) {
    await handles.pop()!.close();
  }
  while (dirs.length) {
    cleanupDir(dirs.pop()!);
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-lens-'));
  dirs.push(dir);
  return dir;
}

describe('port selection', () => {
  it('auto-increments off an occupied default and persists the bound port', async () => {
    const dir = freshDir();
    // Occupy the default port so the next boot must increment.
    const occupier = await startServer({ port: 4470, dataDir: freshDir(), sweepIntervalMs: 0 });
    handles.push(occupier);

    const server = await startServer({ dataDir: dir, sweepIntervalMs: 0 });
    handles.push(server);

    expect(server.port).toBeGreaterThan(4470);
    expect(readConfig(dir)?.port).toBe(server.port);
  });

  it('binds an explicit free port verbatim', async () => {
    const dir = freshDir();
    // Grab an ephemeral port, then release it and reuse the number explicitly.
    const probe = await startServer({ port: 0, dataDir: freshDir(), sweepIntervalMs: 0 });
    const freePort = probe.port;
    await probe.close();

    const server = await startServer({ port: freePort, dataDir: dir, sweepIntervalMs: 0 });
    handles.push(server);
    expect(server.port).toBe(freePort);
  });

  it('fails loudly on an explicitly-occupied port (no silent increment)', async () => {
    const occupier = await startServer({ port: 0, dataDir: freshDir(), sweepIntervalMs: 0 });
    handles.push(occupier);
    const busy = occupier.port;

    await expect(
      startServer({ port: busy, dataDir: freshDir(), sweepIntervalMs: 0 }),
    ).rejects.toThrow();
  });
});

describe('boot hermeticity — direct startServer construction', () => {
  it('performs no archive walk when the sweep is off', async () => {
    const dir = freshDir();
    handles.push(await startServer({ port: 0, dataDir: dir, sweepIntervalMs: 0 }));

    const db = new DatabaseSync(join(dir, CACHE_DB_FILE));
    try {
      const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
      // Zero rows, not merely "no timer": one tick would have indexed every
      // archived transcript on the machine and left a `sessions` row per file.
      expect(Number(sessions.n)).toBe(0);
      // And no `index_built_at`, which `stampIndexMeta` writes on any clean pass
      // — the marker that discriminates "swept and found nothing" from "never
      // swept", which the row count alone cannot.
      const meta = db.prepare(`SELECT value FROM meta WHERE key = 'index_built_at'`).get();
      expect(meta).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
