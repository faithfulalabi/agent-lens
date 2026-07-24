import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FILE } from '../../db/index.js';
import {
  bootTestServer,
  cleanupDir,
  makeTestEnvelope,
  TOKEN_HEADER,
} from './helpers.js';

let dataDir: string;

afterEach(() => {
  if (dataDir) cleanupDir(dataDir);
});

describe('restart persistence', () => {
  it('re-hydrates prior events after close + reopen on the same data dir', async () => {
    const first = await bootTestServer();
    dataDir = first.dataDir;

    for (const id of ['sess-1:hook:PreToolUse:a', 'sess-1:hook:PreToolUse:b']) {
      const res = await fetch(first.url('/api/ingest'), {
        method: 'POST',
        headers: { [TOKEN_HEADER]: first.token, 'content-type': 'application/json' },
        body: JSON.stringify(makeTestEnvelope({ event_id: id })),
      });
      expect(res.status).toBe(200);
    }
    await first.close();

    expect(existsSync(join(dataDir, DB_FILE))).toBe(true);

    const second = await bootTestServer(dataDir);
    try {
      const events = (await (
        await fetch(second.url('/api/events'), {
          headers: { [TOKEN_HEADER]: second.token },
        })
      ).json()) as { event_id: string }[];
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.event_id)).toEqual([
        'sess-1:hook:PreToolUse:a',
        'sess-1:hook:PreToolUse:b',
      ]);
    } finally {
      await second.close();
    }
  });
});
