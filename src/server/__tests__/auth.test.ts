import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import {
  bootTestServer,
  cleanupDir,
  makeTestEnvelope,
  TOKEN_HEADER,
  type TestServer,
} from './helpers.js';

/**
 * Raw HTTP request that can set a custom Host header — `fetch` forbids Host as a
 * header name, so the host guard can only be exercised via `node:http`.
 */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let server: TestServer;

afterEach(async () => {
  if (server) {
    await server.close();
    cleanupDir(server.dataDir);
  }
});

async function eventCount(s: TestServer): Promise<number> {
  const events = (await (
    await fetch(s.url('/api/events'), { headers: { [TOKEN_HEADER]: s.token } })
  ).json()) as unknown[];
  return events.length;
}

describe('token auth on /api/*', () => {
  it('rejects ingest without a token (401) and writes no row', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeTestEnvelope()),
    });
    expect(res.status).toBe(401);
    expect(await eventCount(server)).toBe(0);
  });

  it('rejects ingest with a wrong token (401)', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: 'nope', 'content-type': 'application/json' },
      body: JSON.stringify(makeTestEnvelope()),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a stream without a token (401)', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/stream'));
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('accepts requests with the correct token', async () => {
    server = await bootTestServer();
    const res = await fetch(server.url('/api/ingest'), {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token, 'content-type': 'application/json' },
      body: JSON.stringify(makeTestEnvelope()),
    });
    expect(res.status).toBe(200);
  });
});

describe('host-header guard', () => {
  it('rejects a non-localhost Host (403) even with a valid token, no row', async () => {
    server = await bootTestServer();
    const res = await rawRequest(
      server.handle.port,
      '/api/ingest',
      {
        [TOKEN_HEADER]: server.token,
        'content-type': 'application/json',
        host: 'evil.com',
      },
      'POST',
      JSON.stringify(makeTestEnvelope()),
    );
    expect(res.status).toBe(403);
    expect(await eventCount(server)).toBe(0);
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'allows loopback Host %s',
    async (host) => {
      server = await bootTestServer();
      const res = await rawRequest(server.handle.port, '/api/events', {
        [TOKEN_HEADER]: server.token,
        host: `${host}:${server.handle.port}`,
      });
      expect(res.status).toBe(200);
    },
  );
});
