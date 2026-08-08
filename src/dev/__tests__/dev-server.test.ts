// `npm run dev`: the real collector plus `ui/`'s real Vite, driven over HTTP.
// Fixtures are synthesized in temp dirs — nothing here reads the developer's
// `~/.claude/projects`, so the defaults pointing at it are pinned at the seam.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToken, TOKEN_HEADER } from '../../shared/index.js';
import { clearConfig, readConfig, writeConfig } from '../../server/config.js';
import {
  bootstrapFromHtml,
  rawRequest,
  urlLiterals,
} from '../../server/__tests__/helpers.js';
import { devBootstrapPlugin } from '../bootstrap-plugin.js';
import {
  defaultTranscriptRoot,
  slugFor,
  startDevServer,
  type DevServerHandle,
} from '../server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DEV_SERVER_SOURCE = readFileSync(join(REPO_ROOT, 'src', 'dev', 'server.ts'), 'utf8');
const PLUGIN_SOURCE = readFileSync(
  join(REPO_ROOT, 'src', 'dev', 'bootstrap-plugin.ts'),
  'utf8',
);

const SLUG = '-Users-dev-proj';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A transcript root holding one slug directory with one real-shaped transcript. */
function makeCorpus(slug = SLUG): string {
  const root = tempDir('agent-lens-dev-tr-');
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(
    join(root, slug, 'sess-dev.jsonl'),
    Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `u-${i}`,
        sessionId: 'sess-dev',
        timestamp: new Date(Date.UTC(2026, 6, 26, 0, 0, i)).toISOString(),
        cwd: '/Users/dev/proj',
      }),
    )
      .map((l) => `${l}\n`)
      .join(''),
  );
  return root;
}

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// --- One boot, driven over real HTTP ---------------------------------------

describe('startDevServer — the real stack', { timeout: 15_000 }, () => {
  let dev: DevServerHandle;
  let dataDir: string;
  let token: string;
  let vitePort: number;

  beforeAll(async () => {
    dataDir = tempDir('agent-lens-dev-data-');
    dev = await startDevServer({
      dataDir,
      transcriptRoot: makeCorpus(),
      projects: [SLUG],
      // The boot catch-up already ran by the time `startDevServer` resolves.
      tailIntervalMs: 60_000,
    });
    token = readToken(dataDir)!;
    vitePort = Number(new URL(dev.viteUrl).port);
  }, 60_000);

  afterAll(async () => {
    await dev.close();
  });

  it('binds an ephemeral collector port and persists it', () => {
    expect(dev.collectorPort).toBeGreaterThan(0);
    expect(dev.collectorPort).not.toBe(4470);
    expect(readConfig(dataDir)?.port).toBe(dev.collectorPort);
  });

  it('401s /api on both hops, and never answers /api with HTML', async () => {
    const throughVite = await fetch(`${dev.viteUrl}/api/sessions`);
    const direct = await fetch(`http://127.0.0.1:${dev.collectorPort}/api/sessions`);
    expect(throughVite.status).toBe(401);
    expect(direct.status).toBe(401);
    // Vite's html fallback sits AFTER the proxy: a mis-wired proxy answers
    // `/api/*` with `200 text/html`, invisible to a status-only assertion.
    for (const res of [throughVite, direct]) {
      expect(res.headers.get('content-type') ?? '').not.toMatch(/^text\/html/);
    }

    const authed = await fetch(`${dev.viteUrl}/api/sessions`, {
      headers: { [TOKEN_HEADER]: token },
    });
    expect(authed.status).toBe(200);
    expect(authed.headers.get('content-type') ?? '').not.toMatch(/^text\/html/);
    // The proxy really did reach the collector: the backfilled session is there.
    const body = (await authed.json()) as { items: { id: string }[] };
    expect(body.items.map((s) => s.id)).toContain('sess-dev');
  });

  it('rejects a foreign Host on both hops', async () => {
    // `changeOrigin: true` rewrites the Host, so Vite answers through the proxy,
    // not the collector's `hostGuard` — hence status, not responder.
    const throughVite = await rawRequest(vitePort, '/api/sessions', {
      host: 'evil.com',
      [TOKEN_HEADER]: token,
    });
    const direct = await rawRequest(dev.collectorPort, '/api/sessions', {
      host: 'evil.com',
      [TOKEN_HEADER]: token,
    });
    expect(throughVite.status).toBeGreaterThanOrEqual(400);
    expect(throughVite.status).toBeLessThan(500);
    expect(direct.status).toBe(403);
  });

  it('puts the token in the page and nowhere else', async () => {
    const page = await rawRequest(vitePort, '/', { host: `localhost:${vitePort}` });
    expect(page.status).toBe(200);
    const html = page.body;

    const bootstrap = bootstrapFromHtml(html);
    expect(bootstrap).toBeDefined();
    expect(bootstrap!.token).toBe(token);
    expect(bootstrap!.tokenHeader).toBe(TOKEN_HEADER);
    expect(Object.isFrozen(bootstrap)).toBe(true);

    // Never dereferenceable, never a cookie, never localStorage.
    for (const literal of urlLiterals(html)) {
      expect(literal, `token leaked into a URL literal: ${literal}`).not.toContain(token);
    }
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(html).not.toContain('document.cookie');
    expect(html).not.toContain('localStorage.setItem');

    // Vite inlines every `VITE_`-prefixed env var into module text — which is
    // why the token never touches process.env.
    const moduleText = await (await fetch(`${dev.viteUrl}/src/lib/bootstrap.ts`)).text();
    expect(moduleText).not.toContain(token);
    expect(moduleText).not.toContain('import.meta.env.VITE_');
  });
});

