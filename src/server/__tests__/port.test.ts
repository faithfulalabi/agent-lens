import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type ServerHandle } from '../start.js';
import { readConfig } from '../config.js';
import { cleanupDir } from './helpers.js';

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
    const occupier = await startServer({ port: 4470, dataDir: freshDir() });
    handles.push(occupier);

    const server = await startServer({ dataDir: dir });
    handles.push(server);

    expect(server.port).toBeGreaterThan(4470);
    expect(readConfig(dir)?.port).toBe(server.port);
  });

  it('binds an explicit free port verbatim', async () => {
    const dir = freshDir();
    // Grab an ephemeral port, then release it and reuse the number explicitly.
    const probe = await startServer({ port: 0, dataDir: freshDir() });
    const freePort = probe.port;
    await probe.close();

    const server = await startServer({ port: freePort, dataDir: dir });
    handles.push(server);
    expect(server.port).toBe(freePort);
  });

  it('fails loudly on an explicitly-occupied port (no silent increment)', async () => {
    const occupier = await startServer({ port: 0, dataDir: freshDir() });
    handles.push(occupier);
    const busy = occupier.port;

    await expect(startServer({ port: busy, dataDir: freshDir() })).rejects.toThrow();
  });
});
