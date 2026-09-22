// Task 2.3 AC6-AC8, AC10-AC12 for `../human.js`. The golden scorer lives next
// door in `./human-golden.test.ts`; this file pins the shapes and the two
// archive regressions that plan 001's defect keeps coming back through.
//
// Every count quoted here is DATED EVIDENCE measured against
// `~/.agent-lens/archive` on 2026-08-13, never an assertion: a launchd cron
// appends to the archive every 15 minutes.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { arr, obj } from '../accessors.js';
import { classifyLine, type ParsedLine } from '../line.js';
import { fallbackIsHuman, isHumanPrompt, MACHINERY_TAGS } from '../human.js';
import { ARCHIVE_ROOT, archiveJsonlFiles, classifyFixture, ctx, offsetLines } from './fixtures.js';
import { runIt } from './run-it.js';

/** Lower bounds, well under 2026-08-13's measurement of 262 files / 43,108 lines. */
const MIN_FILES = 100;
const MIN_LINES = 20000;

/** The real prompt every ship-task sub-agent is launched with. Prose, by an agent. */
const SHIP_TASK_PROMPT =
  'You are executing a task autonomously. Read ~/.claude/skills/ship-task/SKILL.md and ' +
  'follow it exactly for the task file path you were given. You are in sub-agent mode.';

/** One `user` line carrying `text`, plus whatever the case under test overrides. */
function userLine(text: string, extra: Record<string, unknown> = {}): ParsedLine {
  return classifyLine(
    {
      type: 'user',
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-08-13T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text }] },
      ...extra,
    },
    ctx(),
  );
}

describe('AC6 — ★ a line that is not a user line is never human', () => {
  it('refuses an assistant line carrying ordinary prose', () => {
    // Real archive text. With every other clause applied but the `kind` guard,
    // 1,149 assistant lines score human against an oracle of 90 — a 12.8x
    // overcount, and plan 001's headline bug on its third recurrence.
    const line = classifyLine(
      {
        type: 'assistant',
        uuid: '22222222-2222-4222-8222-222222222222',
        message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] },
      },
      ctx(),
    );
    expect(isHumanPrompt(line)).toEqual({ human: false, path: 'kind', reason: 'not-a-user-line' });
  });

  it('refuses it through the exported fallback too, called with nothing in front of it', () => {
    // The export exists so the golden scorer can score it standalone, which is
    // exactly the call that would resurrect the 12.8x defect if `kind` were only
    // the caller's guard.
    const { lines } = classifyFixture('human-fallback.jsonl');
    const assistants = lines.filter((line) => line.kind === 'assistant');
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants.filter(fallbackIsHuman)).toEqual([]);
  });

  it.each(['system', 'attachment', 'ai-title', 'mode', 'queue-operation'])(
    'refuses a %s line whatever it carries',
    (type) => {
      const line = classifyLine(
        {
          type,
          subtype: 'turn_duration',
          message: { role: 'user', content: 'ship task 2.3 and open the draft PR' },
        },
        ctx(),
      );
      expect(isHumanPrompt(line).human).toBe(false);
      expect(fallbackIsHuman(line)).toBe(false);
    },
  );
});

describe('AC7 — the origin fast path is authoritative in both directions', () => {
  const TEXT = 'ship task 2.3 and open the draft PR';

  const CASES: ReadonlyArray<readonly [string | undefined, boolean, boolean]> = [
    // origin.kind, isSidechain, expected human
    ['human', false, true],
    // 0 occurrences in the archive — all 90 human-origin lines are non-sidechain.
    // A DESIGN DECISION, not a reproduction: the fast path wins.
    ['human', true, true],
    ['task-notification', false, false],
    ['task-notification', true, false],
    // Undocumented in the RFC's table, 2 occurrences. Machinery falls out of
    // "any kind other than human" with no branch of its own.
    ['coordinator', false, false],
    ['coordinator', true, false],
    // Absent: the fallback decides, and only the sidechain flag separates these.
    [undefined, false, true],
    [undefined, true, false],
  ];

  it.each(CASES)('origin %s x isSidechain %s -> human %s', (kind, isSidechain, human) => {
    const line = userLine(TEXT, {
      isSidechain,
      ...(kind === undefined ? {} : { origin: { kind } }),
    });
    const verdict = isHumanPrompt(line);
    expect(verdict.human).toBe(human);
    expect(verdict.path).toBe(kind === undefined ? 'fallback' : 'origin');
  });

  it('falls through to the fallback when origin carries no readable kind', () => {
    expect(isHumanPrompt(userLine(TEXT, { origin: {} })).path).toBe('fallback');
    expect(isHumanPrompt(userLine(TEXT, { origin: { kind: 7 } })).path).toBe('fallback');
    expect(isHumanPrompt(userLine(TEXT, { origin: 'human' })).path).toBe('fallback');
  });
});

