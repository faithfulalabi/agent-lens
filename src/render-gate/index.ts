// `npm run render-gate -- --task <id>` — the machine-decidable half of AC-R1.
//
// Boots 0.2's own dev server, drives the installed Chrome through it with
// `playwright-core`, and writes `.render-gate/<task>/` — six screenshots, a
// `report.json` of every assertion, and an `index.html` contact sheet.
//
// Two rules hold the whole file up:
//   * NO SLEEPS. Every wait is a selector or a function, or this is a flaky
//     timer rather than a proof. A test greps this directory for the Playwright
//     sleep call and requires zero hits — including in prose, so the token is
//     spelled nowhere here on purpose.
//   * An OVERALL DEADLINE. A wait that never settles must produce an exit code,
//     not a hung AFK run.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import { resolveUiDir } from '../server/static-ui.js';
import { startDevServer } from '../dev/server.js';
import {
  buildReport,
  renderContactSheet,
  type DetailTexts,
  type DriftProbe,
  type EventDetailProbe,
  type LiveProbe,
  type Observations,
  type RenderGateReport,
  type SearchProbe,
  type ShotRecord,
  type SubagentProbe,
  type ThreadProbe,
  type ToolCallProbe,
} from './report.js';

/**
 * The thirteen `data-slot` values the gate drives. `data-slot` carries no styling
 * weight anywhere in `ui/src` — it is already a pure test hook, and four UI
 * suites assert these exact strings, so a rename reds there before it reds here.
 *
 * Every entry is CLICKED or READ by the drive below. `thread-view` is
 * deliberately not listed: the container is reached through `data-thread-kind`,
 * and an entry no drive touches is the vacuity the guard exists to catch.
 *
 * ★ `search-warm` IS DELIBERATELY NOT AN ENTRY EITHER, for exactly that reason.
 * MEASURED: `countUnprojected` is 0 over the dev corpus — 293 of 293 `ready` —
 * and the gate snapshot copies the same database, so the control cannot be
 * driven at all. `probeSearch` reads it as a raw attribute selector instead, on
 * `TREE_CANVAS`'s precedent below, and asserts its ABSENCE. Task 7.4's probe
 * adds the entry when it can drive the raise side.
 *
 * `spanExpand` is task 5.5's, and it is the toggle AC-R1(b) commits to clicking
 * by name. Every slot the drive touches goes through this constant.
 */
export const SELECTORS = {
  sessionCount: 'session-list-count',
  sessionRow: 'session-row',
  backToSessions: 'back-to-sessions',
  traceRow: 'trace-group',
  traceExpand: 'trace-expand',
  spanRow: 'span-row',
  spanExpand: 'span-expand',
  spanDetail: 'span-detail',
  threadToggle: 'thread-toggle',
  driftBanner: 'drift-banner',
  inSessionSearch: 'in-session-search',
  searchInput: 'search-input',
  searchScope: 'search-scope',
} as const;

/** `SpanTree`'s own `ESTIMATED_ROW_PX`. Pinned by a test — `totalRows` needs it. */
export const ESTIMATED_ROW_PX = 28;

const VIEWPORT = { width: 1440, height: 900 } as const;
const DEFAULT_DEADLINE_MS = 180_000;
/** Per-wait, so a missing selector fails fast with a useful message. */
const PER_WAIT_TIMEOUT_MS = 15_000;

/**
 * The nine screenshots, numbered in the order a reviewer should read them.
 *
 * ★ THAT IS NO LONGER THE ORDER THEY ARE TAKEN IN, AND IT CANNOT BE.
 * `07-subagent.png` is shot BEFORE `06-thread.png`: the thread toggle swaps the
 * tree away with no trip back, so every tree reading has to happen first, while
 * the sub-agent number has to stay 07 because six code sites pin the shot set by
 * name. So `report.shots` is in CAPTURE order and reads 05, 07, 06.
 *
 * `05-tool-call.png` was added by task 5.3 and it is not decoration. The four
 * before it are shot at `[data-index="1"]` and at the row `ArrowDown` reaches —
 * measured `text`, `prompt` or `unknown`, never a `tool_call` on any session in
 * the corpus. So without a fifth shot the AC-R2 sign-off could not see the
 * state AC-R1 asserts on. Moving an earlier shot is not the fix: `driveKeyboard`
 * reads `selectedIndexBefore`, and a click before it corrupts that reading.
 *
 * `06-thread.png` is task 5.4's, on the same argument: the five before it are
 * all taken on the tree, so without it the AC-R2 eye would open the contact
 * sheet and see no thread pixels at all.
 *
 * `07-subagent.png` is task 5.5's, and it is the only one that can show an
 * embedded sidecar: it is shot while the expanded Agent row's own turns and
 * events are on screen, which is a state none of the six before it reach.
 *
 * `08-live.png` is task 6.2's, and it is shot BEFORE `06-thread.png` for the
 * same reason 07 is: the tail is read off the tree, and the thread toggle takes
 * the tree away for good. It is the only shot taken after the open session grew
 * under the reader, which is the state AC-R1 asserts on for that task.
 *
 * `09-drift.png` is task 7.3's, and it is shot after the thread toggle, which it
 * survives because the alarm draws above the tree/thread split rather than
 * inside either. It is the only shot in which the durability alarm is on screen
 * at all: the corpus is clean (measured 291 of 293 sessions carry no drift), so
 * no other shot can hold one, and the AC-R2 eye would otherwise open the contact
 * sheet for an alarm task and see no alarm.
 *
 * `10-search.png` is task 7.2's, and it is shot LAST OF ALL — the search drive
 * NAVIGATES AWAY from the session, so every reading taken on the session view
 * has to be finished before it. It is the only shot that can show the search
 * screen. It shows NO warm control, and that is correct rather than missing:
 * `countUnprojected` is 0 over this corpus, so there is nothing left to warm.
 * Task 7.4's gate photographs the raise side.
 */
