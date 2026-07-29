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
import { runInNewContext } from 'node:vm';
import { TOKEN_HEADER } from '../../shared/index.js';
import { BOOTSTRAP_MARKER, injectToken } from '../static-ui.js';
import { bootTestServer, cleanupDir, type TestServer } from './helpers.js';

const MARKED_HTML = `<!doctype html>
<html lang="en"><head>${BOOTSTRAP_MARKER}</head><body><div id="root"></div></body></html>`;

/** The published global, shaped as a browser would see it after parsing `html`. */
interface Bootstrap {
  token: string;
  tokenHeader: string;
}

/**
 * Run every inline `<script>` in `html` against a stub `window`, then hand back
 * what they defined. This is the closest thing to "what the browser ends up
 * with" that a node test can assert on, and — unlike a source-text match — it
 * cannot be satisfied by a string that merely looks right.
 */
function bootstrapFromHtml(html: string): Bootstrap | undefined {
  const window: Record<string, unknown> = {};
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1] ?? '';
    if (body.trim() === '') continue;
    runInNewContext(body, { window });
  }
  return window.__AGENT_LENS__ as Bootstrap | undefined;
}

/**
 * Every string in `html` that a browser could turn into a request target, plus
 * anything that merely looks like one: `src`/`href` values, absolute URLs, and
 * query strings. A token in any of them would leak into referrers and logs.
 */
function urlLiterals(html: string): string[] {
  return [
    ...[...html.matchAll(/\b(?:src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)].map((m) => m[1]!),
    ...[...html.matchAll(/https?:\/\/[^\s"'`<>]+/g)].map((m) => m[0]),
    ...[...html.matchAll(/\?[^\s"'`<>]*=[^\s"'`<>]*/g)].map((m) => m[0]),
  ];
}

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
