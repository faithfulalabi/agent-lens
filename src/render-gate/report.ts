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

/**
 * AC-R1 for task 5.4: what the THREAD showed, read off `data-thread-kind` rows.
 *
 * ★ `null` DOES NOT MEAN "NOTHING TO CHECK" HERE, AND THAT IS THE POINT.
 * `ToolCallProbe` above may be absent because the tree virtualizer rendered no
 * qualifying row — a fact about the window, not about the product. The thread
 * has no virtualizer and MEASURED 293 of 293 sessions carry a `tool_call` with
 * both halves, so no corpus fact can empty this probe. The only remaining cause
 * is a control that does not work, and a warning there would ship a green gate
 * over a dead feature. `threadAssertions` fails on `null`.
 */
export interface ThreadProbe {
  eventId: string;
  /** Whitespace-normalised prefix of the wire `input` that was looked for. */
  inputPrefix: string;
  /** The same, for the wire `text` — the tool's output. */
  outputPrefix: string;
  inputMatched: boolean;
  outputMatched: boolean;
  /** `[data-thread-kind="thinking"]` rows in the document. */
  thinkingRows: number;
  /** `kind === 'thinking'` events in the one detail response. */
  thinkingEvents: number;
  /** Of those rows, how many carry the elided-reasoning string verbatim. */
  markerRows: number;
  /** Of those rows, how many render no text at all. Must be zero. */
  emptyRows: number;
}

/**
 * AC-R1 for task 5.5: opening an Agent row fetched exactly its own sidecar, and
 * the sidecar's rows landed under it carrying the sidecar's identity.
 *
 * ★ `null` IS A WARNING, NOT A FAILURE — and unlike the thread probe, that is
 * decided by the corpus rather than by the product. MEASURED, 6 of 21 top-level
 * sessions spawned no sub-agent at all, so the driven session may honestly hold
 * no Agent row to open. `toolCallAssertions` is the precedent.
 *
 * The response half is NOT recorded here. It is read off `detailPaths` and
 * `detailResponsesAtLoad` instead, because a count the probe carried would go
 * vacuous the moment the probe warned off.
 */
export interface SubagentProbe {
  /** `data-session-id` on the Agent row that was opened. */
  parentSessionId: string;
  /** `data-child-session-id` on that same row — the sidecar it names. */
  childSessionId: string;
  /**
   * `data-session-id` off every nested EVENT row that appeared. An event row,
   * not a turn row: the turn row is the one a `depthOffset`-only splice would
   * still stamp correctly, so asserting on it would miss the real defect.
   */
  nestedEventSessionIds: readonly string[];
}

/**
 * AC-R1 for task 6.2: the open session GREW while it was on screen, with no
 * reload and no navigation.
 *
 * ★ `null` IS A FAILING ASSERTION, on the thread probe's terms rather than the
 * tool-call probe's. `toolCallInline` degrades to a warning because a
 * virtualizer decides which rows exist to read; nothing decides that here. The
 * probe grows the archive itself, so an empty answer can only mean the tail did
 * not arrive — which for this task IS the acceptance criterion.
 *
 * The counts are taken INSIDE the probe's own window, between the two row
 * readings. A whole-drive count would mix in the load and the sub-agent's
 * sidecar and could never say which request the tail caused.
 */
export interface LiveProbe {
  /** `totalRows` before the archive grew. `null` when the derivation was unsafe. */
  before: number | null;
  /** `totalRows` after the tree caught up. */
  after: number | null;
  /** Main-frame navigations between the two readings. A reload would be one. */
  navigations: number;
  /** `/api/sessions` list responses in the window. The list is not even mounted. */
  listResponses: number;
  /** `/api/sessions/:id` responses in the window — the splice's own page request. */
  detailResponses: number;
  /**
   * The archived transcript this probe grew, so the drift probe can grow it too.
   *
   * ★ CARRIED HERE RATHER THAN RESOLVED TWICE. `probeLiveUpdate` already walks
   * the archive for this path, and both alternatives — a second walk in the
   * drive, or handing the drift probe a session id of its own — write one of
   * `one-door.test.ts`'s eleven TERMS at a source position that re-keys ten
   * suppression entries and buys one to three more. This field costs none.
   */
  archivePath: string;
}

