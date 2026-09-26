// Task 8.2 — the sandboxed cold-run harness. `npm run smoke:pack`.
//
// Builds, packs, installs the tarball into a resolution jail, boots THAT install,
// drives it with Playwright, and asserts the teardown. It never skips: the rule
// `ui/src/__tests__/build-ui.ts` states — "an acceptance criterion that skips
// itself is worse than no test at all" — applies here more than anywhere.
//
// ★ WHAT THIS IS, EXACTLY. A sandboxed approximation of a clean machine, not a
// clean machine. It proves: no repo checkout on the resolution path, no compile
// step, no repo `node_modules` reachable by Node's resolver, an isolated HOME and
// npm cache. It does NOT prove: a different OS or arch, a different Node build,
// a cold upstream registry, or a machine with no Homebrew Node. The real cold run
// against the public registry is task 8.4's, and nothing here may claim it.
//
// The isolation is PROVED rather than asserted. Node's resolver only consults
// `node_modules` in ANCESTOR directories of the importing file, so a walk from
// the jail to `/` that finds none makes a repo-resident or hoisted copy
// unreachable by construction. `mutationControl` plants one and confirms the walk
// aborts, which is what makes the walk a detector instead of a comment.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/server/config.js';
import { SLUG, sessionRecords, writeSession } from '../src/corpus/__tests__/fixtures.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Generous: a cold npm install plus a bind. Never a sleep an assertion rests on. */
const READY_TIMEOUT_MS = 120_000;

/** npm's force-included paths. `files` cannot exclude them; measured in the dry run. */
const MANDATORY = new Set(['package.json', 'README.md', 'LICENSE']);
const WHITELIST = ['bin/', 'dist/', 'ui/dist/'];

let step = 0;
function heading(text) {
  step += 1;
  console.log(`\n── ${step}. ${text}`);
}

function ok(text) {
  console.log(`   ok  ${text}`);
}

/** Run to completion with the repo's own environment, failing loudly. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: REPO_ROOT, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`);
  }
}

/**
 * The child's environment, with every inherited npm and Node hook removed.
 *
 * Stripping `npm_*` is load-bearing, not hygiene: this script runs under
 * `npm run`, which exports `npm_config_local_prefix` and friends pointing at the
 * REPO. Inheriting those would aim the jailed install straight back at the tree
 * the jail exists to escape.
 */
function jailedEnv(jail, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('npm_') || key.startsWith('NPM_') || key.startsWith('NODE_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: join(jail, 'home'),
    npm_config_cache: join(jail, 'cache'),
    npm_config_userconfig: join(jail, 'npmrc'),
    ...extra,
  };
}

/** Every directory from `from` to the filesystem root, inclusive. */
function ancestors(from) {
  const chain = [];
  let dir = from;
  for (;;) {
    chain.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return chain;
    dir = parent;
  }
}

/**
 * Abort unless no directory on `from`'s resolution path holds a `node_modules`.
 *
 * Throwing rather than returning a boolean is what `mutationControl` exercises:
 * the control has to observe the ABORT, not merely a false.
 */
function requireIsolation(from) {
  const offenders = ancestors(from).filter((dir) => existsSync(join(dir, 'node_modules')));
  if (offenders.length > 0) {
    throw new Error(
      `resolution jail breached: node_modules reachable from ${from} at ${offenders.join(', ')}`,
    );
  }
}

/** Plant a `node_modules` above the jail and require the walk to abort on it. */
function mutationControl(jail) {
  const planted = join(jail, 'node_modules');
  mkdirSync(planted);
  let raised = null;
  try {
    requireIsolation(join(jail, 'app'));
  } catch (err) {
    raised = err;
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }

  if (raised === null) {
    throw new Error(
      'mutation control did not fire: the isolation walk is not a detector, so every ' +
        'isolation claim below it is unfounded',
    );
  }
  assert.match(raised.message, /resolution jail breached/);
  assert.ok(raised.message.includes(jail), 'the walk must name the directory it found');
}

/** Parse `npm pack --json`, which prefixes its array with npm's own notices. */
function packJson(stdout) {
  const start = stdout.indexOf('[');
  assert.notEqual(start, -1, `npm pack produced no JSON:\n${stdout}`);
  return JSON.parse(stdout.slice(start));
}

