import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules, scrubText, scrubJsonl, stripAttachmentLine } from './scrub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'scrub.config.json'), 'utf8'));
const rules = compileRules(config);
const anon = {
  home: '/Users/realperson',
  user: 'realperson',
  homePlaceholder: config.anonymize.homePlaceholder,
  userPlaceholder: config.anonymize.userPlaceholder,
};

/** Secret shapes that must NOT survive scrubbing (matches SCRUBBING.md greps). */
const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

describe('scrubText redacts known secret shapes to zero hits', () => {
  it.each([
    'sk-ant-abcd1234EFGH5678ijkl',
    'sk-abcd1234EFGH5678ijklmnop',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnop1234567890',
    'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT',
  ])('leaves no residue for %s', (secret) => {
    const input = `{"tool_output":"leak=${secret} more text"}`;
    const out = scrubText(input, rules, anon);
    for (const shape of SECRET_SHAPES) {
      expect(shape.test(out)).toBe(false);
    }
  });

  it('redacts bearer and x-agentlens-token headers', () => {
    const input = 'Authorization: Bearer supersecretvalue123\nx-agentlens-token: tok_abc123';
    const out = scrubText(input, rules, anon);
    expect(out).not.toContain('supersecretvalue123');
    expect(out).not.toContain('tok_abc123');
    expect(out).toContain('Bearer REDACTED');
  });

  it('redacts key/token/secret/password assignments', () => {
    const input = '{"API_KEY":"deadbeef","PASSWORD":"hunter2","X_SECRET":"nope"}';
    const out = scrubText(input, rules, anon);
    expect(out).not.toContain('deadbeef');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('nope');
  });

  it('anonymizes home dir and username', () => {
    const input = '/Users/realperson/.claude/projects/x by realperson';
    const out = scrubText(input, rules, anon);
    expect(out).not.toContain('/Users/realperson');
    expect(out).not.toContain('realperson');
    expect(out).toContain('/home/USER');
  });

  it('redacts emails and private IPs', () => {
    const input = 'from a@corp.io at 10.1.2.3 and 192.168.5.9';
    const out = scrubText(input, rules, anon);
    expect(out).not.toContain('a@corp.io');
    expect(out).not.toContain('10.1.2.3');
    expect(out).not.toContain('192.168.5.9');
  });

  it('is deterministic and preserves JSON shape', () => {
    const input = '{"a":1,"b":{"c":"sk-ant-abcdefgh1234"}}';
    const first = scrubText(input, rules, anon);
    const second = scrubText(input, rules, anon);
    expect(first).toBe(second);
    expect(() => JSON.parse(first)).not.toThrow();
  });

  it('preserves Q3 size markers (non-secret content survives)', () => {
    const input = 'prefix <<@000000512>> suffix';
    expect(scrubText(input, rules, anon)).toContain('<<@000000512>>');
  });
});

/**
 * The named Task 1.7 bug, from the redactor's side: this repo's own vocabulary
 * embeds the literal `sk-` ("ta-sk-break", "di-sk-usage"). scrub.config.json's
 * quantifiers were always correct here — it was SCRUBBING.md:62's hand-copied,
 * quantifier-less grep that false-positived. This corpus pins the correct
 * behavior so a future "tighten the regex" edit cannot regress it silently.
 * The detector half of the same corpus lives in verify.test.mjs.
 */
const FALSE_POSITIVE_CORPUS = [
  'task-break',
  'task-review',
  'task-shipper',
  'disk-usage',
  'ask-me',
  'risk-score',
  'internal_docs/agent-lens/tasks/task-1.7-fixture-finalization.md',
  'run task-break then task-review then task-shipper; check disk-usage',
];

describe('scrubText does not false-positive on this repo (AC1)', () => {
  it.each(FALSE_POSITIVE_CORPUS)('leaves %s byte-identical', (line) => {
    expect(scrubText(line, rules, anon)).toBe(line);
  });

  it('still redacts a short anthropic key (the {20,} regression guard)', () => {
    // scrub.test.mjs's original assertion, restated as an explicit AC: raising
    // the sk-ant- quantifier to {20,} would un-redact this, and rule 2's
    // (?!ant-) lookahead means no other rule would catch it.
    expect(scrubText('sk-ant-abcdefgh1234', rules, anon)).toBe('[REDACTED-ANTHROPIC-KEY]');
  });
});

