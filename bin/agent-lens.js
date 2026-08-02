#!/usr/bin/env node
// Dev shim: run the TypeScript CLI directly via tsx so `node ./bin` works from a
// fresh clone with no build step. A built `dist/cli/index.js` supersedes this
// in the published package (wired in a later task).
//
// When you repoint this at `dist/` (Task 8.4): the UI is already safe. It is
// located by `resolveUiDir` in src/server/static-ui.ts, which walks up to the
// nearest `package.json` instead of using a fixed relative path — precisely
// because `dist/src/server/` sits one directory deeper than `src/server/`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, '../src/cli/index.ts');
const tsxBin = resolve(here, '../node_modules/.bin/tsx');

const result = spawnSync(tsxBin, [cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
