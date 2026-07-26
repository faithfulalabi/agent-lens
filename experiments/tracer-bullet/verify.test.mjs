import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules, scrubText, listFiles } from './scrub.mjs';
import { verifyText, verifyDir, formatHit } from './verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'scrub.config.json'), 'utf8'));
const scrubRules = compileRules(config);
const detectRules = compileRules(config, 'detectRules');
const anon = {
  home: '/Users/realperson',
  user: 'realperson',
  homePlaceholder: config.anonymize.homePlaceholder,
  userPlaceholder: config.anonymize.userPlaceholder,
};

/**
 * This repo's own vocabulary. Every one of these contains the literal `sk-`
 * ("ta-sk-break", "di-sk-usage"), which is what made SCRUBBING.md:62's
 * quantifier-less grep unpassable. Task 1.7 AC1's regression corpus.
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

/** Realistic-length secrets. Each must be caught by BOTH the scrubber and the detector. */
const SECRET_CORPUS = [
  `sk-ant-api03-${'A1b2C3d4E5'.repeat(9)}xyz12`,
  `sk-${'a1B2c3D4'.repeat(6)}`,
  'AKIAABCDEFGHIJKLMNOP',
  `ghp_${'a1B2c3D4e5F6'.repeat(3)}`,
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36P',
  'Authorization: Bearer abc123.def456-ghi789',
  'x-agentlens-token: 9f8e7d6c5b4a3210',
  'contact ops at leak@corp-internal.io',
  'bound to 10.1.2.3 and 192.168.5.9 and 172.20.30.40',
  '{"API_KEY":"deadbeefcafe01"}',
  '{"db_password":"hunter2hunter2"}',
];

/**
 * Shapes the REDACTOR misses but the detector must still catch — the whole
 * reason the gate is an independent cross-check and not a projection of
 * `rules`. Each of these is a live-credential format whose hyphens/underscores
 * break the scrub rules' character classes, so a hit here is a gate failure the
 * operator resolves by adding a scrub rule (recorded as a task follow-up).
 */
const DETECT_ONLY_CORPUS = [
  ['openai project key', `sk-proj-${'A1b2C3d4E5_f-G6'.repeat(9)}`],
  ['openai service-account key', `sk-svcacct-${'A1b2C3d4E5_f-G6'.repeat(9)}`],
  ['github fine-grained PAT', `github_pat_11ABCDEFG0${'abcdefghij'.repeat(6)}`],
];

describe('verifyText — the independent cross-check (AC1)', () => {
  it.each(FALSE_POSITIVE_CORPUS)('reports zero hits on %s', (line) => {
    expect(verifyText(line, detectRules, anon)).toEqual([]);
  });

  it.each(SECRET_CORPUS)('flags %s, and clears once scrubbed', (secret) => {
    const scrubbed = scrubText(secret, scrubRules, anon);
    expect(verifyText(secret, detectRules, anon).length).toBeGreaterThan(0);
    expect(scrubbed).not.toBe(secret);
    // Placeholders must not re-trigger the detector, or the gate can never pass.
    expect(verifyText(scrubbed, detectRules, anon)).toEqual([]);
  });

  it.each(DETECT_ONLY_CORPUS)('flags a %s that the scrubber misses', (_label, secret) => {
    expect(scrubText(secret, scrubRules, anon)).toBe(secret); // redactor gap, documented
    expect(verifyText(secret, detectRules, anon).length).toBeGreaterThan(0); // gate holds
  });
});

describe('detector is a superset of the redactor (anti-drift)', () => {
  // The failure mode the loose detect set exists to catch: a scrub quantifier
  // tightened past a real secret. If detect ever became a projection of `rules`
  // the gate would return zero by construction and test nothing.
  it('detectRules is not a copy of rules', () => {
    const scrubPatterns = config.rules.map((r) => r.pattern);
    const detectPatterns = config.detectRules.map((r) => r.pattern);
    expect(detectPatterns.some((p) => scrubPatterns.includes(p))).toBe(false);
  });

  it('catches an anthropic key that a hypothetical {20,} scrub rule would miss', () => {
    // The exact regression the STOP block warns about: `{20,}` would stop
    // redacting this, and rule 2's (?!ant-) means nothing else catches it.
    const tightened = compileRules({
      rules: [{ name: 'too-tight', pattern: 'sk-ant-[A-Za-z0-9_-]{20,}', replacement: 'X' }],
    });
    const input = 'sk-ant-abcdefgh1234';
    expect(scrubText(input, tightened, anon)).toBe(input); // scrubber misses it
    expect(verifyText(input, detectRules, anon).length).toBeGreaterThan(0); // gate still fails
  });
});

/**
 * The detect rules scan `tool-results/*.txt` — up to 10MB of ARBITRARY command
 * output (a build log, a base64 blob, a minified bundle). An unbounded
 * quantifier in front of a required literal is quadratic there: the first draft
 * of `detect-keyish-assignment` (`[A-Za-z0-9_.-]*` prefix) and `detect-jwt`
 * (unbounded segments) both took >20s on 100KB and did not finish 10MB.
 *
 * The budget is deliberately loose — the observed cost is ~150ms for all 13
 * rules over 200KB. Quadratic behavior costs tens of seconds at this size, so
 * this catches a regression without being timing-flaky.
 */