/** A transcript line whose `attachment` body is the operator's private inventory. */
function attachmentLine(uuid, kind, names) {
  return JSON.stringify({
    parentUuid: 'u0',
    isSidechain: false,
    attachment: { type: kind, addedNames: names, addedLines: names.length, content: names.join() },
    type: 'attachment',
    uuid,
    timestamp: '2026-07-25T18:22:03.914Z',
    userType: 'external',
    cwd: '/work/scratch-project',
    sessionId: '46f49151-6f7a-4b1e-9b6f-1b2c3d4e5f60',
    version: '2.1.197',
    gitBranch: 'main',
  });
}

const PRIVATE_INVENTORY = ['acme-client-deploy', 'internal-revenue-audit', 'founder-inbox-triage'];

describe('scrubJsonl strips attachment bodies (AC2)', () => {
  const attachA = attachmentLine('u1', 'skill_listing', PRIVATE_INVENTORY);
  const attachB = attachmentLine('u3', 'agent_listing_delta', PRIVATE_INVENTORY);
  const plain = [
    '{"type":"user","uuid":"u0","message":{"role":"user","content":"hi"}}',
    '{"type":"assistant","uuid":"u2","message":{"role":"assistant","content":"ok"}}',
    '{"type":"system","uuid":"u4","subtype":"turn_end"}',
  ];
  const input = `${[plain[0], attachA, plain[1], attachB, plain[2]].join('\n')}\n`;
  const out = scrubJsonl(input, rules, anon, config);
  const outLines = out.split('\n').slice(0, -1);

  it('preserves line count', () => {
    expect(outLines).toHaveLength(5);
  });

  it('leaves every line valid JSON', () => {
    for (const line of outLines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('leaves non-attachment lines byte-identical', () => {
    expect(outLines[0]).toBe(plain[0]);
    expect(outLines[2]).toBe(plain[1]);
    expect(outLines[4]).toBe(plain[2]);
  });

  it('replaces the attachment body with {type, stripped}', () => {
    for (const [index, kind] of [
      [1, 'skill_listing'],
      [3, 'agent_listing_delta'],
    ]) {
      expect(JSON.parse(outLines[index]).attachment).toEqual({ type: kind, stripped: true });
    }
  });

  it('preserves the envelope keys the tailer walks', () => {
    const parsed = JSON.parse(outLines[1]);
    expect(parsed.uuid).toBe('u1');
    expect(parsed.parentUuid).toBe('u0');
    expect(parsed.timestamp).toBe('2026-07-25T18:22:03.914Z');
    expect(parsed.sessionId).toBe('46f49151-6f7a-4b1e-9b6f-1b2c3d4e5f60');
    expect(parsed.type).toBe('attachment');
  });

  it('leaves no operator inventory name anywhere in the output', () => {
    for (const name of PRIVATE_INVENTORY) expect(out).not.toContain(name);
  });

  it('strips every attachment kind, including unknown ones (fail-closed)', () => {
    const unknown = attachmentLine('u9', 'future_listing_v2', PRIVATE_INVENTORY);
    const stripped = JSON.parse(stripAttachmentLine(unknown, config));
    expect(stripped.attachment).toEqual({ type: 'future_listing_v2', stripped: true });
  });

  it('honors stripAllAttachments:false by restricting to attachmentTypes', () => {
    const narrow = { strip: { attachmentTypes: ['skill_listing'], stripAllAttachments: false } };
    const known = attachmentLine('u9', 'skill_listing', PRIVATE_INVENTORY);
    const other = attachmentLine('u9', 'agent_listing_delta', PRIVATE_INVENTORY);
    expect(JSON.parse(stripAttachmentLine(known, narrow)).attachment.stripped).toBe(true);
    expect(stripAttachmentLine(other, narrow)).toBe(other);
  });

  it('passes through non-JSON and non-attachment lines untouched', () => {
    expect(stripAttachmentLine('not json at all', config)).toBe('not json at all');
    expect(stripAttachmentLine('', config)).toBe('');
    expect(stripAttachmentLine('{"type":"user"}', config)).toBe('{"type":"user"}');
  });

  it('REFUSES a torn line rather than letting the inventory through', () => {
    // A transcript copied mid-write leaves a truncated last line. Passing it to
    // the text-only path would carry the attachment body into the fixture, and
    // no scrub or detect rule can recognize a skill/agent/MCP name — so it
    // would clear every automated gate. Fail closed.
    const torn = attachA.slice(0, 120);
    expect(torn).toContain(PRIVATE_INVENTORY[0]); // the leak this refusal prevents
    const input = `${plain[0]}\n${torn}`;
    expect(() => scrubJsonl(input, rules, anon, config)).toThrow(/line 2 is not valid JSON/);
    expect(() => scrubJsonl(input, rules, anon, config)).toThrow(/Re-capture/);
    // ...and the text pass alone would not have caught it.
    expect(scrubText(torn, rules, anon)).toContain(PRIVATE_INVENTORY[0]);
  });

  it('tolerates a trailing blank line (not a torn line)', () => {
    expect(() => scrubJsonl(`${plain[0]}\n`, rules, anon, config)).not.toThrow();
  });
});

describe('scrubJsonl strips hookInfos[].command from system lines (Task 1.7 OQ3)', () => {
  // The real leak, verbatim from fixtures/scrubbed/*/transcripts/parent.jsonl
  // before this rule existed. It is the operator's OTHER registered hook.
  const OPERATOR_HOOK =
    '[ -n "$SUPERSET_HOME_DIR" ] && [ -x "$SUPERSET_HOME_DIR/hooks/notify.sh" ] && ' +
    'SUPERSET_AGENT_ID=claude "$SUPERSET_HOME_DIR/hooks/notify.sh" || true';

  const stopHookLine = JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    uuid: 'u-stop-1',
    parentUuid: 'u-prev',
    hookCount: 2,
    hookInfos: [{ command: OPERATOR_HOOK, durationMs: 49 }, { command: 'agent-lens hook' }],
    hookErrors: [],
  });

  it('redacts every command, including agent-lens own', () => {
    const out = JSON.parse(stripAttachmentLine(stopHookLine, config));
    expect(out.hookInfos[0].command).toBe('[REDACTED-HOOK-COMMAND]');
    // Deliberately NOT allowlisted: auditing a redactor by reading the strings
    // it chose to keep is not auditing it. agent-lens's participation is proven
    // by the envelope stream, not by this field.
    expect(out.hookInfos[1].command).toBe('[REDACTED-HOOK-COMMAND]');
    expect(JSON.stringify(out)).not.toContain('SUPERSET_HOME_DIR');
    expect(JSON.stringify(out)).not.toContain('notify.sh');
  });

  it('preserves shape: line kept, array length, hookCount, durationMs, uuid chain', () => {
    const out = JSON.parse(stripAttachmentLine(stopHookLine, config));
    expect(out.hookInfos).toHaveLength(2);
    expect(out.hookCount).toBe(2);
    expect(out.hookInfos[0].durationMs).toBe(49); // sibling keys untouched
    expect(out.uuid).toBe('u-stop-1');
    expect(out.parentUuid).toBe('u-prev'); // the chain Phase 3's tailer walks
    expect(out.subtype).toBe('stop_hook_summary');
  });

  it('★ NO regex rule can catch this — which is why it needed a structural strip', () => {
    // The whole reason this survived four captures and a standing security gate:
    // the command is ordinary shell text with no secret SHAPE, so the text pass
    // and every detectRule score it clean. If this expectation ever flips, the
    // structural strip has become redundant and this comment is wrong.
    expect(scrubText(stopHookLine, rules, anon)).toContain('SUPERSET_HOME_DIR');
  });

  it('★ EXEMPTS compact_boundary — the compaction set’s entire payload', () => {
    const boundary = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'u-boundary',
      logicalParentUuid: 'u-pre-compact',
      compactMetadata: { trigger: 'manual', preTokens: 1234 },
      hookInfos: [{ command: 'should survive the exemption' }],
    });
    expect(stripAttachmentLine(boundary, config)).toBe(boundary);
  });

  it('leaves other system subtypes and non-system lines alone', () => {
    // turn_duration / away_summary carry no hookInfos; nothing should change.
    const turn = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 12 });
    expect(stripAttachmentLine(turn, config)).toBe(turn);
    expect(stripAttachmentLine('{"type":"user"}', config)).toBe('{"type":"user"}');
  });

  it('is idempotent', () => {
    const once = stripAttachmentLine(stopHookLine, config);
    expect(stripAttachmentLine(once, config)).toBe(once);
  });

  it('survives a malformed hookInfos without throwing', () => {
    const odd = JSON.stringify({
      type: 'system',
      subtype: 'stop_hook_summary',
      hookInfos: [null, 'a string', {}, { command: OPERATOR_HOOK }],
    });
    const out = JSON.parse(stripAttachmentLine(odd, config));
    expect(out.hookInfos[3].command).toBe('[REDACTED-HOOK-COMMAND]');
    expect(out.hookInfos[0]).toBeNull();
    expect(JSON.stringify(out)).not.toContain('SUPERSET_HOME_DIR');
  });

  it('runs through the full scrubJsonl pass, not just the unit helper', () => {
    const out = scrubJsonl(stopHookLine, rules, anon, config);
    expect(out).not.toContain('SUPERSET_HOME_DIR');
    expect(out).toContain('[REDACTED-HOOK-COMMAND]');
  });

  it('★ strips the ENVELOPE-nested copy too (envelopes.jsonl, raw_payload)', () => {
    // The same transcript line reaches disk twice, in two shapes. This is the
    // one the original strip never tested — see stripParsedLine's header.
    const envelope = JSON.stringify({
      event_id: 'sess-1:transcript:u-stop-1',
      session_id: 'sess-1',
      source: 'transcript',
      ts: '2026-08-05T00:00:00.000Z',
      raw_payload: JSON.parse(stopHookLine),
    });
    const out = JSON.parse(stripAttachmentLine(envelope, config));
    expect(out.raw_payload.hookInfos[0].command).toBe('[REDACTED-HOOK-COMMAND]');
    expect(JSON.stringify(out)).not.toContain('SUPERSET_HOME_DIR');
    // The envelope's own identity fields must survive — Phase 2 replays these.
    expect(out.event_id).toBe('sess-1:transcript:u-stop-1');
    expect(out.source).toBe('transcript');
  });
});

