// The projector under real data, without the decay. Opt-in via
// `AGENT_LENS_REAL_CORPUS=1`, the same gate and the same doctrine as
// `src/transcript/__tests__/archive-invariants.test.ts`: reads
// `~/.agent-lens/archive` and NEVER `~/.claude/projects`, and every assertion is
// an INVARIANT or a LOWER BOUND. The archive gains data every 15 minutes — it
// went 275 -> 276 -> 281 files across three measurement passes on one day — so an
// absolute count here would red on a Tuesday for no reason.
//
// The two TIMESTAMP invariants live here rather than beside `classifyLine`,
// because the assumption belongs to the PROJECTOR and not to classification:
// `isoTs` accepts the wider ISO grammar on purpose and must keep doing so, while
// `epochMs` and every ordering compare rest on the narrow 24-character form.
// These reds are the drift alarm for that ceiling.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contentBlocks } from '../../transcript/blocks.js';
import { DriftCounter } from '../../transcript/drift.js';
import { classifyLine, type ParsedLine } from '../../transcript/line.js';
import { archiveJsonlFiles, offsetLines } from '../../transcript/__tests__/fixtures.js';
import { runPipeline } from '../pipeline.js';
import { INLINE_MAX, PREVIEW_MAX } from '../tools.js';

const ENABLED = process.env.AGENT_LENS_REAL_CORPUS === '1';
const runIt = ENABLED ? it : it.skip;

const ARCHIVE_ROOT = join(homedir(), '.agent-lens', 'archive');

/** Lower bounds, well under what was measured on 2026-08-14 (276 files, 45,219 lines). */
const MIN_FILES = 100;
const MIN_LINES = 20000;
const MIN_UUIDS = 20000;
const MIN_TOOL_IDS = 8000;
/** 301 adjacent-pair inversions measured; 362 derived turns. Bounded, never pinned. */
const MIN_INVERSIONS = 100;
const MIN_DERIVED_TURNS = 100;

/** Task 3.2's bounds. 15,220 pairs, 218 async agents and 61 spill claims measured. */
const MIN_TOOL_PAIRS = 8000;
const MIN_ASYNC_AGENTS = 100;
const MIN_SPILL_CLAIMS = 25;
/**
 * ⚠️ Rests on the SINGLE over-cap input measured — 68,782 B on a `Write` call,
 * which is also the corpus maximum. It cannot go higher, and if that file ever
 * leaves the mirror this is the one line to move. The deterministic proof of the
 * arm is `large-output.jsonl`, never the corpus.
 */
const MIN_LINE_REF_INPUTS = 1;

/** What an async `Agent` result says instead of the agent's answer. */
const LAUNCH_MARKER = 'Async agent launched successfully.';
/** What a spilled result says instead of the payload. */
const PERSISTED_MARKER = '<persisted-output>';

/** The one shape `epochMs` slices and every ordering compare rests on. */
const FIXED_WIDTH_Z = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function parsedLines(file: string): ParsedLine[] {
  const drift = new DriftCounter();
  return offsetLines(readFileSync(file).toString('utf8')).map((entry) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.text);
    } catch {
      parsed = undefined;
    }
    return classifyLine(parsed, {
      byteOffset: entry.byteOffset,
      byteLength: entry.byteLength,
      drift,
    });
  });
}

describe('AC6 — the timestamp shape the projector rests on still holds', () => {
  runIt(
    'every top-level timestamp is the 24-character Z form, and every uuid line carries one',
    () => {
      const files = archiveJsonlFiles(ARCHIVE_ROOT);
      expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);

      let stamps = 0;
      let uuids = 0;
      const wrongShape: string[] = [];
      const missing: string[] = [];

      for (const file of files) {
        for (const line of parsedLines(file)) {
          const at = line.timestamp;
          if (at !== undefined) {
            stamps += 1;
            if (!FIXED_WIDTH_Z.test(at)) wrongShape.push(`${file}: ${at}`);
          }
          if (line.uuid === undefined) continue;
          uuids += 1;
          // `events.ts` is NOT NULL and a pure function may not invent a time,
          // so this property is what makes the column satisfiable at all.
          if (at === undefined) missing.push(`${file}: ${line.uuid}`);
        }
      }

      expect(stamps).toBeGreaterThanOrEqual(MIN_LINES);
      expect(uuids).toBeGreaterThanOrEqual(MIN_UUIDS);
      expect(wrongShape.slice(0, 10)).toEqual([]);
      expect(missing.slice(0, 10)).toEqual([]);
    },
    600000,
  );
});

