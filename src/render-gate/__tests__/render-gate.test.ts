// AC-R1's own guard rail. The gate itself is what discharges AC-R1 on a real
// corpus; these tests pin the parts a vitest worker CAN own — the pure report
// model, the argv parser, the selector constant, and the exit-code contract —
// so a gate that silently stopped asserting anything reds here first.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ESTIMATED_ROW_PX,
  IGNORED_PATHS,
  SELECTORS,
  archiveRefusal,
  devDataDir,
  isSessionDetailPath,
  parseArgv,
  pickPayloadRow,
  runRenderGate,
  type DriveOutcome,
  type WireEvent,
} from '../index.js';
import {
  MAX_LABELS,
  MIN_SHOT_BYTES,
  buildReport,
  evaluateDetail,
  evaluateShot,
  renderContactSheet,
  type DriveResult,
  type Observations,
} from '../report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const GATE_DIR = join(REPO_ROOT, 'src', 'render-gate');
const UI_SRC = join(REPO_ROOT, 'ui', 'src');

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'render-gate-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Every `.ts` the gate itself is made of. */
function gateSources(): { file: string; text: string }[] {
  return readdirSync(GATE_DIR, { recursive: true, encoding: 'utf8' })
    .map((name) => name.split('\\').join('/'))
    .filter((name) => name.endsWith('.ts') && !name.includes('__tests__/'))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(GATE_DIR, file), 'utf8') }));
}

/** A drive result whose every assertion passes, so a test can spoil one field. */
function passingObservations(overrides: Partial<Observations> = {}): Observations {
  return {
    viteUrl: 'http://localhost:5173',
    sessionId: 'sess-1',
    sessionCountRaw: '8 sessions',
    sessionCount: 8,
    backLinks: 1,
    spanRowCount: 4,
    turnGroupCount: 2,
    // The live splice adds a THIRD response by design, which is why the
    // sub-agent's window closes at `detailResponsesBeforeLive`.
    detailPaths: ['/api/sessions/sess-1', '/api/sessions/child-1', '/api/sessions/sess-1'],
    detailResponsesAtLoad: 1,
    detailResponsesBeforeLive: 2,
    listPaths: ['/api/sessions', '/api/sessions'],
    subagentExpansion: {
      parentSessionId: 'sess-1',
      childSessionId: 'child-1',
      nestedEventSessionIds: ['child-1', 'child-1'],
    },
    toolCallInline: {
      eventId: 'toolu_1',
      inputPrefix: '{"cmd":"ls"}',
      outputPrefix: 'a.txt',
      inputMatched: true,
      outputMatched: true,
    },
    eventDetail: {
      eventId: 'toolu_1',
      inputPrefix: '{"cmd":"ls"}',
      outputPrefix: 'a.txt',
      storageWord: 'inline',
      inputMatched: true,
      outputMatched: true,
      storageMatched: true,
    },
    threadInline: {
      eventId: 'toolu_1',
      inputPrefix: '{"cmd":"ls"}',
      outputPrefix: 'a.txt',
      inputMatched: true,
      outputMatched: true,
      thinkingRows: 3,
      thinkingEvents: 3,
      markerRows: 3,
      emptyRows: 0,
    },
    liveUpdate: {
      before: 30,
      after: 31,
      navigations: 0,
      listResponses: 0,
      detailResponses: 1,
      archivePath: '/tmp/agent-lens-dev/archive/proj/sess-1.jsonl',
    },
    driftBanner: {
      before: 0,
      after: 1,
      appendedType: 'render_gate_unknown_record',
    },
    labels: [
      { index: 0, text: 'turn 1: hello' },
      { index: 1, text: 'tool Read, ok' },
    ],
    windowFirstIndex: 0,
    windowLastIndex: 1,
    renderedRows: 2,
    totalRows: 30,
    detail: { t0: 'Select a span.', t1: 'Detail for a.', t2: 'Detail for b.' },
    focusIndexBefore: '1',
    focusIndexAfter: '2',
    selectedIndexBefore: '1',
    selectedIndexAfter: '2',
    consoleErrors: [],
    failedResponses: [],
    ...overrides,
  };
}

const SHOT_NAMES = [
  '01-sessions.png',
  '02-session.png',
  '03-detail.png',
  '04-focus.png',
  // Task 5.3. The four above are shot at `data-index="1"` and at the row
  // `ArrowDown` reaches, neither of which is ever a `tool_call` — so this is
  // the only one that can show the AC-R2 eye the state AC-R1 asserted on.
  '05-tool-call.png',
  // Task 5.4, on the same argument: the five above are all taken on the tree,
  // so without this one the contact sheet carries no thread pixels at all.
  '06-thread.png',
  // Task 5.5. The only shot taken with a sidecar's own turns and events on
  // screen — a state none of the six above ever reach.
  '07-subagent.png',
  // Task 6.2. The only shot taken after the open session GREW under the reader,
  // which is the state that task's AC-R1 asserts on. Shot before the thread, on
  // the same argument as 07: the toggle takes the tree away for good.
  '08-live.png',
  // Task 7.3, and the only one that can show the durability alarm at all: the
  // corpus is clean, so nothing but the probe's own append puts a banner on
  // screen. Shot LAST — after the thread toggle, which the alarm survives
  // because it draws above the tree/thread split.
  '09-drift.png',
];

/** Screenshots that all clear the byte threshold, so only the override can red. */
const PASSING_SHOTS = SHOT_NAMES.map((name) => ({ name, bytes: MIN_SHOT_BYTES + 1 }));

function passingResult(overrides: Partial<Observations> = {}): DriveResult {
  return { ...passingObservations(overrides), shots: PASSING_SHOTS };
}

