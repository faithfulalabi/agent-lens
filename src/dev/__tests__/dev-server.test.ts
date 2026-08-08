// Task 0.2 — `npm run dev`: the real collector plus `ui/`'s real Vite, wired
// together and driven over real HTTP.
//
// Fixtures are SYNTHESIZED in temp dirs, like every other capture test: nothing
// here reads the developer's `~/.claude/projects`. Only `src/dev/server.ts` run
// as a COMMAND ever points at the real corpus, so the two AC1 clauses that are
// about that default ("the real root", "the cwd's slug") are pinned structurally
// — at the seam, and by source assertion — rather than by reading local history.
//
// Timeouts are budgeted explicitly: the root vitest project sets none, so the
// defaults (5 s per test, 10 s per hook) apply, and this suite boots a real
// server AND a real Vite that compiles the React graph on demand.

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

// --- Items 5, 9, 10, 11: one boot, driven over real HTTP --------------------

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
      // The interval is not what this suite is about; the boot catch-up already
      // ran by the time `startDevServer` resolves.
      tailIntervalMs: 60_000,
    });
    token = readToken(dataDir)!;
    vitePort = Number(new URL(dev.viteUrl).port);
  }, 60_000);

  afterAll(async () => {
    await dev.close();
  });

  // Item 5 — AC1
  it('binds an ephemeral collector port and persists it', () => {
    expect(dev.collectorPort).toBeGreaterThan(0);
    expect(dev.collectorPort).not.toBe(4470);
    expect(readConfig(dataDir)?.port).toBe(dev.collectorPort);
  });

  // Item 9 — AC3
  it('401s /api on both hops, and never answers /api with HTML', async () => {
    const throughVite = await fetch(`${dev.viteUrl}/api/sessions`);
    const direct = await fetch(`http://127.0.0.1:${dev.collectorPort}/api/sessions`);
    expect(throughVite.status).toBe(401);
    expect(direct.status).toBe(401);
    // Vite's `htmlFallbackMiddleware` sits AFTER the proxy, so a mis-wired proxy
    // answers `/api/*` with `200 text/html` instead of failing — the one failure
    // mode a status-only assertion would sail straight past.
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

  // Item 10 — AC3
  it('rejects a foreign Host on both hops', async () => {
    // `changeOrigin: true` rewrites the outgoing Host, so through the proxy it is
    // VITE's `hostCheckMiddleware` that answers, not the collector's `hostGuard`
    // — which is why this asserts the status, not the responder.
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

  // Item 11 — AC3
  it('puts the token in the page and nowhere else', async () => {
    const page = await rawRequest(vitePort, '/', { host: `localhost:${vitePort}` });
    expect(page.status).toBe(200);
    const html = page.body;

    const bootstrap = bootstrapFromHtml(html);
    expect(bootstrap).toBeDefined();
    expect(bootstrap!.token).toBe(token);
    expect(bootstrap!.tokenHeader).toBe(TOKEN_HEADER);
    expect(Object.isFrozen(bootstrap)).toBe(true);

    // Never in anything a browser would dereference, never a cookie, never
    // localStorage — the three prohibitions `ui/src/lib/bootstrap.ts` spells out.
    for (const literal of urlLiterals(html)) {
      expect(literal, `token leaked into a URL literal: ${literal}`).not.toContain(token);
    }
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(html).not.toContain('document.cookie');
    expect(html).not.toContain('localStorage.setItem');

    // And not in the client bundle: Vite inlines every `VITE_`-prefixed env var
    // into module text, which is exactly why the token never touches process.env.
    const moduleText = await (await fetch(`${dev.viteUrl}/src/lib/bootstrap.ts`)).text();
    expect(moduleText).not.toContain(token);
    expect(moduleText).not.toContain('import.meta.env.VITE_');
  });
});

// --- Items 5b, 6, 12: structural pins, no boot -----------------------------

describe('startDevServer — wiring pinned at the seam', () => {
  // Item 5b — AC1. The ephemeral-port clause has to hold even on a machine that
  // happens to leave 4470 free, and a dev server that never asks for 4470 cannot
  // collide with `port.test.ts`, which deliberately occupies it.
  it('asks for port 0, never the default port', () => {
    expect(DEV_SERVER_SOURCE).toContain('port: 0');
    expect(DEV_SERVER_SOURCE).not.toContain('4470');
  });

  // Item 6 — AC1
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

  // Item 6 — AC1. Measured against `~/.claude.json`'s `projects` keys, which are
  // the real path→slug ground truth.
  it.each([
    ['/Users/faithful/Desktop/agent-lens', '-Users-faithful-Desktop-agent-lens'],
    [
      '/Users/faithful/Desktop/BLITZ-DATA/client-projects/locdnstudios',
      '-Users-faithful-Desktop-BLITZ-DATA-client-projects-locdnstudios',
    ],
    // The discriminating pair: underscores become hyphens too, so this row goes
    // RED under `cwd.split(sep).join('-')` — the other candidate encoder, which
    // reproduces 10 of 11 real slug directories instead of 11.
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

  // Not in the original test plan — a defect found by driving the real command.
  // Vite's `createServer` installs `process.once('SIGTERM', closeServerAndExit)`,
  // which `process.exit()`s once IT has closed, mid-`handle.close()`. Measured
  // before the fix: `config.json`, `-wal` and `-shm` all survived a SIGTERM, so
  // the stale-instance guard became the recovery path for an ORDINARY quit.
  // Signals cannot be driven from inside this worker, so this pins the seam.
  it('takes SIGTERM back from Vite before registering its own shutdown', () => {
    expect(DEV_SERVER_SOURCE).toContain("removeAllListeners('SIGTERM')");
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      expect(DEV_SERVER_SOURCE).toContain(`'${signal}'`);
    }
  });

  // Item 12 — AC3
  it('injects through the production injectToken, serve-only', () => {
    expect(PLUGIN_SOURCE).toContain("from '../server/static-ui.js'");
    expect(PLUGIN_SOURCE).toContain('injectToken(');
    // A `<script>` literal here would mean a second injector — and with it the
    // missing-marker throw, the `<` escaping and the `$&`-safe replacer all gone.
    expect(PLUGIN_SOURCE).not.toContain('<script');

    const plugin = devBootstrapPlugin('tok');
    expect(plugin.apply).toBe('serve');
  });
});

// --- Items 7, 8, 15: the refusal and cleanup paths -------------------------

describe('startDevServer — refuses rather than boots wrong', { timeout: 15_000 }, () => {
  let booted: DevServerHandle | undefined;

  afterEach(async () => {
    if (booted !== undefined) {
      await booted.close();
      booted = undefined;
    }
  });

  // Item 7 — AC1
  it('throws on an unknown slug, listing the slugs that do exist', async () => {
    const root = makeCorpus('slug-a');
    await expect(
      startDevServer({
        dataDir: tempDir('agent-lens-dev-data-'),
        transcriptRoot: root,
        projects: ['slug-nope'],
      }),
    ).rejects.toThrow(/slug-a/);
    // Without the guard this boots green: `readDirSafe` swallows the ENOENT and
    // the UI shows an empty session list with no error anywhere.
  });

  // Item 8 — AC1. `port: 0` prevents a port collision; it does nothing about two
  // SQLite connections and two tail timers on one persistent dataDir.
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

  // Item 15 — AC1
  it('closes the collector when Vite fails to boot', async () => {
    const dataDir = tempDir('agent-lens-dev-data-');
    // A real directory with no `vite.config.ts`, so the explicit `configFile`
    // fails to load and the rejection is deterministic. By then `startServer`
    // has already bound a socket, opened SQLite and armed a tail timer.
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

    // `handle.close()` ran: `clearConfig` removed config.json, and the socket,
    // the SQLite handle and the tail interval went with it. Without the try/catch
    // all three leak into this worker.
    expect(readConfig(dataDir)).toBeNull();
  }, 60_000);
});
