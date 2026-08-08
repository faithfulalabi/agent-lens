// AC3 (same-origin token bootstrap): the served page must carry the token so
// the browser can authenticate, and the token must NEVER travel in a URL — only
// in the `x-agentlens-token` request header.
//
// The Task 1.3 version of this file asserted the SHAPE OF THE SOURCE (`[HEADER]:
// TOKEN`, `fetch('/api/events'`). Those assertions could be satisfied by
// rewriting a string and said nothing about what a browser would do. Every
// invariant is preserved here, re-expressed against the served document:
// the scripts are executed in a `vm` sandbox and the result is inspected.

import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN_HEADER } from '../../shared/index.js';
import { BOOTSTRAP_MARKER, injectToken } from '../static-ui.js';
import {
  bootstrapFromHtml,
  bootTestServer,
  cleanupDir,
  urlLiterals,
  type TestServer,
} from './helpers.js';

const MARKED_HTML = `<!doctype html>
<html lang="en"><head>${BOOTSTRAP_MARKER}</head><body><div id="root"></div></body></html>`;

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    cleanupDir(server.dataDir);
    server = undefined;
  }
});

describe('AC3 — the served page bootstraps the token as a script global', () => {
  it('exposes window.__AGENT_LENS__ with the token and the header name', async () => {
    server = await bootTestServer();
    const html = await (await fetch(server.url('/'))).text();

    const bootstrap = bootstrapFromHtml(html);
    expect(bootstrap).toBeDefined();
    expect(bootstrap!.token).toBe(server.token);
    // Shipped alongside the token so 5.1c never re-derives the header name.
    expect(bootstrap!.tokenHeader).toBe(TOKEN_HEADER);
    expect(Object.isFrozen(bootstrap)).toBe(true);
  });

  it('puts the token in no URL anywhere in the served page', async () => {
    server = await bootTestServer();
    const html = await (await fetch(server.url('/'))).text();

    // The token IS in the page — that is the whole mechanism — just never in
    // anything a browser would dereference.
    expect(html).toContain(server.token);
    for (const literal of urlLiterals(html)) {
      expect(literal, `token leaked into a URL literal: ${literal}`).not.toContain(server.token);
    }
  });

  it('serves the page from a URL with no query string', async () => {
    server = await bootTestServer();
    const url = server.url('/');
    expect(new URL(url).search).toBe('');
    expect((await fetch(url)).status).toBe(200);
  });
});

describe('AC3 — injectToken', () => {
  it('escapes a token that would otherwise break out of the script tag', () => {
    // The token is read straight off disk, and only *generated* tokens are
    // guaranteed base64url — so a hand-edited one has to be assumed hostile.
    const evil = 'a</script><script>alert(1)//';
    const html = injectToken(MARKED_HTML, evil);

    expect(html).not.toContain('</script><script>alert');
    // Escaped, not mangled: the browser still reads back the exact token.
    expect(bootstrapFromHtml(html)?.token).toBe(evil);
  });

  it('throws when the marker is missing rather than serving an un-injected page', () => {
    // Silently serving the page without the global would produce a UI that 401s
    // on every request with nothing to explain why.
    expect(() => injectToken('<!doctype html><html></html>', 'tok')).toThrow(BOOTSTRAP_MARKER);
  });
});