function passingOutcome(overrides: Partial<Observations> = {}): DriveOutcome {
  return {
    observations: passingObservations(overrides),
    shots: SHOT_NAMES.map((name) => ({ name, buffer: Buffer.alloc(MIN_SHOT_BYTES + 1) })),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseArgv (AC1)', () => {
  it('accepts --task and returns the id', () => {
    expect(parseArgv(['--task', '0.3'])).toEqual({ task: '0.3' });
  });

  it.each([
    ['missing --task', []],
    ['--task with no value', ['--task']],
    ['an unknown flag', ['--task', '0.3', '--url', 'http://x']],
    // The id becomes a directory name under `.render-gate/`.
    ['a POSIX path separator', ['--task', 'a/b']],
    ['a Windows path separator', ['--task', 'a\\b']],
    ['a parent traversal', ['--task', '../../etc']],
    ['a bare dot-dot', ['--task', '..']],
    ['an empty id', ['--task', '']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseArgv(argv)).toThrow(/render-gate/);
  });
});

describe('the empty-archive precondition (AC-R1)', () => {
  /** A data dir holding an `archive/` with `names` in it. */
  function dataDirWith(names: readonly string[]): string {
    const dir = tempRoot();
    const archive = join(dir, 'archive', 'a-project');
    mkdirSync(archive, { recursive: true });
    for (const name of names) writeFileSync(join(archive, name), '{}\n');
    return dir;
  }

  it('refuses an archive with no transcript, and names the command that fills it', () => {
    const refusal = archiveRefusal(dataDirWith([]));

    // Not a bare failure: the whole point is that an environment fault must not
    // read as a product fault, so the message has to carry the remediation.
    expect(refusal).toContain('render-gate:');
    expect(refusal).toContain('node bin/agent-lens.js archive --dataDir .agent-lens-dev');
    expect(refusal).toContain('.jsonl');
  });

  it('refuses a data dir with no archive directory at all', () => {
    expect(archiveRefusal(tempRoot())).toContain('node bin/agent-lens.js archive');
  });

  it('allows a populated archive, however deeply nested', () => {
    expect(archiveRefusal(dataDirWith(['a-session.jsonl']))).toBeNull();
  });

  it('is not satisfied by a non-transcript file', () => {
    expect(archiveRefusal(dataDirWith(['cache.db', 'notes.txt']))).not.toBeNull();
  });

  it('checks the same directory the dev server would sweep', () => {
    // The refusal is worthless if it inspects a directory the drive never
    // reads. `startDevServer` honours this env var first, exactly as this does.
    const previous = process.env.AGENT_LENS_DEV_DIR;
    process.env.AGENT_LENS_DEV_DIR = '/tmp/agent-lens-dev-probe';
    try {
      expect(devDataDir()).toBe('/tmp/agent-lens-dev-probe');
    } finally {
      if (previous === undefined) delete process.env.AGENT_LENS_DEV_DIR;
      else process.env.AGENT_LENS_DEV_DIR = previous;
    }
    expect(devDataDir()).toContain('.agent-lens-dev');
  });
});

describe('evaluateShot (AC4) — the byte threshold discriminates', () => {
  it.each([
    // The measured near-blank 1440x900 Chrome PNG, and the boundary itself.
    [7_150, false],
    [MIN_SHOT_BYTES, false],
    [MIN_SHOT_BYTES + 1, true],
  ])('%i bytes -> ok=%s', (bytes, ok) => {
    const record = evaluateShot({ name: '01-sessions.png', bytes });
    expect(record.ok).toBe(ok);
    expect(record.name).toContain('01-sessions.png');
    expect(record.actual).toContain(String(bytes));
  });
});

describe('a real blank page is under the threshold (AC4)', () => {
  // Discharges "a deliberately blanked page fails this check" by measuring it
  // rather than asserting it. A skip here would be the silent-skip failure mode
  // the golden-replay manifest guard exists to prevent, so a missing Chrome is
  // a loud failure with a remediation line.
  it(
    'screenshots an empty document below MIN_SHOT_BYTES',
    async () => {
      const { chromium } = await import('playwright-core');
      let browser;
      try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
      } catch (err) {
        throw new Error(
          'render-gate: could not launch Google Chrome via playwright-core ' +
            `(channel: 'chrome'). Install Google Chrome and re-run. Cause: ${String(err)}`,
        );
      }
      try {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        await page.setContent('<!doctype html><title>blank</title>');
        const shot = await page.screenshot();
        expect(evaluateShot({ name: 'blank.png', bytes: shot.length }).ok).toBe(false);
      } finally {
        await browser.close();
      }
    },
    { timeout: 60_000 },
  );
});

