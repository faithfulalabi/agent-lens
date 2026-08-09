// AC-R1's own guard rail. The gate itself is what discharges AC-R1 on a real
// corpus; these tests pin the parts a vitest worker CAN own — the pure report
// model, the argv parser, the selector constant, and the exit-code contract —
// so a gate that silently stopped asserting anything reds here first.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ESTIMATED_ROW_PX,
  IGNORED_PATHS,
  SELECTORS,
  parseArgv,
  runRenderGate,
  type DriveOutcome,
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
    spanRowCount: 4,
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

const SHOT_NAMES = ['01-sessions.png', '02-session.png', '03-detail.png', '04-focus.png'];

/** Four screenshots that clear the byte threshold, so only the override can red. */
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
    ['no span rows', { spanRowCount: 0 }],
    ['a console error', { consoleErrors: ['boom'] }],
    ['a 500 response', { failedResponses: ['500 /api/sessions'] }],
    ['focus that never moved', { focusIndexAfter: '1' }],
    ['focus that vanished', { focusIndexAfter: null }],
    ['selection that never moved', { selectedIndexAfter: '1' }],
    ['a pane that never changed', { detail: { t0: 'same', t1: 'same', t2: 'other' } }],
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
    const report = buildReport({
      task: '0.3',
      startedAt: '2026-08-08T00:00:00.000Z',
      result: {
        ...passingObservations(),
        shots: [...PASSING_SHOTS.slice(0, 3), { name: '04-focus.png', bytes: 7_150 }],
      },
      error: null,
    });
    expect(report.ok).toBe(false);
  });

  it('records a non-blocking warning when the pane still shows the 5.4 placeholder', () => {
    const report = buildReport({
      task: '0.3',
      startedAt: '2026-08-08T00:00:00.000Z',
      result: passingResult({
        detail: {
          t0: 'Select a span to see its detail.',
          t1: 'Span detail for a arrives with the detail pane.',
          t2: 'Span detail for b arrives with the detail pane.',
        },
      }),
      error: null,
    });

    expect(report.warnings.length).toBeGreaterThan(0);
    // A warning is context for AC-R2's eye, never a failure.
    expect(report.ok).toBe(true);
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

  it.each(['01-sessions.png', '02-session.png', '03-detail.png', '04-focus.png'])(
    'references %s',
    (name) => {
      expect(html).toContain(name);
    },
  );

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

    // Vacuity guard: a silently-shrinking constant would trivially satisfy the loop.
    expect(values).toHaveLength(6);
    expect(new Set(values).size).toBe(6);

    for (const slot of values) {
      const found = execFileSync('grep', ['-rl', `data-slot="${slot}"`, UI_SRC], {
        encoding: 'utf8',
      }).trim();
      expect(found, `data-slot="${slot}" is not in ui/src`).not.toBe('');
    }
  });

  it('suppresses exactly one path, and only the one that was measured', () => {
    // A suppression list is where a real 404 goes to hide. `/favicon.ico` 404s
    // under Vite dev only — the packaged server answers it from the SPA
    // catch-all — and it was observed on the 2026-08-08 run.
    expect([...IGNORED_PATHS]).toEqual(['/favicon.ico']);
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
