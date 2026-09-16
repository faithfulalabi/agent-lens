// The smoke runner, deliberately separate from `npm test`.
//
// `vitest.config.ts` caps the node project at a 15s `testTimeout`, and a run
// that packs a tarball and launches Chrome would blow through it. So the smoke
// keeps its own config and its own script, and `npm test` collects exactly what
// it collected before plus `src/packaging.test.ts`.
//
// `channel: 'chrome'` drives the machine's installed Chrome. That is how task
// 0.3 bought `playwright-core` at 13.4 MB — by refusing the browser downloads —
// and adding the runner here must not quietly undo it.
//
// The server's life cycle belongs to `scripts/pack-smoke.mjs`, not to this file:
// the thing under test is the copy INSTALLED FROM THE TARBALL inside a
// resolution jail, which nothing in this repo could start on its own.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './smoke',
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env['SMOKE_BASE_URL'],
    channel: 'chrome',
    headless: true,
  },
});
