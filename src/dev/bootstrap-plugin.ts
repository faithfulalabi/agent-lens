// The one thing the dev Vite server needs that a plain `vite dev` cannot do:
// put the collector's token into the served `index.html`.
//
// It calls the PRODUCTION `injectToken` (`src/server/static-ui.ts`) rather than
// re-spelling the script tag. That function throws when the bootstrap marker is
// absent instead of serving an un-injected page, escapes `<` so a token cannot
// break out of the enclosing script tag, and replaces via a function so `$&`/`$'`
// in a token read off disk are not expanded. A reimplementation here would
// re-open all three holes in the one server a developer points at a real corpus.
// This module therefore contains no script-tag literal at all, and
// `dev-server.test.ts` asserts that.
//
// The plugin object is constructed in the tsx process and handed to
// `createServer` by reference, so Vite never runs this module through its own
// esbuild config-bundling pipeline — which is what keeps the server graph
// (`node:sqlite`, NodeNext `.js`→`.ts` specifiers) out of `vite.config.ts`.
// It is deliberately NOT registered in `ui/vite.config.ts`: `vite build` and
// every UI test are structurally unable to reach it, and `apply: 'serve'` is the
// second belt.

import { injectToken } from '../server/static-ui.js';

/**
 * The structural shape Vite checks at run time — deliberately NOT
 * `import type { Plugin } from 'vite'`.
 *
 * The root has no `vite` dependency (see `resolveUiViteEsm`): a type import
 * would resolve to the root's transitive **vite 7** `Plugin`, describing an
 * object that is handed to `ui/`'s **vite 5**. A local structural type is
 * honest about which properties are actually load-bearing.
 */
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