type ShotName =
  | '01-sessions.png'
  | '02-session.png'
  | '03-detail.png'
  | '04-focus.png'
  | '05-tool-call.png'
  | '06-thread.png'
  | '07-subagent.png'
  | '08-live.png'
  | '09-drift.png'
  | '10-search.png';

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

/* ------------------------------------------------------- precondition --- */

/**
 * The data directory the drive will sweep. Mirrors `startDevServer`'s own
 * default, because the gate has to check the archive BEFORE booting the server
 * that would otherwise index nothing and report a product failure.
 */
export function devDataDir(): string {
  return process.env.AGENT_LENS_DEV_DIR ?? join(repoRoot(), '.agent-lens-dev');
}

/**
 * Why the gate must not run yet, or `null`.
 *
 * ★ AN ENVIRONMENT FAULT MUST NOT READ AS A PRODUCT FAULT. Nothing in the boot
 * path mirrors the corpus into `<dataDir>/archive`: `startServer` points the
 * sweep at that directory and `scanCorpus` walks it and nothing else. On a
 * clean checkout it is empty, the sweep indexes zero files, and `session-count`
 * fails for a reason that has nothing to do with the UI. So the refusal happens
 * before the drive, names the command that fixes it, and writes no report
 * claiming a FAIL.
 */
export function archiveRefusal(dataDir: string): string | null {
  const archive = join(dataDir, 'archive');
  if (existsSync(archive) && jsonlCount(archive) > 0) return null;
  return (
    `render-gate: ${archive} holds no .jsonl transcript, so the sweep would index nothing ` +
    'and every reading would be empty for an environment reason. ' +
    'Run `node bin/agent-lens.js archive --dataDir .agent-lens-dev` first.'
  );
}

function jsonlCount(root: string): number {
  try {
    return readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) =>
      name.endsWith('.jsonl'),
    ).length;
  } catch {
    return 0;
  }
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

/** The fields the payload cross-checks read off the detail response. */
export interface WireEvent {
  id: string;
  /** What the projector called this record. The thread counts `thinking` rows. */
  kind: string;
  input: string | null;
  text: string | null;
  /** The word the detail pane has to print. Null on every non-tool row. */
  output_storage: string | null;
}

/** One `tool_call` row the virtualizer actually rendered, as read off the page. */
export interface RenderedRow {
  id: string;
  text: string;
}

/** A `WireEvent` that carries every field AC-R1 looks for. See `pickPayloadRow`. */
export interface PayloadEvent extends WireEvent {
  input: string;
  text: string;
  output_storage: string;
}

/** A row on screen and the wire event behind it — what both probes read. */
interface PayloadRow {
  wire: PayloadEvent;
  row: RenderedRow;
}

/**
 * The first rendered row whose wire event carries everything AC-R1 reads.
 *
 * ★ RENDERED ROWS FIRST, NEVER THE WIRE FIRST. The tree is virtualized —
 * `SpanTree.tsx` emits ~34 rows into a 720px viewport — and a `.click()` on a
 * locator for a row the virtualizer never rendered throws after
 * `PER_WAIT_TIMEOUT_MS` and fails the whole drive rather than degrading to the
 * `null` observation. So the candidate set is what is on screen, and the wire
 * map only says which of those rows is worth clicking.
 *
 * Pure, and exported, because the choreography around it is Playwright and this
 * is the only part of the probe a unit test can reach. The same split
 * `isSessionDetailPath` already uses.
 */
export function pickPayloadRow(
  rows: readonly RenderedRow[],
  payloads: ReadonlyMap<string, WireEvent>,
): PayloadEvent | null {
  for (const row of rows) {
    const wire = payloads.get(row.id);
    // All three, because the pane must show all three: a row whose storage word
    // is null would make AC-R1's third clause unassertable rather than failing.
    if (wire === undefined) continue;
    const { input, text, output_storage } = wire;
    if (input === null || text === null || output_storage === null) continue;
    return { ...wire, input, text, output_storage };
  }
  return null;
}

/** How much of a payload the gate looks for in the rendered row. */
const PAYLOAD_PREFIX_CHARS = 24;

