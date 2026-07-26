// AC2 (same-origin token bootstrap): the served `/` page must carry the token so
// the browser can authenticate, but the token must NEVER travel in a URL — only
// in the `x-agentlens-token` header. These tests read the rendered HTML directly
// (no listening socket needed) and assert the token appears in a header-based
// fetch and nowhere in a URL/query string.

import { afterEach, describe, expect, it } from 'vitest';
import { renderPage } from '../static-page.js';
import { TOKEN_HEADER } from '../../shared/index.js';
import { bootTestServer, cleanupDir, type TestServer } from './helpers.js';

const TOKEN = 'test-token-abc123';

describe('static page token bootstrap (renderPage)', () => {
  it('inlines the token so the browser can authenticate same-origin', () => {
    const html = renderPage(TOKEN);
    expect(html).toContain(JSON.stringify(TOKEN));
    expect(html).toContain(JSON.stringify(TOKEN_HEADER));
  });

  it('sends the token as a header, never as a URL/query param', () => {
    const html = renderPage(TOKEN);
    // Token is used to build a request header, not appended to any URL.
    expect(html).toContain(`[HEADER]: TOKEN`);
    // No `?token=`, no `token=` query assignment, no token in a fetch URL literal.
    expect(html).not.toMatch(/\?token=/);
    expect(html).not.toContain(`?${TOKEN_HEADER}=`);
    // The fetch targets are relative API paths with no query string.
    expect(html).toContain(`fetch('/api/events'`);
    expect(html).toContain(`fetch('/api/stream'`);
    // The literal token value never appears inside a URL-looking string.
    expect(html).not.toMatch(new RegExp(`https?://[^'"\\s]*${TOKEN}`));
  });
});

let server: TestServer;

afterEach(async () => {
  if (server) {
    await server.close();
    cleanupDir(server.dataDir);
  }
});

describe('served / page (over HTTP)', () => {
  it('returns 200 with the real token embedded and no token in the URL', async () => {
    server = await bootTestServer();
    const url = server.url('/');
    // The page URL itself carries no token.
    expect(new URL(url).search).toBe('');

    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(JSON.stringify(server.token));
    // The token never appears attached to a query string anywhere in the page.
    expect(body).not.toContain(`?${TOKEN_HEADER}=${server.token}`);
  });
});
