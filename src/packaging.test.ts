// Task 8.2 — the shipping manifest and the shim, pinned where checking is cheap.
//
// Deliberately fast and hermetic. The tarball-content proof, the resolution jail
// and the browser drive all live in `scripts/pack-smoke.mjs`, OUTSIDE `npm test`:
// the root vitest project caps tests at 15s (`vitest.config.ts` `testTimeout`),
// and a packing, Chrome-launching run inside the default suite would blow
// through it. This file is what makes task 8.4 confirm rather than discover.

import { describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NOT_SHIPPED_DIRS,
  SHIPPED_DIRS,
  SHIPPED_FILES,
  isShipped,
} from '../scripts/release-scope.js';

const REPO_ROOT = join(import.meta.dirname, '..');

function read(...rel: string[]): string {
  return readFileSync(join(REPO_ROOT, ...rel), 'utf8');
}

interface Manifest {
  name: string;
  publishConfig: { access: string };
  version: string;
  repository: { type: string; url: string };
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

describe('the publish metadata names a real release (task 8.4)', () => {
  it('publishes under the founder scope, publicly', () => {
    // npm refused the unscoped `agent-lens` as too similar to `agentlens`.
    expect(MANIFEST.name).toBe('@faithfulalabi/agent-lens');
    expect(MANIFEST.publishConfig).toEqual({ access: 'public' });
  });

  it('carries a release version, not the 0.0.0 placeholder', () => {
    // 0.0.0 is what the manifest was scaffolded with; publishing it would
    // claim the name with a version nobody meant. Since task 8.5 the version
    // moves only through release-please's release PR, and the tag is created by
    // CI when the founder merges that PR — never by hand.
    expect(MANIFEST.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(MANIFEST.version).not.toBe('0.0.0');
  });

  it('points the registry listing at the public repository', () => {
    expect(MANIFEST.repository.type).toBe('git');
    expect(MANIFEST.repository.url).toContain('faithfulalabi/agent-lens');
  });

  it('rebuilds dist before every publish', () => {
    // `dist/` is gitignored and nothing else builds it on the publish path, so
    // without this hook a publish ships whatever `dist/` last happened to hold.
    // `prepublishOnly` never fires on `npm pack`, so `smoke:pack`'s own
    // build-then-pack path is untouched.
    expect(MANIFEST.scripts['prepublishOnly']).toContain('run build');
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

// Task 8.5 — the release pipeline. `scripts/release-scope.ts` is the one
// definition of "shipped"; these tests hold it against the compiler, the
// manifest and the ui build, and pin the workflow shape the release relies on.

describe('the release scope predicate (task 8.5, AC1)', () => {
  it.each([
    'src/cli/index.ts',
    'src/shared/x.ts',
    'ui/src/App.tsx',
    'ui/index.html',
    'ui/package-lock.json',
    'bin/agent-lens.js',
    'README.md',
    'package.json',
    'tsconfig.build.json',
  ])('ships %s', (path) => {
    expect(isShipped(path)).toBe(true);
  });

  it.each([
    'src/search/__tests__/a.test.ts',
    'src/packaging.test.ts',
    'ui/src/lib/__tests__/x.test.tsx',
    'src/dev/server.ts',
    'src/render-gate/index.ts',
    'src/db/__tests__/__snapshots__/s.json',
    '.github/workflows/ci.yml',
    'scripts/pack-smoke.mjs',
    'fixtures/set/manifest.json',
    'smoke/cold-run.spec.ts',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'ui/src/assets/fonts/README.md',
    'vitest.config.ts',
    'ui/vitest.config.ts',
    'eslint.config.js',
    'package-lock.json',
    'internal_docs/x.md',
  ])('does not ship %s', (path) => {
    expect(isShipped(path)).toBe(false);
  });
});

/** JSONC with whole-line `//` comments, as tsconfig.build.json is written. */
function readJsonc<T>(...rel: string[]): T {
  const text = read(...rel)
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  return JSON.parse(text) as T;
}

describe('"what ships" and "what triggers a release" cannot drift (task 8.5, AC2)', () => {
  it('agrees with the compiler on exactly which src files reach dist', () => {
    const tsc = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(REPO_ROOT, 'tsconfig.build.json'),
        '--listFilesOnly',
      ],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(tsc.status).toBe(0);
    const compiled = tsc.stdout
      .split('\n')
      .filter(Boolean)
      .map((file) =>
        file
          .split('\\')
          .join('/')
          .replace(`${REPO_ROOT.split('\\').join('/')}/`, ''),
      )
      .filter((file) => !file.includes('node_modules/'))
      .sort();

    const tracked = spawnSync('git', ['ls-files', 'src'], { encoding: 'utf8', cwd: REPO_ROOT });
    expect(tracked.status).toBe(0);
    const predicted = tracked.stdout
      .split('\n')
      .filter((file) => file.endsWith('.ts') && isShipped(file))
      .sort();

    expect(predicted.length).toBeGreaterThan(0);
    expect(compiled).toEqual(predicted);
  }, 30_000);

  it('maps every manifest `files` root onto shipped inputs, and nothing else', () => {
    const tsconfigNode = readJsonc<{ include: string[] }>('tsconfig.node.json');
    const inputsOf: Record<string, string[]> = {
      bin: ['bin/'],
      dist: tsconfigNode.include.map((dir) => `${dir}/`),
      'ui/dist': ['ui/src/', 'ui/index.html', 'ui/vite.config.ts'],
    };
    expect(Object.keys(inputsOf).sort()).toEqual([...MANIFEST.files].sort());

    const inputs = Object.values(inputsOf).flat();
    for (const input of inputs) {
      const probe = input.endsWith('/') ? `${input}probe.ts` : input;
      expect(`${probe}: ${isShipped(probe)}`).toBe(`${probe}: true`);
    }
    // The reverse direction: no shipped dir the manifest does not account for.
    for (const dir of SHIPPED_DIRS) expect(inputs).toContain(dir);
    for (const file of SHIPPED_FILES.filter((f) => f.startsWith('ui/src/'))) {
      expect(inputs).toContain(file);
    }
  });

  it('covers every vite alias target, so a bundled import cannot sit outside the scope', () => {
    const targets = [...read('ui', 'vite.config.ts').matchAll(/new URL\('([^']+)'/g)].map(
      (m) => m[1]!,
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const repoRel = new URL(target, 'file:///repo/ui/').pathname.replace('/repo/', '');
      const probe = `${repoRel}/probe.ts`;
      expect(`${probe}: ${isShipped(probe)}`).toBe(`${probe}: true`);
    }
  });

  it("excludes exactly the build's non-glob src excludes", () => {
    const build = readJsonc<{ exclude: string[] }>('tsconfig.build.json');
    const srcExcludes = build.exclude
      .filter((entry) => entry.startsWith('src/') && !entry.includes('*'))
      .map((entry) => `${entry}/`)
      .sort();
    expect([...NOT_SHIPPED_DIRS].sort()).toEqual(srcExcludes);
  });

  it('runs under plain node with no tsx and prints its decision', () => {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'release-scope.ts'), '--files', 'src/a.ts', 'src/a.test.ts'],
      { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SHIPPED  src/a.ts');
    expect(result.stdout).toContain('skip  src/a.test.ts');
    expect(result.stdout).toContain('decision: release-eligible');
  });

  it('exits 1, never 2, on a usage error', () => {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'release-scope.ts'), '--nope'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
  });
});

const PR_TITLE_WORKFLOW = read('.github', 'workflows', 'pr-title.yml');
const PR_TITLE_REGEX = new RegExp(/grep -Eq '([^']+)'/.exec(PR_TITLE_WORKFLOW)![1]!);

describe('the PR title is the squash commit release-please reads (task 8.5, AC3)', () => {
  it('checks the title in a job named pr-title, on every title edit', () => {
    expect(PR_TITLE_WORKFLOW).toContain('  pr-title:\n    name: pr-title');
    expect(PR_TITLE_WORKFLOW).toMatch(/types: \[[^\]]*\bedited\b[^\]]*\]/);
    expect(PR_TITLE_WORKFLOW).toContain('TITLE: ${{ github.event.pull_request.title }}');
    // The title reaches the script through env only — never interpolated into `run:`.
    const run = PR_TITLE_WORKFLOW.slice(PR_TITLE_WORKFLOW.indexOf('run: |'));
    expect(run).not.toContain('${{');
  });

  it.each(['fix(search): x', 'feat!: y', 'chore(release): 0.2.0', 'ci(release): automate'])(
    'accepts %s',
    (title) => {
      expect(PR_TITLE_REGEX.test(title)).toBe(true);
    },
  );

  it.each(['Merge pull request #1', 'Update README', 'fix:', 'Fix: capitalised'])(
    'rejects %s',
    (title) => {
      expect(PR_TITLE_REGEX.test(title)).toBe(false);
    },
  );
});