/** One line, one space run — the shape both the row and the wire are reduced to. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** `/api/sessions/:id` and nothing else — the list route has no path segment. */
export function isSessionDetailPath(url: string): boolean {
  try {
    return /^\/api\/sessions\/[^/]+$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * `/api/sessions` exactly — the LIST route, which the predicate above can never
 * match. Its own function rather than a widened `isSessionDetailPath`: three
 * assertions pin that one, and widening it would move all of them.
 */
export function isSessionListPath(url: string): boolean {
  try {
    return new URL(url).pathname === '/api/sessions';
  } catch {
    return false;
  }
}

declare const document: {
  querySelector(selectors: string): PageElement | null;
  querySelectorAll(selectors: string): readonly PageElement[];
};

async function chromeDriver(ctx: DriveContext): Promise<DriveOutcome> {
  // The corpus sweep runs at its default period: after task 4.5 it is what
  // indexes the archive at all, so disabling it would drive the gate against an
  // empty list rather than a quiet one.
  const dev = await startDevServer().catch((err: unknown) => {
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
  /*
   * ★ RESPONSES, NOT REQUESTS. `ui/src/main.tsx` wraps the app in StrictMode,
   * so `useAsync`'s effect double-invokes and the first fetch is aborted only
   * AFTER it is issued — two requests always reach the wire and exactly one
   * response comes back. The response count is the decidable property, and it
   * is the one AC1 means: one response fills the whole screen.
   */
  const detailPaths: string[] = [];
  /** The LIST route's own tally — see `isSessionListPath`. */
  const listPaths: string[] = [];
  /** Main-frame navigations. A live tail must cause none. */
  let navigations = 0;
  let wireEvents: Promise<WireEvent[]> | null = null;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
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
    if (isSessionDetailPath(response.url()) && response.status() < 400) {
      // The PATH, not just a tally: AC-R1(b) has to prove the expansion asked
      // for that row's own child and for nothing else.
      detailPaths.push(new URL(response.url()).pathname);
      // Kept as a promise: reading a body inside the handler would make the
      // listener async and the count race the drive. `??=` so it stays the
      // PARENT's page — a later sidecar response must not overwrite it.
      wireEvents ??= response
        .json()
        .then((body: { events?: WireEvent[] }) => body.events ?? [])
        .catch(() => []);
    }
    if (isSessionListPath(response.url()) && response.status() < 400) {
      listPaths.push(new URL(response.url()).pathname);
    }
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

  // The way back to the list, counted on the screen that has to offer one.
  // Absent on `main`, so this reading is red before task 5.1 and green after.
  const backLinks = await page.locator(slot(SELECTORS.backToSessions)).count();

  // T0: the pane before anything is selected. Read BEFORE the expand, so the
  // transition assertions have a real pre-selection baseline.
  const detailPane = page.locator(slot(SELECTORS.spanDetail));
  const t0 = (await detailPane.innerText()).trim();

  await expandFirstTurn(page);
  await shoot('02-session.png');

  const tree = await readTree(page);
  const spanRowCount = await page.locator(slot(SELECTORS.spanRow)).count();
  // Counted at ANY depth: a `task_notification` turn folds under the Agent
  // event that spawned it, so depth-0 counting is wrong on a folded session.
  const turnGroupCount = await page.locator(slot(SELECTORS.traceRow)).count();

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

  // LAST, because the search may expand further turns and the detail probe
  // moves the selection: every reading above is already taken, so nothing
  // either of them does can disturb an assertion.
  const events: readonly WireEvent[] = (await wireEvents) ?? [];
  const found = await findPayloadRow(page, new Map(events.map((event) => [event.id, event])));
  const toolCallInline = toolCallProbe(found);
  const eventDetail = await probeEventDetail(page, found, shoot);

  // AFTER the detail probe, because opening a sub-agent inserts rows and would
  // move the row that probe clicks; BEFORE the thread probe, because that one
  // swaps the tree away for good. Read the at-load count here, on the last line
  // before anything can issue a second detail request.
  const detailResponsesAtLoad = detailPaths.length;
  const subagentExpansion = await probeSubagentExpansion(page, shoot);

  // BEFORE the live probe, because the splice fetches a page of its own: the
  // sub-agent's window has to close here or its "exactly one further response"
  // reading would red the moment task 6.2's feature worked.
  const detailResponsesBeforeLive = detailPaths.length;
  const liveUpdate = await probeLiveUpdate(page, ctx, sessionId, shoot, {
    detailPaths,
    listPaths,
    navigations: () => navigations,
  });

  // LAST of all: the toggle swaps the tree out for the thread, so every tree
  // reading has to be taken before it — INCLUDING the live probe's, which reads
  // `totalRows` off the tree canvas and would answer null once the tree is gone.
  // There is no trip back: a return would be dead motion, and the response count
  // below spans the whole drive either way, which is what makes AC1 survive it.
  const threadInline = await probeThreadInline(page, events, shoot);

  // LAST OF ALL, after the thread probe. An unrecognised line becomes an event
  // row, so appending one any earlier would move the `totalRows` reading the
  // live probe's whole assertion rests on. The toggle cannot hide the alarm:
  // it draws above the tree/thread split, so it survives into the thread.
  const driftBanner = await probeDriftBanner(page, ctx, liveUpdate, shoot);

  // LAST OF ALL, after the alarm. This probe NAVIGATES — twice — so every
  // reading taken on the session view has to be finished before it runs. It
  // leaves the session for the search screen and then follows a hit back into a
  // session, which no earlier reading would survive.
  const searchScreen = await probeSearch(page, events, shoot);

  const detail: DetailTexts = { t0, t1, t2 };
  return {
    shots,
    observations: {
      viteUrl: dev.viteUrl,
      sessionId,
      sessionCountRaw,
      sessionCount,
      backLinks,
      spanRowCount,
      turnGroupCount,
      detailPaths,
      detailResponsesAtLoad,
      detailResponsesBeforeLive,
      listPaths,
      toolCallInline,
      eventDetail,
      subagentExpansion,
      threadInline,
      liveUpdate,
      driftBanner,
      searchScreen,
      detail,
      consoleErrors,
      failedResponses,
      ...tree,
      ...keyboard,
    },
  };
}

/**
 * The rendered `tool_call` row both probes read, found once and shared.
 *
 * The window is the hard part, not the fields — measured on the newest archived
 * session, 91 of 91 `tool_call` events carry both halves, but only the rows the
 * virtualizer rendered can be read. So collapsed turns in the window are opened,
 * a few at a time, until a qualifying row appears. When none does, this answers
 * `null` and `report.ts` records an observation rather than a pass.
 *
 * Found ONCE so both probes describe the same row: a report where the row
 * assertion and the pane assertion name different events would be two readings
 * a human has to reconcile rather than one fact.
 */
async function findPayloadRow(
  page: Page,
  payloads: ReadonlyMap<string, WireEvent>,
): Promise<PayloadRow | null> {
  if (payloads.size === 0) return null;

  const readRows = (): Promise<RenderedRow[]> =>
    page.$$eval('[data-event-kind="tool_call"]', (nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute('data-event-id') ?? '',
        text: node.textContent ?? '',
      })),
    );

  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const rows = await readRows();
    const wire = pickPayloadRow(rows, payloads);
    if (wire !== null) {
      const row = rows.find((candidate) => candidate.id === wire.id);
      if (row !== undefined) return { wire, row };
    }
    // Nothing qualifying in the window: open one more closed turn and look
    // again. Bounded, because an unbounded search is a hang rather than a miss.
    const closed = page.locator(`${slot(SELECTORS.traceRow)}[aria-expanded="false"]`).first();
    if ((await closed.count()) === 0) break;
    await closed.locator(slot(SELECTORS.traceExpand)).click();
    await page.waitForSelector(`${slot(SELECTORS.spanRow)}`);
  }

  return null;
}

/**
 * Task 5.2's clause: the ROW carries a prefix of the input and of the output.
 *
 * Pure — the search above already did the browser work — so this reading stays
 * decidable in a unit test rather than only on a live drive.
 */
function toolCallProbe(found: PayloadRow | null): ToolCallProbe | null {
  if (found === null) return null;
  const { wire, row } = found;
  const shown = oneLine(row.text);
  const inputPrefix = oneLine(wire.input).slice(0, PAYLOAD_PREFIX_CHARS);
  const outputPrefix = oneLine(wire.text).slice(0, PAYLOAD_PREFIX_CHARS);
  return {
    eventId: wire.id,
    inputPrefix,
    outputPrefix,
    inputMatched: inputPrefix !== '' && shown.includes(inputPrefix),
    outputMatched: outputPrefix !== '' && shown.includes(outputPrefix),
  };
}

/**
 * AC-R1: clicking that row fills the DETAIL PANE with the event's real input,
 * its real output, and the word naming where the output was stored.
 *
 * ★ THE PANE IS READ ONLY AFTER IT SAYS WHICH EVENT IT IS SHOWING. A bare wait
 * would read the previous event's body under the new selection and assert a
 * pass against a pane that never updated — which is why `data-event-id` is a
 * production attribute on `EventDetail` rather than a hook bolted on here.
 *
 * `05-tool-call.png` is shot on this row, so the AC-R2 sign-off sees the state
 * AC-R1 asserted on. The four earlier shots never can: they are taken at
 * `data-index="1"` and at the row `ArrowDown` reaches, neither of which is a
 * `tool_call` on any session in the corpus.
 */
async function probeEventDetail(
  page: Page,
  found: PayloadRow | null,
  shoot: (name: ShotName) => Promise<void>,
): Promise<EventDetailProbe | null> {
  if (found === null) return null;
  const { wire } = found;
  const onThisEvent = `[data-event-id="${cssAttrValue(wire.id)}"]`;
  const rowSelector = `${slot(SELECTORS.spanRow)}${onThisEvent}`;

  // Safe to click: the row came out of `$$eval` over the rendered DOM, so the
  // virtualizer has it. A locator for a row it never rendered would throw after
  // PER_WAIT_TIMEOUT_MS and fail the drive instead of degrading.
  await page.locator(rowSelector).click();
  await page.waitForSelector(`${rowSelector}[aria-selected="true"]`);
  await page.waitForSelector(`${slot(SELECTORS.spanDetail)}${onThisEvent}`);

  const pane = oneLine(await page.locator(slot(SELECTORS.spanDetail)).innerText());
  await shoot('05-tool-call.png');

  const inputPrefix = oneLine(wire.input).slice(0, PAYLOAD_PREFIX_CHARS);
  const outputPrefix = oneLine(wire.text).slice(0, PAYLOAD_PREFIX_CHARS);
  return {
    eventId: wire.id,
    inputPrefix,
    outputPrefix,
    storageWord: wire.output_storage,
    inputMatched: inputPrefix !== '' && pane.includes(inputPrefix),
    outputMatched: outputPrefix !== '' && pane.includes(outputPrefix),
    storageMatched: pane.includes(wire.output_storage),
  };
}

/** One scroll step, and how many of them the search will take. */
const SUBAGENT_SCROLL_STEPS = 12;

/** How long one scroll step is given to move the window before the search stops. */
const SUBAGENT_SETTLE_MS = 3_000;

/*
 * ★ THE EXPANSION KEEPS THE ORDINARY PER-WAIT, AND THAT IS A MEASUREMENT.
 *
 * The first expansion of almost any sidecar RE-PROJECTS it inside the request:
 * `PROJECTOR_VERSION` is 5, 287 of 293 rows carry 4, and the freshness check
 * demands equality. So the honest question was whether a parse of the whole file
 * fits inside `PER_WAIT_TIMEOUT_MS`. MEASURED against a v4 snapshot, on the five
 * children of the session this gate drives (0.67-2.86 MB, 72-368 events): the
 * re-projecting request took 36, 44, 71, 88 and 158 ms. Two orders of magnitude
 * of headroom, so no special wait is invented here.
 */

/**
 * AC-R1 for task 5.5: opening an Agent row embeds ITS OWN sidecar, in place.
 *
 * ★ IT SCROLLS. IT NEVER CLOSES A TURN AND NEVER OPENS ONE.
 * MEASURED on the session `openFirstSession` opens: only turns 0, 6 and 7 are
 * top-level, and turns 1-5 are a five-deep `task_notification` chain hanging off
 * the Agent events INSIDE turn 0. So all five child-bearing rows live in turn
 * 0's subtree, `flatten` stops descending at a closed turn, and closing turn 0
 * would leave this probe nothing to find — it would answer `null`, the optional
 * shape would turn that into a warning, and the gate would go green over a
 * feature nobody exercised. Opening further turns is wrong the other way: it
 * pushes the Agent row further down the list the search is walking.
 *
 * Scrolling to the last rendered row and looking again is the whole search. The
 * tree is virtualized, so a row outside the window is not in the document at
 * all, and a locator for one would throw rather than degrade.
 */
async function probeSubagentExpansion(
  page: Page,
  shoot: (name: ShotName) => Promise<void>,
): Promise<SubagentProbe | null> {
  const agentRows = page.locator(`${slot(SELECTORS.spanRow)}[data-child-session-id]`);

  for (let step = 0; step <= SUBAGENT_SCROLL_STEPS; step += 1) {
    if ((await agentRows.count()) > 0) break;
    const last = page.locator(slot(SELECTORS.spanRow)).last();
    if ((await last.count()) === 0) break;
    const before = await last.getAttribute('data-event-id');
    await last.scrollIntoViewIfNeeded();
    // The window advancing is the latched fact worth waiting on. Bounded and
    // tolerated, because reaching the bottom of the list is a legitimate answer
    // — it means this session has no Agent row, which 6 of 21 do not.
    const advanced = await page
      .waitForFunction(
        ([rowSelector, previous]) => {
          const rows = document.querySelectorAll(rowSelector);
          const tail = rows[rows.length - 1];
          return tail !== undefined && tail.getAttribute('data-event-id') !== previous;
        },
        [slot(SELECTORS.spanRow), before] as const,
        { timeout: SUBAGENT_SETTLE_MS },
      )
      .then(
        () => true,
        () => false,
      );
    if (!advanced) break;
  }

  const row = agentRows.first();
  if ((await row.count()) === 0) return null;
  const childSessionId = await row.getAttribute('data-child-session-id');
  const parentSessionId = await row.getAttribute('data-session-id');
  if (childSessionId === null || parentSessionId === null) return null;

  await row.locator(slot(SELECTORS.spanExpand)).click();

  // An EVENT row of the child, not its turn row. The turn row is the one a
  // splice that carried only a depth offset would still stamp correctly, so
  // waiting on it would let the real defect through.
  const nested = `${slot(SELECTORS.spanRow)}[data-session-id="${cssAttrValue(childSessionId)}"]`;
  await page.waitForSelector(nested);
  await shoot('07-subagent.png');

  const nestedEventSessionIds = await page.$$eval(nested, (nodes) =>
    nodes.map((node) => node.getAttribute('data-session-id') ?? ''),
  );
  return { parentSessionId, childSessionId, nestedEventSessionIds };
}

/** How long the tail is given to arrive. The tick runs at 1 Hz; a projection is ms. */
const LIVE_SETTLE_MS = 30_000;

/** The virtualizer's canvas — the one element whose height states the row count. */
const TREE_CANVAS = '[data-slot="span-tree"]';

/**
 * The archived transcript of one session, or `null`.
 *
 * `<dataDir>/archive/<slug>/<sessionId>.jsonl`, found by walking rather than by
 * rebuilding the slug: the slug is the mirror's business and re-deriving it here
 * would be a second copy of a rule that can drift. A sealed session answers
 * `null` — its bytes are a `.zst` frame, which appending to would corrupt.
 */
export function archivedTranscript(dataDir: string, sessionId: string): string | null {
  const archive = join(dataDir, 'archive');
  let names: string[];
  try {
    names = readdirSync(archive, { recursive: true, encoding: 'utf8' });
  } catch {
    return null;
  }
  const wanted = `${sessionId}.jsonl`;
  const found = names
    .map((name) => name.split('\\').join('/'))
    .find((name) => name === wanted || name.endsWith(`/${wanted}`));
  return found === undefined ? null : join(archive, found);
}

/**
 * One human-prompt record, which is the ONLY shape that grows the row count.
 *
 * ★ A `task_notification` MOVES `totalRows` BY ZERO, and that is why this is a
 * user line. Turn segmentation is one variable: a line whose `promptId` differs
 * from the running one opens a new segment, and a segment that emits earns a
 * turn row. A turn row draws whether or not it is expanded; an EVENT row draws
 * only under an expanded turn, and the drive expands turn 1 alone — so an append
 * that lands inside the last, collapsed turn adds no visible row at all.
 */
function liveAppendRecord(sessionId: string, stamp: number): string {
  const record = {
    type: 'user',
    uuid: `ffffffff-6262-4262-8262-${String(stamp).slice(-12).padStart(12, '0')}`,
    parentUuid: null,
    sessionId,
    timestamp: new Date(stamp).toISOString(),
    // A prompt group nothing else can carry: this is what opens the turn.
    promptId: `render-gate-6-2-${stamp}`,
    origin: { kind: 'human' },
    message: { role: 'user', content: 'render gate: a live append, reverted at teardown' },
  };
  return `${JSON.stringify(record)}\n`;
}

/**
 * AC-R1 for task 6.2: the open session GROWS UNDER THE READER.
 *
 * ★ IT RUNS BEFORE THE THREAD PROBE, AND THAT IS NOT AN ORDERING PREFERENCE.
 * The thread toggle replaces the tree subtree for good, and `totalRows` is
 * derived from the tree canvas — so after the toggle this probe could only ever
 * answer `null`, which `report.ts` scores as a failure.
 *
 * ★ IT READS `totalRows`, NEVER A COUNT OF RENDERED ROWS. The tree is
 * virtualized, so the number of `span-row` elements is bounded by the viewport
 * and does not move when the session grows. The canvas height does.
 *
 * ★ IT GROWS THE ARCHIVE ITSELF, AND PUTS IT BACK. Nothing in the boot path
 * mirrors new bytes — `archiveOnce`'s only production caller is the CLI, and in
 * production the mirror is an external job on a 15-minute interval with measured
 * real gaps of hours. So the probe appends one record and reverts it in
 * `onCleanup`, against the throwaway data dir `AGENT_LENS_DEV_DIR` names. Both
 * write sites are reviewed in `src/fs-write-sites.test.ts`.
 */
async function probeLiveUpdate(
  page: Page,
  ctx: DriveContext,
  sessionId: string,
  shoot: (name: ShotName) => Promise<void>,
  counters: {
    detailPaths: readonly string[];
    listPaths: readonly string[];
    navigations: () => number;
  },
): Promise<LiveProbe | null> {
  const path = archivedTranscript(devDataDir(), sessionId);
  if (path === null) return null;

  const before = await readTree(page);
  const height = await page.evaluate(
    (selector) => document.querySelector(selector)?.getBoundingClientRect().height ?? null,
    TREE_CANVAS,
  );
  if (height === null) return null;

  const detailsBefore = counters.detailPaths.length;
  const listBefore = counters.listPaths.length;
  const navigationsBefore = counters.navigations();

  // Registered BEFORE the write, so no window exists in which the append can
  // outlive the run. Truncating to the pre-append size is a no-op if the append
  // never happened.
  const size = statSync(path).size;
  ctx.onCleanup(async () => {
    truncateSync(path, size);
  });
  appendFileSync(path, liveAppendRecord(sessionId, Date.now()));

  // The canvas growing is the latched fact worth waiting on, and waiting on it
  // is what makes "without a manual refresh" mechanical: no goto, no reload,
  // and the assertions below count both.
  const grew = await page
    .waitForFunction(
      ([selector, previous]) => {
        const tree = document.querySelector(selector);
        return tree !== null && tree.getBoundingClientRect().height > previous;
      },
      [TREE_CANVAS, height] as const,
      { timeout: LIVE_SETTLE_MS },
    )
    .then(
      () => true,
      () => false,
    );

  const after = await readTree(page);

  // The shot AC-R2's eye opens has to SHOW the tail, and the newest rows sit
  // below the fold: `AppShell`'s content pane is `min-h-screen`/`flex-1` with no
  // `min-h-0`, so the tree's own scroller resolves to auto height and the PAGE
  // scrolls instead of it. Bringing the last row into view is what puts the
  // appended turn and the pill in frame. Taken AFTER both readings, and the
  // scroller itself never moves, so it can disturb no assertion and no state.
  await page.locator(slot(SELECTORS.spanRow)).last().scrollIntoViewIfNeeded();
  await shoot('08-live.png');

  return {
    before: before.totalRows,
    // A wait that never settled is a tail that never arrived. Reporting the
    // second reading anyway would let a rounding wobble read as growth.
    after: grew ? after.totalRows : before.totalRows,
    navigations: counters.navigations() - navigationsBefore,
    listResponses: counters.listPaths.length - listBefore,
    detailResponses: counters.detailPaths.length - detailsBefore,
    // Handed on rather than resolved twice — see `LiveProbe.archivePath`.
    archivePath: path,
  };
}

/** A top-level `type` no `LINE_TYPES` entry names. Echoed into the report. */
const DRIFT_RECORD_TYPE = 'render_gate_unknown_record';

/**
 * One record the projector cannot name, which is what raises the alarm.
 *
 * ★ THREE FIELDS, AND THE SHORTNESS IS THE POINT. `classifyLine` reaches
 * `noteUnknownType` off `type` alone and returns `kind: 'unknown'` without
 * throwing, so the session still projects `ready` with `unknown_line_types` at
 * 1. Every field this record does NOT carry — the five `liveAppendRecord` next
 * door needs to open a turn — is one of the eleven words in
 * `one-door.test.ts`'s `TERMS`, and each would buy a suppression entry for a
 * line that proves nothing extra.
 */
function driftAppendRecord(stamp: number): string {
  const record = {
    type: DRIFT_RECORD_TYPE,
    uuid: `ffffffff-7373-4373-8373-${String(stamp).slice(-12).padStart(12, '0')}`,
    timestamp: new Date(stamp).toISOString(),
  };
  return `${JSON.stringify(record)}\n`;
}

/**
 * AC-R1 for task 7.3: the durability alarm is SILENT on a clean session and
 * RAISES when the transcript format moves under the reader.
 *
 * ★ IT RUNS LAST OF ALL, AND THAT IS NOT A PREFERENCE. An unknown line becomes
 * an event row, so appending one before the live probe would perturb the
 * `totalRows` reading that probe's whole assertion rests on. The thread toggle
 * is not a hazard the other way: the alarm draws above the tree/thread split, so
 * it is on screen in both surfaces — checked in the page source, not assumed,
 * because the ordering hazard 6.2 hit was exactly this shape.
 *
 * ★ IT READS BOTH SIDES. The corpus is clean — measured 291 of 293 sessions —
 * so an observe-only probe could assert nothing but the zero side and would be
 * green over a dead alarm. Appending the drift it then looks for is what makes
 * the reading falsifiable in the direction the alarm exists for.
 *
 * ★ IT PUTS THE BYTES BACK, on `probeLiveUpdate`'s idiom: the truncate is
 * registered BEFORE the write, so no window exists in which the append can
 * outlive the run. The gate unwinds cleanups LIFO, so this revert runs before
 * the live probe's and the two truncates cannot cross.
 */
async function probeDriftBanner(
  page: Page,
  ctx: DriveContext,
  live: LiveProbe | null,
  shoot: (name: ShotName) => Promise<void>,
): Promise<DriftProbe | null> {
  if (live === null) return null;
  const path = live.archivePath;

  const banner = page.locator(slot(SELECTORS.driftBanner));
  const before = await banner.count();

  const size = statSync(path).size;
  ctx.onCleanup(async () => {
    truncateSync(path, size);
  });
  appendFileSync(path, driftAppendRecord(Date.now()));

  // The alarm appearing is the latched fact worth waiting on. No goto and no
  // reload: the 1 Hz tick replaces the header wholesale on every frame, which
  // is what carries the reprojected `has_drift` to the screen.
  await page
    .waitForSelector(slot(SELECTORS.driftBanner), { timeout: LIVE_SETTLE_MS })
    .catch(() => null);

  const after = await banner.count();
  await shoot('09-drift.png');

  return { before, after, appendedType: DRIFT_RECORD_TYPE };
}

/**
 * AC-R1 for task 5.4: the THREAD is read, not merely reached.
 *
 * ★ IT AIMS AT `data-thread-kind`, NOT AT `data-event-kind`. The pre-existing
 * cross-check selects the latter, which `SpanRow` renders and no thread row
 * carries — so a probe that reused it would discharge this AC with the tree.
 *
 * ★ A NULL ANSWER FAILS THE GATE. `findPayloadRow` may legitimately answer
 * nothing because the tree virtualizer decides what is on screen; the thread has
 * no window, so every tool row of the session is in the document and MEASURED
 * 293 of 293 sessions carry a qualifying one. The candidate set here is
 * therefore a superset of the tree probe's, and an empty one means the toggle is
 * broken. `report.ts` scores that as a failure rather than a warning.
 *
 * `pickPayloadRow` is reused verbatim so both surfaces agree on what "a row
 * worth reading" is, rather than this file growing a third search.
 */
async function probeThreadInline(
  page: Page,
  events: readonly WireEvent[],
  shoot: (name: ShotName) => Promise<void>,
): Promise<ThreadProbe | null> {
  const toggle = page.locator(slot(SELECTORS.threadToggle));
  if ((await toggle.count()) === 0) return null;

  await toggle.click();
  await page.waitForSelector('[data-thread-kind]');
  await shoot('06-thread.png');

  const rows = await page.$$eval('[data-thread-kind="tool"]', (nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute('data-event-id') ?? '',
      text: node.textContent ?? '',
    })),
  );
  const thinkingTexts = await page.$$eval('[data-thread-kind="thinking"]', (nodes) =>
    nodes.map((node) => node.textContent ?? ''),
  );

  const wire = pickPayloadRow(rows, new Map(events.map((event) => [event.id, event])));
  const row = wire === null ? undefined : rows.find((candidate) => candidate.id === wire.id);
  if (wire === null || row === undefined) return null;

  const shown = oneLine(row.text);
  const inputPrefix = oneLine(wire.input).slice(0, PAYLOAD_PREFIX_CHARS);
  const outputPrefix = oneLine(wire.text).slice(0, PAYLOAD_PREFIX_CHARS);
  const marked = thinkingTexts.map(oneLine);

  return {
    eventId: wire.id,
    inputPrefix,
    outputPrefix,
    inputMatched: inputPrefix !== '' && shown.includes(inputPrefix),
    outputMatched: outputPrefix !== '' && shown.includes(outputPrefix),
    thinkingRows: marked.length,
    thinkingEvents: events.filter((event) => event.kind === 'thinking').length,
    markerRows: marked.filter((text) => text.includes(REASONING_NOT_RECORDED)).length,
    emptyRows: marked.filter((text) => text === '').length,
  };
}

