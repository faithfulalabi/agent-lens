// The hermetic half of Task 3.2. Every fixture is SYNTHETIC and hand-written in
// the harness's own line shape, so it reaches `runPipeline` through
// `classifyLine` exactly as a production line does.
//
// Three of these fixtures pin phenomena the live corpus CANNOT reach, and they
// are never to be deleted for looking redundant:
//   - `result-before-use.jsonl` pair B is the ONLY proof the duration clamp
//     exists. 0 negative elapsed measured over 15,220 pairs, so a bare `>= 0`
//     passes on an unclamped implementation for every row that exists.
//   - `large-output.jsonl`'s over-cap OUTPUT is unwitnessed (0 of 15,220, max
//     63,868 B — just under the cap). Its over-cap INPUT is witnessed once.
//   - `async-agent.jsonl`'s structured-only detector arm has zero corpus
//     witnesses. It pins the OR against a harness string change, not a
//     population.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentBlocks } from '../../transcript/blocks.js';
import { DriftCounter } from '../../transcript/drift.js';
import type { ParsedLine } from '../../transcript/line.js';
import { runPipeline, type ProjectedEvent, type Projection } from '../pipeline.js';
import { INLINE_MAX, PREVIEW_MAX } from '../tools.js';
import { classifyProjectFixture, projectFixtureBytes } from './fixtures.js';

const SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function project(name: string): Projection & { lines: ParsedLine[] } {
  const { lines, drift } = classifyProjectFixture(name);
  return { ...runPipeline(lines, { session_id: SESSION, drift }), lines };
}