describe('the version comes from release-please, not by hand (task 8.5, AC3)', () => {
  const releaseManifest = JSON.parse(read('.release-please-manifest.json')) as Record<
    string,
    string
  >;

  it('keeps package.json, the lockfile and the release manifest on one version', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(MANIFEST.version).toBe(releaseManifest['.']);
    expect(lock.version).toBe(MANIFEST.version);
    expect(lock.packages['']?.version).toBe(MANIFEST.version);
  });

  it('applies the 0.x bump policy to the root package', () => {
    const config = JSON.parse(read('release-please-config.json')) as Record<string, unknown> & {
      packages: Record<string, Record<string, unknown>>;
    };
    expect(config['release-type']).toBe('node');
    expect(config['include-component-in-tag']).toBe(false);
    expect(config['bump-minor-pre-major']).toBe(true);
    expect(config['bump-patch-for-minor-pre-major']).toBe(false);
    expect(Object.keys(config.packages)).toEqual(['.']);
    expect(config.packages['.']!['package-name']).toBe(MANIFEST.name);
  });
});

const CI_WORKFLOW = read('.github', 'workflows', 'ci.yml');

/** The text of one top-level job in ci.yml, up to the next job key. */
function job(name: string): string {
  const start = CI_WORKFLOW.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = CI_WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('publish ships the smoke-tested tarball from CI over OIDC (task 8.5, AC4-AC8)', () => {
  const JOBS = ['lint', 'test', 'smoke', 'release', 'automerge', 'publish-check', 'publish'];

  it('keeps the required-check job names lint, test and smoke', () => {
    for (const name of ['lint', 'test', 'smoke']) expect(job(name)).toContain(`name: ${name}\n`);
  });

  it('publishes the artifact tarball with provenance, from the one OIDC job', () => {
    const publish = job('publish');
    expect(publish).toContain('id-token: write');
    expect(publish).toContain('environment: npm-publish');
    // The ./ is load-bearing: a bare `pkg/x.tgz` is read as a GitHub owner/repo spec (v0.1.1).
    expect(publish).toContain('npm publish "./$(ls pkg/*.tgz)" --provenance --access public');
    expect(publish).not.toMatch(/npm publish "\$\(ls pkg/);
    // Both OIDC failure modes are silent at npm's default loglevel (first live publish).
    expect(publish).toContain('ACTIONS_ID_TOKEN_REQUEST_URL');
    expect(publish).toContain('--loglevel verbose');
    expect(publish).toContain("if: needs.publish-check.outputs.publish == 'true'");
    expect(publish).toContain('check-latest: true');
    for (const name of JOBS.filter((n) => n !== 'publish')) {
      expect(`${name}: ${job(name).includes('id-token')}`).toBe(`${name}: false`);
      expect(`${name}: ${job(name).includes('environment:')}`).toBe(`${name}: false`);
    }
  });

  it('never rebuilds, reinstalls or re-checks-out on the publish runner', () => {
    const publish = job('publish');
    expect(publish).not.toContain('registry-url');
    expect(publish).not.toContain('npm run build');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('actions/checkout');
  });

  it('gates the chain on green: lint/test/smoke → release → publish-check → publish', () => {
    expect(job('release')).toContain('needs: [lint, test, smoke]');
    expect(job('publish-check')).toContain('needs: [release]');
    expect(job('publish')).toContain('needs: [publish-check]');
  });

  it('keeps the tarball smoke drove and hands it to publish', () => {
    const smoke = job('smoke');
    expect(smoke).toContain('SMOKE_KEEP_TGZ:');
    expect(smoke).toContain('actions/upload-artifact@v4');
    expect(smoke).toContain('name: package-tarball');
    expect(smoke).toContain('overwrite: true');
    expect(read('scripts', 'pack-smoke.mjs')).toContain('process.env.SMOKE_KEEP_TGZ');
  });

  it('decides from facts, idempotently, and heals or alarms on an unpublished release', () => {
    const check = job('publish-check');
    expect(check).toContain("if: always() && needs.release.result == 'success'");
    expect(check).toContain('npm view');
    expect(check).toContain('E404');
    expect(check).toContain('released but unpublished');
    expect(check).toContain('actions/runs?head_sha=');
    // Self-heal: a re-run replays the tagged commit's workflow, so an unpublished tag is
    // published from a later run, but only when no shipped file changed since the tag.
    expect(check).toContain('node scripts/release-scope.ts --base "v$LATEST"');
    expect(check).toContain('[ "$VER" = "$LATEST" ]');
    expect(check).not.toContain('re-run the run for');
    expect(check).not.toContain('release_created');
    expect(job('publish')).not.toContain('release_created');
  });

  it('never lets a newer main push cancel a release or publish in flight', () => {
    expect(CI_WORKFLOW).toContain(
      "group: ci-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
    );
    expect(job('release')).toMatch(/group: release-please\n\s+cancel-in-progress: false/);
    expect(job('publish')).toMatch(/group: npm-publish\n\s+cancel-in-progress: false/);
  });

  it('auto-merges only on opt-in, by squash, and only behind active required checks', () => {
    const automerge = job('automerge');
    expect(automerge).toContain("vars.RELEASE_AUTOMERGE == 'true'");
    expect(automerge).toContain('rules/branches/main');
    expect(automerge).toContain('--squash');
    expect(automerge).not.toContain('--merge');
  });

  it('stores no npm token anywhere under .github', () => {
    const root = join(REPO_ROOT, '.github');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) =>
      /\.(ya?ml|json)$/.test(name),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(`${file}: ${/NPM_TOKEN|NODE_AUTH_TOKEN/.test(text)}`).toBe(`${file}: false`);
    }
  });

  it('pins the main ruleset payload the founder applies', () => {
    const ruleset = JSON.parse(read('.github', 'ruleset-main.json')) as {
      enforcement: string;
      bypass_actors: unknown[];
      conditions: { ref_name: { include: string[] } };
      rules: { type: string; parameters?: Record<string, unknown> }[];
    };
    const rule = (type: string) => ruleset.rules.find((r) => r.type === type)?.parameters;
    expect(ruleset.enforcement).toBe('active');
    expect(ruleset.bypass_actors).toEqual([]);
    expect(ruleset.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH']);
    expect(rule('pull_request')?.['allowed_merge_methods']).toEqual(['squash']);
    const checks = rule('required_status_checks')!;
    expect(checks['strict_required_status_checks_policy']).toBe(false);
    expect(checks['required_status_checks']).toEqual([
      { context: 'lint' },
      { context: 'test' },
      { context: 'smoke' },
      { context: 'pr-title' },
    ]);
  });
});
