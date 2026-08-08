// `npm run dev` — one command, two servers, one process: the REAL collector on
// an ephemeral port, plus `ui/`'s own Vite dev server proxying `/api` at it.
//
// Why this exists: three real defects survived 1,225 green tests and four
// adversarial review rounds because they were only visible on screen. Looking at
// the real screen with real data used to cost a throwaway `preview.local.ts`
// that staged empty files, rewrote them mid-tail to fake append-growth, and
// squatted the default port — which reds `src/server/__tests__/port.test.ts`.
// `firstSight: 'backfill'` deletes the dance; `port: 0` deletes the collision.
//
// Two properties this module must keep:
//
//  1. **Zero write-capable `node:fs` calls.** It reads `~/.claude/projects` and
//     it reads `<dataDir>/config.json`; every write on the path belongs to
//     `startServer` (`mkdirSync(dataDir)`) or the tailer's offset commits.
//     `src/fs-write-sites.test.ts` pins that repo-wide.
//  2. **The token never leaves the process except into the served HTML.** Not
//     `process.env` (Vite inlines every `VITE_`-prefixed variable into client
//     JS), not a query param, not a cookie, not `localStorage`.
//
// `startDevServer` is an exported function and the CLI body runs only when this
// module IS the entry point, so importing it from a test boots nothing.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readToken } from '../shared/index.js';
import { resolveTranscriptRoot } from '../capture/tailer.js';
import { readConfig, type RuntimeConfig } from '../server/config.js';
import { resolveUiDir } from '../server/static-ui.js';
import { startServer } from '../server/start.js';
import { devBootstrapPlugin } from './bootstrap-plugin.js';

/** Knobs for {@link startDevServer}. Every one is defaulted for the CLI. */
export interface DevServerOptions {
  /** Dev data dir; defaults to `$AGENT_LENS_DEV_DIR` then `<repo>/.agent-lens-dev`. */
  dataDir?: string;
  /** Transcript root; defaults to {@link defaultTranscriptRoot}. */
  transcriptRoot?: string;
  /**
   * Project slug directories to tail, or `'all'` for the whole root. Defaults to
   * the slug of `process.cwd()`.
   */
  projects?: readonly string[] | 'all';
  /** The Vite project root; defaults to `<repo>/ui`. */
  uiDir?: string;
  /** Tail period in ms; defaults to 1000. */
  tailIntervalMs?: number;
}

/** A running dev stack: the collector, the Vite server, and one `close()`. */
export interface DevServerHandle {
  collectorPort: number;
  viteUrl: string;
  dataDir: string;
  close: () => Promise<void>;
}

const CONFIG_FILE = 'config.json';

/**
 * The `~/.claude/projects` slug for a working directory.
 *
 * Measured, not guessed: `~/.claude.json`'s `projects` object is keyed by real
 * absolute paths, so its key set is a ground-truth path→slug mapping. This form
 * reproduces 11 of 11 slug directories that exist on this machine;
 * `cwd.split(sep).join('-')` reproduces 10, failing on
 * `/Users/…/Personal_Finance/personal_finance_kpi_project` — **underscores
 * become hyphens too**, which only the character-class rule gets right.
 *
 * All slug-encoding knowledge lives here and nowhere else: `TailOptions.projects`
 * is a plain list of directory names. The existence guard in `startDevServer` is
 * the backstop for any character class these 13 paths do not cover.
 */
