import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { useAsync } from '../use-async';
import { makePage, makeSession, stubApiClient } from './fixtures';

/*
 * AC1 (hook half) — Test 2 of the task plan.
 *
 * Two things are provable here and a third is not, and the split is stated
 * rather than papered over:
 *
 *   - PROVABLE: the module imports and the hook renders under
 *     `environment: 'node'`. That is what catches a module-scope
 *     `createApiClient()` / `readBootstrap()` creeping in later — the bootstrap
 *     reader throws outside a browser, which would take down every suite that
 *     transitively imports this hook rather than just this one.
 *   - PROVABLE: the pending state is what the first render shows.
 *   - NOT PROVABLE: the fetch itself. `renderToStaticMarkup` never runs an
 *     effect, so there is no behavioural instrument for the dependency array or
 *     the ref-minted id at all. Those two are pinned against the source text
 *     instead — the same honest instrument `router.test.ts` uses for the
 *     default port's `window` binding. `async-state.test.ts` carries the
 *     behavioural proof of what those ids buy.
 */

const MODULE_PATH = fileURLToPath(new URL('../use-async.ts', import.meta.url));
const SOURCE = readFileSync(MODULE_PATH, 'utf8');

function Probe() {
  const api = stubApiClient({
    listSessions: () => Promise.resolve(makePage([makeSession()])),
  });
  const state = useAsync('sessions:3d', (signal) => api.listSessions({}, { signal }));
  return <span>{state.kind}</span>;
}

describe('useAsync is safe to import and render without a DOM', () => {
  it('renders the pending state on the first pass', () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>loading</span>');
  });

  it('builds no client and reads no bootstrap at module scope', () => {
    expect(SOURCE).not.toMatch(/^(let|var)\s/m);
    expect(SOURCE, 'a module-scope client would throw at import time').not.toContain(
      'createApiClient(',
    );
    expect(SOURCE).not.toContain('readBootstrap(');
  });
});

describe('the two seams no server render can reach are pinned to the source', () => {
  it('keys the effect on the refresh token as well as the key', () => {
    expect(
      SOURCE,
      'with `[key]` alone the same key could never fetch again, and Task 6.2 ' +
        'would have no way to invalidate what this hook is holding.',
    ).toContain('}, [key, refreshToken]);');
  });

  it('mints the request id from a ref inside the effect', () => {
    expect(
      SOURCE,
      'deriving the id from the slot the current render can see deadlocks ' +
        'under StrictMode — see async-state.ts. It must come from a ref.',
    ).toContain('const requestId = ++idRef.current;');
    expect(SOURCE).toContain("dispatch({ type: 'start', requestId });");
  });
});