/**
 * AC-R1 for task 7.3: an unrecognised record RAISES the alarm, and its absence
 * before the append is what proves the raise was not already there.
 *
 * ★ `null` IS A FAILING ASSERTION, on the live probe's terms. The probe grows
 * the archive itself, so an empty answer can only mean the transcript could not
 * be reached — and a silent alarm is the one defect this whole task exists to
 * prevent. A warning here would ship a green gate over a dead alarm.
 */
export interface DriftProbe {
  /** Banner elements before the unrecognised record was appended. Must be 0. */
  before: number;
  /** Banner elements after it. Must be 1 — the raise, with no reload. */
  after: number;
  /** The `type` that was appended, echoed so the report names what it sent. */
  appendedType: string;
}

/**
 * AC-R1 for task 7.2: the search screen was REACHED from the session view, it
 * drew a highlighted hit, and clicking that hit landed on the matched row.
 *
 * ★ `null` IS A FAILURE, on `threadAssertions`' terms rather than the tool-call
 * probe's. Nothing about the corpus can empty this: the term is derived from the
 * open session's OWN wire events and the search is scoped to that session, so a
 * query with no hit means the screen is broken rather than the corpus quiet.
 *
 * ★ THE PATH IS RECORDED BECAUSE THE ENTRY POINT IS AN ACCEPTANCE CRITERION.
 * AC2's "in-session search is reachable from the session view" is discharged by
 * CLICKING `in-session-search` and reading where it landed — not by a source pin
 * that would pass over an anchor nothing can reach.
 */