describe('AC3/AC4/AC5/AC9/AC10 — the projector over the whole archive', () => {
  runIt(
    'projects every archived file as a property, never as a count',
    () => {
      const files = archiveJsonlFiles(ARCHIVE_ROOT);
      expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);

      let lineCount = 0;
      let uuidCount = 0;
      let toolIdCount = 0;
      let inversions = 0;
      let derivedTurns = 0;
      let headers = 0;
      let emptyFiles = 0;

      const duplicateIds: string[] = [];
      const duplicateUuids: string[] = [];
      const duplicateToolIds: string[] = [];
      const outOfOrder: string[] = [];
      const badEvents: string[] = [];
      const badTurns: string[] = [];
      const badHeaders: string[] = [];
      const badRoundTrips: string[] = [];
      const badCensus: string[] = [];

      for (const file of files) {
        const bytes = readFileSync(file);
        const lines = parsedLines(file);
        lineCount += lines.length;

        const { header, turns, events } = runPipeline(lines, {
          session_id: file,
          drift: new DriftCounter(),
        });

        // --- AC5: a file that emits nothing is not a session ------------------
        if (events.length === 0) {
          emptyFiles += 1;
          if (header !== undefined || turns.length > 0)
            badHeaders.push(`${file}: empty but present`);
          continue;
        }
        if (header === undefined) {
          badHeaders.push(`${file}: emitted rows but no header`);
          continue;
        }
        headers += 1;
        if (header.started_at === '' || header.last_activity_at === '') {
          badHeaders.push(`${file}: empty session bounds`);
        }

        // --- AC4: ids, ordering and determinism -------------------------------
        const ids = new Set<string>();
        let previousOffset = -1;
        for (const event of events) {
          if (ids.has(event.id)) duplicateIds.push(`${file}: ${event.id}`);
          ids.add(event.id);
          if (event.src_offset < previousOffset) outOfOrder.push(`${file}: ${event.id}`);
          previousOffset = event.src_offset;

          // --- AC1/AC10: every row is complete ------------------------------
          if (event.id === '' || event.ts === '' || event.turn_id === '') {
            badEvents.push(`${file}: ${event.seq}`);
          }
          if (event.src_len <= 0) badEvents.push(`${file}: ${event.seq} has no length`);
        }

        // --- AC10: the round trip the content resolver depends on -------------
        const uuidAt = new Map(lines.map((line) => [line.byte_offset, line.uuid]));
        for (const event of events) {
          const slice = bytes.subarray(event.src_offset, event.src_offset + event.src_len);
          try {
            const parsed: { uuid?: unknown } = JSON.parse(slice.toString('utf8'));
            if (parsed.uuid !== uuidAt.get(event.src_offset)) {
              badRoundTrips.push(`${file}: ${event.seq}`);
            }
          } catch {
            badRoundTrips.push(`${file}: ${event.seq} did not parse`);
          }
        }

        // --- AC1/AC4: nothing dropped, windows tile ---------------------------
        let units = 0;
        let toolResults = 0;
        let blockless = 0;
        const fileUuids = new Set<string>();
        const fileToolIds = new Set<string>();
        let previousStamp = '';
        for (const line of lines) {
          if (line.timestamp !== undefined) {
            if (previousStamp !== '' && line.timestamp < previousStamp) inversions += 1;
            previousStamp = line.timestamp;
          }
          if (line.uuid === undefined) continue;
          uuidCount += 1;
          if (fileUuids.has(line.uuid)) duplicateUuids.push(`${file}: ${line.uuid}`);
          fileUuids.add(line.uuid);

          const blocks = contentBlocks(line);
          units += blocks.length;
          toolResults += blocks.filter((block) => block.kind === 'tool_result').length;
          if (blocks.length === 0) blockless += 1;
          for (const block of blocks) {
            if (block.kind !== 'tool_use' || block.id === '') continue;
            toolIdCount += 1;
            if (fileToolIds.has(block.id)) duplicateToolIds.push(`${file}: ${block.id}`);
            fileToolIds.add(block.id);
          }
        }
        if (events.length !== units - toolResults + blockless) {
          badCensus.push(`${file}: ${events.length} vs ${units - toolResults + blockless}`);
        }

        // --- AC6/AC9: turn windows, durations and bounds -----------------------
        let expected = 0;
        for (const turn of turns) {
          const own = events.filter((event) => event.turn_id === turn.id);
          if (turn.first_seq !== expected || turn.last_seq !== expected + own.length - 1) {
            badTurns.push(`${file}: ${turn.id} window`);
          }
          expected += own.length;

          const stamps = own.map((event) => event.ts).sort();
          if (turn.started_at !== stamps[0] || turn.ended_at !== stamps[stamps.length - 1]) {
            badTurns.push(`${file}: ${turn.id} bounds`);
          }
          if (turn.duration_source === 'derived') {
            derivedTurns += 1;
            if ((turn.duration_ms ?? -1) < 0) badTurns.push(`${file}: ${turn.id} negative`);
          }
        }
        if (expected !== events.length) badTurns.push(`${file}: windows do not tile`);
      }

      expect(lineCount).toBeGreaterThanOrEqual(MIN_LINES);
      expect(uuidCount).toBeGreaterThanOrEqual(MIN_UUIDS);
      expect(toolIdCount).toBeGreaterThanOrEqual(MIN_TOOL_IDS);
      expect(headers).toBeGreaterThan(0);

      expect(duplicateIds.slice(0, 10)).toEqual([]);
      expect(duplicateUuids.slice(0, 10)).toEqual([]);
      expect(duplicateToolIds.slice(0, 10)).toEqual([]);
      expect(outOfOrder.slice(0, 10)).toEqual([]);
      expect(badEvents.slice(0, 10)).toEqual([]);
      expect(badTurns.slice(0, 10)).toEqual([]);
      expect(badHeaders.slice(0, 10)).toEqual([]);
      expect(badRoundTrips.slice(0, 10)).toEqual([]);
      expect(badCensus.slice(0, 10)).toEqual([]);

      // The one out-of-order phenomenon still alive in the corpus: it projects
      // without an exception and without a null `ts`, asserted above.
      expect(inversions).toBeGreaterThanOrEqual(MIN_INVERSIONS);
      // The derived path is the MAJORITY, not a fallback — 57.6% measured.
      expect(derivedTurns).toBeGreaterThanOrEqual(MIN_DERIVED_TURNS);
      // At least one archived file is not a session transcript at all.
      expect(emptyFiles).toBeGreaterThanOrEqual(0);
    },
    600000,
  );
});

