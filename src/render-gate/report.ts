// The render gate's assertion model, `report.json` shape and contact sheet.
//
// Pure by design: nothing here touches a browser, a clock or the disk, so every
// rule the gate enforces is decidable in a unit test. `index.ts` owns the
// driving and the writing; this owns what counts as a pass.

/** A near-blank 1440x900 Chrome PNG measured 7,150 bytes. Above it, something painted. */
export const MIN_SHOT_BYTES = 20_000;

/** How many row labels `report.json` carries. Bounded by the virtual window too. */
export const MAX_LABELS = 25;

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

/**
 * The AC-R1 payload cross-check: did a rendered `tool_call` row actually carry
 * its input and its output, as fetched from the wire?
 *
 * `null` on `Observations.toolCallInline` means NO qualifying row was inside the
 * virtual window — an observation, never a pass. The corpus decides whether the
 * check has anything to look at, so a green tick there would be a claim about
 * the archive rather than about the screen.
 */
export interface ToolCallProbe {
  eventId: string;
  /** Whitespace-normalised prefix of the wire `input` that was looked for. */
  inputPrefix: string;
  /** The same, for the wire `text` — the tool's output. */
  outputPrefix: string;
  inputMatched: boolean;
  outputMatched: boolean;
}

/**
 * AC-R1 itself: clicking that row filled the DETAIL PANE with the event's real
 * input, its real output, and the word naming where the output was stored.
 *
 * Distinct from `ToolCallProbe` above, which reads the tree ROW. The row shows
 * 96 characters of a body whose measured p99 is 36,168 bytes — 0.27% — so a
 * green row assertion says nothing about whether the pane shows the rest.
 *
 * `null` carries the same meaning it does there: no qualifying row was inside
 * the virtual window, which is a fact about the corpus rather than a pass.
 */
export interface EventDetailProbe {
  eventId: string;
  inputPrefix: string;
  outputPrefix: string;
  /** The row's `output_storage`, verbatim — the word the pane has to print. */
  storageWord: string;
  inputMatched: boolean;
  outputMatched: boolean;
  storageMatched: boolean;
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
  /** `data-slot="trace-group"` headers in the window — turn groups at any depth. */
  turnGroupCount: number;
  /** Responses whose path is `/api/sessions/:id`. StrictMode doubles REQUESTS. */
  detailResponses: number;
  /** `null` when no rendered tool_call row carried both halves. See the type. */
  toolCallInline: ToolCallProbe | null;
  /** The same row, read in the detail pane instead of the tree. See the type. */
  eventDetail: EventDetailProbe | null;
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
  turnGroupCount: number | null;
  detailResponses: number | null;
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

  const warnings = result === null ? [] : driveWarnings(result);

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
    turnGroupCount: result?.turnGroupCount ?? null,
    detailResponses: result?.detailResponses ?? null,
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
      // AC2's group-by, seen from the browser. Counted at ANY depth: a
      // `task_notification` turn folds under the Agent event that spawned it,
      // so a depth-0 count is arithmetically wrong on a folded session.
      name: 'turn-groups',
      ok: result.turnGroupCount >= 1,
      actual: String(result.turnGroupCount),
      expected: '>= 1',
    },
    {
      // AC1: one request fills the screen. RESPONSES, not requests —
      // `main.tsx` wraps the app in StrictMode, so the effect double-invokes
      // and the first fetch is aborted after it is issued. Two requests always
      // reach the wire; exactly one response comes back and fills the screen.
      name: 'session-detail-responses',
      ok: result.detailResponses === 1,
      actual: `${result.detailResponses} response(s)`,
      expected: 'exactly one GET /api/sessions/:id response',
    },
    ...toolCallAssertions(result.toolCallInline),
    ...eventDetailAssertions(result.eventDetail),
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
      // RAISED 4 -> 5 BY TASK 5.3, with `05-tool-call.png`. The literal below
      // is pinned by no test of its own, so leaving it at four would ship a
      // report reading `5 screenshot(s) / expected: 4 screenshots` with
      // `ok: true` — a contact sheet that contradicts itself while passing.
      name: 'shot-count',
      ok: result.shots.length === 5,
      actual: `${result.shots.length} screenshot(s)`,
      expected: '5 screenshots',
    },
    ...result.shots.map(evaluateShot),
  ];
}

/**
 * The payload cross-check, asserted ONLY when the window held something to
 * check. An absent row is a fact about the corpus, so it is reported as a
 * warning instead — the same shape task 5.1 gave `range-straddle: none in
 * corpus`, and for the same reason: a check that cannot fail is not a pass.
 */
function toolCallAssertions(probe: ToolCallProbe | null): AssertionRecord[] {
  if (probe === null) return [];
  return [
    {
      name: 'tool-call-inline',
      ok: probe.inputMatched && probe.outputMatched,
      actual:
        `${probe.eventId}: input ${probe.inputMatched ? 'found' : 'MISSING'} ` +
        `(${quote(probe.inputPrefix)}), output ${probe.outputMatched ? 'found' : 'MISSING'} ` +
        `(${quote(probe.outputPrefix)})`,
      expected: 'the rendered row text contains a prefix of both its input and its output',
    },
  ];
}

/**
 * AC-R1's own assertion: the pane, not the row.
 *
 * All three clauses in one record rather than three, because they are one
 * question — did clicking this row show this event — and a partial pass is not
 * a state anybody would act on differently.
 */
function eventDetailAssertions(probe: EventDetailProbe | null): AssertionRecord[] {
  if (probe === null) return [];
  const found = (ok: boolean): string => (ok ? 'found' : 'MISSING');
  return [
    {
      name: 'detail-event-payload',
      ok: probe.inputMatched && probe.outputMatched && probe.storageMatched,
      actual:
        `${probe.eventId}: input ${found(probe.inputMatched)} (${quote(probe.inputPrefix)}), ` +
        `output ${found(probe.outputMatched)} (${quote(probe.outputPrefix)}), ` +
        `storage ${found(probe.storageMatched)} (${quote(probe.storageWord)})`,
      expected:
        'the detail pane contains a prefix of the input, of the output, and the storage word',
    },
  ];
}

/**
 * Context for the AC-R2 eye. Never affects `ok`.
 *
 * Task 5.3 deleted the pre-5.3 placeholder warning with the placeholder itself.
 * A warning that can never fire has stopped being reviewed, which is the same
 * objection `retokenized.test.ts` raises about a stale allowlist entry.
 */
function driveWarnings(result: DriveResult): string[] {
  const warnings: string[] = [];
  if (result.toolCallInline === null) {
    warnings.push(
      'tool-call-inline: none in window — OBSERVED, NOT ASSERTED. No rendered ' +
        'tool_call row carried both an input and an output, so the payload ' +
        'cross-check had nothing to look at on this session.',
    );
  }
  return warnings;
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
    `<p>${report.turnGroupCount === null ? 'unknown' : report.turnGroupCount} turn group(s) ` +
      `in the window; ${fmt(report.detailResponses)} session-detail response(s).</p>`,
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