/** The one row a test is about, by the id the fixture gave its `tool_use`. */
function callAt(result: Projection, id: string): ProjectedEvent {
  const event = result.events.find((candidate) => candidate.id === id);
  if (event === undefined) throw new Error(`no tool call ${id}`);
  return event;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

describe('AC1 — the join folds one row, and the result contributes none', () => {
  it('turns a call and its result into ONE tool_call row', () => {
    const result = project('tool-join.jsonl');
    const call = callAt(result, 'toolu_ok');

    expect(call.kind).toBe('tool_call');
    expect(call.text).toBe('stdout');
    expect(call.status).toBe('ok');

    // The result block is the output half of THIS row, so no row of its own —
    // and no row anywhere else carries its text either.
    expect(result.events.filter((event) => event.text === 'stdout')).toHaveLength(1);
  });

  it.each(['tool-join.jsonl', 'async-agent.jsonl', 'spill-claim.jsonl'])(
    '%s still accounts for every unit after the fold',
    (name) => {
      const result = project(name);

      let units = 0;
      let toolResults = 0;
      let blockless = 0;
      for (const line of result.lines) {
        if (line.uuid === undefined) continue;
        const blocks = contentBlocks(line);
        units += blocks.length;
        toolResults += blocks.filter((block) => block.kind === 'tool_result').length;
        if (blocks.length === 0) blockless += 1;
      }

      // Non-vacuity: without a result in the file this is `events === units`.
      expect(toolResults).toBeGreaterThan(0);
      expect(result.events).toHaveLength(units - toolResults + blockless);
    },
  );

  it('joins a result that sits BEFORE its own call in the file', () => {
    // Extinct in the live corpus, so the guard survives only as this fixture.
    // Pair A inverts BYTE order and its stamps ascend, which is why it proves
    // the join rather than the clamp.
    const call = callAt(project('result-before-use.jsonl'), 'toolu_early');

    expect(call.text).toBe('answered first');
    expect(call.status).toBe('ok');
    expect(call.duration_ms).toBe(3000);
  });
});

describe('AC2 — the status ladder, four arms and the order that decides two', () => {
  it('reads `error` from `is_error === true` EXACTLY, never from its absence', () => {
    const result = project('tool-join.jsonl');

    // The ported assertion from plan 001. The flag is ABSENT on 6,096 corpus
    // results, so any `!is_error` reading calls all of them failures.
    expect(callAt(result, 'toolu_ok').status).toBe('ok');
    expect(callAt(result, 'toolu_err').status).toBe('error');
  });

  it('ranks `denied` ABOVE `error`, on a result that is both', () => {
    // The arm that reds if the ladder is reordered: all 8 measured denials also
    // carry `is_error: true`, so testing the flag first mislabels 8 of 8.
    const result = project('tool-join.jsonl');
    const denial = result.lines.find(
      (line) =>
        contentBlocks(line)[0]?.kind === 'tool_result' && line.raw.toolDenialKind !== undefined,
    );

    expect(callAt(result, 'toolu_denied').status).toBe('denied');
    expect(contentBlocks(denial!)[0]).toMatchObject({ kind: 'tool_result', is_error: true });
  });

  it('leaves a call nothing answered `running`, with no output and no duration', () => {
    const pending = callAt(project('tool-join.jsonl'), 'toolu_unjoined');

    expect(pending).toMatchObject({
      status: 'running',
      output_storage: 'absent',
      text: undefined,
      text_bytes: undefined,
      duration_ms: undefined,
      duration_source: undefined,
      result_offset: undefined,
      result_len: undefined,
      result_block: undefined,
    });
  });
});

describe('AC3 — the duration is labelled `elapsed`, and clamps rather than lies', () => {
  it.each(['tool-join.jsonl', 'async-agent.jsonl', 'large-output.jsonl'])(
    '%s stamps every joined call `elapsed` with a non-negative duration',
    (name) => {
      const joined = project(name).events.filter(
        (event) => event.kind === 'tool_call' && event.duration_source !== undefined,
      );

      expect(joined.length).toBeGreaterThan(0);
      for (const event of joined) {
        expect(event.duration_source, event.id).toBe('elapsed');
        expect(event.duration_ms, event.id).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it('clamps a result stamped BEFORE its own call to exactly 0', () => {
    // The whole proof of the clamp. Measured 0 negative and 0 zero elapsed over
    // 15,220 pairs, so no corpus row can reach this arm and a `>= 0` limb passes
    // on an unclamped implementation everywhere else.
    const backwards = callAt(project('result-before-use.jsonl'), 'toolu_backwards');

    expect(backwards.duration_ms).toBe(0);
    expect(backwards.duration_source).toBe('elapsed');
  });

  it('never labels a duration "execution", in any emitted row or any source file', () => {
    // A 61 ms `Bash` reads 8,063 ms elapsed when a human sits on the approval
    // dialog, so the label is the honest half of the number (RFC §4).
    for (const name of ['tool-join.jsonl', 'async-agent.jsonl']) {
      for (const event of project(name).events) {
        expect(event.duration_source === 'elapsed' || event.duration_source === undefined).toBe(
          true,
        );
      }
    }

    // The only hits in the tree are the DDL comment that FORBIDS the label and
    // `tools.ts`'s header explaining why. Both are the prohibition itself, so
    // deleting them to quiet a grep would delete the measured provenance —
    // exempted by name, exactly as `one-door.test.ts` suppresses SQL comments.
    const lines = sourceLines();
    const named = lines.filter((hit) => /\bexecution\b/.test(hit.text));

    expect(
      named.filter((hit) => !/NEVER/.test(hit.text)).map((hit) => `${hit.file}:${hit.line}`),
    ).toEqual([]);

    // Non-vacuous both ways: the scan reaches real files, and the exemption
    // exempts something rather than matching nothing.
    expect(lines.length).toBeGreaterThan(1000);
    expect(named.length).toBeGreaterThan(0);
  });
});

describe('AC4 — the back-patch gate is the tool NAME, and the marker is `startsWith`', () => {
  it('patches nothing on a non-Agent row a notification happens to name', () => {
    // Without this the implementation destroys the 5 measured non-Agent targets,
    // 2 of which carry 290 B of real output and no `<result>` tag at all.
    const { lines, drift } = classifyProjectFixture('notification-non-agent.jsonl');
    const withNotification = runPipeline(lines, { session_id: SESSION, drift });

    // The same file with the notification line deleted — the byte-identical
    // comparison, rather than three values retyped by hand.
    const without = runPipeline(
      lines.filter((line) => !JSON.stringify(line.raw).includes('task-notification')),
      { session_id: SESSION, drift: new DriftCounter() },
    );

    const patched = callAt(withNotification, 'toolu_bash');
    const untouched = callAt(without, 'toolu_bash');

    expect(without.events.length).toBeLessThan(withNotification.events.length);
    expect(patched.text).toBe(untouched.text);
    expect(patched.output_storage).toBe(untouched.output_storage);
    expect(patched.status).toBe(untouched.status);
    expect(patched.agent_status).toBeUndefined();
    expect(patched.text).toBe('real bash output');
  });

  it('reads the launch marker with `startsWith`, so a quoting Bash row survives', () => {
    // `includes` matches 226 corpus results and `startsWith` 218: the 8-row
    // difference is all `Bash`, quoting the marker as data.
    const quoting = callAt(project('notification-non-agent.jsonl'), 'toolu_quotes');

    expect(quoting.text?.startsWith('match at line 12: ')).toBe(true);
    expect(quoting.text).toContain('Async agent launched successfully.');
    expect(quoting.output_storage).toBe('inline');
    expect(quoting.status).toBe('ok');
  });

  it('detects a launch from the marker alone AND from the structured field alone', () => {
    const result = project('async-agent.jsonl');

    // The marker arm is the sidecar shape — the ONE real corpus witness of a
    // launch the structured field misses.
    expect(callAt(result, 'toolu_marker').text).toBe('the marker arm answer');
    // The structured arm is SYNTHETIC with zero corpus witnesses. It pins the
    // OR against a harness string change, never an observed population.
    expect(callAt(result, 'toolu_structured').text).toBe('the structured arm answer');
  });
});

describe('AC5 — the back-patch, both arms, across turns', () => {
  it('publishes the `<result>` payload and the `<status>`, never the boilerplate', () => {
    const result = project('async-agent.jsonl');
    const patched = callAt(result, 'toolu_marker');

    expect(patched).toMatchObject({
      text: 'the marker arm answer',
      text_bytes: 21,
      output_storage: 'inline',
      // `killed` is witnessed ONCE in the whole corpus and never on an Agent
      // row, so the arm exists here as a fixture and not as a corpus claim.
      agent_status: 'killed',
    });
    expect(callAt(result, 'toolu_structured').agent_status).toBe('completed');

    for (const event of result.events) {
      expect(event.text?.startsWith('Async agent launched successfully.') === true).toBe(false);
    }
  });

  it('labels an unanswered launch `running` rather than showing the boilerplate', () => {
    // 71 of 218 async calls have no notification. A labelled state beats a
    // precise-looking lie, and this arm OVERRIDES the ladder's `ok`.
    expect(callAt(project('async-agent.jsonl'), 'toolu_silent')).toMatchObject({
      text: undefined,
      text_bytes: undefined,
      output_storage: 'absent',
      status: 'running',
      agent_status: 'running',
    });
  });

  it('patches ACROSS turns, which is why the join runs after turn assembly', () => {
    const result = project('async-agent.jsonl');
    const call = callAt(result, 'toolu_marker');
    const notification = result.turns.find((turn) => turn.kind === 'task_notification');

    expect(result.turns.length).toBeGreaterThan(4);
    expect(notification).toBeDefined();
    expect(call.turn_id).not.toBe(notification?.id);
  });

  it('survives a notification carrying no `<result>` at all', () => {
    // 2 of 158 are this shape. The parse answers `undefined` and the row takes
    // the labelled-unknown arm; `match(...)[1]` unguarded would throw here.
    expect(callAt(project('notification-no-result.jsonl'), 'toolu_noresult')).toMatchObject({
      text: undefined,
      output_storage: 'absent',
      status: 'running',
      agent_status: 'running',
    });
  });

  it('ignores a notification whose call lives in another file', () => {
    // 1 measured notification is cross-file, its `tool_use` in a sidecar that a
    // per-file pass structurally cannot reach. It must patch nothing and throw
    // nothing. (A notification naming no call at all is `agents.test.ts`'s.)
    const { lines, drift } = classifyProjectFixture('async-agent.jsonl');
    const stray = [
      ...lines,
      ...classifyProjectFixture('notification-non-agent.jsonl').lines.filter((line) =>
        JSON.stringify(line.raw).includes('task-notification'),
      ),
    ];

    expect(() => runPipeline(stray, { session_id: SESSION, drift })).not.toThrow();
    const result = runPipeline(stray, { session_id: SESSION, drift: new DriftCounter() });
    expect(callAt(result, 'toolu_marker').text).toBe('the marker arm answer');
  });
});

describe('AC6 — the output storage split, and the coordinates on both arms', () => {
  it('stores an under-cap output inline, with the full text', () => {
    const call = callAt(project('tool-join.jsonl'), 'toolu_ok');

    expect(call.output_storage).toBe('inline');
    expect(call.text).toBe('stdout');
    expect(call.text_bytes).toBe(bytes('stdout'));
  });

  it('stores an over-cap output as a line_ref with an 8 KB head', () => {
    // Unwitnessed in the corpus — 0 of 15,220, max 63,868 B — so this fixture is
    // the only proof the arm works at all.
    const call = callAt(project('large-output.jsonl'), 'toolu_bigout');

    expect(call.output_storage).toBe('line_ref');
    expect(call.text_bytes).toBeGreaterThan(INLINE_MAX);
    expect(bytes(call.text!)).toBeLessThanOrEqual(PREVIEW_MAX);
  });

  it.each([
    ['tool-join.jsonl', 'toolu_ok'],
    ['large-output.jsonl', 'toolu_bigout'],
    ['spill-claim.jsonl', 'toolu_spill'],
  ])('%s row %s carries coordinates that slice back to its own result line', (name, id) => {
    const call = callAt(project(name), id);
    const slice = projectFixtureBytes(name)
      .subarray(call.result_offset!, call.result_offset! + call.result_len!)
      .toString('utf8');
    const parsed: { message?: { content?: { tool_use_id?: unknown }[] } } = JSON.parse(slice);

    // `result_block` is 0 on every corpus row — at most 1 result block per line,
    // always at index 0 — so an implementation that never writes the column
    // looks correct under every other limb. Read it off the row, never assume.
    expect(call.result_block).toBe(0);
    expect(parsed.message?.content?.[call.result_block!]?.tool_use_id).toBe(id);
  });
});

describe('AC7 — the spill mark, and it OVERRIDES the size rule', () => {
  it('marks a 2 KB spill claim `spill`, not `inline`', () => {
    // All 61 claims measure 1,480–6,286 B, far UNDER the cap, so the size rule
    // alone would publish `"<persisted-output>\nOutput too large…"` as output.
    const call = callAt(project('spill-claim.jsonl'), 'toolu_spill');

    expect(call.output_storage).toBe('spill');
    expect(call.text).toBeUndefined();
    expect(call.spill_path).toBeUndefined();
    expect(call.text_bytes).toBeGreaterThan(2000);
    expect(call.text_bytes).toBeLessThan(INLINE_MAX);
    expect(call.result_offset).toBeGreaterThan(0);
  });

  it('reads the spill marker with `startsWith`, so a mention mid-text is not a claim', () => {
    const mention = callAt(project('spill-claim.jsonl'), 'toolu_quotes');

    expect(mention.output_storage).toBe('inline');
    expect(mention.text).toContain('<persisted-output>');
  });

  it('emits no row whose text starts with the spill marker', () => {
    for (const name of ['spill-claim.jsonl', 'tool-join.jsonl', 'large-output.jsonl']) {
      for (const event of project(name).events) {
        expect(event.text?.startsWith('<persisted-output>') === true, event.id).toBe(false);
      }
    }
  });
});

describe('AC8 — an unanswered call is counted, and silence stays silent', () => {
  it('reports `unjoined_tool_uses` for the one call nothing answered', () => {
    // ⚠️ NOT an ordering claim: this fixture drifts one way only, so its
    // `drift_json` is a ONE-KEY object and any ordering assertion on it is
    // vacuous. The ordering lives on `serialize()`'s own test, in drift.test.ts.
    expect(JSON.parse(project('tool-join.jsonl').drift).unjoined_tool_uses).toBe(1);
  });

  it('leaves a fully joined file serializing to exactly `{}`', () => {
    expect(project('async-agent.jsonl').drift).toBe('{}');
    expect(project('spill-claim.jsonl').drift).toBe('{}');
  });
});

describe('AC10 — the input columns, and `text_bytes` in every arm', () => {
  it('splits input three ways, and sizes the payload rather than the preview', () => {
    const result = project('large-output.jsonl');

    const small = callAt(result, 'toolu_bigout');
    expect(small.input_storage).toBe('inline');
    expect(small.input).toBe('{"command":"cat big"}');
    expect(small.input_bytes).toBe(bytes(small.input!));

    // Witnessed ONCE in the corpus, at 68,782 B on a `Write` call — the inverse
    // of the output side, where the over-cap arm is extinct.
    const big = callAt(result, 'toolu_bigin');
    expect(big.input_storage).toBe('line_ref');
    expect(big.input_bytes).toBeGreaterThan(INLINE_MAX);
    expect(bytes(big.input!)).toBeLessThanOrEqual(PREVIEW_MAX);

    // Legal harness shape, unwitnessed: 0 of 15,220 blocks omit `input`.
    const none = callAt(result, 'toolu_noinput');
    expect(none.input_storage).toBe('absent');
    expect(none.input).toBeUndefined();
    expect(none.input_bytes).toBeUndefined();
  });

  it('leaves `input_storage` UNDEFINED on every row that is not a tool call', () => {
    // Never `'absent'` — the same shape `output_storage` already has, and the
    // difference between "the call carried none" and "this is not a call".
    for (const event of project('tool-join.jsonl').events) {
      if (event.kind === 'tool_call') continue;
      expect(event.input_storage, event.id).toBeUndefined();
      expect(event.input, event.id).toBeUndefined();
      expect(event.input_bytes, event.id).toBeUndefined();
    }
  });

  it('measures `text_bytes` in TRUE bytes, not characters', () => {
    // 41 characters, 43 bytes: a `.length` regression reds here and nowhere else.
    const denied = callAt(project('tool-join.jsonl'), 'toolu_denied');

    expect(denied.text).toHaveLength(41);
    expect(denied.text_bytes).toBe(43);
  });

  it('defines `text_bytes` exactly when the output is not absent', () => {
    for (const name of ['tool-join.jsonl', 'async-agent.jsonl', 'spill-claim.jsonl']) {
      const calls = project(name).events.filter((event) => event.kind === 'tool_call');
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        expect(call.text_bytes === undefined, `${name} ${call.id}`).toBe(
          call.output_storage === 'absent',
        );
        if (call.output_storage === 'inline') expect(call.text_bytes).toBe(bytes(call.text!));
      }
    }
  });
});

/** Every line of every non-test source file under `src/` and `ui/src/`. */
function sourceLines(): { file: string; line: number; text: string }[] {
  // `src/project/__tests__/` up to the repo root.
  const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const hits: { file: string; line: number; text: string }[] = [];

  for (const tree of ['src', join('ui', 'src')]) {
    for (const name of readdirSync(join(root, tree), { recursive: true, encoding: 'utf8' })) {
      const file = name.split('\\').join('/');
      if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue;
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx') || file.includes('__tests__/'))
        continue;

      for (const [index, text] of readFileSync(join(root, tree, name), 'utf8')
        .split('\n')
        .entries()) {
        hits.push({ file: `${tree}/${file}`, line: index + 1, text });
      }
    }
  }
  return hits;
}