describe('★ REGRESSION: attachment bodies nested in an Envelope (found 2026-08-05)', () => {
  // PR #11's attachment strip only ever tested the TOP-LEVEL `type`. Every
  // attachment captured through the collector therefore reached
  // envelopes.jsonl INTACT — 11 across three fixture sets, carrying the
  // operator's installed skill/agent/MCP inventory. verify.mjs exits 0 on it
  // because no scrub or detect rule can recognize those names, which is exactly
  // why this needed a structural strip and why it survived four captures.
  const inventoryLine = JSON.stringify({
    type: 'attachment',
    uuid: 'u-att-1',
    parentUuid: 'u-prev',
    attachment: {
      type: 'skill_listing',
      content: `- ${PRIVATE_INVENTORY[0]}: a private skill the operator installed`,
    },
  });

  it('strips it inside raw_payload, not just at the top level', () => {
    const envelope = JSON.stringify({
      event_id: 'sess-1:transcript:u-att-1',
      session_id: 'sess-1',
      source: 'transcript',
      raw_payload: JSON.parse(inventoryLine),
    });
    const out = JSON.parse(stripAttachmentLine(envelope, config));
    expect(out.raw_payload.attachment).toEqual({ type: 'skill_listing', stripped: true });
    expect(JSON.stringify(out)).not.toContain(PRIVATE_INVENTORY[0]);
    expect(out.event_id).toBe('sess-1:transcript:u-att-1');
    expect(out.raw_payload.parentUuid).toBe('u-prev');
  });

  it('★ the text pass alone would NOT have caught it', () => {
    // The proof that this is a structural leak and not a regex gap: an
    // installed skill name has no secret shape, so scrubText passes it through.
    expect(scrubText(inventoryLine, rules, anon)).toContain(PRIVATE_INVENTORY[0]);
  });

  it('is idempotent over an already-stripped envelope', () => {
    const envelope = JSON.stringify({
      source: 'transcript',
      raw_payload: JSON.parse(inventoryLine),
    });
    const once = stripAttachmentLine(envelope, config);
    expect(stripAttachmentLine(once, config)).toBe(once);
  });

  it('leaves an envelope whose raw_payload is not a strippable line alone', () => {
    const hookEnv = JSON.stringify({
      source: 'hook',
      hook_name: 'PreToolUse',
      raw_payload: { tool_name: 'Bash', tool_use_id: 'toolu_1' },
    });
    expect(stripAttachmentLine(hookEnv, config)).toBe(hookEnv);
  });
});