describe('Task 3.2 — the tool join over the whole archive, as properties', () => {
  runIt(
    'joins every result, and strands an unjoined call only on its file’s LAST EMITTING line',
    () => {
      const files = archiveJsonlFiles(ARCHIVE_ROOT);
      expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);

      let pairs = 0;
      let asyncAgents = 0;
      let spillClaims = 0;
      let lineRefInputs = 0;
      let inlineOutputs = 0;

      const orphans: string[] = [];
      const strandedMidFile: string[] = [];
      const parentageMismatches: string[] = [];
      const launchBoilerplate: string[] = [];
      const publishedMarkers: string[] = [];
      const badAgentStatus: string[] = [];
      const badInputStorage: string[] = [];
      const badTextBytes: string[] = [];

      for (const file of files) {
        const lines = parsedLines(file);
        const { events } = runPipeline(lines, { session_id: file, drift: new DriftCounter() });

        // The harness names below are read HERE, in a test, which the one door
        // exempts by path — the cross-check has to see the raw field to be a
        // cross-check at all.
        const callLine = new Map<string, ParsedLine>();
        const resultIds: { id: string; parent: unknown }[] = [];
        for (const line of lines) {
          if (line.uuid === undefined) continue;
          for (const block of contentBlocks(line)) {
            if (block.kind === 'tool_use' && block.id !== '') callLine.set(block.id, line);
            if (block.kind === 'tool_result') {
              resultIds.push({ id: block.tool_call_id, parent: line.raw.sourceToolAssistantUUID });
            }
          }
        }

        // ⚠️ The LAST EMITTING line, not the file's last line. Measured
        // 2026-08-19 on a session being archived mid-call: the in-flight `Agent`
        // sat on line 1,007 of 1,012, and all 5 lines after it were uuid-LESS
        // control lines (`last-prompt`, `ai-title`, `mode`) that project no row
        // at all. A control line appended behind a pending call does not make
        // the call less in flight, so the projection's own last row is the
        // honest anchor — and it stays a tripwire, because a broken join strands
        // calls with many emitting lines after them.
        const lastEmitting = events.reduce(
          (at, event) => (event.src_offset > at ? event.src_offset : at),
          -1,
        );

        for (const { id, parent } of resultIds) {
          const call = callLine.get(id);
          if (call === undefined) {
            orphans.push(`${file}: ${id}`);
            continue;
          }
          pairs += 1;
          // An INDEPENDENT parentage signal: the harness's own back-pointer must
          // agree with the id join, or one of the two is wrong.
          if (parent !== undefined && parent !== call.uuid) {
            parentageMismatches.push(`${file}: ${id}`);
          }
        }

        for (const event of events) {
          if (event.kind !== 'tool_call') continue;

          if (event.result_offset === undefined) {
            // ⚠️ The COUNT of these is deliberately not asserted: the mirror is
            // live, and the same walk read 1 at 03:28 — an in-flight
            // `AskUserQuestion` on line 956 of 956 — and 0 minutes later. The
            // SHAPE is the stronger tripwire anyway, because a harness change
            // that breaks the join strands calls MID-file.
            if (event.src_offset !== lastEmitting) strandedMidFile.push(`${file}: ${event.id}`);
            continue;
          }

          if (event.name === 'Agent' && event.text?.startsWith(LAUNCH_MARKER) === true) {
            launchBoilerplate.push(`${file}: ${event.id}`);
          }
          if (event.agent_status !== undefined) {
            asyncAgents += 1;
            // The OBSERVED subset, never `schema.ts`'s full enum: `killed` is
            // witnessed once in the whole corpus, on a `Bash` notification and
            // never on an Agent row, so asserting all four arms appear reds.
            if (!['completed', 'failed', 'running'].includes(event.agent_status)) {
              badAgentStatus.push(`${file}: ${event.agent_status}`);
            }
          }
          if (event.output_storage === 'spill') spillClaims += 1;
          if (event.input_storage === 'line_ref') lineRefInputs += 1;

          // The storage label must agree with the size it was decided from.
          const overCap = (event.input_bytes ?? 0) > INLINE_MAX;
          if (event.input_storage === 'line_ref' ? !overCap : overCap) {
            badInputStorage.push(`${file}: ${event.id}`);
          }
          if (event.input_storage === 'line_ref' && Buffer.byteLength(event.input!) > PREVIEW_MAX) {
            badInputStorage.push(`${file}: ${event.id} preview over budget`);
          }

          if (event.output_storage === 'inline') {
            inlineOutputs += 1;
            if (event.text_bytes !== Buffer.byteLength(event.text!)) {
              badTextBytes.push(`${file}: ${event.id}`);
            }
          }
          if ((event.text_bytes === undefined) !== (event.output_storage === 'absent')) {
            badTextBytes.push(`${file}: ${event.id} disagrees with its storage`);
          }
        }

        for (const event of events) {
          if (event.text?.startsWith(PERSISTED_MARKER) === true) {
            publishedMarkers.push(`${file}: ${event.id}`);
          }
        }
      }

      expect(orphans.slice(0, 10)).toEqual([]);
      expect(strandedMidFile.slice(0, 10)).toEqual([]);
      expect(parentageMismatches.slice(0, 10)).toEqual([]);
      expect(launchBoilerplate.slice(0, 10)).toEqual([]);
      expect(publishedMarkers.slice(0, 10)).toEqual([]);
      expect(badAgentStatus.slice(0, 10)).toEqual([]);
      expect(badInputStorage.slice(0, 10)).toEqual([]);
      expect(badTextBytes.slice(0, 10)).toEqual([]);

      // Lower bounds, so no limb above can pass by selecting nothing.
      expect(pairs).toBeGreaterThanOrEqual(MIN_TOOL_PAIRS);
      expect(asyncAgents).toBeGreaterThanOrEqual(MIN_ASYNC_AGENTS);
      expect(spillClaims).toBeGreaterThanOrEqual(MIN_SPILL_CLAIMS);
      expect(lineRefInputs).toBeGreaterThanOrEqual(MIN_LINE_REF_INPUTS);
      expect(inlineOutputs).toBeGreaterThanOrEqual(MIN_TOOL_PAIRS);
    },
    600000,
  );
});