export interface SearchProbe {
  /** Where clicking `in-session-search` landed. Must name the open session. */
  path: string;
  /** The `search-scope` strip's text, read on the search screen. */
  scopeText: string;
  /** The query, derived from the open session's own wire events. */
  term: string;
  /** `data-slot="search-hit"` anchors the query drew. */
  hitCount: number;
  /** The first hit's `data-event-id` — the row that must end up selected. */
  eventId: string;
  /** Highlighted runs inside that hit's snippet. Zero means no highlight drawn. */
  markedRuns: number;
  /**
   * `data-slot="search-warm"` controls on screen.
   *
   * MEASURED 0: `countUnprojected` reports 0 over the dev corpus (293 of 293
   * `ready`) and the gate snapshot copies the same database, so the control is
   * correctly absent. Asserting the ABSENCE is falsifiable — a control stuck
   * permanently on reds here. The raise side belongs to task 7.4's probe, whose
   * own AC needs the count to start above zero.
   */
  warmControls: number;
  /** Did the row carrying `eventId` become `aria-selected` after the click? */
  landedSelected: boolean;
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
  /**
   * The path of every `/api/sessions/:id` response, in arrival order.
   *
   * Paths and not a tally, because AC-R1(b) has to prove the expansion asked for
   * that row's own child and for nothing else. The count the report publishes is
   * this array's length — one collector, so the two can never disagree.
   * StrictMode doubles REQUESTS; responses are what land here.
   */
  detailPaths: readonly string[];
  /**
   * How many had arrived BEFORE any sub-agent was opened.
   *
   * The whole-drive count is 2 once an expansion fetches a sidecar, by design —
   * so AC-R1(a)'s "one request fills the screen" has to be read at load, or it
   * reds the moment the feature works.
   */
  detailResponsesAtLoad: number;
  /**
   * How many had arrived before the LIVE probe grew the archive.
   *
   * The sub-agent window is `[atLoad, beforeLive)`, and it has to be: the splice
   * issues a further detail request by design, so a window open to the end of
   * the drive would red 5.5's assertion the moment 6.2's feature worked.
   */
  detailResponsesBeforeLive: number;
  /**
   * The path of every `/api/sessions` LIST response, in arrival order.
   *
   * Its own collector rather than a widened predicate: `isSessionDetailPath`
   * matches `/api/sessions/:id` and can never match the list route, and three
   * assertions pin that predicate.
   */
  listPaths: readonly string[];
  /** `null` when no rendered tool_call row carried both halves. See the type. */
  toolCallInline: ToolCallProbe | null;
  /** The same row, read in the detail pane instead of the tree. See the type. */
  eventDetail: EventDetailProbe | null;
  /** The sub-agent expansion. `null` is a warning — see the type. */
  subagentExpansion: SubagentProbe | null;
  /** The thread, read after the toggle. `null` is a FAILURE — see the type. */
  threadInline: ThreadProbe | null;
  /** The live tail. `null` is a FAILURE — see the type. */
  liveUpdate: LiveProbe | null;
  /** The durability alarm, raised last of all. `null` is a FAILURE — see the type. */
  driftBanner: DriftProbe | null;
  /** The search screen, driven last of all. `null` is a FAILURE — see the type. */
  searchScreen: SearchProbe | null;
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
    detailResponses: result === null ? null : result.detailPaths.length,
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
      //
      // READ AT LOAD, not over the whole drive. Task 5.5 makes a second response
      // the point of the feature, and the whole-drive count would red on the
      // working product. Its own delta is `subagent-expansion-request` below;
      // spelling this one as "1 + expansions" would instead go VACUOUS whenever
      // the sub-agent probe warns off, which is 6 of 21 measured sessions.
      name: 'session-detail-responses',
      ok: result.detailResponsesAtLoad === 1,
      actual: `${result.detailResponsesAtLoad} at load, ${result.detailPaths.length} over the drive`,
      expected: 'exactly one GET /api/sessions/:id response before any expansion',
    },
    ...toolCallAssertions(result.toolCallInline),
    ...eventDetailAssertions(result.eventDetail),
    ...subagentAssertions(
      result.subagentExpansion,
      // The window CLOSES at the live probe: the splice fetches a page of its
      // own, and a window open to the end of the drive would red this the
      // moment task 6.2's feature worked.
      result.detailPaths.slice(result.detailResponsesAtLoad, result.detailResponsesBeforeLive),
    ),
    ...liveAssertions(result.liveUpdate),
    ...threadAssertions(result.threadInline),
    ...driftAssertions(result.driftBanner),
    ...searchAssertions(result.searchScreen),
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
      // RAISED 9 -> 10 BY TASK 7.2, with `10-search.png`; 7.3 raised it 8 -> 9
      // and 6.2 raised it 7 -> 8.
      // TWO literals move, and they are the `ok:` line and the `expected:` line
      // — NOT the `actual:` template between them, which interpolates and holds
      // no number to change. Leaving one behind ships a report reading
      // `10 screenshot(s) / expected: 9 screenshots` with `ok: true` — a contact
      // sheet that contradicts itself while passing.
      name: 'shot-count',
      ok: result.shots.length === 10,
      actual: `${result.shots.length} screenshot(s)`,
      expected: '10 screenshots',
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
 * AC-R1 for task 5.5, in two records: the RIGHT ONE request went out, and the
 * sidecar's own rows arrived.
 *
 * The request half reads `detailPaths` rather than anything the probe carried,
 * so a probe that never fired cannot make it pass by arithmetic. The zero-extra
 * case is the only automated witness of the self-cancelling fetch effect, which
 * no test in the UI project can see at all.
 *
 * The row half asserts on nested EVENT rows. A splice that carried only a depth
 * offset would still place them correctly and still stamp the child's root turn,
 * so the event row is the only reading that tells the two apart.
 */
function subagentAssertions(
  probe: SubagentProbe | null,
  extra: readonly string[],
): AssertionRecord[] {
  if (probe === null) return [];
  const wanted = `/api/sessions/${probe.childSessionId}`;
  const stamps = [...new Set(probe.nestedEventSessionIds)];
  return [
    {
      name: 'subagent-expansion-request',
      ok: extra.length === 1 && extra[0] === wanted,
      actual: extra.length === 0 ? 'no further response' : extra.join(' | '),
      expected: `exactly one further response, and its path is ${wanted}`,
    },
    {
      name: 'subagent-nested-rows',
      ok:
        probe.nestedEventSessionIds.length > 0 &&
        probe.childSessionId !== probe.parentSessionId &&
        stamps.every((id) => id === probe.childSessionId),
      actual:
        `${probe.nestedEventSessionIds.length} nested event row(s) stamped ` +
        `${quote(stamps.join(', '))}, under a parent row stamped ${quote(probe.parentSessionId)}`,
      expected: `>= 1 nested event row carrying data-session-id ${quote(probe.childSessionId)}`,
    },
  ];
}

