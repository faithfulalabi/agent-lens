// Puts the collector's token into the served `index.html`. It calls the
// PRODUCTION `injectToken` rather than re-spelling the script tag: that throws
// on a missing marker, escapes `<` so a token cannot break out of the tag, and
// replaces via a function so a `$`-sequence in a token is not expanded. No
// script-tag literal lives here, and `dev-server.test.ts` pins that.

import { injectToken } from '../server/static-ui.js';

// Structural on purpose, not `import type { Plugin } from 'vite'`: the root's
// transitive vite is 7.x while this object is handed to `ui/`'s vite 5.
export interface DevBootstrapPlugin {
  name: string;
  /** Serve only. A build must never see this plugin, let alone the token. */
  apply: 'serve';
  enforce: 'post';
  transformIndexHtml(html: string): string;
}

/** A serve-only plugin that injects `token` into the dev server's `index.html`. */
export function devBootstrapPlugin(token: string): DevBootstrapPlugin {
  return {
    name: 'agent-lens:dev-bootstrap',
    apply: 'serve',
    enforce: 'post',
    transformIndexHtml: (html) => injectToken(html, token),
  };
}
