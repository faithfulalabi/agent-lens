// The standing fixture residue gate — the ongoing privacy guarantee behind the
// task-3.3 ruling that the scrubbed fixtures stay in the public repo. It fails
// loudly when any committed fixture (or derived golden snapshot) carries
// secret- or PII-shaped residue, so a future fixture commit cannot silently
// reintroduce what the one-time scrub removed.
//
// PROVENANCE: the 15 `DETECT_RULES` below are the `detectRules` set from
// `archive/tracer-bullet-experiment:experiments/tracer-bullet/scrub.config.json`,
// copied verbatim (recover with `git show`). `compileRules` is the `(?i)`-lifting
// shim from that tag's `scrub.mjs`; `verifyText`/`formatHit` are the line-scan
// and `file:line:rule` reporter from its `verify.mjs`. Two pieces were
// consciously DROPPED:
// - `residual-home-dir` / `residual-username` (the runtime `--home`/`--user`
//   checks): machine-local, non-hermetic — the standing gate must give the same
//   verdict on every machine. `detect-home-path` is the machine-independent
//   replacement.
// - The redactor cross-check suite (`SECRET_CORPUS` flag-then-clear,
//   `DETECT_ONLY_CORPUS`, anti-drift blocks): it imports the archived
//   `scrubText`/`scrubRules`, which are not on `main` — nothing to cross-check.
//   The detection half survives here as the positive-control describe.
//
// Discovery is `git ls-files` over exactly the two committed coverage roots
// (docs.test.ts pattern): a newly added fixture is scanned automatically, and
// the gitignored 10 MB `tool-results/` blobs are structurally excluded.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DETECT_RULES = [
  { name: 'detect-anthropic-key', pattern: 'sk-ant-[A-Za-z0-9_-]{6,}' },
  { name: 'detect-openai-key', pattern: 'sk-(?!ant-)[A-Za-z0-9]{12,}' },
  { name: 'detect-openai-project-key', pattern: 'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}' },
  { name: 'detect-aws-access-key-id', pattern: 'AKIA[0-9A-Z]{12,}' },
  { name: 'detect-github-token', pattern: 'gh[pousr]_[A-Za-z0-9]{12,}' },
  { name: 'detect-github-fine-grained-pat', pattern: 'github_pat_[A-Za-z0-9_]{20,}' },
  { name: 'detect-jwt', pattern: 'eyJ[A-Za-z0-9_-]{6,512}\\.[A-Za-z0-9_-]{6,512}' },
  {
    name: 'detect-bearer-header',
    pattern: '(?i)authorization"?\\s*[:=]\\s*"?bearer\\s+(?!REDACTED\\b)[A-Za-z0-9._-]{4,}',
  },
  {
    name: 'detect-agentlens-token-header',
    pattern: '(?i)x-agentlens-token"?\\s*[:=]\\s*"?(?!REDACTED\\b)[A-Za-z0-9._-]{4,}',
  },
  {
    name: 'detect-keyish-assignment',
    pattern:
      '(?i)(?:^|[^A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,64}(?:key|token|secret|password)(?![A-Za-z0-9])"?\\s*[:=]\\s*"?(?!REDACTED\\b)(?![0-9]+["\\s,}]|[0-9]+$)[^"\\s,}]{6,}',
  },
  {
    name: 'detect-email',
    pattern: '[A-Za-z0-9._%+-]{1,64}@(?!example\\.com\\b)[A-Za-z0-9.-]{1,255}\\.[A-Za-z]{2,24}',
  },
  { name: 'detect-private-ip-10', pattern: '\\b10\\.(?!0\\.0\\.0\\b)\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b' },
  { name: 'detect-private-ip-192-168', pattern: '\\b192\\.168\\.(?!0\\.0\\b)\\d{1,3}\\.\\d{1,3}\\b' },
  {
    name: 'detect-private-ip-172',
    pattern: '\\b172\\.(?!16\\.0\\.0\\b)(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}\\b',
  },
  { name: 'detect-home-path', pattern: '/(?:Users|home)/(?!USER\\b)[A-Za-z0-9._-]+' },
] as const;

