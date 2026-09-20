// Kept out of `fixtures.ts` on purpose: `scripts/pack-smoke.mjs` loads that
// module (through the corpus and db fixtures) outside a vitest run, where
// importing `vitest` throws.

import { it } from 'vitest';

/** `it` for the real-corpus sweeps: skipped unless `AGENT_LENS_REAL_CORPUS=1`. */
export const runIt: typeof it.skip = process.env['AGENT_LENS_REAL_CORPUS'] === '1' ? it : it.skip;