/**
 * AC-R1 for task 5.4, in two records: the thread carried the payload, and it
 * accounted for every `thinking` event.
 *
 * ★ `null` IS A FAILING ASSERTION, NOT A WARNING. `toolCallAssertions` above
 * degrades because a virtualizer decides what it can see; nothing decides that
 * here. A silent pass over an unclickable toggle is the "validated structure,
 * never validated experience" failure this AC was written to stop.
 *
 * The two clauses stay separate because they fail for different reasons and a
 * reader acts on them differently: a missing prefix is a rendering defect, a
 * miscounted marker is a model defect.
 */
function threadAssertions(probe: ThreadProbe | null): AssertionRecord[] {
  if (probe === null) {
    return [
      {
        name: 'thread-reached',
        ok: false,
        actual: 'no thread control was found, or it drew no [data-thread-kind] row',
        expected: 'the thread control renders, and clicking it draws the thread',
      },
    ];
  }

  const found = (ok: boolean): string => (ok ? 'found' : 'MISSING');
  const markersOk =
    probe.thinkingRows === probe.thinkingEvents &&
    probe.markerRows === probe.thinkingRows &&
    probe.emptyRows === 0;

  return [
    {
      name: 'thread-tool-inline',
      ok: probe.inputMatched && probe.outputMatched,
      actual:
        `${probe.eventId}: input ${found(probe.inputMatched)} (${quote(probe.inputPrefix)}), ` +
        `output ${found(probe.outputMatched)} (${quote(probe.outputPrefix)})`,
      expected: 'a [data-thread-kind="tool"] row contains a prefix of its input and its output',
    },
    {
      name: 'thread-thinking-markers',
      ok: markersOk,
      actual:
        `${probe.thinkingRows} row(s) for ${probe.thinkingEvents} event(s); ` +
        `${probe.markerRows} carry the marker, ${probe.emptyRows} render empty`,
      expected: 'one marker per thinking event, every one carrying the string, none empty',
    },
  ];
}

/**
 * AC-R1 for task 6.2, in three records: the tree GREW, nothing navigated, and
 * the growth arrived through a splice rather than through a reload.
 *
 * ★ A `null` READING FAILS. `totalRows` is derived from the virtualizer's own
 * canvas and degrades to `null` behind a plausibility guard — which is the right
 * answer for a reading nobody acts on, and the wrong one here, where the reading
 * IS the acceptance criterion. The thread probe's semantics, not the tool-call
 * probe's.
 *
 * The three clauses stay separate because a reader acts on them differently: no
 * growth is a dead tail, a navigation is a reload wearing a tail's clothes, and
 * a missing page request means the rows came from somewhere else entirely.
 */
function liveAssertions(probe: LiveProbe | null): AssertionRecord[] {
  if (probe === null) {
    return [
      {
        name: 'live-update-reached',
        ok: false,
        actual: 'the archived transcript of the open session could not be grown',
        expected: 'the probe appends one record to the open session and the tree answers',
      },
    ];
  }

  const shown = (value: number | null): string => (value === null ? 'unknown' : String(value));
  return [
    {
      name: 'live-row-growth',
      ok: probe.before !== null && probe.after !== null && probe.after > probe.before,
      actual: `${shown(probe.before)} -> ${shown(probe.after)} total rows`,
      expected: 'the tree holds more rows after the archive grew, with no manual refresh',
    },
    {
      name: 'live-no-navigation',
      ok: probe.navigations === 0 && probe.listResponses === 0,
      actual: `${probe.navigations} navigation(s), ${probe.listResponses} list response(s)`,
      expected: 'no reload, no navigation, and no further GET /api/sessions',
    },
    {
      // What tells a splice from a reload: the client asked for ONE page, at the
      // cursor the frame carried. A reload would have re-fetched the document.
      name: 'live-splice-request',
      ok: probe.detailResponses >= 1,
      actual: `${probe.detailResponses} detail response(s) while the tail arrived`,
      expected: '>= 1 GET /api/sessions/:id, which is the spliced page',
    },
  ];
}

/**
 * AC-R1 for task 7.3, in two records: the alarm was SILENT on the clean session
 * and it RAISED once an unrecognised record landed.
 *
 * ★ BOTH SIDES OR NEITHER. A probe that only read the raise would pass over a
 * banner stuck permanently on, which is AC3's failure and the exact defect plan
 * 001's task 3.3 shipped twice. A probe that only read the silence would pass on
 * a dead alarm, which is AC2's. So the before reading is an assertion of its own
 * rather than a precondition, and neither can discharge the other.
 *
 * ★ A `null` READING FAILS, on `liveAssertions`' terms rather than the tool-call
 * probe's. Nothing about the corpus can empty this: the probe writes the drift
 * it then looks for.
 */
