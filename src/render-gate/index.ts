// `npm run render-gate -- --task <id>` — the machine-decidable half of AC-R1.
//
// Boots 0.2's own dev server, drives the installed Chrome through it with
// `playwright-core`, and writes `.render-gate/<task>/` — four screenshots, a
// `report.json` of every assertion, and an `index.html` contact sheet.
//
// Two rules hold the whole file up:
//   * NO SLEEPS. Every wait is a selector or a function, or this is a flaky
//     timer rather than a proof. A test greps this directory for the Playwright
//     sleep call and requires zero hits — including in prose, so the token is
//     spelled nowhere here on purpose.
//   * An OVERALL DEADLINE. A wait that never settles must produce an exit code,
//     not a hung AFK run.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import { resolveUiDir } from '../server/static-ui.js';
import { startDevServer } from '../dev/server.js';
import {
  buildReport,
  renderContactSheet,
  type DetailTexts,
  type Observations,
  type RenderGateReport,
  type ShotRecord,
} from './report.js';

/**
 * The six `data-slot` values the gate drives. `data-slot` carries no styling
 * weight anywhere in `ui/src` — it is already a pure test hook, and four UI
 * suites assert these exact strings, so a rename reds there before it reds here.
 */
export const SELECTORS = {
  sessionCount: 'session-list-count',
  sessionRow: 'session-row',
  traceRow: 'trace-group',
  traceExpand: 'trace-expand',
  spanRow: 'span-row',
  spanDetail: 'span-detail',
} as const;

/** `SpanTree`'s own `ESTIMATED_ROW_PX`. Pinned by a test — `totalRows` needs it. */
export const ESTIMATED_ROW_PX = 28;

const VIEWPORT = { width: 1440, height: 900 } as const;
const DEFAULT_DEADLINE_MS = 180_000;
/** Per-wait, so a missing selector fails fast with a useful message. */
const PER_WAIT_TIMEOUT_MS = 15_000;

/** The four screenshots, named so the contact sheet reads in drive order. */
type ShotName = '01-sessions.png' | '02-session.png' | '03-detail.png' | '04-focus.png';

/**
 * The one reviewed exclusion, in the style of `no-egress.test.ts`'s
 * `KNOWN_INERT_URLS`: a path that 404s for a reason that is not a UI defect.
 *
 * `/favicon.ico` — MEASURED on the 2026-08-08 run. `ui/index.html` declares no
 * icon and Vite's `htmlFallbackMiddleware` excludes `/favicon.ico` from the SPA
 * fallback, so headless Chrome's automatic request 404s under `npm run dev`.
 * The PACKAGED server never produces it: only `/assets/*` is served statically
 * and everything else falls to the `app.get('*')` SPA catch-all, so a real
 * user's `/favicon.ico` gets `200 text/html`. Vite-dev-only, and excluded from
 * BOTH collectors — the response 404 and the console message it triggers are
 * one event seen twice.
 */
export const IGNORED_PATHS = new Set(['/favicon.ico']);

export interface ShotBuffer {
  name: string;
  buffer: Uint8Array;
}

/** What a driver hands back: the page readings, plus the raw screenshot bytes. */
export interface DriveOutcome {
  observations: Observations;
  shots: readonly ShotBuffer[];
}

export interface DriveContext {
  task: string;
  /** Teardown registered as resources are acquired, so the deadline cannot strand one. */
  onCleanup: (fn: () => Promise<void>) => void;
}

export type Driver = (ctx: DriveContext) => Promise<DriveOutcome>;

export interface RunOptions {
  task: string;
  /** Injected by tests. Defaults to the real dev-server + Chrome drive. */
  driver?: Driver;
  deadlineMs?: number;
  /** `.render-gate/` is created under here. Defaults to the repo root. */
  outRoot?: string;
}

/* ------------------------------------------------------------------ argv --- */