describe('AC8 — every independently reachable fallback clause is load-bearing', () => {
  const PROSE = 'ship task 2.3 and open the draft PR';

  it('calls ordinary typed prose human, so the table below is not vacuous', () => {
    expect(fallbackIsHuman(userLine(PROSE))).toBe(true);
    expect(isHumanPrompt(userLine(PROSE))).toEqual({
      human: true,
      path: 'fallback',
      reason: 'prose',
    });
  });

  it('calls a bare-string /compact invocation human', () => {
    // Both typed `/compact` invocations in the archive carry no `origin` at all,
    // so the fast path alone has FN=2 without the fallback.
    const line = classifyLine(
      { type: 'user', message: { role: 'user', content: '/compact keep the measurements' } },
      ctx(),
    );
    expect(isHumanPrompt(line).human).toBe(true);
  });

  it.each([
    ['not a user line', { type: 'assistant' }, 'not-a-user-line'],
    ['a sub-agent line', { isSidechain: true }, 'sidechain'],
    ['a meta line', { isMeta: true }, 'meta'],
    ['a compaction summary', { isCompactSummary: true }, 'compact-summary'],
  ])('%s flips the verdict on that clause alone', (_label, override, reason) => {
    const line = userLine(PROSE, override);
    expect(fallbackIsHuman(line)).toBe(false);
    expect(isHumanPrompt(line).reason).toBe(reason);
  });

  it.each([
    ['<system-reminder>\nthe user opened a plan file\n</system-reminder>', 'machinery-tag'],
    ['<never-measured-tag>a tag nobody has seen yet', 'machinery-tag'],
    ['[Request interrupted by user for tool use]', 'machinery-prefix:[Request interrupted'],
    [
      'Caveat: The messages below were generated by the user',
      'machinery-prefix:Caveat: The messages below',
    ],
    [
      'This session is being continued from a previous conversation',
      'machinery-prefix:This session is being continued',
    ],
    ['API Error: 500 upstream connect error', 'machinery-prefix:API Error'],
    ['   \n  ', 'no-text'],
    ['', 'no-text'],
  ])('text %j flips the verdict on that clause alone', (text, reason) => {
    const line = userLine(text);
    expect(fallbackIsHuman(line)).toBe(false);
    expect(isHumanPrompt(line).reason).toBe(reason);
  });

  it('claims no individual weight for MACHINERY_TAGS — the generic rule covers all 11', () => {
    // Documentation of intent, deliberately kept: no input exists where the
    // named list flips a verdict on its own, so AC8 tests the clause THROUGH the
    // generic rule rather than pretending the list is load-bearing.
    expect(MACHINERY_TAGS).toHaveLength(11);
    for (const tag of MACHINERY_TAGS) {
      expect(/^<[a-z][a-z0-9-]*>/.test(tag), tag).toBe(true);
      expect(fallbackIsHuman(userLine(`${tag} whatever follows`)), tag).toBe(false);
    }
  });
});

describe('AC10 — sub-agent prompts are not human', () => {
  it('refuses a real ship-task prompt: sidechain, no origin, pure prose', () => {
    // 235 sidechain `user` lines carry origin-less, tag-less prose today, and
    // every one is an agent prompt. Without `isSidechain !== true` the fallback
    // overcounts by 3.7x.
    const line = userLine(SHIP_TASK_PROMPT, { isSidechain: true });
    expect(fallbackIsHuman(line)).toBe(false);
    expect(isHumanPrompt(line)).toEqual({ human: false, path: 'fallback', reason: 'sidechain' });
  });

  it('would have called it human without that one clause', () => {
    // Non-vacuity: the prompt fails no other clause, so the case above really is
    // about the sidechain flag and not about the text being unusual.
    expect(fallbackIsHuman(userLine(SHIP_TASK_PROMPT))).toBe(true);
  });
});

describe('AC12 — ★ the fallback reads top-level text blocks and nothing else', () => {
  const PROSE = 'ship task 2.3 and open the draft PR';

  it('ignores prose that lives inside a tool_result, bare-string content and array alike', () => {
    // `tool_result.content` is a bare string 13,144 times. Joining that text into
    // the fallback's input scores 2,028 `user` lines human against an oracle of
    // 90 — a 22.5x overcount, the same defect class as the 3.7x and 12.8x ones.
    const bare = classifyLine(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: PROSE }],
        },
      },
      ctx(),
    );
    const array = classifyLine(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: PROSE }] },
          ],
        },
      },
      ctx(),
    );

    expect(isHumanPrompt(bare)).toEqual({ human: false, path: 'fallback', reason: 'no-text' });
    expect(isHumanPrompt(array).human).toBe(false);
    // The same prose, one level up, is a person talking.
    expect(isHumanPrompt(userLine(PROSE)).human).toBe(true);
  });

  it('joins several top-level text blocks and judges the leading one', () => {
    const line = classifyLine(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>context</system-reminder>' },
            { type: 'text', text: PROSE },
          ],
        },
      },
      ctx(),
    );
    expect(isHumanPrompt(line).reason).toBe('machinery-tag');
  });
});