function driftAssertions(probe: DriftProbe | null): AssertionRecord[] {
  if (probe === null) {
    return [
      {
        name: 'drift-banner-reached',
        ok: false,
        actual: 'the archived transcript of the open session could not carry an unknown record',
        expected: 'the probe appends one unrecognised record and the session view answers',
      },
    ];
  }

  return [
    {
      name: 'drift-banner-silent-when-clean',
      ok: probe.before === 0,
      actual: `${probe.before} banner(s) before the append`,
      expected: 'no drift banner anywhere while every counter is zero',
    },
    {
      name: 'drift-banner-raised',
      ok: probe.after > 0,
      actual: `${probe.before} -> ${probe.after} banner(s) after a "${probe.appendedType}" record`,
      expected: 'the banner raises on the unrecognised record, with no manual refresh',
    },
  ];
}

/**
 * AC-R1 for task 7.2, in four records: the screen was REACHED from the session
 * view, it drew a highlighted hit, the hit landed on its own row, and the warm
 * control stayed silent over a fully-projected corpus.
 *
 * ★ A `null` READING FAILS, on `threadAssertions`' terms. The query is derived
 * from the open session's own wire events and the search is scoped to that
 * session, so "no hit" cannot be a fact about the corpus — it is the screen
 * failing.
 *
 * The four clauses stay separate because a reader acts on each differently: a
 * wrong path is a broken entry point, a missing highlight is a rendering defect,
 * an unselected row is a broken jump, and a warm control on a corpus with
 * nothing to warm is the "stuck permanently on" defect the silence catches.
 */
function searchAssertions(probe: SearchProbe | null): AssertionRecord[] {
  if (probe === null) {
    return [
      {
        name: 'search-reached',
        ok: false,
        actual: 'the in-session search control was not found, or the screen drew no scope',
        expected: 'the session view offers in-session search, and it reaches the search screen',
      },
    ];
  }

  return [
    {
      // AC2, GATE-VERIFIED rather than source-pinned: the control was clicked
      // and this is where it landed.
      name: 'search-reachable-in-session',
      ok: probe.path.startsWith('/search/session/') && probe.scopeText.includes('this session'),
      actual: `landed on ${quote(probe.path)}, scope reads ${quote(probe.scopeText)}`,
      expected:
        'clicking in-session search reaches /search/session/:id and states the session scope',
    },
    {
      name: 'search-hit-highlighted',
      ok: probe.hitCount > 0 && probe.markedRuns > 0,
      actual: `${probe.hitCount} hit(s) for ${quote(probe.term)}, ${probe.markedRuns} highlighted run(s) in the first`,
      expected: '>= 1 search hit, and its snippet carries a highlighted run',
    },
    {
      name: 'search-jump-lands-on-event',
      ok: probe.landedSelected,
      actual: probe.landedSelected
        ? `the row carrying ${quote(probe.eventId)} is aria-selected`
        : `no row carrying ${quote(probe.eventId)} became aria-selected`,
      expected: 'clicking the hit navigates and selects the row it named',
    },
    {
      // MEASURED: `countUnprojected` is 0 over the dev corpus — 293 of 293
      // `ready` — so the control is correctly absent and its ABSENCE is the
      // falsifiable reading. Task 7.4's probe owns the raise side; if this ever
      // reds, the count has risen and that probe is the one to look at.
      name: 'search-warm-silent-when-nothing-to-warm',
      ok: probe.warmControls === 0,
      actual: `${probe.warmControls} warm control(s) on screen`,
      expected: 'no warm control while every transcript is already projected',
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
  if (result.subagentExpansion === null) {
    warnings.push(
      'subagent-expansion: no Agent row — OBSERVED, NOT ASSERTED. No rendered ' +
        'row named a child_session_id, so there was nothing to open. MEASURED: ' +
        '6 of 21 top-level sessions spawned no sub-agent at all.',
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
 * The artifact the founder opens for AC-R2's visual sign-off: every shot, the
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
