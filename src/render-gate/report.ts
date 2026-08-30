// The render gate's assertion model, `report.json` shape and contact sheet.
//
// Pure by design: nothing here touches a browser, a clock or the disk, so every
// rule the gate enforces is decidable in a unit test. `index.ts` owns the
// driving and the writing; this owns what counts as a pass.

/** A near-blank 1440x900 Chrome PNG measured 7,150 bytes. Above it, something painted. */
export const MIN_SHOT_BYTES = 20_000;

/** How many row labels `report.json` carries. Bounded by the virtual window too. */
export const MAX_LABELS = 25;

/** The two strings `SessionView`'s detail pane renders until task 4.5 fills it. */
const PLACEHOLDER_DETAIL = /^Select a span to see its detail\.$|arrives with the detail pane\.$/;

/** One machine-decidable check. `actual`/`expected` are for the human reading it. */
export interface AssertionRecord {
  name: string;
  ok: boolean;
  actual: string;
  expected: string;
}

/** One tree row, keyed by the virtualizer's own `data-index` rather than DOM order. */
export interface RowLabel {
  index: number;
  text: string;
}

export interface DetailTexts {
  /** After the session loads, before anything is selected. */
  t0: string;
  /** After the first span row is clicked. */
  t1: string;
  /** After the keyboard moves selection one row on. */
  t2: string;
}

export interface ShotRecord {
  name: string;
  bytes: number;
}

/** Everything the drive read out of the page. Screenshot bytes are added on write. */
export interface Observations {
  viteUrl: string;
  sessionId: string;
  /** Verbatim, e.g. `"1,204+ sessions"` — the parse is checked against it. */
  sessionCountRaw: string;
  sessionCount: number;
  /** `data-slot="back-to-sessions"` anchors on the open session screen. */
  backLinks: number;
  spanRowCount: number;
  /** The full window capture; `buildReport` is what caps it at `MAX_LABELS`. */
  labels: readonly RowLabel[];
  windowFirstIndex: number | null;
  windowLastIndex: number | null;
  renderedRows: number;
  /** Derived from the virtualizer's total size; `null` when the derivation is unsafe. */
  totalRows: number | null;
  detail: DetailTexts;
  /** `data-index` of the roving `tabindex="0"` row, before and after `ArrowDown`. */
  focusIndexBefore: string | null;
  focusIndexAfter: string | null;
  /** `data-index` of the `aria-selected` row, before and after `Enter`. */
  selectedIndexBefore: string | null;
  selectedIndexAfter: string | null;
  consoleErrors: readonly string[];
  failedResponses: readonly string[];
}

export interface DriveResult extends Observations {
  shots: readonly ShotRecord[];
}

export interface RenderGateReport {
  task: string;
  startedAt: string;
  ok: boolean;
  viteUrl: string | null;
  sessionId: string | null;
  assertions: AssertionRecord[];
  labels: RowLabel[];
  windowFirstIndex: number | null;
  windowLastIndex: number | null;
  renderedRows: number | null;
  totalRows: number | null;
  detail: DetailTexts | null;
  shots: ShotRecord[];
  consoleErrors: string[];
  failedResponses: string[];
  /** Non-blocking notes for the AC-R2 eye. Never affects `ok`. */
  warnings: string[];
}

export interface BuildReportInput {
  task: string;
  startedAt: string;
  /** `null` when the drive threw or the deadline elapsed before it finished. */
  result: DriveResult | null;
  error: string | null;
}

/** A screenshot that is large enough to be a picture of something. */
export function evaluateShot(shot: ShotRecord): AssertionRecord {
  return {
    name: `shot-${shot.name}`,
    ok: shot.bytes > MIN_SHOT_BYTES,
    actual: `${shot.bytes} bytes`,
    expected: `> ${MIN_SHOT_BYTES} bytes`,
  };
}

/**
 * The detail pane, asserted as a TRANSITION rather than a value.
 *
 * The pane sits inside `SessionView`'s unconditional return, so it renders
 * non-empty placeholder text during the pending state — a bare "non-empty"
 * check goes green against a page that fetched nothing and can never fail.
 * Requiring the text to CHANGE reds on an inert pane, on an unwired click and
 * on a dead keyboard path, and stays correct once 4.5 fills the pane for real.
 */