export function slugFor(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The real corpus root, resolved through the tailer's own seam. */
export function defaultTranscriptRoot(): string {
  return resolveTranscriptRoot();
}

/**
 * `file://` URL of `ui/`'s Vite **ESM** entry.
 *
 * No `vite` entry is added to the root `package.json`, deliberately: the root has
 * no `workspaces` key and `postinstall: npm --prefix ui install` reifies
 * `ui/node_modules` as a separate install root, so a root dependency cannot
 * dedupe — it would just drop the root's transitive vite (7.x, via vitest) to
 * 5.x and move the whole suite onto it.
 *
 * `require.resolve('vite', …)` is NOT usable here: vite 5's `exports["."]` has a
 * `require` condition, so it lands on `index.cjs`, whose ESM namespace is only
 * `['default','defineConfig','module.exports']` — `createServer` is `undefined`,
 * because that file assigns exports inside a `forEach` loop cjs-module-lexer
 * cannot see. Deep paths are not exported either (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
 * `"./package.json"` is exported by every published `vite@^5`, and every one of
 * them maps `exports["."].import.default` to `./dist/node/index.js`, so
 * resolving the manifest and joining that constant is the one form that works.
 */
export function resolveUiViteEsm(uiDir: string): string {
  const install = 'run `npm install` (postinstall installs `ui/`)';
  let manifest: string;
  try {
    manifest = createRequire(import.meta.url).resolve('vite/package.json', { paths: [uiDir] });
  } catch {
    throw new Error(`agent-lens dev: vite is not installed under ${uiDir} — ${install}`);
  }
  const esm = join(dirname(manifest), 'dist', 'node', 'index.js');
  // A drifted join surfaces as a bare ERR_MODULE_NOT_FOUND on a file:// URL from
  // deep inside `await import()`; this turns it into the same actionable line.
  if (!existsSync(esm)) {
    throw new Error(`agent-lens dev: vite ESM entry missing at ${esm} — ${install}`);
  }
  return pathToFileURL(esm).href;
}

/**
 * Boot the collector and the Vite dev server, in that order.
 *
 * Rejects — without leaving anything running — when another live dev server owns
 * `dataDir`, when a requested slug does not exist under the transcript root, or
 * when Vite fails to boot.
 */
export async function startDevServer(
  options: DevServerOptions = {},
): Promise<DevServerHandle> {
  const dataDir =
    options.dataDir ?? process.env.AGENT_LENS_DEV_DIR ?? join(repoRoot(), '.agent-lens-dev');
  refuseIfOwned(dataDir);

  const transcriptRoot = options.transcriptRoot ?? defaultTranscriptRoot();
  const projects =
    options.projects === 'all' ? undefined : (options.projects ?? [slugFor(process.cwd())]);
  requireSlugsExist(transcriptRoot, projects);

  const uiDir = options.uiDir ?? join(repoRoot(), 'ui');
  const { files, bytes } = measureCorpus(transcriptRoot, projects);
  const scope = projects === undefined ? 'all projects' : projects.join(', ');
  // Printed BEFORE `startServer`, not before `createServer`: the catch-up tail
  // pass runs inside `startServer` and *before the socket binds*, so a line
  // printed afterwards leaves the user watching an unexplained hang.
  console.log(
    `agent-lens dev: backfilling ${files} file(s) / ${mib(bytes)} MiB ` +
      `from ${transcriptRoot} (${scope})…`,
  );

  const handle = await startServer({
    port: 0,
    dataDir,
    transcriptRoot,
    firstSight: 'backfill',
    projects,
    // Every historical session is long-silent, so the first sweep tick would
    // flip all of them to `interrupted` — the render gate would be looking at an
    // artifact of its own tooling. `preview.local.ts` reasoned the same way.
    sweepIntervalMs: 0,
    // Left undefined on purpose: `startServer` already defaults it to
    // `DEFAULT_TAIL_INTERVAL_MS`, and a second spelling of 1000 here would be a
    // constant to keep in sync for nothing.
    tailIntervalMs: options.tailIntervalMs,
  });

  // By here a socket is bound, SQLite is open and a tail timer is armed. Every
  // line below can throw — vite missing, an unloadable `configFile`, a bind
  // failure — and without this catch the collector is stranded exactly the way
  // the abandoned preview server was.
  try {
    const token = readToken(dataDir)!;
    const { createServer } = await import(resolveUiViteEsm(uiDir));
    const vite = await createServer({
      // `configFile` does NOT set the root — vite falls back to `process.cwd()`,
      // which is the repo root when this runs as a command.
      root: uiDir,
      configFile: join(uiDir, 'vite.config.ts'),
      plugins: [devBootstrapPlugin(token)],
      server: {
        proxy: {
          '/api': {
            target: `http://127.0.0.1:${handle.port}`,
            changeOrigin: true,
            // Both are no-ops on vite 5 (each is falsy-guarded before it reaches
            // `setTimeout`, and vite merges no defaults in), kept to pin intent:
            // an SSE stream must never be timed out. The UI's SSE client treats a
            // body that simply ends as a reconnect, so a proxy timeout would
            // present as a silent reconnect loop rather than an error.
            timeout: 0,
            proxyTimeout: 0,
          },
        },
      },
    });
    await vite.listen();
    const viteUrl = resolvedViteUrl(vite);
    return {
      collectorPort: handle.port,
      viteUrl,
      dataDir,
      close: async () => {
        await vite.close();
        await handle.close();
      },
    };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

// --- Guards ----------------------------------------------------------------

/**
 * Refuse to start when a live process already owns this dev data dir.
 *
 * `port: 0` prevents a *port* collision; it does nothing about two SQLite
 * connections and two live tail timers on one persistent `dataDir`. `writeConfig`
 * already records `{ port, pid }` and a clean `close()` removes the file, so the
 * liveness protocol comes for free — this only ever reads it.
 */
function refuseIfOwned(dataDir: string): void {
  const configPath = join(dataDir, CONFIG_FILE);
  let prior: RuntimeConfig | null;
  try {
    prior = readConfig(dataDir);
  } catch (err) {
    // `readConfig` returns null only on ENOENT and rethrows everything else, and
    // `writeConfig` writes 0600 — so a file left by another uid would otherwise
    // surface as a raw EACCES stack instead of something actionable.
    throw new Error(
      `agent-lens dev: cannot read ${configPath} (${String(err)}). ` +
        remediation(configPath),
    );
  }
  if (prior !== null && pidIsLive(prior.pid)) {
    throw new Error(
      `agent-lens dev: pid ${prior.pid} is already running a dev server on port ` +
        `${prior.port} against ${dataDir}. ${remediation(configPath, prior.pid)}`,
    );
  }
}

/** The two ways out, named identically wherever the guard gives up. */
function remediation(configPath: string, pid?: number): string {
  const stop = pid === undefined ? 'stop the process that owns it' : `\`kill ${pid}\``;
  return `Either ${stop}, or delete ${configPath}.`;
}

/**
 * True when `pid` names a live process.
 *
 * `EPERM` means the process EXISTS but belongs to another uid — reading that as
 * "dead" is the silent double-boot this guard exists to prevent. Only `ESRCH` is
 * proof of death.
 */
function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Throw when a requested slug directory does not exist, listing what does.
 *
 * Without this, `readDirSafe`'s `catch { return []; }` turns a mis-encoded slug
 * into a dev server that boots green, binds, serves the UI and shows an empty
 * session list with no error anywhere — a Plan-001-class defect reintroduced by
 * the tool built to prevent them.
 */
function requireSlugsExist(root: string, projects: readonly string[] | undefined): void {
  if (projects === undefined) return;
  const missing = projects.filter((slug) => !existsSync(join(root, slug)));
  if (missing.length === 0) return;
  throw new Error(
    `agent-lens dev: no such project slug under ${root}: ${missing.join(', ')}. ` +
      `Present: ${slugDirs(root).join(', ') || '(none)'}`,
  );
}

// --- Read-only corpus inspection -------------------------------------------

/** Slug directory names under the transcript root, or `[]` when unreadable. */
function slugDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * How much the boot catch-up is about to parse — the same depth-one
 * `<slug>/*.jsonl` set the tailer scans, so the number the user reads is the
 * number that is about to be paid.
 */
function measureCorpus(
  root: string,
  projects: readonly string[] | undefined,
): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const slug of projects ?? slugDirs(root)) {
    const dir = join(root, slug);
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        bytes += statSync(join(dir, name)).size;
        files += 1;
      } catch {
        // A file that vanished between readdir and stat is not worth failing over.
      }
    }
  }
  return { files, bytes };
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// --- Paths -----------------------------------------------------------------