describe('detect rules stay sub-quadratic on adversarial input', () => {
  const SIZE = 200_000;
  const BUDGET_MS = 5_000;

  it.each([
    ['unbroken alnum run', 'sk-ant-'.concat('a'.repeat(SIZE))],
    ['unbroken name-char run', 'a.b-c_'.repeat(SIZE / 6)],
    ['base64-dense blob', 'QUJDRGVmZ2hpams'.repeat(SIZE / 15)],
    ['eyJ-dense blob', 'eyJ'.repeat(SIZE / 3)],
    ['long run then an email', 'a'.repeat(SIZE).concat('@corp-internal.io')],
    ['long run after a key name', 'api_key:'.concat('a'.repeat(SIZE))],
  ])('scans %s within budget', (_label, text) => {
    const started = Date.now();
    verifyText(text, detectRules);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
  });
});

describe('verifyText reporting', () => {
  it('reports the 1-based line number of each hit', () => {
    const text = ['clean line', 'task-break is fine', 'AKIAABCDEFGHIJKLMNOP', 'clean'].join('\n');
    const hits = verifyText(text, detectRules, anon);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].rule).toBe('detect-aws-access-key-id');
    expect(hits[0].match).toBe('AKIAABCDEFGHIJKLMNOP');
  });

  it('flags a residual real home dir and username via anon', () => {
    const hits = verifyText('/Users/realperson/x said realperson', detectRules, anon);
    const rules = hits.map((h) => h.rule);
    expect(rules).toContain('residual-home-dir');
    expect(rules).toContain('residual-username');
  });

  it('does not flag the anonymized placeholders', () => {
    expect(verifyText('/home/USER/.claude/projects/x by USER', detectRules, anon)).toEqual([]);
  });

  it('flags a near-miss home path that is not exactly the placeholder', () => {
    const hits = verifyText('/home/USERNAME/.claude', detectRules, anon);
    expect(hits.map((h) => h.rule)).toContain('detect-home-path');
  });

  it('does not flag transcript token accounting', () => {
    const usage = '{"input_tokens":15234,"cache_read_input_tokens":1048576,"output_tokens":9}';
    expect(verifyText(usage, detectRules, anon)).toEqual([]);
  });

  it('does not flag transcript join keys', () => {
    const line =
      '{"session_id":"46f49151-6f7a-4b1e-9b6f-1b2c3d4e5f60",' +
      '"tool_use_id":"toolu_011yHPRrpTe1ESJTtV7wAaiK",' +
      '"agent_id":"agent-a45c7513","ts":"2026-07-25T18:22:03.914Z"}';
    expect(verifyText(line, detectRules, anon)).toEqual([]);
  });

  it('formatHit renders file:line:rule', () => {
    expect(
      formatHit({ file: 'a/b.jsonl', line: 7, rule: 'detect-jwt', match: 'eyJ...' }),
    ).toContain('a/b.jsonl:7:detect-jwt');
  });
});

describe('verifyDir', () => {
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-test-'));
    mkdirSync(join(dir, 'transcripts'), { recursive: true });
    writeFileSync(join(dir, 'envelopes.jsonl'), '{"a":"task-break"}\n{"b":"disk-usage"}\n');
    writeFileSync(join(dir, 'transcripts', 'parent.jsonl'), '{"c":"clean"}\n');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns zero hits over a clean tree', () => {
    expect(verifyDir(dir, detectRules, anon)).toEqual([]);
  });

  it('reports the repo-relative file for a leaked secret', () => {
    writeFileSync(join(dir, 'transcripts', 'leak.jsonl'), 'x\n{"k":"AKIAABCDEFGHIJKLMNOP"}\n');
    const hits = verifyDir(dir, detectRules, anon);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe(join('transcripts', 'leak.jsonl'));
    expect(hits[0].line).toBe(2);
    rmSync(join(dir, 'transcripts', 'leak.jsonl'));
  });

  it('returns zero hits (not an error) for a directory that does not exist yet', () => {
    expect(verifyDir(join(dir, 'nope'), detectRules, anon)).toEqual([]);
  });
});

/**
 * Test Plan #9 — the STANDING gate. Runs on every `npm test`, not just at
 * sign-off, so a leak cannot be introduced by a later fixture edit and go
 * unnoticed until someone re-reads SCRUBBING.md. It scans whatever exists;
 * fixture SET COMPLETENESS is asserted separately, in
 * `src/capture/__tests__/golden-fixtures.test.ts` (that file needs the real
 * `isValidEnvelopeShape`/`bootTestServer`, which only TypeScript can import).
 */
describe('standing secret-residue gate over fixtures/scrubbed (AC1/AC5)', () => {
  const scrubbedRoot = resolve(here, '..', '..', 'fixtures', 'scrubbed');
  const fixtureFiles = existsSync(scrubbedRoot) ? listFiles(scrubbedRoot) : [];

  it('reports zero detectRules hits over every committed fixture file', () => {
    // No `anon` here on purpose: the operator's own $HOME/$USER is a
    // machine-local check for the pre-commit CLI run. The standing gate must
    // give the same verdict on every machine, so it leans on detect-home-path.
    expect(verifyDir(scrubbedRoot, detectRules).map(formatHit)).toEqual([]);
  });

  it('leaves no real /Users/<name> or /home/<name> path in any fixture', () => {
    const offenders = [];
    for (const rel of fixtureFiles) {
      const text = readFileSync(join(scrubbedRoot, rel), 'utf8');
      for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
        if (match[1] !== 'USER') offenders.push(`${rel}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