function everyFileUnder(root) {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isFile());
}

async function main() {
  heading('build a clean dist');
  // `rm -rf dist` lives in the build script itself. Without it `tsc` leaves
  // orphans forever: measured before this task, 81 files for a `capture/` module
  // `src/layout.test.ts` asserts must not exist, plus five modules task 4.5
  // deleted, all packing from an Aug-12 build.
  run('npm', ['run', 'build']);

  const jail = realpathSync(mkdtempSync(join(tmpdir(), 'agent-lens-pack-')));
  try {
    await smoke(jail);
  } finally {
    rmSync(jail, { recursive: true, force: true });
  }
}

function smoke(jail) {
  const app = join(jail, 'app');
  const dataDir = join(jail, 'data');

  heading('build the jail and prove it is isolated');
  for (const dir of ['home', 'app', 'cache', 'tgz', 'data', 'corpus']) {
    mkdirSync(join(jail, dir), { recursive: true });
  }
  writeFileSync(join(jail, 'npmrc'), '');
  writeFileSync(
    join(app, 'package.json'),
    `${JSON.stringify({ name: 'agent-lens-jail', private: true, version: '0.0.0' }, null, 2)}\n`,
  );

  assert.ok(
    relative(REPO_ROOT, jail).startsWith('..'),
    `the jail must sit outside the repo; got ${jail}`,
  );
  requireIsolation(app);
  mutationControl(jail);
  ok(`no node_modules on the path from ${app} to /, and the walk aborts when one appears`);

  heading('pack the tarball');
  const packed = spawnSync(
    'npm',
    ['pack', '--pack-destination', join(jail, 'tgz'), '--ignore-scripts', '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}`);
  const [manifest] = packJson(packed.stdout);
  console.log(
    `   ${manifest.entryCount} files, ${manifest.size} B packed / ${manifest.unpackedSize} B unpacked`,
  );

  heading('the tarball carries nothing outside the whitelist');
  const paths = manifest.files.map((file) => file.path);
  const strays = paths.filter(
    (path) => !MANDATORY.has(path) && !WHITELIST.some((prefix) => path.startsWith(prefix)),
  );
  assert.deepEqual(strays, [], "paths outside bin/dist/ui/dist and npm's mandatory set");

  const forbidden = [
    [
      /internal_docs|(^|\/)fixtures\/|experiments|\.render-gate|\.agent-lens-dev/,
      'repo-only trees',
    ],
    [/\.jsonl$/, 'transcripts'],
    [/__tests__|\.test\.[cm]?js$/, 'compiled tests'],
    [/\.map$/, 'source maps'],
    [/^dist\/src\/(dev|render-gate|capture)\//, 'devDependency importers and orphans'],
  ];
  for (const [pattern, label] of forbidden) {
    assert.deepEqual(
      paths.filter((path) => pattern.test(path)),
      [],
      `packed ${label}`,
    );
  }
  ok(`${paths.length} paths, all inside the whitelist`);

  heading('install the tarball into the jail');
  const tarballs = readdirSync(join(jail, 'tgz')).filter((name) => name.endsWith('.tgz'));
  assert.deepEqual(tarballs.length, 1, `expected one tarball, got ${tarballs.join(', ')}`);
  const tgz = join(jail, 'tgz', tarballs[0]);
  // Scripts are NOT ignored here: an install that runs the consumer's lifecycle
  // is the only thing that proves the old `postinstall` — which prefixed a
  // directory the tarball does not contain — is really gone.
  run('npm', ['install', tgz, '--no-audit', '--no-fund'], { cwd: app, env: jailedEnv(jail) });

  const installed = join(app, 'node_modules', '@faithfulalabi', 'agent-lens');
  requireIsolation(jail);
  ok('the install added no node_modules above the jail');

  heading('the installed tree leaks no home path');
  // Buffers, not utf8 strings: fonts and any future binary asset are scanned on
  // the same terms as source. Before this task two compiled test files carried a
  // literal `/Users/<name>`, and a doc comment in `corpus/paths` carried an
  // example one — the build now drops tests and comments alike.
  const files = everyFileUnder(installed);
  const needles = ['/Users/', '/home/', homedir()].map((text) => Buffer.from(text));
  const leaks = files.filter((path) => {
    const body = readFileSync(path);
    return needles.some((needle) => body.includes(needle));
  });
  assert.deepEqual(
    leaks.map((path) => relative(installed, path)),
    [],
    'files carrying a literal home path',
  );
  ok(`${files.length} installed files, none naming a home directory`);

  heading('lay down a synthetic archive');
  // The generator is imported, never re-written: `src/corpus/__tests__/fixtures.ts`
  // already owns the transcript shape. Only the Sandbox's roots are re-pointed at
  // the jail, so nothing here can reach the developer's real archive.
  const sandbox = {
    root: jail,
    sourceRoot: join(jail, 'corpus'),
    dataDir,
    archiveRoot: join(dataDir, 'archive'),
  };
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) {
    // Inside the session list's default range, so the drive needs no widening.
    const started = new Date(now - (i + 1) * 60_000).toISOString();
    const ended = new Date(now - (i + 1) * 60_000 + 1_000).toISOString();
    writeSession(sandbox, `smoke-session-${i}`, sessionRecords(`call-${i}`, started, ended), SLUG);
  }
  ok(`3 sessions under ${join(sandbox.archiveRoot, SLUG)}`);

  return boot({ jail, app, dataDir });
}

async function boot({ jail, app, dataDir }) {
  heading('boot the installed CLI with zero configuration');
  const binPath = join(app, 'node_modules', '.bin', 'agent-lens');
  assert.ok(existsSync(binPath), `npm linked no bin at ${binPath}`);

  // The .bin link is spawned directly, shebang and exec bit included: that is the
  // surface `npx agent-lens` actually uses, and running it through `node` instead
  // would quietly skip both.
  const child = spawn(binPath, ['start', '--port', '0'], {
    cwd: app,
    env: jailedEnv(jail, {
      AGENT_LENS_DIR: dataDir,
      AGENT_LENS_TRANSCRIPT_ROOT: join(jail, 'corpus'),
    }),
  });

  let err = '';
  let out = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (err += chunk));

  // Registered before the wait, so a child that dies during boot rejects the
  // handshake instead of hanging until the timeout.
  const exit = new Promise((resolveExit) => {
    child.on('close', (code, signal) => resolveExit({ code, signal }));
  });

  try {
    const port = await Promise.race([
      new Promise((resolvePort, rejectPort) => {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          out += chunk;
          const match = /agent-lens listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
          if (match) resolvePort(Number(match[1]));
        });
        void exit.then(() =>
          rejectPort(new Error(`the installed CLI exited before readiness\n${out}\n${err}`)),
        );
      }),
      new Promise((_, rejectPort) =>
        setTimeout(
          () =>
            rejectPort(new Error(`no readiness line in ${READY_TIMEOUT_MS} ms\n${out}\n${err}`)),
          READY_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
    ok(`listening on 127.0.0.1:${port} — no settings edit, no consent prompt, no compile step`);

    heading('drive the four screens');
    run('npm', ['run', 'smoke:ui'], {
      env: { ...process.env, SMOKE_BASE_URL: `http://127.0.0.1:${port}` },
    });

    heading('teardown leaves nothing behind');
    child.kill('SIGTERM');
    // One deep-equal, because the failure modes are not independent: `signal:
    // null` is task 0.4's discriminator that the process exited through its own
    // handler, and a stale `config.json` is the visible wreckage it left if not.
    assert.deepEqual(await exit, { code: 0, signal: null });
    assert.equal(readConfig(dataDir), null, 'config.json survived the shutdown');
    await rebindable(port);
    ok(`exit {code: 0, signal: null}, no config.json, and ${port} re-binds immediately`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  console.log('\nPASS — sandboxed cold run. NOT a clean machine: see the header, and task 8.4.\n');
}

/** Positive proof the socket was released, rather than absence of evidence. */
function rebindable(port) {
  return new Promise((resolveBind, rejectBind) => {
    const server = createServer();
    server.once('error', (cause) =>
      rejectBind(new Error(`port ${port} was not released: ${cause.message}`)),
    );
    server.listen(port, '127.0.0.1', () => server.close(() => resolveBind()));
  });
}

await main();
