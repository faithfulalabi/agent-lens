import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, type ServerHandle } from '../start.js';
import { readConfig } from '../config.js';
import { DB_FILE } from '../../db/index.js';
import { cleanupDir } from './helpers.js';

// Every `startServer` here bypasses `bootTestServer` and therefore its hermetic
// defaults, so each passes `tailIntervalMs: 0` explicitly. Without it the boot
// catch-up pass walks the DEVELOPER'S real `~/.claude/projects` before binding —
// 15 files / 20.3 MB / a dozen unrelated projects on a working machine. The
// assertion below pins that, rather than leaving it to a code reading.

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
    const occupier = await startServer({ port: 4470, dataDir: freshDir(), tailIntervalMs: 0 });
    handles.push(occupier);

    const server = await startServer({ dataDir: dir, tailIntervalMs: 0 });
    handles.push(server);

    expect(server.port).toBeGreaterThan(4470);
    expect(readConfig(dir)?.port).toBe(server.port);
  });

  it('binds an explicit free port verbatim', async () => {
    const dir = freshDir();
    // Grab an ephemeral port, then release it and reuse the number explicitly.
    const probe = await startServer({ port: 0, dataDir: freshDir(), tailIntervalMs: 0 });
    const freePort = probe.port;
    await probe.close();

    const server = await startServer({ port: freePort, dataDir: dir, tailIntervalMs: 0 });
    handles.push(server);
    expect(server.port).toBe(freePort);
  });

  it('fails loudly on an explicitly-occupied port (no silent increment)', async () => {
    const occupier = await startServer({ port: 0, dataDir: freshDir(), tailIntervalMs: 0 });
    handles.push(occupier);
    const busy = occupier.port;

    await expect(
      startServer({ port: busy, dataDir: freshDir(), tailIntervalMs: 0 }),
    ).rejects.toThrow();
  });
});

describe('boot hermeticity — direct startServer construction', () => {
  it('performs no transcript scan when tailing is off', async () => {
    const dir = freshDir();
    handles.push(await startServer({ port: 0, dataDir: dir, tailIntervalMs: 0 }));

    const db = new DatabaseSync(join(dir, DB_FILE));
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM tailer_offsets').get() as {
        n: number;
      };
      // Zero rows, not merely "no timer": a boot pass would have first-sighted
      // every transcript on the machine and left one offset row per file.
      expect(Number(row.n)).toBe(0);
    } finally {
      db.close();
    }
  });
});