describe('AC11 — isHumanPrompt is total', () => {
  it('never throws on any line fast-check can build', () => {
    fc.assert(
      fc.property(fc.anything({ maxDepth: 4, withBigInt: true, withMap: true }), (value) => {
        const line = classifyLine(value, ctx());
        expect(() => isHumanPrompt(line)).not.toThrow();
        expect(() => fallbackIsHuman(line)).not.toThrow();
      }),
      { seed: 20260813, numRuns: 500 },
    );
  });

  it('never throws on a user line with arbitrary content', () => {
    fc.assert(
      fc.property(fc.anything({ maxDepth: 4 }), (content) => {
        const line = classifyLine({ type: 'user', message: { content } }, ctx());
        expect(() => isHumanPrompt(line)).not.toThrow();
      }),
      { seed: 20260813, numRuns: 500 },
    );
  });
});

describe('the mixed fixture separates the people from the machinery', () => {
  const { lines } = classifyFixture('human-fallback.jsonl');

  it('picks exactly the two typed prompts out of ten lines', () => {
    const human = lines.map((line, index) => (isHumanPrompt(line).human ? index : -1));
    expect(human.filter((index) => index >= 0)).toEqual([0, 7]);
  });

  it('records which path decided every line', () => {
    expect(lines.map((line) => isHumanPrompt(line).path)).toEqual([
      'fallback',
      'fallback',
      'fallback',
      'fallback',
      'fallback',
      'fallback',
      'fallback',
      'fallback',
      'kind',
      'origin',
    ]);
  });

  it('shows the fast path overriding a fallback that would have said human', () => {
    // The last line is prose, not sidechain, no tag — the fallback calls it
    // human. `origin.kind: 'task-notification'` is authoritative and wins.
    const notification = lines.at(-1);
    if (notification === undefined) throw new Error('unreachable');
    expect(fallbackIsHuman(notification)).toBe(true);
    expect(isHumanPrompt(notification)).toEqual({
      human: false,
      path: 'origin',
      reason: 'origin:task-notification',
    });
  });
});

interface Regression {
  files: number;
  lines: number;
  assistantLines: number;
  assistantsScoredHuman: number;
  userLines: number;
  toolResultLines: number;
  toolResultLinesScoredHuman: number;
  humanDetections: number;
}

let scanned: Regression | undefined;

/** One walk of the archive for the two regressions that keep recurring. */
function scanArchive(): Regression {
  if (scanned !== undefined) return scanned;

  const found: Regression = {
    files: 0,
    lines: 0,
    assistantLines: 0,
    assistantsScoredHuman: 0,
    userLines: 0,
    toolResultLines: 0,
    toolResultLinesScoredHuman: 0,
    humanDetections: 0,
  };

  for (const file of archiveJsonlFiles(ARCHIVE_ROOT)) {
    found.files += 1;
    for (const entry of offsetLines(readFileSync(file).toString('utf8'))) {
      found.lines += 1;
      let json: unknown;
      try {
        json = JSON.parse(entry.text);
      } catch {
        continue;
      }

      const line = classifyLine(json, ctx(entry.byteOffset));
      const human = isHumanPrompt(line).human;
      if (human) found.humanDetections += 1;
      if (line.kind === 'assistant') {
        found.assistantLines += 1;
        if (human) found.assistantsScoredHuman += 1;
      }
      if (line.kind !== 'user') continue;

      found.userLines += 1;
      const blocks = arr(obj(line.raw.message, undefined)?.content, []);
      const carriesToolResult = blocks.some(
        (block) => obj(block, undefined)?.type === 'tool_result',
      );
      if (!carriesToolResult) continue;
      found.toolResultLines += 1;
      if (human) found.toolResultLinesScoredHuman += 1;
    }
  }

  scanned = found;
  return found;
}

describe('the archive regressions (opt-in via AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt(
    'AC6 — ★ zero assistant lines score human across the whole archive',
    () => {
      const found = scanArchive();
      expect(found.files).toBeGreaterThanOrEqual(MIN_FILES);
      expect(found.lines).toBeGreaterThanOrEqual(MIN_LINES);
      console.log('human detections', found.humanDetections, 'of', found.userLines, 'user lines');

      // Non-vacuity: a discriminator that answered `false` for everything would
      // satisfy the zero below and be worse than useless, and an archive with no
      // assistant line in it would satisfy it for free.
      expect(found.humanDetections).toBeGreaterThan(0);
      expect(found.assistantLines).toBeGreaterThan(0);
      expect(found.assistantsScoredHuman).toBe(0);
    },
    600000,
  );

  runIt(
    'AC12 — ★ zero user lines carrying a tool_result score human',
    () => {
      const found = scanArchive();
      expect(found.files).toBeGreaterThanOrEqual(MIN_FILES);
      expect(found.lines).toBeGreaterThanOrEqual(MIN_LINES);
      console.log('user lines carrying a tool_result', found.toolResultLines);

      expect(found.userLines).toBeGreaterThan(0);
      expect(found.toolResultLines).toBeGreaterThan(0);
      expect(found.toolResultLinesScoredHuman).toBe(0);
    },
    600000,
  );
});