describe('scrubJsonl is deterministic, idempotent, and shape-preserving (AC1/AC4)', () => {
  const corpus = Array.from({ length: 100 }, (_, i) =>
    i % 3 === 0
      ? attachmentLine(`u${i}`, 'skill_listing', PRIVATE_INVENTORY)
      : JSON.stringify({ type: 'user', uuid: `u${i}`, text: `sk-ant-abcd1234EFGH5678ijkl ${i}` }),
  ).join('\n');

  it('preserves line count on a 100-line input', () => {
    expect(scrubJsonl(`${corpus}\n`, rules, anon, config).split('\n').slice(0, -1)).toHaveLength(
      100,
    );
  });

  it('is idempotent', () => {
    const once = scrubJsonl(`${corpus}\n`, rules, anon, config);
    expect(scrubJsonl(once, rules, anon, config)).toBe(once);
  });

  it('is deterministic', () => {
    expect(scrubJsonl(`${corpus}\n`, rules, anon, config)).toBe(
      scrubJsonl(`${corpus}\n`, rules, anon, config),
    );
  });

  it('preserves the presence or absence of a trailing newline', () => {
    const line = '{"type":"user","uuid":"u0"}';
    expect(scrubJsonl(`${line}\n`, rules, anon, config)).toBe(`${line}\n`);
    expect(scrubJsonl(line, rules, anon, config)).toBe(line);
  });

  it('still redacts secrets inside a stripped transcript', () => {
    const withSecret = `{"type":"user","text":"key is sk-ant-abcd1234EFGH5678ijkl"}\n`;
    expect(scrubJsonl(withSecret, rules, anon, config)).toContain('[REDACTED-ANTHROPIC-KEY]');
  });
});

