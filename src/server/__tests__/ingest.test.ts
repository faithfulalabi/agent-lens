import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  cleanupDir,
  makeTestEnvelope,
  TOKEN_HEADER,
  type TestServer,
} from './helpers.js';

let server: TestServer;

afterEach(async () => {
  if (server) {
    await server.close();
    cleanupDir(server.dataDir);
  }
});

/** Read one SSE data frame (for the given event type) from a stream response. */
async function readOneEvent(
  res: Response,
  eventType: string,
  timeoutMs = 1000,
): Promise<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!frame.includes(`event: ${eventType}`)) continue;
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (dataLine) {
          return JSON.parse(dataLine.slice('data:'.length).trim());
        }
      }
    }
    throw new Error(`no "${eventType}" frame within ${timeoutMs}ms`);
  } finally {
    await reader.cancel();
  }
}

describe('POST /api/ingest -> row -> SSE', () => {
  it('ingests, persists one row, and broadcasts within ~1s; dedupes by event_id', async () => {
    server = await bootTestServer();
    const envelope = makeTestEnvelope();

    const streamRes = await fetch(server.url('/api/stream'), {
      headers: { [TOKEN_HEADER]: server.token },
    });
    const framePromise = readOneEvent(streamRes, 'raw_event');

    const res = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: true, seq: 1 });

    const frame = await framePromise;
    expect(frame.event_id).toBe(envelope.event_id);

    const events = await (
      await fetch(server.url('/api/events'), { headers: { [TOKEN_HEADER]: server.token } })
    ).json();
    expect(events).toHaveLength(1);

    // Duplicate event_id: no new row, no broadcast, still 200.
    const dup = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ inserted: false, seq: -1 });

    const after = await (
      await fetch(server.url('/api/events'), { headers: { [TOKEN_HEADER]: server.token } })
    ).json();
    expect(after).toHaveLength(1);
  });

  it('rejects a malformed envelope (missing event_id) with 400 and no row', async () => {
    server = await bootTestServer();
    const bad = makeTestEnvelope();
    delete (bad as Record<string, unknown>).event_id;

    const res = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token, 'content-type': 'application/json' },
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);

    const events = await (
      await fetch(server.url('/api/events'), { headers: { [TOKEN_HEADER]: server.token } })
    ).json();
    expect(events).toHaveLength(0);
  });
});