interface CompiledRule {
  name: string;
  regex: RegExp;
}

interface Hit {
  line: number;
  rule: string;
  match: string;
}

/** Compile pattern strings, lifting a leading `(?i)` to the JS `i` flag. Always global. */
function compileRules(rules: readonly { name: string; pattern: string }[]): CompiledRule[] {
  return rules.map((rule) => {
    let source = rule.pattern;
    let flags = 'g';
    if (source.startsWith('(?i)')) {
      source = source.slice(4);
      flags += 'i';
    }
    return { name: rule.name, regex: new RegExp(source, flags) };
  });
}

/** Line-oriented scan so every hit reports a 1-based line number. */
function verifyText(text: string, rules: CompiledRule[]): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    for (const rule of rules) {
      // Compiled rules are global; reset lastIndex so a shared RegExp cannot
      // skip a hit on the next line it is applied to.
      rule.regex.lastIndex = 0;
      for (const match of line.matchAll(rule.regex)) {
        hits.push({ line: i + 1, rule: rule.name, match: match[0] });
      }
    }
  }
  return hits;
}

/** Render one hit as `file:line:rule: match` (truncated), the gate's report line. */
function formatHit(file: string, hit: Hit): string {
  const snippet = hit.match.length > 60 ? `${hit.match.slice(0, 57)}...` : hit.match;
  return `${file}:${hit.line}:${hit.rule}: ${snippet}`;
}

const COVERAGE_ROOTS = ['fixtures/scrubbed', 'src/project/__tests__/__snapshots__/golden'];

function trackedCoverageFiles(): string[] {
  return execFileSync('git', ['ls-files', ...COVERAGE_ROOTS], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
}

const detectRules = compileRules(DETECT_RULES);
const coverageFiles = trackedCoverageFiles();

describe('standing residue gate over committed fixtures + golden snapshots', () => {
  it('discovery is dynamic and non-vacuous', () => {
    expect(coverageFiles.length).toBeGreaterThan(0);
    expect(coverageFiles).toContain('fixtures/scrubbed/subagent/manifest.json');
  });

  it.each(coverageFiles)('%s carries zero secret/PII residue', (file) => {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    const report = verifyText(text, detectRules).map((hit) => formatHit(file, hit));
    expect(report).toEqual([]);
  });
});

describe('positive control — the rules bite', () => {
  it.each([
    ['detect-aws-access-key-id', 'AKIAABCDEFGHIJKLMNOP'],
    ['detect-anthropic-key', 'sk-ant-api03-A1b2C3d4E5'],
    ['detect-jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
  ])('%s flags its synthetic secret with a 1-based line', (rule, secret) => {
    const hits = verifyText(`clean line\n${secret}`, detectRules);
    expect(hits.map((h) => h.rule)).toContain(rule);
    expect(hits[0]?.line).toBe(2);
  });
});

/**
 * This repo's own vocabulary plus the scrub placeholders. Every `sk-`-lookalike
 * ("ta-sk-break", "di-sk-usage") is the regression the tag's quantifiers exist
 * to clear; the placeholder lines keep the gate idempotent over scrubbed output.
 */
const FALSE_POSITIVE_CORPUS = [
  'task-break',
  'task-review',
  'task-shipper',
  'disk-usage',
  'ask-me',
  'risk-score',
  'run task-break then task-review then task-shipper; check disk-usage',
  '/home/USER/.claude/projects/x by USER',
  'user@example.com',
  'bound to 10.0.0.0 and 192.168.0.0 and 172.16.0.0',
];

describe('repo vocabulary and placeholders stay clean', () => {
  it.each(FALSE_POSITIVE_CORPUS)('zero hits on %s', (line) => {
    expect(verifyText(line, detectRules)).toEqual([]);
  });
});
