// Kept out of `fixtures.ts` on purpose: `scripts/pack-smoke.mjs` loads that
// module (through `src/corpus/__tests__/fixtures.ts`) outside a vitest run, where
// importing `vitest` throws.

import { afterEach } from 'vitest';
import { cleanup, makeSandbox, type Sandbox } from './fixtures.js';

/**
 * One sandbox per test, made on first use and removed after it. Call once at a
 * file's top level; the returned getter is the file's `sb()`.
 */
export function useSandbox(): () => Sandbox {
  let sandbox: Sandbox | undefined;
  afterEach(() => {
    if (sandbox) cleanup(sandbox);
    sandbox = undefined;
  });
  return () => (sandbox ??= makeSandbox());
}
