// `npm run demo:capture` — the README's screenshots, regenerated.
//
// Drives the REAL UI in Chrome against the invented corpus in `demo-corpus.mjs`,
// so the README's images are photographs of the product rather than drawings of
// it, and a UI change that strands the page is one command away from being seen.
//
// Two passes, each against its own planted copy of the corpus: a THREAD PASS
// driven here, where a session opens by default and therefore where a reader
// reads it, and `runRenderGate` for the session list, the search screen and the
// ten assertions it scores the corpus on.
//
// ★ THE THREAD SHOTS CANNOT COME OUT OF THE GATE. Its own thread shot is taken
// after `probeLiveUpdate` has appended a record naming the gate, and the toggle
// it reaches the thread through must stay last — every tree reading, that
// probe's included, has to happen first. So the thread is driven here, before
// anything has appended anything.
//
// ★ THE CORPUS IS PLANTED IN A THROWAWAY DIRECTORY AND NEVER COMMITTED. Two env
// vars point the gate's own drive away from anything real:
//
//   AGENT_LENS_DEV_DIR         the data dir whose `archive/` the sweep indexes
//   AGENT_LENS_TRANSCRIPT_ROOT the source tree the boot path measures
//
// The second one exists for a narrow reason worth writing down: `chromeDriver`
// calls `startDevServer()` with no options, so `projects` falls back to the slug
// of the CURRENT WORKING DIRECTORY and `requireSlugsExist` throws if that slug is
// absent under the transcript root. So the slug is created, empty — the sweep
// reads `<dataDir>/archive` and nothing else, so an empty source tree changes no
// reading.
//
// ★ NO AUTOMATED GATE READS A PNG. `fixture-residue.test.ts` scans text under two
// roots; an image is not text. The contact sheet is printed at the end for that
// reason: every committed image is read by a human at full size before the commit
// that adds it.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRenderGate } from '../src/render-gate/index.js';
import { slugFor, startDevServer } from '../src/dev/server.js';
import { plantDemoCorpus } from './demo-corpus.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The render-gate task id, and therefore the output directory's name. */
const TASK = 'readme';

/** The shots the gate takes that a human has read. See the header. */
const FROM_GATE = ['01-sessions.png', '10-search.png'];

/** The shots the thread pass takes. */
const TOOL_CALL_SHOT = 'thread-tool-call.png';
const SUBAGENT_SHOT = 'thread-subagent.png';
const FROM_THREAD = [TOOL_CALL_SHOT, SUBAGENT_SHOT];

const IMAGES_DIR = join(REPO_ROOT, 'docs', 'images');

/** The gate's own viewport, so every committed image is one size. */
const VIEWPORT = { width: 1440, height: 900 };

/** Per-wait, so a missing selector fails fast with a useful message. */
const WAIT_MS = 15_000;

/** Clearance below the last element a shot has to show. */
const FRAME_MARGIN_PX = 12;

const SESSION_ROW = '[data-slot="session-row"]';
const THREAD_VIEW = '[data-slot="thread-view"]';
const ACTIVITY = 'details[data-slot="thread-activity"]';
const TOOL_ROW = '[data-thread-kind="tool"]';
const TOOL_DETAIL = 'details[data-slot="thread-tool-detail"]';

function heading(text) {
  console.log(`\n── ${text}`);
}

/** Nothing a published image may say. The first is the gate's live-append body. */
const FORBIDDEN = ['render gate', process.env.HOME ?? '/root'];

/** Opens a `<details>` by its own summary, and refuses to photograph a closed one. */
async function disclose(details) {
  await details.locator(':scope > summary').click();
  if ((await details.getAttribute('open')) === null) {
    throw new Error('a disclosure stayed closed after it was clicked');
  }
}

/** Scrolls the element's bottom into the thread's own window, with clearance. */
async function scrollIntoFrame(locator) {
  await locator.evaluate((node, margin) => {
    node.scrollIntoView({ block: 'end', inline: 'nearest' });
    let scroller = node.parentElement;
    while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    if (scroller !== null) scroller.scrollTop += margin;
  }, FRAME_MARGIN_PX);
}

