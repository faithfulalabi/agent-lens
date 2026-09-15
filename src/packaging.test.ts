// Task 8.2 — the shipping manifest and the shim, pinned where checking is cheap.
//
// Deliberately fast and hermetic. The tarball-content proof, the resolution jail
// and the browser drive all live in `scripts/pack-smoke.mjs`, OUTSIDE `npm test`:
// the root vitest project sets no `testTimeout` (`vitest.config.ts`), and a
// packing, Chrome-launching run inside the default suite would feed that gap
// directly. This file is what makes task 8.4 confirm rather than discover.

import { describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = join(import.meta.dirname, '..');

function read(...rel: string[]): string {
  return readFileSync(join(REPO_ROOT, ...rel), 'utf8');
}

interface Manifest {
  files: string[];
  engines: Record<string, string>;
  bin: Record<string, string>;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  license: string;
}

const MANIFEST = JSON.parse(read('package.json')) as Manifest;
const BIN_PATH = join(REPO_ROOT, 'bin', 'agent-lens.js');
const BIN_SOURCE = read('bin', 'agent-lens.js');
const PW_CONFIG_SOURCE = read('playwright.config.ts');

/** Every non-test `.ts` under a directory, the `render-gate.test.ts:51` idiom. */
function sourcesUnder(dir: string): { file: string; text: string }[] {
  const root = join(REPO_ROOT, dir);
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((name) => name.split('\\').join('/'))
    .filter((name) => name.endsWith('.ts') && !name.includes('__tests__/'))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
}

describe('the published manifest is exactly the shipping shape (AC1, AC2)', () => {
  it('whitelists only bin, dist and ui/dist', () => {
    expect([...MANIFEST.files].sort()).toEqual(['bin', 'dist', 'ui/dist']);
  });

  it('declares the node:sqlite / zstd engine floor', () => {
    expect(MANIFEST.engines['node']).toBe('>=24');
  });

  it('maps the agent-lens bin at the shim', () => {
    expect(MANIFEST.bin).toEqual({ 'agent-lens': 'bin/agent-lens.js' });
  });

  it('ships no postinstall, because ui/package.json is not in the tarball', () => {
    // `postinstall` runs in every CONSUMER's install; `prepare` runs only on a
    // local install and before pack/publish. Same ergonomics here, zero surface
    // there — and the directory it prefixes does not exist in the tarball at all.
    expect(MANIFEST.scripts['postinstall']).toBeUndefined();
    expect(MANIFEST.scripts['prepare']).toBe('npm --prefix ui install');
  });

  it('builds from a clean dist through the build-only tsconfig', () => {
    // `tsc` never removes orphaned outputs and `dist/` is gitignored, so without
    // the `rm -rf` a deleted module keeps packing forever. Measured before this
    // task: 81 orphaned `capture/` files and 5 modules task 4.5 deleted.
    expect(MANIFEST.scripts['build']).toContain('rm -rf dist');
    expect(MANIFEST.scripts['build']).toContain('tsconfig.build.json');
  });
});

describe('bin/agent-lens.js resolves the built CLI in-process (AC2)', () => {
  it('imports the compiled entry and names neither tsx nor the source tree', () => {
    expect(BIN_SOURCE).toContain('../dist/src/cli/index.js');
    expect(BIN_SOURCE).not.toContain('tsx');
    // Not a bare `src/cli` pin: the BUILT path nests that substring
    // (`dist/src/cli/index.js`), because `tsconfig.node.json`'s `rootDir: "."`
    // is load-bearing for `resolveUiDir` (`static-serving.test.ts:194-195`).
    // What must be gone is any reach back into the repo's own source tree.
    expect(BIN_SOURCE).not.toMatch(/['"`]\.\.\/src\//);
    // No import specifier resolving a TypeScript entry, which is the other half
    // of "no tsx": the shim must never need a transpiler to start.
    expect(BIN_SOURCE).not.toMatch(/\.ts['"`]/);
  });

  it('calls main() in-process rather than spawning', () => {
    // The recorded signal-forwarding defect: `start-signals.test.ts:7-12` records
    // that the old `spawnSync` shim plus a tsx fork made a three-process chain,
    // so `child.kill()` on the top pid reached only the shim. In-process means
    // SIGTERM lands on the handlers `commands/start.ts` registers — which is the
    // only reason the smoke can drive `bin/` and observe `{code: 0, signal: null}`.
    expect(BIN_SOURCE).not.toContain('spawnSync');
    expect(BIN_SOURCE).not.toContain('spawn(');
    expect(BIN_SOURCE).toContain('main(');
    // `process.exitCode`, not `process.exit()`: the latter truncates piped stdout.
    expect(BIN_SOURCE).toContain('process.exitCode');
    expect(BIN_SOURCE).not.toMatch(/process\.exit\(/);
  });
});

describe('the engine floor is enforced at runtime, not merely declared (AC1)', () => {
  // npm's `engine-strict` defaults to FALSE, so `engines` alone is an EBADENGINE
  // warning that installs anyway. Without this guard a Node 22 user's first run
  // dies on `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` from deep inside the DB
  // layer. The guard must therefore precede the `dist/` import, which is exactly
  // what this test observes: a sentence, and no module resolution at all.
  const runWithNodeVersion = (version: string): SpawnSyncReturns<string> =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)}, configurable: true });\n` +
          `await import(${JSON.stringify(pathToFileURL(BIN_PATH).href)});`,
      ],
      { encoding: 'utf8' },
    );

  it('refuses a sub-24 Node with one sentence and a non-zero exit', () => {
    const result = runWithNodeVersion('22.11.0');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Node 24');
    expect(result.stderr).toContain('22.11.0');
    // A sentence, not a stack trace — and specifically not the failure the guard
    // exists to pre-empt.
    expect(result.stderr).not.toContain('ERR_UNKNOWN_BUILTIN_MODULE');
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('reads the running Node major rather than hard-coding a pass', () => {
    // Mutation control for the test above: if the guard were an unconditional
    // `exit(1)` the smoke could never boot, and if it were unconditional pass the
    // test above would be vacuous. A 23.x Node is refused, a 24.x one is not.
    expect(runWithNodeVersion('23.11.0').status).not.toBe(0);
    expect(runWithNodeVersion('24.0.0').stderr).not.toContain('Node 24 or newer');
  });
});

describe('one Playwright driver, two entry points (AC3)', () => {
  it('keeps playwright-core as the render gate driver', () => {
    const gate = sourcesUnder('src/render-gate');
    expect(gate.length).toBeGreaterThan(0);
    expect(gate.filter((s) => s.text.includes('playwright-core')).length).toBeGreaterThan(0);
    for (const { file, text } of gate) {
      expect(`${file}: ${text.includes('@playwright/test')}`).toBe(`${file}: false`);
    }
  });

  it('keeps @playwright/test to the smoke, which never touches the core driver', () => {
    const smoke = sourcesUnder('smoke');
    expect(smoke.length).toBeGreaterThan(0);
    for (const { file, text } of smoke) {
      expect(`${file}: ${text.includes('@playwright/test')}`).toBe(`${file}: true`);
      expect(`${file}: ${text.includes('playwright-core')}`).toBe(`${file}: false`);
    }
  });

  it('drives the machine Chrome and downloads no browser', () => {
    // Task 0.3 bought `playwright-core` at 13.4 MB precisely by refusing the
    // browser downloads. `channel: 'chrome'` keeps that; a `webServer` block
    // would also re-introduce a second way to boot the app.
    expect(PW_CONFIG_SOURCE).toContain(`channel: 'chrome'`);
    expect(PW_CONFIG_SOURCE).not.toContain('webServer');
    expect(MANIFEST.devDependencies['@playwright/test']).toBe('^1.62.1');
    expect(MANIFEST.devDependencies['playwright-core']).toBe('^1.62.1');
    expect(MANIFEST.scripts['smoke:pack']).not.toContain('playwright install');
  });

  it('resolves exactly one playwright-core copy', () => {
    // The dedupe question, asked of the lockfile because that is where a second
    // hoisted copy would appear as a second install path.
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string }>;
    };
    const installs = Object.entries(lock.packages).filter(([path]) =>
      path.endsWith('node_modules/playwright-core'),
    );

    expect(installs.map(([path]) => path)).toEqual(['node_modules/playwright-core']);

    const onDisk = JSON.parse(read('node_modules', 'playwright-core', 'package.json')) as {
      version: string;
    };
    expect(onDisk.version).toBe(installs[0]![1].version);
  });
});

describe('the MIT license is on record and consistent (task 1.1)', () => {
  it('ships the standard MIT text at the repo root', () => {
    const license = read('LICENSE');
    expect(license).toContain('MIT License');
    expect(license).toContain('Permission is hereby granted, free of charge');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('names the founder as copyright holder, year 2026', () => {
    expect(read('LICENSE')).toContain('Copyright (c) 2026 Faithful Alabi');
  });

  it('keeps the declared license field in agreement with the text', () => {
    expect(MANIFEST.license).toBe('MIT');
  });
});

describe('the smoke abstains from port 4470 (AC4)', () => {
  it('never names the default port', () => {
    // `dev-server.test.ts:194`'s idiom. 4470 is `DEFAULT_PORT` and `port.test.ts:39`
    // deliberately BINDS it in a parallel worker to prove auto-increment. A
    // `--port 0` smoke never touches it, so asserting it is free would be
    // vacuous — and a check that bound it would race that test on EADDRINUSE.
    const sources = [
      read('scripts', 'pack-smoke.mjs'),
      ...sourcesUnder('smoke').map((s) => s.text),
    ];
    for (const text of sources) expect(text).not.toContain('4470');
  });
});
