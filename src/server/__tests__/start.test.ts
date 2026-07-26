// AC3 test 14: the inactivity sweep is injectable AND provably torn down. A
// surviving interval that fires after `db.close()` throws inside a timer
// callback, where nothing can catch it — so `clearInterval` must precede the
// close, and this test proves it rather than trusting `.unref()`.

import { afterEach, describe, expect, it } from 'vitest';
import type { SweepResult } from '../../capture/inactivity.js';
import { bootTestServer, cleanupDir, type TestServer } from './helpers.js';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    cleanupDir(server.dataDir);
    server = undefined;
  }
});

/** Resolve once `predicate` holds, or reject after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe('startServer — inactivity sweep lifecycle', () => {
  it('runs the sweep on an interval and stops it before closing the DB', async () => {
    const results: SweepResult[] = [];
    const booted = await bootTestServer({
      sweepIntervalMs: 5,
      onSweep: (r) => results.push(r),
    });

    await waitFor(() => results.length >= 1);
    const uncaught: unknown[] = [];
    const spy = (err: unknown): number => uncaught.push(err);
    process.on('uncaughtException', spy);

    try {
      await booted.handle.close();
      const countAtClose = results.length;
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The interval is gone: no sweep ran after close, and nothing blew up
      // trying to query a closed database from a timer callback.
      expect(results.length).toBe(countAtClose);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', spy);
      cleanupDir(booted.dataDir);
    }
  });

  it('sweepIntervalMs: 0 disables the sweep entirely', async () => {
    let swept = 0;
    server = await bootTestServer({ sweepIntervalMs: 0, onSweep: () => (swept += 1) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(swept).toBe(0);
  });
});