/**
 * The package root, located the depth-invariant way `resolveUiDir` already does
 * — walk up to the nearest `package.json` — rather than by a fixed `../..`,
 * which differs between `src/dev/` under tsx and `dist/src/dev/` once compiled.
 * `resolveUiDir` returns `<root>/ui/dist`; two `dirname`s give `<root>`.
 */
function repoRoot(): string {
  return dirname(dirname(resolveUiDir(dirname(fileURLToPath(import.meta.url)))));
}

/**
 * The URL Vite is actually serving on, after `listen()` resolved its port.
 * Vite auto-increments off an occupied 5173 (`strictPort` is false), so the
 * configured port is not the served one and must not be assumed.
 */
function resolvedViteUrl(vite: { resolvedUrls?: { local?: string[] } | null }): string {
  const local = vite.resolvedUrls?.local?.[0];
  if (local === undefined) {
    throw new Error('agent-lens dev: vite reported no local URL after listen()');
  }
  return local.replace(/\/$/, '');
}

// --- Command ---------------------------------------------------------------

/** `--project <slug>` (repeatable, literal directory name) and `--all`. */
function parseArgv(argv: readonly string[]): DevServerOptions {
  const slugs: string[] = [];
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--all') all = true;
    else if (arg === '--project') {
      const value = argv[++i];
      if (value === undefined) throw new Error('agent-lens dev: --project needs a slug');
      slugs.push(value);
    } else throw new Error(`agent-lens dev: unknown argument ${arg}`);
  }
  if (all) return { projects: 'all' };
  return slugs.length > 0 ? { projects: slugs } : {};
}

async function main(): Promise<void> {
  const dev = await startDevServer(parseArgv(process.argv.slice(2)));
  console.log('\n─────────────────────────────────────────────');
  console.log('  agent-lens dev — REAL SESSIONS');
  console.log(`  UI:        ${dev.viteUrl}/`);
  console.log(`  collector: http://127.0.0.1:${dev.collectorPort}/`);
  console.log(`  dataDir:   ${dev.dataDir}`);
  console.log(`  reset:     rm -rf ${dev.dataDir}`);
  console.log('─────────────────────────────────────────────\n');

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void dev.close().then(() => process.exit(0));
  };
  // Take SIGTERM back from Vite. `createServer` installs its own
  // `process.once('SIGTERM', closeServerAndExit)`, which closes ITSELF and then
  // calls `process.exit()` — measured: that fires while `handle.close()` is
  // still waiting on the collector's socket, so the DB never closes and
  // `config.json` and a live WAL are left behind for the next boot's
  // stale-instance guard to trip over. Removing the listener is the only fix
  // that is not a race: `emit` clones its listener array, so a removal made
  // from inside the same signal dispatch would not stop it.
  //
  // SIGHUP is the other half — it is what a closed terminal sends a foreground
  // job, node's default action terminates WITHOUT running `close()`, and
  // `src/cli/commands/start.ts` misses it.
  process.removeAllListeners('SIGTERM');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, shutdown);
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