/**
 * What the projector writes in place of reasoning the harness withheld.
 *
 * Spelled here rather than imported from `src/transcript/`: the gate asserts on
 * what reaches the BROWSER, and importing the projector's own constant would let
 * a rename pass on both sides while the screen changed under the reader.
 */
const REASONING_NOT_RECORDED = 'reasoning not recorded (signature only)';

/** An id, safe inside a double-quoted CSS attribute selector. */
function cssAttrValue(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
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
    ([traceSlot, spanSlot, estimate, canvas]) => {
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

      const tree = document.querySelector(canvas);
      const totalSize = tree === null ? null : tree.getBoundingClientRect().height;
      let totalRows: number | null = null;
      if (totalSize !== null) {
        // ★ A SHORTFALL UNDER ONE PIXEL PER RENDERED ROW IS ROUNDING, NOT A
        // FAULT. The virtualizer stores each measured row as a whole number of
        // pixels while the DOM reports a fractional height, so a list with
        // EVERY row rendered measures a little taller than its own canvas —
        // 70 rows measured 3,098.84 against a 3,084 canvas. The count of
        // unrendered rows cannot be negative, so that remainder is floored at
        // zero; a larger shortfall is a real inconsistency and still degrades
        // to `null` rather than reporting a number nobody can stand behind.
        const remainder = totalSize - measured;
        const derived = wrappers.length + (remainder > 0 ? Math.round(remainder / estimate) : 0);
        const plausible =
          Number.isInteger(derived) &&
          remainder > -wrappers.length &&
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
    [slot(SELECTORS.traceRow), slot(SELECTORS.spanRow), ESTIMATED_ROW_PX, TREE_CANVAS] as const,
  );
}

/* ------------------------------------------------- task 7.2, the search --- */

/**
 * FTS5 keywords. A bareword query that is one of these parses as an OPERATOR.
 *
 * `searchEvents` retries an unparseable term as a quoted phrase, so one of these
 * still answers 200 — but it answers about the wrong thing, and the probe needs
 * a term whose hit it can predict.
 */
const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * A query derived FROM THE WIRE, not from a literal nobody re-measures.
 *
 * ★ THE MOST FREQUENT WORD WINS, and that is what makes the hit predictable.
 * The index is built over `events.text` and `events.input`, so a word taken from
 * either is a token in it; taking the one that appears in the most events makes
 * the query robust against any single event being a spilled-output marker whose
 * body never entered the index (measured, 59 of 17,897 tool results).
 *
 * The shape rule is deliberately narrow. Word boundaries on both ends, so a long
 * identifier is never truncated into a token the index does not hold; ASCII
 * only, so the `unicode61` tokenizer's folding cannot surprise it; and never an
 * operator, so the query means what it says.
 *
 * Pure and exported, because the choreography around it is Playwright and this
 * is the only part of the probe a unit test can reach. The same split
 * `pickPayloadRow` already uses.
 */
export function pickSearchTerm(events: readonly WireEvent[]): string | null {
  const counts = new Map<string, number>();
  for (const event of events) {
    // Per EVENT, not per occurrence: a word repeated 400 times in one blob is
    // one event's word, and the point of the count is breadth.
    const seen = new Set<string>();
    for (const field of [event.text, event.input]) {
      if (field === null) continue;
      for (const word of field.match(/\b[A-Za-z][A-Za-z0-9]{4,15}\b/g) ?? []) {
        if (FTS_OPERATORS.has(word.toUpperCase())) continue;
        seen.add(word);
      }
    }
    for (const word of seen) counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [word, count] of counts) {
    // Ties break on the lower word, so the same corpus always yields the same
    // query and a failing run is reproducible.
    if (count > bestCount || (count === bestCount && best !== null && word < best)) {
      best = word;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The two search slots that stay raw selectors.
 *
 * `search-warm` cannot be driven at all while `countUnprojected` is 0, so an
 * entry for it would be the exact vacuity the `SELECTORS` guard exists to catch.
 * `search-hit` is driven, but the raise this task pays for is the three slots
 * that carry AC2 — the entry point, the input and the scope — and a fourth
 * would be a raise nothing in the guard's own comment accounts for. Both follow
 * `TREE_CANVAS`'s precedent above.
 */
const WARM_CONTROL = '[data-slot="search-warm"]';
const SEARCH_HIT = '[data-slot="search-hit"]';

/**
 * AC-R1 for task 7.2: the search screen is REACHED, it HIGHLIGHTS, and the hit
 * LANDS on the event it named.
 *
 * ★ IT RUNS LAST OF ALL, AND THAT IS NOT A PREFERENCE. This is the only probe
 * that navigates away from the open session, twice — once to the search screen
 * and once back into a session by following a hit. Every reading any earlier
 * probe takes is off the session view, so none of them would survive it.
 *
 * ★ IT REACHES THE SCREEN BY CLICKING, NEVER BY A `goto`. AC2 asks for
 * in-session search to be REACHABLE from the session view. A `goto` would prove
 * the route resolves while an unreachable control sat broken on the header, which
 * is the "validated structure, never validated experience" failure this whole
 * task was written against. Clicking is what makes that clause gate-verified.
 *
 * ★ THE QUERY IS SCOPED TO THE OPEN SESSION AND DERIVED FROM ITS OWN EVENTS, so
 * `null` is a failure rather than a fact about the corpus — `report.ts` scores it
 * on `threadAssertions`' terms.
 *
 * ★ IT WRITES NO FILE AND TAKES NO SESSION IDENTIFIER, so neither ordinal-keyed
 * manifest moves. `fs-write-sites.test.ts` keys on write sites in source order
 * and this probe has none. `one-door.test.ts` keys on the eleven harness terms
 * and this file alone carries twelve suppressions for the session one — and
 * that scan reads RAW SOURCE, comments included, so a single extra mention
 * anywhere in this file re-keys every one of them. Hence this paragraph naming
 * the identifier by role rather than spelling it, the same constraint
 * `lib/route-match.ts`'s own header works under.
 *
 * The path the entry point landed on is read off the page instead, which is the
 * stronger reading anyway: it is what the browser did, not what the drive
 * already knew.
 */
async function probeSearch(
  page: Page,
  events: readonly WireEvent[],
  shoot: (name: ShotName) => Promise<void>,
): Promise<SearchProbe | null> {
  const term = pickSearchTerm(events);
  if (term === null) return null;

  const entry = page.locator(slot(SELECTORS.inSessionSearch));
  if ((await entry.count()) === 0) return null;
  await entry.click();

  // The input appearing is the latched fact worth waiting on — it exists only on
  // the search screen, so this cannot resolve against the page just left.
  const input = page.locator(slot(SELECTORS.searchInput));
  await input.waitFor({ state: 'visible' });
  const path = pathnameOf(page.url());

  await input.fill(term);

  // A hit appearing is what the query changes. No sleep: the request is issued
  // by the load key changing, and the row is the latched result of it.
  const hits = page.locator(SEARCH_HIT);
  await page.waitForSelector(SEARCH_HIT).catch(() => null);

  const scopeText = oneLine(
    await page
      .locator(slot(SELECTORS.searchScope))
      .innerText()
      .catch(() => ''),
  );
  const warmControls = await page.locator(WARM_CONTROL).count();
  const hitCount = await hits.count();
  await shoot('10-search.png');

  if (hitCount === 0) {
    return {
      path,
      scopeText,
      term,
      hitCount,
      eventId: '',
      markedRuns: 0,
      warmControls,
      landedSelected: false,
    };
  }

  const first = hits.first();
  const eventId = (await first.getAttribute('data-event-id')) ?? '';
  // The highlight is an element this screen DREW, never markup the server sent —
  // counting the elements is what tells those two apart.
  const markedRuns = await first.locator('mark').count();

  await first.click();
  const landed = `${slot(SELECTORS.spanRow)}[data-event-id="${cssAttrValue(eventId)}"][aria-selected="true"]`;
  const landedSelected = await page.waitForSelector(landed, { timeout: LIVE_SETTLE_MS }).then(
    () => true,
    () => false,
  );

  return { path, scopeText, term, hitCount, eventId, markedRuns, warmControls, landedSelected };
}

/* ----------------------------------------------------------------- misc --- */

/** The path an absolute page URL names, or the raw value when it parses as none. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

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
  const options = parseArgv(process.argv.slice(2));
  const refusal = archiveRefusal(devDataDir());
  if (refusal === null) {
    process.exitCode = await runRenderGate(options);
  } else {
    // 2, not 1: the gate did not run, so this is not an assertion failing.
    console.error(refusal);
    process.exitCode = 2;
  }
}
