// `npm run dev` — the real collector on an ephemeral port plus `ui/`'s Vite dev
// server proxying `/api` at it, in one process.
//
// The token reaches the browser only through the served HTML, never via
// `process.env`: Vite inlines every `VITE_`-prefixed name into client JS.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readToken } from '../shared/index.js';
import { resolveTranscriptRoot } from '../archive/paths.js';
import { readConfig, type RuntimeConfig } from '../server/config.js';
import { resolveUiDir } from '../server/static-ui.js';
import { startServer } from '../server/start.js';
import { devBootstrapPlugin } from './bootstrap-plugin.js';

export interface DevServerOptions {
  /** Defaults to `$AGENT_LENS_DEV_DIR`, then `<repo>/.agent-lens-dev`. */
  dataDir?: string;
  transcriptRoot?: string;
  /** Slug dirs to tail, or `'all'`; defaults to the slug of `process.cwd()`. */
  projects?: readonly string[] | 'all';
  uiDir?: string;
  /** Corpus-sweep period in ms, forwarded to `startServer`; `0` disables it. */
  sweepIntervalMs?: number;
}

export interface DevServerHandle {
  collectorPort: number;
  viteUrl: string;
  dataDir: string;
  close: () => Promise<void>;
}

const CONFIG_FILE = 'config.json';

// The `~/.claude/projects` slug for a cwd. The character class is load-bearing:
// underscores become hyphens too, so `split(sep).join('-')` is wrong.
export function slugFor(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function defaultTranscriptRoot(): string {
  return resolveTranscriptRoot();
}

// Resolves the manifest and joins `dist/node/index.js` rather than resolving
// `'vite'`, which lands on the CJS entry whose namespace has no `createServer`.
// No root `vite` dep exists to resolve instead — `ui/node_modules` is a
// separate install root.
export function resolveUiViteEsm(uiDir: string): string {
  const install = 'run `npm install` (postinstall installs `ui/`)';
  let manifest: string;
  try {
    manifest = createRequire(import.meta.url).resolve('vite/package.json', { paths: [uiDir] });
  } catch {
    throw new Error(`agent-lens dev: vite is not installed under ${uiDir} — ${install}`);
  }
  const esm = join(dirname(manifest), 'dist', 'node', 'index.js');
  // A drifted join is otherwise a bare ERR_MODULE_NOT_FOUND inside `import()`.
  if (!existsSync(esm)) {
    throw new Error(`agent-lens dev: vite ESM entry missing at ${esm} — ${install}`);
  }
  return pathToFileURL(esm).href;
}

/** Boot the collector, then Vite. Rejects leaving nothing running. */
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
  // Before `startServer`: the sweep's first tick runs before the socket binds,
  // so a line printed afterwards leaves the user watching a silent hang.
  //
  // TWO DIRECTORIES, NAMED SEPARATELY. The measurement walks the transcript
  // tree; the sweep this line announces reads `<dataDir>/archive` and nothing
  // else, and nothing here copies one into the other. One sentence naming only
  // the measured tree read as though the sweep indexed it, which is how an
  // empty archive looked like a broken product rather than a missing step.
  console.log(
    `agent-lens dev: indexing ${join(dataDir, 'archive')} — ` +
      `${files} file(s) / ${mib(bytes)} MiB of transcripts under ${transcriptRoot} (${scope}) ` +
      'are what `agent-lens archive` mirrors into it…',
  );

  const handle = await startServer({
    port: 0,
    dataDir,
    transcriptRoot,
    sweepIntervalMs: options.sweepIntervalMs,
  });

  // Without this catch, anything thrown below strands the bound collector.
  try {
    const token = readToken(dataDir)!;
    const { createServer } = await import(resolveUiViteEsm(uiDir));
    const vite = await createServer({
      // `configFile` does NOT set the root; without this vite falls back to
      // `process.cwd()`, which is the repo root when this runs as a command.
      root: uiDir,
      configFile: join(uiDir, 'vite.config.ts'),
      plugins: [devBootstrapPlugin(token)],
      server: {
        proxy: {
          '/api': {
            target: `http://127.0.0.1:${handle.port}`,
            changeOrigin: true,
            // An SSE stream must never be timed out: the UI reads a body that
            // simply ends as a reconnect, so this would be a silent retry loop.
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

// `port: 0` prevents a port collision, not two SQLite connections on one dir.
function refuseIfOwned(dataDir: string): void {
  const configPath = join(dataDir, CONFIG_FILE);
  let prior: RuntimeConfig | null;
  try {
    prior = readConfig(dataDir);
  } catch (err) {
    // `readConfig` rethrows anything but ENOENT, so a 0600 file left by another
    // uid would otherwise surface as a raw EACCES stack.
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

function remediation(configPath: string, pid?: number): string {
  const stop = pid === undefined ? 'stop the process that owns it' : `\`kill ${pid}\``;
  return `Either ${stop}, or delete ${configPath}.`;
}

// `EPERM` means it EXISTS under another uid; reading that as dead double-boots.
function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// `readDirSafe` swallows ENOENT, so without this a mis-encoded slug boots green
// and shows an empty session list with no error anywhere.
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

/** How much the boot catch-up is about to parse — the tailer's own file set. */
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

// Nearest `package.json`, not a fixed `../..`: the depth differs once compiled.
function repoRoot(): string {
  return dirname(dirname(resolveUiDir(dirname(fileURLToPath(import.meta.url)))));
}

// Vite auto-increments off an occupied 5173; the configured port is not it.
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
  // Take SIGTERM back from Vite: its handler calls `process.exit()` while
  // `handle.close()` is still running, leaving `config.json` and a live WAL
  // behind. Removal must happen HERE — `emit` clones its listener array, so
  // removing from inside the dispatch is too late. SIGHUP is the other half: a
  // closed terminal sends it and node's default action skips `close()`.
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