/** Refuses to shoot content the viewport edge would cut off. */
async function requireInFrame(page, locator, what) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} is not rendered`);
  const header = await page.locator('[data-slot="session-header"]').boundingBox();
  const top = header === null ? 0 : header.y + header.height;
  if (box.y < top || box.y + box.height > VIEWPORT.height) {
    throw new Error(
      `${what} is clipped by the viewport edge (top ${Math.round(box.y)}, ` +
        `bottom ${Math.round(box.y + box.height)} of ${VIEWPORT.height})`,
    );
  }
}

/** Screenshots the viewport, after reading the screen for what it must and must not say. */
async function shoot(page, outDir, name, expected) {
  // Case-folded: a label the stylesheet upper-cases reads that way in `innerText`.
  const text = (await page.locator('body').innerText()).toLowerCase();
  for (const phrase of expected) {
    if (!text.includes(phrase.toLowerCase())) {
      throw new Error(`${name}: the screen never said ${phrase}`);
    }
  }
  for (const phrase of FORBIDDEN) {
    if (text.includes(phrase.toLowerCase()))
      throw new Error(`${name}: the screen carries ${phrase}`);
  }
  if ((await page.locator('[data-slot="drift-banner"]').count()) > 0) {
    throw new Error(`${name}: a drift alarm is on screen`);
  }
  writeFileSync(join(outDir, name), await page.screenshot());
  console.log(`   shot  ${name}`);
}

/** The two tour shots. Content-addressed, so a corpus edit misses rather than mis-shoots. */
async function captureThreadShots({ dataDir, transcriptRoot, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const dev = await startDevServer({ dataDir, transcriptRoot });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      // A 2x default would multiply every PNG's byte count.
      deviceScaleFactor: 1,
    });
    context.setDefaultTimeout(WAIT_MS);

    // Vite's first cold optimize pass answers 504 until it finishes. One
    // throwaway navigation absorbs it — a page load, not a timer.
    const warmup = await context.newPage();
    await warmup.goto(`${dev.viteUrl}/`, { waitUntil: 'load' });
    await warmup.close();

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => {
      // Vite's dev server has no favicon route; the packaged server does.
      if (message.type() !== 'error') return;
      if (message.location().url.endsWith('/favicon.ico')) return;
      consoleErrors.push(message.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto(`${dev.viteUrl}/`, { waitUntil: 'load' });
    await page.locator(SESSION_ROW).first().click();
    await page.waitForSelector(THREAD_VIEW);

    const activity = page.locator(ACTIVITY);

    // The first group that ran a tool, which is the one with a prompt and a
    // reply above it — the payload reads as part of a conversation, not alone.
    const toolGroup = activity.filter({ has: page.locator(TOOL_ROW) }).first();
    await disclose(toolGroup);
    const tool = toolGroup.locator(TOOL_ROW).first();
    await disclose(tool.locator(TOOL_DETAIL));
    await scrollIntoFrame(toolGroup);
    await requireInFrame(page, tool.locator('[data-slot="thread-input"]'), 'the tool input');
    await requireInFrame(page, tool.locator('[data-slot="thread-output"]'), 'the tool output');
    await shoot(page, outDir, TOOL_CALL_SHOT, ['INPUT', 'OUTPUT', 'webhook_route.py']);

    // The sub-agent's OWN transcript, reached the way a reader reaches it. The
    // link is matched by text rather than by role: a closed disclosure hides its
    // children from the accessibility tree, so a role query finds nothing.
    const toSubagent = page.locator(`${TOOL_ROW} a`).filter({ hasText: /subagent thread/i });
    const agentGroup = activity.filter({ has: toSubagent }).first();
    await disclose(agentGroup);
    await agentGroup
      .locator('a')
      .filter({ hasText: /subagent thread/i })
      .first()
      .click();
    await page.waitForSelector(THREAD_VIEW);

    const childGroup = page
      .locator(ACTIVITY)
      .filter({ has: page.locator(TOOL_ROW) })
      .first();
    await disclose(childGroup);
    const childTool = childGroup.locator(TOOL_ROW).last();
    await disclose(childTool.locator(TOOL_DETAIL));
    const report = page.locator('[data-thread-kind="message"]').last();
    await scrollIntoFrame(report);
    await requireInFrame(page, childGroup, "the sub-agent's activity");
    await requireInFrame(page, report, "the sub-agent's report");
    await shoot(page, outDir, SUBAGENT_SHOT, [
      'Parent session',
      'Audit idempotency key call sites',
    ]);

    if (consoleErrors.length > 0) {
      throw new Error(
        `the thread pass logged ${consoleErrors.length} console error(s): ${consoleErrors[0]}`,
      );
    }
  } finally {
    await browser.close();
    await dev.close();
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'agent-lens-demo-'));
const threadDataDir = join(scratch, 'thread-data');
const gateDataDir = join(scratch, 'gate-data');
const threadOut = join(scratch, 'thread');
const transcriptRoot = join(scratch, 'projects');

try {
  heading('Planting the invented demo corpus');
  // The cwd's own slug, so `requireSlugsExist` is satisfied without a real tree.
  mkdirSync(join(transcriptRoot, slugFor(process.cwd())), { recursive: true });
  // One copy per pass: `refuseIfOwned` reads a live pid, and the second boot in
  // this process would find its own.
  const manifest = plantDemoCorpus(threadDataDir);
  plantDemoCorpus(gateDataDir);
  console.log(
    `   ${manifest.sessions} sessions, ${manifest.sidecars} sub-agent transcript, ` +
      `${manifest.spills} spilled result`,
  );
  console.log(`   project ${manifest.cwd} (slug ${manifest.slug})`);
  console.log(`   newest: ${manifest.newestTitle}`);

  // FIRST, so nothing has appended anything to the corpus it photographs.
  heading('Driving the thread in Chrome');
  await captureThreadShots({ dataDir: threadDataDir, transcriptRoot, outDir: threadOut });

  // Set after the plant and before the drive: `devDataDir()` and
  // `defaultTranscriptRoot()` both read these at call time, not at import time.
  process.env.AGENT_LENS_DEV_DIR = gateDataDir;
  process.env.AGENT_LENS_TRANSCRIPT_ROOT = transcriptRoot;

  heading('Driving the render gate in Chrome');
  const code = await runRenderGate({ task: TASK, outRoot: scratch });

  const gateOut = join(scratch, '.render-gate', TASK);
  heading(`Copying the reviewed shots into ${IMAGES_DIR}`);
  mkdirSync(IMAGES_DIR, { recursive: true });
  const missing = [];
  for (const [from, names] of [
    [threadOut, FROM_THREAD],
    [gateOut, FROM_GATE],
  ]) {
    for (const name of names) {
      const source = join(from, name);
      if (!existsSync(source)) {
        missing.push(name);
        continue;
      }
      copyFileSync(source, join(IMAGES_DIR, name));
      console.log(`   ok  ${name}`);
    }
  }
  for (const name of missing) console.log(`   MISSING  ${name} — the drive never took it`);

  console.log(`\n   contact sheet: ${join(gateOut, 'index.html')}`);
  console.log('   Read every copied image at full size before committing it: no test does.\n');

  // ★ THE SCRATCH TREE IS KEPT, ON EVERY PATH. The contact sheet is the only
  // thing that makes the manual image read practical, and a script that prints a
  // path it has just deleted is worse than one that leaves a directory in the
  // system temp tree for the OS to reap. All ten of the gate's shots stay there
  // too, which is what lets a reviewer check that the ones it does not publish
  // were left behind for the reason the header gives.
  console.log(`   the gate's ten shots and its report: ${gateOut}`);
  console.log(`   the thread pass's shots: ${threadOut}\n`);

  if (missing.length > 0) {
    console.error(`demo:capture: ${missing.length} published shot(s) were never taken`);
    process.exitCode = 1;
  } else {
    process.exitCode = code;
  }
} catch (err) {
  console.error(`demo:capture: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`demo:capture: artifacts kept for inspection at ${scratch}`);
  process.exitCode = 1;
}