describe('join keys survive scrubbing (AC4)', () => {
  // Rewriting any of these breaks the envelopes <-> parent transcript <->
  // subagents/*.meta.json correlation that Tasks 2.6 and 4.3 depend on.
  const JOIN_KEYS = [
    '2026-07-25T18:22:03.914Z',
    '46f49151-6f7a-4b1e-9b6f-1b2c3d4e5f60',
    'toolu_011yHPRrpTe1ESJTtV7wAaiK',
    'agent-a45c7513-6f7a-4b1e-9b6f-1b2c3d4e5f60',
    'prompt_01HZX9',
  ];

  it.each(JOIN_KEYS)('passes %s through verbatim', (key) => {
    const line = `{"k":"${key}"}`;
    expect(scrubText(line, rules, anon)).toBe(line);
    expect(scrubJsonl(`${line}\n`, rules, anon, config)).toBe(`${line}\n`);
  });

  it('keeps join keys on a realistic envelope line', () => {
    const envelope = JSON.stringify({
      event_id: '46f49151:hook:PostToolUse:toolu_011yHPRrpTe1ESJTtV7wAaiK',
      session_id: '46f49151-6f7a-4b1e-9b6f-1b2c3d4e5f60',
      harness: 'claude-code',
      source: 'hook',
      hook_name: 'PostToolUse',
      tool_use_id: 'toolu_011yHPRrpTe1ESJTtV7wAaiK',
      ts: '2026-07-25T18:22:03.914Z',
      raw_payload: { agent_id: 'agent-a45c7513', tool_response: { stdout: '<<@000000512>>' } },
    });
    expect(scrubJsonl(`${envelope}\n`, rules, anon, config)).toBe(`${envelope}\n`);
  });
});