/** `--task <id>`, and nothing else. The id becomes a directory name. */
export function parseArgv(argv: readonly string[]): { task: string } {
  let task: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg !== '--task') throw new Error(`render-gate: unknown argument ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error('render-gate: --task needs a task id');
    task = value;
  }
  if (task === undefined || task === '') {
    throw new Error('render-gate: --task <id> is required, e.g. `--task 0.3`');
  }
  // Not sanitised into something else: a surprising output directory is worse
  // than a refusal that names the rule.
  if (/[/\\]/.test(task) || task.split('.').every((part) => part === '')) {
    throw new Error(
      `render-gate: --task ${task} is not a usable directory name — ` +
        'no path separators, no bare `..`',
    );
  }
  return { task };
}

/* --------------------------------------------------------------- the run --- */

/** Runs the gate and returns the process exit code. Always writes both artifacts. */
export async function runRenderGate(options: RunOptions): Promise<number> {
  const { task, driver = chromeDriver, deadlineMs = DEFAULT_DEADLINE_MS } = options;
  const outDir = join(options.outRoot ?? repoRoot(), '.render-gate', task);
  mkdirSync(outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const cleanups: Array<() => Promise<void>> = [];
  let shots: ShotRecord[] = [];
  let observations: Observations | null = null;
  let error: string | null = null;

  try {
    const outcome = await withDeadline(
      driver({ task, onCleanup: (fn) => cleanups.push(fn) }),
      deadlineMs,
    );
    // The asserted byte count is the byte count on disk, taken from the buffer
    // itself — one write site for all four shots.
    shots = outcome.shots.map((shot) => {
      writeFileSync(join(outDir, shot.name), shot.buffer);
      return { name: shot.name, bytes: shot.buffer.length };
    });
    observations = outcome.observations;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    // Reversed: the browser goes before the dev server that outlives it.
    for (const close of cleanups.reverse()) await close().catch(() => undefined);
  }

  const report = buildReport({
    task,
    startedAt,
    result: observations === null ? null : { ...observations, shots },
    error,
  });

  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'index.html'), renderContactSheet(report));

  printSummary(report, outDir);
  return report.ok ? 0 : 1;
}

/**
 * The whole drive, bounded. Without this a selector that never resolves would
 * hang an AFK run instead of failing it — AC1's "including when a wait never
 * settles" is exactly this wrapper.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`render-gate: the overall deadline of ${ms}ms elapsed mid-run`));
    }, ms);
  });
  // The loser of the race still rejects — when the deadline wins, the driver
  // rejects later as its browser closes underneath it. Swallow it here or it
  // surfaces as an unhandled rejection long after the report is written.
  void work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- the drive --- */

/*
 * The DOM surface the in-page callbacks touch, declared rather than pulled in
 * via `lib: ["dom"]`.
 *
 * These arrow functions are serialized and evaluated inside Chrome, so their
 * globals are the page's, not node's — but the node project compiles with
 * `lib: ["ES2023"]` and widening it would hand every module under `src/` a
 * `document` it must not have. An ambient declaration is type-only, emits
 * nothing, and pins the surface to exactly what the gate reads.
 */
interface PageElement {
  readonly parentElement: PageElement | null;
  readonly isConnected: boolean;
  readonly textContent: string | null;
  readonly innerText?: string;
  getAttribute(name: string): string | null;
  querySelector(selectors: string): PageElement | null;
  getBoundingClientRect(): { height: number };
}

declare const document: {
  querySelector(selectors: string): PageElement | null;
  querySelectorAll(selectors: string): readonly PageElement[];
};

async function chromeDriver(ctx: DriveContext): Promise<DriveOutcome> {
  const dev = await startDevServer({
    // The gate reads a static corpus; a live tail would only add noise.
    tailIntervalMs: 60_000,
  }).catch((err: unknown) => {
    throw new Error(devServerHint(err));
  });
  ctx.onCleanup(() => dev.close());

  // A literal specifier, so the import stays fully typed; inside the function,
  // so importing this module never costs 13 MB.
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  ctx.onCleanup(() => browser.close());

  const context = await browser.newContext({
    viewport: VIEWPORT,
    // Load-bearing: a 2x default would multiply every PNG's byte count and
    // silently invalidate the 20,000-byte threshold.
    deviceScaleFactor: 1,
  });
  context.setDefaultTimeout(PER_WAIT_TIMEOUT_MS);

  // Vite's first cold optimize pass answers 504 until it finishes. One throwaway
  // navigation absorbs it — a page load, not a timer.
  const warmup = await context.newPage();
  await warmup.goto(`${dev.viteUrl}/`, { waitUntil: 'load' });
  await warmup.close();

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The URL matters: a bare "Failed to load resource" names nothing, and the
    // favicon exclusion below has to be decidable from the message.
    const url = message.location().url;
    if (isIgnoredRequest(url)) return;
    consoleErrors.push(url === '' ? message.text() : `${message.text()} (${url})`);
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    if (isIgnoredRequest(response.url())) return;
    failedResponses.push(`${response.status()} ${response.url()}`);
  });

  const shots: ShotBuffer[] = [];
  const shoot = async (name: ShotName): Promise<void> => {
    shots.push({ name, buffer: await page.screenshot() });
  };

  await page.goto(`${dev.viteUrl}/`, { waitUntil: 'load' });
  await widenRangeToAll(page);
  await shoot('01-sessions.png');

  const sessionCountRaw = (await page.locator(slot(SELECTORS.sessionCount)).innerText()).trim();
  // `formatRowCount` runs the number through `Intl.NumberFormat('en-US')`.
  const sessionCount = Number.parseInt(sessionCountRaw.replace(/,/g, ''), 10);

  const sessionId = await openFirstSession(page);

  // T0: the pane before anything is selected. Read BEFORE the expand, so the
  // transition assertions have a real pre-selection baseline.
  const detailPane = page.locator(slot(SELECTORS.spanDetail));
  const t0 = (await detailPane.innerText()).trim();

  await expandFirstTurn(page);
  await shoot('02-session.png');

  const tree = await readTree(page);
  const spanRowCount = await page.locator(slot(SELECTORS.spanRow)).count();

  // Row 1 is the first turn's first span under every session size — the virtual
  // window always holds it, which is the whole reason turn 1 is the driven turn.
  const firstSpan = page.locator(`[data-index="1"] ${slot(SELECTORS.spanRow)}`);
  await firstSpan.click();
  await page.waitForSelector(`[data-index="1"] ${slot(SELECTORS.spanRow)}[aria-selected="true"]`);
  const t1 = (await detailPane.innerText()).trim();
  await shoot('03-detail.png');

  const keyboard = await driveKeyboard(page, t1);
  const t2 = (await detailPane.innerText()).trim();
  await shoot('04-focus.png');

  const detail: DetailTexts = { t0, t1, t2 };
  return {
    shots,
    observations: {
      viteUrl: dev.viteUrl,
      sessionId,
      sessionCountRaw,
      sessionCount,
      spanRowCount,
      detail,
      consoleErrors,
      failedResponses,
      ...tree,
      ...keyboard,
    },
  };
}

/**
 * Widen the range to `all`, without racing the rows that are already there.
 *
 * The list opens at `3d`; on an idle machine that renders `EmptyState` and the
 * gate would red environmentally. But clicking `all` changes the load key, so
 * the rows unmount and come back — a `waitForSelector` fired straight after the
 * click can resolve against the PRE-click rows. Detachment is the latched,
 * monotonic property that polling cannot miss, so the wait is built on it.
 */
async function widenRangeToAll(page: Page): Promise<void> {
  const allButton = page.getByRole('button', { name: 'all', exact: true });
  await allButton.waitFor({ state: 'visible' });
  const button = await allButton.elementHandle();
  const before = await page.$(slot(SELECTORS.sessionRow));

  await allButton.click();
  await page.waitForFunction(
    ([btn, row]: [PageElement | null, PageElement | null]) =>
      btn?.getAttribute('aria-pressed') === 'true' && (row === null || !row.isConnected),
    [button, before] as unknown as [PageElement | null, PageElement | null],
  );
  await page.waitForSelector(slot(SELECTORS.sessionRow));
}

/** Clicks the newest session row. A bare `<a href>`, so this is a real navigation. */
async function openFirstSession(page: Page): Promise<string> {
  const row = page.locator(slot(SELECTORS.sessionRow)).first();
  const href = (await row.getAttribute('href')) ?? '';
  await row.click();
  await page.waitForSelector(slot(SELECTORS.traceRow));
  return (
    href
      .split('/')
      .filter((part) => part !== '')
      .pop() ?? '(unknown)'
  );
}

/**
 * Expand turn 1, and wait on the row it creates.
 *
 * `initialExpanded` opens only the LAST turn, whose first span sits far below
 * the virtualizer's window on a long session — 27 turns puts it at index 27 and
 * the window clears it by three rows. Turn 1's children land at index 1, which
 * is in the window by construction. The guard matters because on a one-turn
 * session the last turn IS turn 1: clicking then would COLLAPSE it.
 */
async function expandFirstTurn(page: Page): Promise<void> {
  const firstTurn = page.locator(slot(SELECTORS.traceRow)).first();
  if ((await firstTurn.getAttribute('aria-expanded')) === 'false') {
    await page.locator(slot(SELECTORS.traceExpand)).first().click();
  }
  await page.waitForSelector(`[data-index="1"] ${slot(SELECTORS.spanRow)}`);
}

/**
 * `ArrowDown` then `Enter`, waiting on what each one actually changes.
 *
 * `ArrowDown` moves the roving `tabindex` ONLY; `selectedId` is untouched. A
 * wait on `[aria-selected]` after `ArrowDown` can never resolve. `Enter` is what
 * moves selection, and it no-ops when the focused row is already selected —
 * which is why focus has to move first.
 */
async function driveKeyboard(
  page: Page,
  previousDetail: string,
): Promise<
  Pick<
    Observations,
    'focusIndexBefore' | 'focusIndexAfter' | 'selectedIndexBefore' | 'selectedIndexAfter'
  >
> {
  const ROVING = '[data-index] > [tabindex="0"]';
  const SELECTED = '[data-index] > [aria-selected="true"]';

  await page.focus(ROVING);
  const focusIndexBefore = await indexOf(page, ROVING);
  const selectedIndexBefore = await indexOf(page, SELECTED);

  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    ([selector, before]) =>
      document.querySelector(selector)?.parentElement?.getAttribute('data-index') !== before,
    [ROVING, focusIndexBefore] as const,
  );
  const focusIndexAfter = await indexOf(page, ROVING);

  await page.keyboard.press('Enter');
  await page.waitForFunction(
    ([selector, before, paneSelector, paneText]) => {
      const index = document.querySelector(selector)?.parentElement?.getAttribute('data-index');
      const pane = document.querySelector(paneSelector);
      return (
        index !== undefined &&
        index !== null &&
        index !== before &&
        pane?.innerText?.trim() !== paneText
      );
    },
    [SELECTED, selectedIndexBefore, slot(SELECTORS.spanDetail), previousDetail] as const,
  );
  const selectedIndexAfter = await indexOf(page, SELECTED);

  return { focusIndexBefore, focusIndexAfter, selectedIndexBefore, selectedIndexAfter };
}

/** The `data-index` of the wrapper around whatever `selector` matches. */
async function indexOf(page: Page, selector: string): Promise<string | null> {
  return page.evaluate(
    (sel) => document.querySelector(sel)?.parentElement?.getAttribute('data-index') ?? null,
    selector,
  );
}

/**
 * The virtualizer's rendered window: its labels, its bounds, and how many rows
 * the tree holds in total.
 *
 * `totalRows` is DERIVED, because nothing in the DOM states it: the tree is
 * sized to `getTotalSize()`, and every row the virtualizer has NOT rendered
 * contributes exactly `ESTIMATED_ROW_PX` to that. The derivation is guarded and
 * degrades to `null` rather than reporting a number it cannot stand behind.
 */
async function readTree(
  page: Page,
): Promise<
  Pick<
    Observations,
    'labels' | 'windowFirstIndex' | 'windowLastIndex' | 'renderedRows' | 'totalRows'
  >
> {
  return page.evaluate(
    ([traceSlot, spanSlot, estimate]) => {
      const wrappers = Array.from(document.querySelectorAll('[data-index]'));
      const labels: { index: number; text: string }[] = [];
      let firstIndex: number | null = null;
      let lastIndex: number | null = null;
      let measured = 0;

      for (const wrapper of wrappers) {
        measured += wrapper.getBoundingClientRect().height;
        const index = Number(wrapper.getAttribute('data-index'));
        if (!Number.isInteger(index)) continue;
        firstIndex = firstIndex === null ? index : Math.min(firstIndex, index);
        lastIndex = lastIndex === null ? index : Math.max(lastIndex, index);
        const row = wrapper.querySelector(`${traceSlot}, ${spanSlot}`);
        if (row === null) continue;
        labels.push({
          index,
          text: (row.getAttribute('aria-label') ?? row.textContent ?? '').trim(),
        });
      }
      labels.sort((a, b) => a.index - b.index);

      const tree = document.querySelector('[data-slot="span-tree"]');
      const totalSize = tree === null ? null : tree.getBoundingClientRect().height;
      let totalRows: number | null = null;
      if (totalSize !== null) {
        const derived = wrappers.length + Math.round((totalSize - measured) / estimate);
        const plausible =
          Number.isInteger(derived) &&
          derived >= wrappers.length &&
          (lastIndex === null || derived > lastIndex);
        if (plausible) totalRows = derived;
      }

      return {
        labels,
        windowFirstIndex: firstIndex,
        windowLastIndex: lastIndex,
        renderedRows: wrappers.length,
        totalRows,
      };
    },
    [slot(SELECTORS.traceRow), slot(SELECTORS.spanRow), ESTIMATED_ROW_PX] as const,
  );
}

/* ----------------------------------------------------------------- misc --- */

function slot(name: string): string {
  return `[data-slot="${name}"]`;
}

/** The one reviewed exclusion, applied to both collectors. See `IGNORED_PATHS`. */
function isIgnoredRequest(url: string): boolean {
  if (url === '') return false;
  try {
    return IGNORED_PATHS.has(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** `startDevServer` refuses a data dir a live pid already owns. Say what to do. */
function devServerHint(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes('already running a dev server')) return message;
  return `${message} (a dev server already owns that data dir; stop \`npm run dev\` and re-run)`;
}

// Nearest `package.json`, not a fixed `../..`: the depth differs once compiled.
function repoRoot(): string {
  return dirname(dirname(resolveUiDir(dirname(fileURLToPath(import.meta.url)))));
}

function printSummary(report: RenderGateReport, outDir: string): void {
  const shown = (value: number | null): string => (value === null ? 'unknown' : String(value));
  console.log('\n─────────────────────────────────────────────');
  console.log(`  render gate — task ${report.task} — ${report.ok ? 'PASS' : 'FAIL'}`);
  console.log(`  session:  ${report.sessionId ?? '(none)'}`);
  console.log(
    `  window:   rows [${shown(report.windowFirstIndex)}, ${shown(report.windowLastIndex)}] ` +
      `of ${shown(report.totalRows)} total`,
  );
  console.log('─────────────────────────────────────────────');
  for (const assertion of report.assertions) {
    console.log(`  ${assertion.ok ? 'pass' : 'FAIL'}  ${assertion.name}  ${assertion.actual}`);
  }
  for (const warning of report.warnings) console.log(`  warn  ${warning}`);
  console.log(`\n  artifacts: ${outDir}`);
  console.log(`  contact sheet: ${join(outDir, 'index.html')}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runRenderGate(parseArgv(process.argv.slice(2)));
}