// --- Structural pins, no boot ----------------------------------------------

describe('startDevServer — wiring pinned at the seam', () => {
  // Holds even where 4470 is free, and keeps this off `port.test.ts`'s port.
  it('asks for port 0, never the default port', () => {
    expect(DEV_SERVER_SOURCE).toContain('port: 0');
    expect(DEV_SERVER_SOURCE).not.toContain('4470');
  });

  it('defaults the transcript root to the real corpus root', () => {
    const saved = process.env.AGENT_LENS_TRANSCRIPT_ROOT;
    delete process.env.AGENT_LENS_TRANSCRIPT_ROOT;
    try {
      expect(defaultTranscriptRoot()).toBe(join(homedir(), '.claude', 'projects'));
    } finally {
      if (saved !== undefined) process.env.AGENT_LENS_TRANSCRIPT_ROOT = saved;
    }
    expect(DEV_SERVER_SOURCE).toContain('options.transcriptRoot ?? defaultTranscriptRoot()');
  });

  it.each([
    ['/Users/faithful/Desktop/agent-lens', '-Users-faithful-Desktop-agent-lens'],
    [
      '/Users/faithful/Desktop/BLITZ-DATA/client-projects/locdnstudios',
      '-Users-faithful-Desktop-BLITZ-DATA-client-projects-locdnstudios',
    ],
    // The discriminating row: goes RED under `cwd.split(sep).join('-')`.
    [
      '/Users/faithful/Desktop/Personal_Finance/personal_finance_kpi_project',
      '-Users-faithful-Desktop-Personal-Finance-personal-finance-kpi-project',
    ],
  ])('slugFor(%s)', (cwd, slug) => {
    expect(slugFor(cwd)).toBe(slug);
  });

  it('defaults the project filter to the cwd slug', () => {
    expect(DEV_SERVER_SOURCE).toContain('options.projects ?? [slugFor(process.cwd())]');
  });

  // Vite's own SIGTERM handler `process.exit()`s mid-`handle.close()`, leaving
  // `config.json` and the WAL behind. Signals cannot be driven from this worker.
  it('takes SIGTERM back from Vite before registering its own shutdown', () => {
    expect(DEV_SERVER_SOURCE).toContain("removeAllListeners('SIGTERM')");
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      expect(DEV_SERVER_SOURCE).toContain(`'${signal}'`);
    }
  });

  it('injects through the production injectToken, serve-only', () => {
    expect(PLUGIN_SOURCE).toContain("from '../server/static-ui.js'");
    expect(PLUGIN_SOURCE).toContain('injectToken(');
    // A `<script>` literal here would be a second, weaker injector.
    expect(PLUGIN_SOURCE).not.toContain('<script');

    const plugin = devBootstrapPlugin('tok');
    expect(plugin.apply).toBe('serve');
  });
});

// --- The refusal and cleanup paths -----------------------------------------

describe('startDevServer — refuses rather than boots wrong', { timeout: 15_000 }, () => {
  let booted: DevServerHandle | undefined;

  afterEach(async () => {
    if (booted !== undefined) {
      await booted.close();
      booted = undefined;
    }
  });

  it('throws on an unknown slug, listing the slugs that do exist', async () => {
    const root = makeCorpus('slug-a');
    await expect(
      startDevServer({
        dataDir: tempDir('agent-lens-dev-data-'),
        transcriptRoot: root,
        projects: ['slug-nope'],
      }),
    ).rejects.toThrow(/slug-a/);
    // Without the guard this boots green: `readDirSafe` swallows the ENOENT.
  });

  // `port: 0` prevents a port collision, not two tail timers on one dataDir.
  it('refuses a dataDir a live pid already owns, and boots once it is released', async () => {
    const dataDir = tempDir('agent-lens-dev-data-');
    const transcriptRoot = makeCorpus();
    writeConfig(dataDir, {
      port: 4470,
      pid: process.pid,
      started_at: new Date().toISOString(),
    });

    await expect(
      startDevServer({ dataDir, transcriptRoot, projects: [SLUG] }),
    ).rejects.toThrow(new RegExp(String(process.pid)));

    clearConfig(dataDir);
    booted = await startDevServer({
      dataDir,
      transcriptRoot,
      projects: [SLUG],
      tailIntervalMs: 60_000,
    });
    expect(booted.collectorPort).toBeGreaterThan(0);
  }, 60_000);

  it('closes the collector when Vite fails to boot', async () => {
    const dataDir = tempDir('agent-lens-dev-data-');
    // No `vite.config.ts` here, so the explicit `configFile` fails to load.
    const uiDir = join(REPO_ROOT, 'ui', 'src');

    await expect(
      startDevServer({
        dataDir,
        transcriptRoot: makeCorpus(),
        projects: [SLUG],
        uiDir,
        tailIntervalMs: 60_000,
      }),
    ).rejects.toThrow();

    // Without the try/catch, the socket, DB and tail interval leak into this worker.
    expect(readConfig(dataDir)).toBeNull();
  }, 60_000);
});