export function evaluateDetail(detail: DetailTexts): AssertionRecord[] {
  const { t0, t1, t2 } = detail;
  return [
    {
      name: 'detail-t0-non-empty',
      ok: t0.length > 0,
      actual: quote(t0),
      expected: 'non-empty text before any selection',
    },
    {
      name: 'detail-t1-changed',
      ok: t1.length > 0 && t1 !== t0,
      actual: quote(t1),
      expected: `non-empty and different from t0 (${quote(t0)})`,
    },
    {
      name: 'detail-t2-changed',
      ok: t2.length > 0 && t2 !== t1,
      actual: quote(t2),
      expected: `non-empty and different from t1 (${quote(t1)})`,
    },
  ];
}

export function buildReport(input: BuildReportInput): RenderGateReport {
  const { task, startedAt, result, error } = input;

  const assertions: AssertionRecord[] = [
    {
      name: 'run-completed',
      ok: result !== null,
      actual: result === null ? (error ?? 'the drive produced no result') : 'the drive finished',
      expected: 'the drive completes inside the overall deadline',
    },
  ];

  if (result !== null) assertions.push(...driveAssertions(result));

  const warnings = result === null ? [] : placeholderWarnings(result.detail);

  return {
    task,
    startedAt,
    ok: assertions.every((a) => a.ok),
    viteUrl: result?.viteUrl ?? null,
    sessionId: result?.sessionId ?? null,
    assertions,
    labels: [...(result?.labels ?? [])].sort((a, b) => a.index - b.index).slice(0, MAX_LABELS),
    windowFirstIndex: result?.windowFirstIndex ?? null,
    windowLastIndex: result?.windowLastIndex ?? null,
    renderedRows: result?.renderedRows ?? null,
    totalRows: result?.totalRows ?? null,
    detail: result?.detail ?? null,
    shots: [...(result?.shots ?? [])],
    consoleErrors: [...(result?.consoleErrors ?? [])],
    failedResponses: [...(result?.failedResponses ?? [])],
    warnings,
  };
}

function driveAssertions(result: DriveResult): AssertionRecord[] {
  return [
    {
      name: 'session-count',
      ok: Number.isFinite(result.sessionCount) && result.sessionCount > 0,
      actual: `${result.sessionCount} (from ${quote(result.sessionCountRaw)})`,
      expected: '> 0',
    },
    {
      // AC-R1's second blocking reading. An open session with no way back to
      // the list is the defect task 5.1 was written to close.
      name: 'back-to-sessions',
      ok: result.backLinks >= 1,
      actual: `${result.backLinks} anchor(s)`,
      expected: '>= 1 on the open session screen',
    },
    {
      name: 'span-rows',
      ok: result.spanRowCount >= 1,
      actual: String(result.spanRowCount),
      expected: '>= 1',
    },
    {
      name: 'console-errors',
      ok: result.consoleErrors.length === 0,
      actual: result.consoleErrors.length === 0 ? 'none' : result.consoleErrors.join(' | '),
      expected: 'no console errors and no page errors',
    },
    {
      name: 'http-errors',
      ok: result.failedResponses.length === 0,
      actual: result.failedResponses.length === 0 ? 'none' : result.failedResponses.join(' | '),
      expected: 'no response with status >= 400',
    },
    ...evaluateDetail(result.detail),
    {
      // `ArrowDown` moves the roving tabindex only — selection is `Enter`'s job.
      name: 'focus-moved',
      ok: result.focusIndexAfter !== null && result.focusIndexAfter !== result.focusIndexBefore,
      actual: `${describeIndex(result.focusIndexBefore)} -> ${describeIndex(result.focusIndexAfter)}`,
      expected: 'ArrowDown moves the roving tabindex to another data-index',
    },
    {
      name: 'selection-moved',
      ok:
        result.selectedIndexAfter !== null &&
        result.selectedIndexAfter !== result.selectedIndexBefore,
      actual: `${describeIndex(result.selectedIndexBefore)} -> ${describeIndex(result.selectedIndexAfter)}`,
      expected: 'Enter moves aria-selected to another data-index',
    },
    {
      name: 'shot-count',
      ok: result.shots.length === 4,
      actual: `${result.shots.length} screenshot(s)`,
      expected: '4 screenshots',
    },
    ...result.shots.map(evaluateShot),
  ];
}

