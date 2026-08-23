// Task 3.2's three readers, plus the source-property arm that pins the ONE
// harness string this directory deliberately holds twice.
//
// Every reader here is total by the same contract the accessors carry: no input,
// however malformed, may throw. A notification is not a promise about its own
// contents — 4 of 158 name no call and 2 carry no payload — so absence is a
// value each of these functions answers, never an exception it raises.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asyncAgentLaunch, claimsPersistedOutput, taskNotification } from '../agents.js';
import { classifyLine, type ParsedLine } from '../line.js';
import { ctx } from './fixtures.js';

/** `src/transcript/` — the directory this file's `__tests__/` sits in. */
const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const LAUNCH_MARKER = 'Async agent launched successfully.';

const MARKER_TEXT =
  `${LAUNCH_MARKER} (This tool result is internal metadata.)\n` +
  'agentId: a718129935450dac5 (internal ID - do not mention to user.)\n' +
  'The agent is working in the background.';

function line(raw: Record<string, unknown>): ParsedLine {
  return classifyLine({ type: 'user', uuid: 'u', ...raw }, ctx());
}

function notification(inner: readonly string[]): string {
  return ['<task-notification>', ...inner, '</task-notification>'].join('\n');
}

describe('asyncAgentLaunch — the structured field, then the marker', () => {
  it('reads the structured field, and answers the agent id with it', () => {
    const launch = asyncAgentLaunch(
      line({ toolUseResult: { isAsync: true, agentId: 'aSTRUCTURED1' } }),
      'no marker in this text',
    );

    expect(launch).toEqual({ agentId: 'aSTRUCTURED1' });
  });

  it('reads the marker alone, on a line carrying no structured object at all', () => {
    // The sidecar shape, and the ONE real corpus witness of a launch the
    // structured field misses: 218 of 218 launches carry the marker, and the
    // field alone would find 217.
    expect(asyncAgentLaunch(line({}), MARKER_TEXT)).toEqual({ agentId: 'a718129935450dac5' });
  });

  it('tests the marker with `startsWith`, never `includes`', () => {
    // 8 `Bash` results QUOTE this marker mid-output. `includes` matches 226
    // results where `startsWith` matches 218, and the 8-row difference is
    // genuine tool output an `includes` detector would blank.
    expect(asyncAgentLaunch(line({}), `grep found: ${MARKER_TEXT}`)).toBeUndefined();
  });

  it('answers nothing for a plain result, and for a false `isAsync`', () => {
    expect(asyncAgentLaunch(line({}), 'total 24\ndrwxr-xr-x')).toBeUndefined();
    expect(asyncAgentLaunch(line({ toolUseResult: { isAsync: false } }), 'done')).toBeUndefined();
    // `toolUseResult` is a bare STRING on some calls, so every read of it has to
    // go through the object narrowing rather than a property access.
    expect(asyncAgentLaunch(line({ toolUseResult: 'a string' }), 'done')).toBeUndefined();
  });

  it('answers a launch with no id rather than refusing the launch', () => {
    expect(asyncAgentLaunch(line({ toolUseResult: { isAsync: true } }), '')).toEqual({
      agentId: undefined,
    });
    expect(asyncAgentLaunch(line({}), LAUNCH_MARKER)).toEqual({ agentId: undefined });
  });
});

describe('taskNotification — every inner tag is optional', () => {
  it('reads the call, the status and the payload', () => {
    const parsed = taskNotification(
      notification([
        '<task-id>aTASK1</task-id>',
        '<tool-use-id>toolu_01</tool-use-id>',
        '<status>completed</status>',
        '<result>the agent said this</result>',
      ]),
    );

    expect(parsed).toEqual({
      toolCallId: 'toolu_01',
      status: 'completed',
      result: 'the agent said this',
    });
  });

  it('answers `result: undefined` when the notification opens no `<result>`', () => {
    // ★ 2 of 158 are exactly this shape — `<output-file>` instead — and both
    // target a `Bash` id. An unguarded `match(...)[1]` throws on both.
    const parsed = taskNotification(
      notification([
        '<tool-use-id>toolu_02</tool-use-id>',
        '<output-file>/tmp/tasks/aTASK1.output</output-file>',
        '<status>killed</status>',
      ]),
    );

    expect(parsed).toEqual({ toolCallId: 'toolu_02', status: 'killed', result: undefined });
  });

  it('answers `toolCallId: undefined` when the notification names no call', () => {
    // 4 measured carry no `<tool-use-id>`. They join nothing and patch nothing.
    const parsed = taskNotification(notification(['<status>completed</status>']));

    expect(parsed?.toolCallId).toBeUndefined();
    expect(parsed?.status).toBe('completed');
  });

  it('captures the FIRST close, so a payload mentioning the tag does not run on', () => {
    const parsed = taskNotification(
      notification(['<result>first</result>', '<result>second</result>']),
    );

    expect(parsed?.result).toBe('first');
  });

  it('keeps a multi-line payload whole, newlines and all', () => {
    const parsed = taskNotification(notification(['<result>line one\nline two</result>']));

    expect(parsed?.result).toBe('line one\nline two');
  });

  it('is not a notification unless the text STARTS with the tag', () => {
    // The same gate `turnKind` applies, so a line is a notification here exactly
    // when it opens a `task_notification` turn there.
    expect(taskNotification(`quoting a <task-notification> in prose`)).toBeUndefined();
    expect(taskNotification('')).toBeUndefined();
  });
});

describe('claimsPersistedOutput — index 0, and only index 0', () => {
  it('claims a spill only when the marker opens the text', () => {
    expect(claimsPersistedOutput('<persisted-output>\nOutput too large (59.4KB).')).toBe(true);
    // The same literal appears mid-string in prose describing truncation, which
    // is why `spill.ts` records this rule and this module repeats it.
    expect(claimsPersistedOutput('the tool wrote <persisted-output> into the log')).toBe(false);
    expect(claimsPersistedOutput('')).toBe(false);
  });
});

describe('the two copies of the spill marker are pinned to each other', () => {
  it('finds the same literal in agents.ts and in spill.ts', () => {
    // ★ The duplication is FORCED: `spill.ts` keeps the marker private and
    // imports `node:path`, and `src/project/`'s purity ban on `node:` specifiers
    // is transitive — so no module in that tree can reach `spill.ts` at any
    // depth, not even its one pure-shaped export. Forced duplication still
    // drifts, and this repo answers that with a source-property test rather than
    // a comment nobody re-reads. A test file may import `node:fs` freely.
    const marker = "'<persisted-output>'";
    const sources = ['agents.ts', 'spill.ts'].map((name) =>
      readFileSync(join(MODULE_DIR, name), 'utf8'),
    );

    for (const [index, source] of sources.entries()) {
      expect(source.includes(marker), `copy ${index} lost the literal`).toBe(true);
    }
    // Non-vacuity: the reads reached real modules, not two empty strings.
    expect(sources.every((source) => source.length > 1000)).toBe(true);
  });
});
