import { afterAll, describe, expect, it } from 'vitest';
import { builtHtml, cleanupBuilds } from './build-ui';

afterAll(cleanupBuilds);

/*
 * The server side of the token bootstrap (src/server/static-ui.ts) replaces this
 * comment with a `<script>` that defines `window.__AGENT_LENS__`. The contract
 * therefore spans two packages with no shared import — the literal below is
 * duplicated there on purpose, because an import edge from `src/` into `ui/`
 * would drag Vite into the server's build graph.
 *
 * That duplication is only safe while both ends are asserted. This is the end
 * that catches a build which drops or rewrites the comment (Vite preserves HTML
 * comments today, but nothing guarantees it across a major bump); the node
 * project asserts the committed `ui/index.html` still carries it.
 */
const BOOTSTRAP_MARKER = '<!--agent-lens-bootstrap-->';

describe('the token-bootstrap marker survives a real vite build', () => {
  it('appears exactly once in the emitted HTML', async () => {
    const html = await builtHtml();
    expect(html.split(BOOTSTRAP_MARKER)).toHaveLength(2);
  });
});