/**
 * The pane still shows 4.5's placeholder. The transition assertions above hold
 * either way, so this is context for the visual sign-off, never a failure.
 */
function placeholderWarnings(detail: DetailTexts): string[] {
  const stale = (['t0', 't1', 't2'] as const).filter((key) => PLACEHOLDER_DETAIL.test(detail[key]));
  if (stale.length === 0) return [];
  return [
    `detail pane still renders the pre-4.5 placeholder at ${stale.join(', ')} — ` +
      'the transitions are real, the content is not',
  ];
}

function describeIndex(index: string | null): string {
  return index === null ? '(none)' : `data-index ${index}`;
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `"${flat.slice(0, 117)}..."` : `"${flat}"`;
}

/* ------------------------------------------------------------ contact sheet --- */

/**
 * The artifact the founder opens for AC-R2's visual sign-off: four shots, the
 * assertion table, and the label capture with its window bounds spelled out —
 * a capture whose bounds are invisible is how "the first 25" became wrong.
 */
export function renderContactSheet(report: RenderGateReport): string {
  const shots =
    report.shots.length === 0
      ? '<p class="empty">No screenshots were captured.</p>'
      : report.shots
          .map(
            (shot) =>
              `<figure><img src="${esc(shot.name)}" alt="${esc(shot.name)}">` +
              `<figcaption>${esc(shot.name)} — ${shot.bytes} bytes</figcaption></figure>`,
          )
          .join('\n');

  return [
    `<title>render gate — task ${esc(report.task)}</title>`,
    '<style>',
    'body{font:13px/1.5 ui-monospace,monospace;margin:2rem;max-width:80rem}',
    'figure{margin:0 0 1.5rem}img{max-width:100%;border:1px solid #ccc}',
    'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.25rem .5rem;text-align:left;vertical-align:top}',
    '.fail{color:#b00}.pass{color:#070}.empty{color:#777}pre{white-space:pre-wrap;margin:0}',
    '</style>',
    `<h1>render gate — task ${esc(report.task)} — ${report.ok ? 'PASS' : 'FAIL'}</h1>`,
    `<p>${esc(report.startedAt)} · session <code>${esc(report.sessionId ?? '(none)')}</code>` +
      ` · <code>${esc(report.viteUrl ?? '(none)')}</code></p>`,
    warningList(report.warnings),
    '<h2>Assertions</h2>',
    '<table><tr><th>assertion</th><th>ok</th><th>actual</th><th>expected</th></tr>',
    ...report.assertions.map(
      (a) =>
        `<tr class="${a.ok ? 'pass' : 'fail'}"><td>${esc(a.name)}</td><td>${a.ok ? 'pass' : 'FAIL'}</td>` +
        `<td>${esc(a.actual)}</td><td>${esc(a.expected)}</td></tr>`,
    ),
    '</table>',
    '<h2>Detail pane</h2>',
    detailTable(report.detail),
    '<h2>Row labels</h2>',
    `<p>${report.labels.length} of up to ${MAX_LABELS}, from the virtualizer's rendered window ` +
      `[${fmt(report.windowFirstIndex)}, ${fmt(report.windowLastIndex)}] ` +
      `of ${fmt(report.totalRows)} total row(s); ${fmt(report.renderedRows)} rendered.</p>`,
    '<table><tr><th>data-index</th><th>label</th></tr>',
    ...report.labels.map((l) => `<tr><td>${l.index}</td><td><pre>${esc(l.text)}</pre></td></tr>`),
    '</table>',
    '<h2>Screenshots</h2>',
    shots,
  ].join('\n');
}

function warningList(warnings: readonly string[]): string {
  if (warnings.length === 0) return '';
  return `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
}

function detailTable(detail: DetailTexts | null): string {
  if (detail === null) return '<p class="empty">The drive never read the detail pane.</p>';
  const rows = (
    [
      ['T0 — before any selection', detail.t0],
      ['T1 — after clicking the first span row', detail.t1],
      ['T2 — after ArrowDown + Enter', detail.t2],
    ] as const
  ).map(([label, text]) => `<tr><td>${esc(label)}</td><td><pre>${esc(text)}</pre></td></tr>`);
  return `<table>${rows.join('')}</table>`;
}

function fmt(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

// Turn labels are real transcript text and carry harness tags in angle brackets.
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