describe('buildReport (AC5)', () => {
  it('caps labels at 25, in data-index order, with the window bounds beside them', () => {
    const labels = Array.from({ length: 40 }, (_, i) => ({
      index: 39 - i,
      text: `row ${39 - i}`,
    }));
    const report = buildReport({
      task: '0.3',
      startedAt: '2026-08-08T00:00:00.000Z',
      result: { ...passingObservations({ labels, windowLastIndex: 39 }), shots: [] },
      error: null,
    });

    expect(report.labels).toHaveLength(MAX_LABELS);
    expect(report.labels.map((l) => l.index)).toEqual(
      Array.from({ length: MAX_LABELS }, (_, i) => i),
    );
    expect(report.labels[0]?.text).toBe('row 0');
    expect(report.windowFirstIndex).toBe(0);
    expect(report.windowLastIndex).toBe(39);
    expect(report.totalRows).toBe(30);
    expect(report.renderedRows).toBe(2);
  });

  it('gives every assertion the same four fields, and keeps the collectors as arrays', () => {
    const report = buildReport({
      task: '0.3',
      startedAt: '2026-08-08T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });

    expect(report.assertions.length).toBeGreaterThan(0);
    for (const record of report.assertions) {
      expect(Object.keys(record).sort()).toEqual(['actual', 'expected', 'name', 'ok']);
      expect(typeof record.name).toBe('string');
      expect(typeof record.ok).toBe('boolean');
    }
    expect(report.consoleErrors).toEqual([]);
    expect(report.failedResponses).toEqual([]);
  });

  // The control for the table below: without it every `reds on` row would pass
  // for the wrong reason, since any spoiled fixture reds an already-red report.
  it('is green on an unspoiled drive', () => {
    const report = buildReport({
      task: '0.3',
      startedAt: '2026-08-08T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    expect(report.assertions.filter((a) => !a.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each([
    ['a zero session count', { sessionCount: 0 }],
    ['no way back to the list', { backLinks: 0 }],
    ['no span rows', { spanRowCount: 0 }],
    ['a console error', { consoleErrors: ['boom'] }],
    ['a 500 response', { failedResponses: ['500 /api/sessions'] }],
    ['focus that never moved', { focusIndexAfter: '1' }],
    ['focus that vanished', { focusIndexAfter: null }],
    ['selection that never moved', { selectedIndexAfter: '1' }],
    ['a pane that never changed', { detail: { t0: 'same', t1: 'same', t2: 'other' } }],
    // AC2 seen from the browser: the group-by put nothing on screen.
    ['no turn groups', { turnGroupCount: 0 }],
    // AC1: one response fills the screen. Two AT LOAD means the paging loop came
    // back. Read at load rather than over the drive, because task 5.5 makes a
    // second response the point of the feature — see the pair of tests below.
    ['a second session-detail response at load', { detailResponsesAtLoad: 2 }],
    ['no session-detail response at all', { detailResponsesAtLoad: 0 }],
    [
      'a tool_call row that rendered no input',
      {
        toolCallInline: {
          eventId: 'toolu_1',
          inputPrefix: '{"cmd":"ls"}',
          outputPrefix: 'a.txt',
          inputMatched: false,
          outputMatched: true,
        },
      },
    ],
    [
      'a tool_call row that rendered no output',
      {
        toolCallInline: {
          eventId: 'toolu_1',
          inputPrefix: '{"cmd":"ls"}',
          outputPrefix: 'a.txt',
          inputMatched: true,
          outputMatched: false,
        },
      },
    ],
    // Task 7.3's alarm, both directions. A silent alarm is the defect the whole
    // task exists to prevent, so an unreachable probe scores like the live
    // probe's null branch rather than the tool-call probe's warning.
    ['a drift probe that could not reach the transcript', { driftBanner: null }],
    [
      'an alarm that never raised on an unrecognised record',
      { driftBanner: { before: 0, after: 0, appendedType: 'render_gate_unknown_record' } },
    ],
    [
      'an alarm already on screen before any drift existed',
      { driftBanner: { before: 1, after: 1, appendedType: 'render_gate_unknown_record' } },
    ],
  ])('reds on %s', (_label, overrides) => {
    const report = buildReport({
      task: '0.3',
      startedAt: '2026-08-08T00:00:00.000Z',
      result: passingResult(overrides),
      error: null,
    });
    expect(report.ok).toBe(false);
  });

  it('reds when a screenshot is too small to be a picture of anything', () => {
    /*
     * ★ THE SPOILED SHOT IS DERIVED, NEVER LISTED. An earlier spelling built a
     * short literal array, so the next task to add a screenshot made this test
     * red on `shot-count` and stop exercising the byte threshold at all — green
     * arithmetic hiding a check that no longer ran. Mapping over `PASSING_SHOTS`
     * keeps the COUNT correct by construction whatever the shot set becomes,
     * and spoils exactly one byte reading.
     */
    const shots = PASSING_SHOTS.map((shot, i) =>
      i === PASSING_SHOTS.length - 1 ? { ...shot, bytes: 7_150 } : shot,
    );
    const report = buildReport({
      task: '0.3',
      startedAt: '2026-08-08T00:00:00.000Z',
      result: { ...passingObservations(), shots },
      error: null,
    });

    expect(shots).toHaveLength(SHOT_NAMES.length);
    expect(report.assertions.find((a) => a.name === 'shot-count')?.ok).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('reports an absent tool_call payload as an observation, never as a pass', () => {
    /*
     * ★ THE 5.1 PRECEDENT. Whether a rendered `tool_call` row carries both
     * halves of its payload is a fact about the corpus, not about the screen.
     * A green tick on an empty window would be a check that cannot fail, so the
     * assertion is not emitted at all and a warning says so out loud.
     */
    const report = buildReport({
      task: '5.2',
      startedAt: '2026-08-30T00:00:00.000Z',
      // Both, because one search feeds both probes: a window with nothing to
      // click leaves the row reading and the pane reading equally unmade.
      result: passingResult({ toolCallInline: null, eventDetail: null }),
      error: null,
    });

    expect(report.assertions.map((a) => a.name)).not.toContain('tool-call-inline');
    expect(report.assertions.map((a) => a.name)).not.toContain('detail-event-payload');
    expect(report.warnings.join(' ')).toContain('tool-call-inline: none in window');
    expect(report.ok, 'an absent row is not a product failure').toBe(true);
  });

  it('asserts the pane reading, and names all three of its clauses (AC-R1)', () => {
    const report = buildReport({
      task: '5.3',
      startedAt: '2026-08-30T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    const probe = report.assertions.find((a) => a.name === 'detail-event-payload');

    expect(probe?.ok).toBe(true);
    expect(probe?.actual).toContain('toolu_1');
    expect(probe?.actual).toContain('inline');
  });

  it.each([
    ['the pane never showed the input', { inputMatched: false }],
    ['the pane never showed the output', { outputMatched: false }],
    // The clause that separates 5.3 from 5.2: a pane can carry both bodies and
    // still never say where the output came from.
    ['the pane never named the storage', { storageMatched: false }],
  ])('reds when %s', (_label, overrides) => {
    const eventDetail = { ...passingObservations().eventDetail!, ...overrides };
    const report = buildReport({
      task: '5.3',
      startedAt: '2026-08-30T00:00:00.000Z',
      result: passingResult({ eventDetail }),
      error: null,
    });
    expect(report.ok).toBe(false);
  });

  it('no longer warns about a placeholder that no longer exists', () => {
    // Task 5.3 deleted the pane's placeholder, so the regex that matched it
    // could never fire again. A warning nobody can trip has stopped being
    // reviewed — the same objection `retokenized.test.ts` makes about a stale
    // allowlist entry.
    const report = buildReport({
      task: '5.3',
      startedAt: '2026-08-30T00:00:00.000Z',
      result: passingResult({
        detail: { t0: 'Select a span to see its detail.', t1: 'a', t2: 'b' },
      }),
      error: null,
    });

    expect(report.warnings.join(' ')).not.toContain('placeholder');
    for (const { text } of gateSources()) expect(text).not.toContain('PLACEHOLDER_DETAIL');
  });

  it('asserts the payload cross-check whenever the window held a row to check', () => {
    const report = buildReport({
      task: '5.2',
      startedAt: '2026-08-30T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    const probe = report.assertions.find((a) => a.name === 'tool-call-inline');
    expect(probe?.ok).toBe(true);
    expect(probe?.actual).toContain('toolu_1');
  });

  it('asserts the thread reading, and names both of its clauses (AC-R1, task 5.4)', () => {
    const report = buildReport({
      task: '5.4',
      startedAt: '2026-08-30T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    const names = report.assertions.map((a) => a.name);

    expect(names).toContain('thread-tool-inline');
    expect(names).toContain('thread-thinking-markers');
    expect(report.assertions.find((a) => a.name === 'thread-tool-inline')?.actual).toContain(
      'toolu_1',
    );
    // The clause that separates 5.4 from 5.3: this row was read off
    // `data-thread-kind`, which `SpanRow` does not render.
    expect(report.assertions.find((a) => a.name === 'thread-tool-inline')?.expected).toContain(
      'data-thread-kind="tool"',
    );
  });

  it.each([
    ['the thread row showed no input', { inputMatched: false }],
    ['the thread row showed no output', { outputMatched: false }],
    // Clause 3, restated: no fold key reduces the count, so the honest reading
    // is equality. A row short of an event is a dropped `thinking` block.
    ['a thinking event rendered no row', { thinkingRows: 2 }],
    ['a thinking row carried something other than the marker', { markerRows: 2 }],
    ['a thinking row rendered empty', { emptyRows: 1, markerRows: 2 }],
  ])('reds when %s', (_label, overrides) => {
    const threadInline = { ...passingObservations().threadInline!, ...overrides };
    const report = buildReport({
      task: '5.4',
      startedAt: '2026-08-30T00:00:00.000Z',
      result: passingResult({ threadInline }),
      error: null,
    });
    expect(report.ok).toBe(false);
  });

  it('FAILS on an absent thread control rather than warning about it', () => {
    /*
     * ★ THE ONE PLACE 5.4 DEPARTS FROM THE 5.1 PRECEDENT, DELIBERATELY.
     * `toolCallInline` degrades to a warning because the tree virtualizer
     * decides which rows exist to read; the thread has no virtualizer, and
     * MEASURED 293 of 293 sessions carry a qualifying `tool_call`. So no corpus
     * fact can empty this probe — a null can only mean the control did not
     * work, and a warning there would ship a green gate over a dead feature.
     */
    const report = buildReport({
      task: '5.4',
      startedAt: '2026-08-30T00:00:00.000Z',
      result: passingResult({ threadInline: null }),
      error: null,
    });

    expect(report.ok).toBe(false);
    const reached = report.assertions.find((a) => a.name === 'thread-reached');
    expect(reached?.ok).toBe(false);
    expect(report.warnings.join(' ')).not.toContain('thread');
  });

  it('asserts the live tail, and names all three of its clauses (AC-R1, task 6.2)', () => {
    const report = buildReport({
      task: '6.2',
      startedAt: '2026-09-01T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    const names = report.assertions.map((a) => a.name);

    expect(names).toContain('live-row-growth');
    expect(names).toContain('live-no-navigation');
    expect(names).toContain('live-splice-request');
    expect(report.assertions.find((a) => a.name === 'live-row-growth')?.actual).toContain(
      '30 -> 31',
    );
    // The clause that separates 6.2 from a page reload wearing a tail's clothes.
    expect(report.assertions.find((a) => a.name === 'live-no-navigation')?.expected).toContain(
      'no reload',
    );
  });

  it.each([
    ['the tree never grew', { after: 30 }],
    ['the tree shrank', { after: 29 }],
    // ★ A NULL READING FAILS. `totalRows` is derived from the virtualizer's own
    // canvas and degrades to null behind a plausibility guard — the right answer
    // for a reading nobody acts on, and the wrong one where the reading IS the
    // acceptance criterion. The thread probe's semantics, not the tool call's.
    ['the before reading was underivable', { before: null }],
    ['the after reading was underivable', { after: null }],
    ['the page navigated instead of splicing', { navigations: 1 }],
    ['the list route was asked again', { listResponses: 1 }],
    ['no page was fetched, so the rows came from somewhere else', { detailResponses: 0 }],
  ])('reds when %s', (_label, overrides) => {
    const liveUpdate = { ...passingObservations().liveUpdate!, ...overrides };
    const report = buildReport({
      task: '6.2',
      startedAt: '2026-09-01T00:00:00.000Z',
      result: passingResult({ liveUpdate }),
      error: null,
    });
    expect(report.ok).toBe(false);
  });

  it('FAILS on a transcript it could not grow rather than warning about it', () => {
    /*
     * The thread probe's precedent, for the same reason. `toolCallInline`
     * degrades because a virtualizer decides which rows exist to read; nothing
     * decides that here — the probe grows the archive ITSELF, so an empty answer
     * can only mean the tail did not arrive. For task 6.2 that is the acceptance
     * criterion, and a warning would ship a green gate over a dead feature.
     */
    const report = buildReport({
      task: '6.2',
      startedAt: '2026-09-01T00:00:00.000Z',
      result: passingResult({ liveUpdate: null }),
      error: null,
    });

    expect(report.ok).toBe(false);
    expect(report.assertions.find((a) => a.name === 'live-update-reached')?.ok).toBe(false);
    expect(report.warnings.join(' ')).not.toContain('live');
  });

  it('closes the sub-agent response window BEFORE the live splice (task 6.2)', () => {
    /*
     * ★ THE ONE 5.5 ASSERTION 6.2 COULD HAVE BROKEN SILENTLY. The splice fetches
     * a page of its own, so a window open to the end of the drive would see two
     * further responses and red `subagent-expansion-request` on a working
     * product. The window is `[atLoad, beforeLive)`.
     */
    const report = buildReport({
      task: '6.2',
      startedAt: '2026-09-01T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    const request = report.assertions.find((a) => a.name === 'subagent-expansion-request');

    expect(request?.ok, 'the third response is the live splice, not the expansion').toBe(true);
    expect(request?.actual).toBe('/api/sessions/child-1');
  });

  it('expects a thread screenshot, so AC-R2 is not decoration (task 5.4)', () => {
    // Without `06-thread.png` the founder opens the contact sheet for a thread
    // task and sees five pictures of the tree, which the plan index forbids by
    // name. The literal is pinned because nothing else pins it.
    const report = buildReport({
      task: '5.4',
      startedAt: '2026-08-30T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    const count = report.assertions.find((a) => a.name === 'shot-count');

    expect(count?.ok).toBe(true);
    expect(count?.expected).toBe(`${SHOT_NAMES.length} screenshots`);
    expect(report.shots.map((s) => s.name)).toContain('06-thread.png');
  });

  /* ------------------------- task 5.5 — the sub-agent expansion ----------- */

  it('reads session-detail-responses AT LOAD, so an expansion cannot red it (Test 18)', () => {
    // The whole point of task 5.5 is a SECOND `/api/sessions/:id` response, so
    // the pre-5.5 spelling (`detailResponses === 1` over the drive) would red on
    // the working feature. This is the half that has to keep passing.
    const report = buildReport({
      task: '5.5',
      startedAt: '2026-08-31T00:00:00.000Z',
      result: passingResult({
        detailResponsesAtLoad: 1,
        detailPaths: ['/api/sessions/sess-1', '/api/sessions/child-1'],
      }),
      error: null,
    });
    const responses = report.assertions.find((a) => a.name === 'session-detail-responses');

    expect(responses?.ok).toBe(true);
    expect(responses?.actual).toContain('1 at load');
    expect(responses?.actual, 'the drive total is still reported, just not asserted').toContain(
      '2 over the drive',
    );
  });

  it.each([
    [
      'zero extra responses — the self-cancelling effect (Test 19)',
      {
        detailPaths: ['/api/sessions/sess-1'],
        detailResponsesAtLoad: 1,
        detailResponsesBeforeLive: 1,
      },
    ],
    [
      'two extra responses',
      {
        detailPaths: ['/api/sessions/sess-1', '/api/sessions/child-1', '/api/sessions/child-2'],
        detailResponsesAtLoad: 1,
        detailResponsesBeforeLive: 3,
      },
    ],
    [
      'an extra response for a session that is not the child',
      {
        detailPaths: ['/api/sessions/sess-1', '/api/sessions/somebody-else'],
        detailResponsesBeforeLive: 2,
      },
    ],
  ])('subagent-expansion-request reds on %s', (_label, overrides) => {
    /*
     * ★ THE ZERO-EXTRA CASE IS THE ONLY AUTOMATED WITNESS OF THE SELF-CANCELLING
     * FETCH EFFECT. With `sub` or `rows` in that effect's dependency array, the
     * `requested` dispatch re-renders, the cleanup aborts the request it just
     * issued, and the re-run asks for nothing because the id is pending — so the
     * child never loads and the drive sees no second response. The UI project
     * cannot see it at all: effects do not fire under `environment: 'node'`.
     */
    const report = buildReport({
      task: '5.5',
      startedAt: '2026-08-31T00:00:00.000Z',
      result: passingResult(overrides),
      error: null,
    });

    expect(report.assertions.find((a) => a.name === 'subagent-expansion-request')?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('subagent-nested-rows reds when the nested rows carry the PARENT’s id (Test 19)', () => {
    // The exact symptom of a splice that carries a depth offset and no session
    // id: every row lands at the right indent and every one of them lies about
    // which transcript it came from.
    const report = buildReport({
      task: '5.5',
      startedAt: '2026-08-31T00:00:00.000Z',
      result: passingResult({
        subagentExpansion: {
          parentSessionId: 'sess-1',
          childSessionId: 'child-1',
          nestedEventSessionIds: ['sess-1'],
        },
      }),
      error: null,
    });

    expect(report.assertions.find((a) => a.name === 'subagent-nested-rows')?.ok).toBe(false);
  });

  it('warns and asserts nothing when the session spawned no sub-agent (Test 20)', () => {
    /*
     * ★ THE 5.1 PRECEDENT AGAIN, and it applies here where it does NOT apply to
     * the thread probe: whether a session holds an Agent row is a fact about the
     * corpus, measured at 6 of 21 top-level sessions with none. A red there
     * would fail the gate for something the product did not do.
     */
    const report = buildReport({
      task: '5.5',
      startedAt: '2026-08-31T00:00:00.000Z',
      result: passingResult({ subagentExpansion: null }),
      error: null,
    });

    expect(report.ok).toBe(true);
    expect(report.assertions.map((a) => a.name)).not.toContain('subagent-expansion-request');
    expect(report.assertions.map((a) => a.name)).not.toContain('subagent-nested-rows');
    expect(report.warnings.join(' ')).toContain('subagent-expansion: no Agent row');
    expect(renderContactSheet(report)).toContain('subagent-expansion: no Agent row');
  });

  it('expects a sub-agent screenshot, so AC-R2 is not decoration (Test 21)', () => {
    // Mirrors 5.4's twin above. Without `07-subagent.png` the founder opens the
    // contact sheet for a sub-agent task and sees six pictures without one.
    const report = buildReport({
      task: '5.5',
      startedAt: '2026-08-31T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    const count = report.assertions.find((a) => a.name === 'shot-count');

    expect(count?.ok).toBe(true);
    expect(count?.expected).toBe(`${SHOT_NAMES.length} screenshots`);
    expect(count?.expected).toBe('9 screenshots');
    expect(report.shots.map((s) => s.name)).toContain('07-subagent.png');
    // Nothing is asserted about its POSITION in the array. The real drive shoots
    // it BEFORE `06-thread.png`, because the thread toggle has no trip back — so
    // a last-element pin here would pass on this fixture and describe a drive
    // order that does not exist.
  });

  it('expects a drift screenshot, because no clean session can produce one (Test 12)', () => {
    // The corpus is clean — measured 291 of 293 sessions — so this is the only
    // shot in the set that can hold an alarm at all. Without it the founder
    // opens the contact sheet for the alarm task and sees eight pictures of a
    // product behaving normally.
    const report = buildReport({
      task: '7.3',
      startedAt: '2026-09-01T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    const count = report.assertions.find((a) => a.name === 'shot-count');

    expect(count?.ok).toBe(true);
    expect(report.shots.map((s) => s.name)).toContain('09-drift.png');
  });

  it('names both sides of the alarm, so neither can discharge the other (Test 13)', () => {
    // A probe that only read the raise would pass over a banner stuck on, which
    // is AC3's failure; one that only read the silence would pass over a dead
    // alarm, which is AC2's. Two records, and the `reds on` rows above spoil
    // each independently.
    const report = buildReport({
      task: '7.3',
      startedAt: '2026-09-01T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    const names = report.assertions.map((a) => a.name);

    expect(names).toContain('drift-banner-silent-when-clean');
    expect(names).toContain('drift-banner-raised');
    // Never a warning: `null` is a failing assertion, not an observation.
    expect(report.warnings.join(' ')).not.toContain('drift-banner');
  });

  it('carries the two new readings into the report and the contact sheet', () => {
    const report = buildReport({
      task: '5.2',
      startedAt: '2026-08-30T00:00:00.000Z',
      result: passingResult(),
      error: null,
    });
    expect(report.turnGroupCount).toBe(2);
    expect(report.detailResponses).toBe(3);
    expect(renderContactSheet(report)).toContain('2 turn group(s)');
  });

  it('turns a drive that never finished into a failed assertion, not an absent one', () => {
    const report = buildReport({
      task: '0.3',
      startedAt: '2026-08-08T00:00:00.000Z',
      result: null,
      error: 'render-gate: overall deadline of 50ms elapsed',
    });

    expect(report.ok).toBe(false);
    const run = report.assertions.find((a) => a.name === 'run-completed');
    expect(run?.ok).toBe(false);
    expect(run?.actual).toContain('deadline');
  });
});

describe('evaluateDetail (AC3) — the three-state transition', () => {
  const distinct = { t0: 'placeholder', t1: 'detail a', t2: 'detail b' };

  it('passes on three distinct non-empty strings', () => {
    expect(evaluateDetail(distinct).every((r) => r.ok)).toBe(true);
  });

  it.each([
    ['an inert pane / unwired click (t1 === t0)', { ...distinct, t1: distinct.t0 }],
    ['a dead keyboard path (t2 === t1)', { ...distinct, t2: distinct.t1 }],
    ['an empty t0', { ...distinct, t0: '' }],
    ['an empty t1', { ...distinct, t1: '' }],
    ['an empty t2', { ...distinct, t2: '' }],
  ])('fails on %s', (_label, detail) => {
    expect(evaluateDetail(detail).some((r) => !r.ok)).toBe(true);
  });
});

describe('renderContactSheet (AC5)', () => {
  const report = buildReport({
    task: '0.3',
    startedAt: '2026-08-08T00:00:00.000Z',
    result: passingResult({
      // Real transcript text: a turn label carries harness tags in angle brackets.
      labels: [{ index: 0, text: '<local-command-caveat> & "quoted"' }],
      detail: { t0: 'T-zero <b>', t1: 'T-one <i>', t2: 'T-two <u>' },
    }),
    error: null,
  });
  const html = renderContactSheet(report);

  // Over `SHOT_NAMES` rather than a literal list: the literal had gone stale by
  // two tasks, so a shot could be added and never checked to reach the sheet.
  it.each(SHOT_NAMES)('references %s', (name) => {
    expect(html).toContain(name);
  });

  it('embeds all three detail texts', () => {
    expect(html).toContain('T-zero');
    expect(html).toContain('T-one');
    expect(html).toContain('T-two');
  });

  it('escapes the angle brackets and quotes real labels carry', () => {
    expect(html).toContain('&lt;local-command-caveat&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).not.toContain('<local-command-caveat>');
    expect(html).not.toContain('T-zero <b>');
  });
});

describe('runRenderGate (AC1) — the exit code follows the assertions', () => {
  it('resolves 0 and writes both artifacts when every assertion passes', async () => {
    const outRoot = tempRoot();
    const code = await runRenderGate({
      task: '0.3',
      outRoot,
      driver: () => Promise.resolve(passingOutcome()),
    });

    expect(code).toBe(0);
    const outDir = join(outRoot, '.render-gate', '0.3');
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.shots.map((s: { name: string }) => s.name)).toEqual([
      '01-sessions.png',
      '02-session.png',
      '03-detail.png',
      '04-focus.png',
      '05-tool-call.png',
      '06-thread.png',
      '07-subagent.png',
      '08-live.png',
      '09-drift.png',
    ]);
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).toContain('01-sessions.png');
    // The bytes asserted are the bytes on disk.
    expect(readFileSync(join(outDir, '01-sessions.png')).length).toBe(MIN_SHOT_BYTES + 1);
  });

  it('resolves non-zero and still writes both artifacts when one assertion fails', async () => {
    const outRoot = tempRoot();
    const code = await runRenderGate({
      task: '0.3',
      outRoot,
      driver: () => Promise.resolve(passingOutcome({ sessionCount: 0 })),
    });

    expect(code).toBe(1);
    const outDir = join(outRoot, '.render-gate', '0.3');
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    expect(report.ok).toBe(false);
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).toContain('01-sessions.png');
  });

  it('resolves non-zero on a wait that never settles, and runs the cleanups', async () => {
    const outRoot = tempRoot();
    let cleaned = false;

    const code = await runRenderGate({
      task: '0.3',
      outRoot,
      deadlineMs: 50,
      driver: (ctx) => {
        ctx.onCleanup(async () => {
          cleaned = true;
        });
        // The shape of a selector wait that is never satisfied.
        return new Promise<DriveOutcome>(() => {});
      },
    });

    expect(code).toBe(1);
    expect(cleaned).toBe(true);
    const outDir = join(outRoot, '.render-gate', '0.3');
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    expect(report.assertions.find((a: { name: string }) => a.name === 'run-completed').ok).toBe(
      false,
    );
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).toContain('render-gate');
  });
});

describe('the gate source itself (AC6)', () => {
  it('contains no waitForTimeout anywhere', () => {
    const sources = gateSources();

    // Vacuity guard: an empty scan would make the assertion below meaningless.
    expect(sources.map((s) => s.file)).toEqual(['index.ts', 'report.ts']);

    for (const { file, text } of sources) {
      expect(text, `${file} must not sleep — every wait is a selector or a function`).not.toMatch(
        /waitForTimeout/,
      );
    }
  });

  it('every SELECTORS value is a data-slot that exists in ui/src', () => {
    const values = Object.values(SELECTORS);

    // Vacuity guard: a silently-shrinking constant would trivially satisfy the
    // loop. RAISED 9 -> 10 BY TASK 7.3, in lockstep with the tenth real slot
    // (`drift-banner`) that the same commit READS in `probeDriftBanner` and
    // `DriftBanner.tsx` renders. 5.5 raised it 8 -> 9 for `span-expand` and 5.4
    // raised it 7 -> 8 for `thread-toggle`, on the same terms — the invariant
    // this guards is a constant that shrinks unnoticed. `thread-view` is
    // deliberately NOT an entry: a slot no drive touches is the vacuity this
    // guard exists to catch.
    expect(values).toHaveLength(10);
    expect(new Set(values).size).toBe(10);

    for (const slot of values) {
      const found = execFileSync('grep', ['-rl', `data-slot="${slot}"`, UI_SRC], {
        encoding: 'utf8',
      }).trim();
      expect(found, `data-slot="${slot}" is not in ui/src`).not.toBe('');
    }
  });

  /*
   * ★ THE PURE HALF OF THE PROBE, AND ONLY THE PURE HALF.
   *
   * The choreography around this — click, wait for `aria-selected`, wait for
   * the pane's `data-event-id`, read, shoot — is Playwright, and faking a
   * `Page` for it would mean an `as unknown as Page` double over `locator`,
   * `waitForSelector`, `$$eval` and `screenshot`. That is the same shape as the
   * plan-001 test that provably could not be written in this environment. The
   * live gate run covers the choreography; this covers the decision, which is
   * the split `isSessionDetailPath` already uses.
   */
  describe('pickPayloadRow — which rendered row is worth clicking (AC-R1)', () => {
    const wire = (overrides: Partial<WireEvent> & { id: string }): WireEvent => ({
      kind: 'tool_call',
      input: '{"file_path":"a.txt"}',
      text: 'ok',
      output_storage: 'inline',
      ...overrides,
    });
    const map = (...events: WireEvent[]): Map<string, WireEvent> =>
      new Map(events.map((event) => [event.id, event]));

    it('reads the RENDERED rows and never the wire order', () => {
      /*
       * The window is the constraint. `SpanTree` emits ~34 rows into a 720px
       * viewport, and a `.click()` on a locator for a row the virtualizer never
       * rendered throws after PER_WAIT_TIMEOUT_MS and fails the whole drive —
       * it does NOT degrade to the null observation. So a wire event with no
       * row on screen is not a candidate, however good its payload is.
       */
      const payloads = map(wire({ id: 'off-screen' }), wire({ id: 'rendered' }));
      const picked = pickPayloadRow([{ id: 'rendered', text: 'tool Read' }], payloads);

      expect(picked?.id).toBe('rendered');
    });

    it('takes the first rendered row that qualifies, in row order', () => {
      const payloads = map(wire({ id: 'a' }), wire({ id: 'b' }));
      const rows = [
        { id: 'unknown-to-the-wire', text: '' },
        { id: 'b', text: '' },
        { id: 'a', text: '' },
      ];

      expect(pickPayloadRow(rows, payloads)?.id).toBe('b');
    });

    it.each([
      ['no input', { input: null }],
      ['no output', { text: null }],
      // AC-R1's third clause needs a word to look for. A row without one would
      // make the clause unassertable rather than failing it.
      ['no storage word', { output_storage: null }],
    ])('skips a row with %s', (_label, missing) => {
      const payloads = map(wire({ id: 'incomplete', ...missing }), wire({ id: 'whole' }));
      const rows = [
        { id: 'incomplete', text: '' },
        { id: 'whole', text: '' },
      ];

      expect(pickPayloadRow(rows, payloads)?.id).toBe('whole');
    });

    it('answers null when nothing on screen qualifies', () => {
      // The observation path. `report.ts` emits no assertion and warns instead:
      // a check that cannot fail is not a pass.
      expect(pickPayloadRow([{ id: 'x', text: '' }], map(wire({ id: 'y' })))).toBeNull();
      expect(pickPayloadRow([], map(wire({ id: 'y' })))).toBeNull();
    });

    it('narrows the three fields so the caller needs no null check', () => {
      const picked = pickPayloadRow([{ id: 'a', text: '' }], map(wire({ id: 'a' })));

      expect(picked).not.toBeNull();
      expect(picked?.input).toBe('{"file_path":"a.txt"}');
      expect(picked?.output_storage).toBe('inline');
    });
  });

  it('counts a session-detail response, and nothing that merely looks like one', () => {
    // The list route has no path segment, so `startsWith('/api/sessions')`
    // would count it and AC1's "exactly one" would be off by one for free.
    expect(isSessionDetailPath('http://localhost:5173/api/sessions/abc-123')).toBe(true);
    expect(isSessionDetailPath('http://localhost:5173/api/sessions?limit=50')).toBe(false);
    expect(isSessionDetailPath('http://localhost:5173/api/sessions')).toBe(false);
    expect(isSessionDetailPath('http://localhost:5173/api/events/abc/content')).toBe(false);
    expect(isSessionDetailPath('http://localhost:5173/api/sessions/abc/extra')).toBe(false);
    expect(isSessionDetailPath('not a url')).toBe(false);
  });

  it('suppresses exactly one path, and only the one that was measured', () => {
    // A suppression list is where a real 404 goes to hide. `/favicon.ico` 404s
    // under Vite dev only — the packaged server answers it from the SPA
    // catch-all — and it was observed on the 2026-08-08 run.
    expect([...IGNORED_PATHS]).toEqual(['/favicon.ico']);
  });

  it('registers the drift revert BEFORE the append, and below the live probe (Test 14)', () => {
    /*
     * ★ THREE SOURCE ORDERINGS NO UNIT TEST CAN REACH, ALL LOAD-BEARING.
     *
     *   - The truncate is registered before the write, so no window exists in
     *     which the appended record can outlive the run. This is the ONLY
     *     witness of that order — a probe that appended first would pass every
     *     other assertion here and leave bytes in the dev archive on a crash.
     *   - `probeDriftBanner` sits BELOW `probeLiveUpdate` in the file, because
     *     `fs-write-sites.test.ts` keys its entries by source order: a probe
     *     placed above would re-key `#5` and `#6` onto the wrong call sites
     *     while every one of those entries still read as reviewed.
     *   - The drive calls it AFTER `probeThreadInline`. An unrecognised line
     *     becomes an event row, so an earlier append would move the `totalRows`
     *     reading the live probe's whole assertion rests on.
     */
    const index = gateSources().find((s) => s.file === 'index.ts')!.text;

    const drift = index.indexOf('async function probeDriftBanner');
    expect(drift, 'probeDriftBanner is not in the gate source').toBeGreaterThan(-1);
    expect(
      drift,
      'moving it above probeLiveUpdate re-keys fs-write-sites #5 and #6',
    ).toBeGreaterThan(index.indexOf('async function probeLiveUpdate'));

    const body = index.slice(drift);
    expect(body.indexOf('ctx.onCleanup'), 'the revert must register first').toBeLessThan(
      body.indexOf('appendFileSync'),
    );

    expect(index.indexOf('await probeDriftBanner(')).toBeGreaterThan(
      index.indexOf('await probeThreadInline('),
    );
  });

  it("pins the virtualizer's estimate to SpanTree's own constant", () => {
    // `totalRows` is derived from the tree's total size, so a drifted estimate
    // would silently mis-report the window's context.
    const spanTree = readFileSync(join(UI_SRC, 'components', 'session', 'SpanTree.tsx'), 'utf8');
    expect(spanTree).toMatch(new RegExp(`ESTIMATED_ROW_PX = ${ESTIMATED_ROW_PX}\\b`));
  });
});

describe('install carries no browser download (AC1)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

  it('keeps playwright-core in devDependencies only', () => {
    expect(pkg.devDependencies['playwright-core']).toBeDefined();
    expect(pkg.dependencies['playwright-core']).toBeUndefined();
    // `playwright` / `@playwright/test` are what carry the browser postinstall.
    expect(pkg.devDependencies['playwright']).toBeUndefined();
    expect(pkg.devDependencies['@playwright/test']).toBeUndefined();
  });

  it('adds no browser-install script', () => {
    for (const [name, body] of Object.entries(pkg.scripts as Record<string, string>)) {
      expect(body, `${name} must not install browsers`).not.toMatch(/playwright.*install/);
    }
    expect(pkg.scripts['render-gate']).toBe('tsx src/render-gate/index.ts');
  });

  it('drives the installed Chrome by channel, never a downloaded build', () => {
    const index = gateSources().find((s) => s.file === 'index.ts')!.text;
    expect(index).toMatch(/channel: 'chrome'/);
    // A 2x scale factor would multiply every PNG and invalidate MIN_SHOT_BYTES.
    expect(index).toMatch(/deviceScaleFactor: 1/);
  });
});

describe('.render-gate/ is ignored (AC5)', () => {
  it.each(['.render-gate/0.3/report.json', '.render-gate/0.3/01-sessions.png'])(
    'git check-ignore matches %s',
    (path) => {
      const out = execFileSync('git', ['check-ignore', '-v', path], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(out).toContain('.render-gate');
    },
  );

  it('does not over-ignore a source path that merely mentions render-gate', () => {
    // `/.render-gate/` is root-anchored precisely so this stays tracked.
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', 'src/render-gate/index.ts'], {
        cwd: REPO_ROOT,
      }),
    ).toThrow();
  });
});
