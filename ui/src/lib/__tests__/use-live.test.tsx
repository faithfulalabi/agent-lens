import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createLiveBus } from '../live';
import { useLiveStream } from '../use-live';

/*
 * The stream binding, on the same terms `use-async.test.tsx` sets out.
 *
 * PROVABLE: the module imports and the hook renders under `environment: 'node'`
 * — which is what catches a module-scope `createSseClient()` creeping in later,
 * since its default reads the page bootstrap and that read throws outside a
 * browser.
 *
 * NOT PROVABLE: the socket. `renderToStaticMarkup` runs no effect, so there is
 * no behavioural instrument for the client, the subscription or the teardown.
 * Those are pinned against the source text — the same honest instrument
 * `router.test.ts` uses for the default port's `window` binding — while the
 * decisions they carry are behavioural in `live.test.ts`.
 */

const MODULE_PATH = fileURLToPath(new URL('../use-live.ts', import.meta.url));
const SOURCE = readFileSync(MODULE_PATH, 'utf8');
const APP = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8');

function Probe() {
  useLiveStream(createLiveBus());
  return <span>mounted</span>;
}

describe('useLiveStream is safe to import and render without a DOM', () => {
  it('renders without opening anything', () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>mounted</span>');
  });

  it('builds no client and reads no bootstrap at module scope', () => {
    expect(SOURCE, 'a module-scope client would throw at import time').not.toMatch(
      /^const \w+ = createSseClient\(/m,
    );
    expect(SOURCE).not.toContain('readBootstrap(');
  });
});

describe('the seams no server render can reach are pinned to the source', () => {
  it('closes the client in its cleanup', () => {
    // Without this the socket outlives the component, and StrictMode's
    // simulated remount leaves two of them open in development.
    expect(SOURCE).toContain('return () => client.close();');
  });

  it('opens exactly one client, in one effect', () => {
    expect(SOURCE.match(/create\(\{/g)).toHaveLength(1);
    expect(SOURCE.match(/useEffect\(/g)).toHaveLength(1);
    // Empty dependencies: one stream for the app's lifetime. The bus and the
    // callbacks are read through refs so a caller passing an arrow does not
    // tear the socket down on every render.
    expect(SOURCE).toContain('}, []);');
  });

  it('forwards every frame name that has a producer, warm_progress included', () => {
    expect(SOURCE).toContain("if (event === 'session_changed')");
    expect(SOURCE).toContain("} else if (event === 'session_indexed')");
    // ★ THIS ASSERTED THE OPPOSITE UNTIL TASK 7.4, and deleting it is that
    // commit's job rather than a later one's. The message was "a payload shape
    // for a frame nothing emits is an invention" — true while `warm_progress`
    // was a reserved name with no producer. 7.4 shipped `src/server/warm.ts`,
    // which IS the producer, so the shape became a contract (`WarmProgressFrame`)
    // and the limb below decodes it.
    expect(SOURCE).toContain("} else if (event === 'warm_progress')");
    // The limb PUBLISHES rather than merely matching: a branch that decodes and
    // drops would satisfy the name check above and carry no frame to either page.
    // Source text is the honest instrument here for the reason this file states —
    // no effect runs under `environment: 'node'`, so `create` is never called and
    // the socket, the subscription and this dispatch are all unreachable at
    // runtime. `live.test.ts` carries the behaviour the frames feed.
    expect(SOURCE).toContain("busRef.current.publish({ event, data: data as WarmProgressFrame })");
  });
});

describe('the app builds one bus and one stream, and both pages share them', () => {
  it('builds exactly one of each, at the top of the tree', () => {
    expect(APP.match(/createLiveBus\(\)/g)).toHaveLength(1);
    expect(APP.match(/useLiveStream\(/g)).toHaveLength(1);
    // A page opening its own client would be two sockets for one app, which is
    // what Task 6.1's "ONE stream for the whole app" forbids.
    expect(APP).toContain('const bus = useMemo(() => createLiveBus(), []);');
  });

  it('passes the bus to both pages', () => {
    expect(APP.match(/bus=\{bus\}/g)).toHaveLength(2);
  });
});
