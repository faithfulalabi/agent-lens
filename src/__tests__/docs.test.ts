// The public docs, gated the way `one-door.test.ts` gates prose: a text grep,
// not a parser. Three properties are worth a test here.
//
// FIRST, THE DURABILITY CONTRACT CANNOT DRIFT FROM THE PRODUCT. The README quotes
// `COVERAGE_GAP_STATEMENT` and `DURABILITY_STATEMENT` verbatim, and this file
// IMPORTS them rather than retyping them. Retyping would assert that two strings
// a human typed twice are equal, which is exactly the thing that stops being
// true.
//
// SECOND, NO MEASURED COUNT BELONGS IN THE README. The spill quantity was
// measured 43 -> 53 -> 52 -> 59 across four passes, twice on one day, and the
// source population moved 332 -> 295 the same day. `agent-lens doctor` prints
// the reader's own numbers; a README number is a measurement that was true once,
// on one machine. Test 3 keeps the retracted figure from being pasted back in.
//
// THIRD, THE DEAD-INSTALL GATE IS SCOPED TO THE THREE PUBLIC DOCS, deliberately,
// and that scoping is why it needs no suppressions table. Repo-wide it would
// flag the *anti*-installer comments in `report.ts` and `doctor.ts`, its own
// enforcement in `layout.test.ts` and `smoke.test.ts`, and the retained
// `fixtures/scrubbed/**` transcripts plus the golden snapshots — permanent by
// ruling. A suppressions table over generated snapshots would also recreate the
// `snapshots:update` disarm hazard `golden-replay.test.ts:9-19` records. Scoped
// to the three documents AC3 actually names, the hit set is empty.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDoctorReport } from '../archive/index.js';
import { COVERAGE_GAP_STATEMENT, DURABILITY_STATEMENT } from '../cli/commands/doctor.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The three documents AC3 names. Every gate below is scoped to exactly these. */
const PUBLIC_DOCS = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md'] as const;

function doc(name: string): string {
  return readFileSync(join(REPO_ROOT, name), 'utf8');
}

/**
 * Whitespace-collapsed text, for asserting a PHRASE. A markdown paragraph wraps
 * at 100 columns, so a phrase assertion on raw text silently depends on where
 * the wrap fell. Verbatim assertions (Test 1) stay on the raw text on purpose.
 */
function prose(name: string): string {
  return doc(name).replace(/\s+/g, ' ');
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Lines of `text` that contain `needle`, so a role can be asserted beside its path. */
function linesContaining(text: string, needle: string): string[] {
  return text.split('\n').filter((line) => line.includes(needle));
}

describe('the README quotes the product, not a paraphrase of it (Test 1)', () => {
  it.each([
    ['DURABILITY_STATEMENT', DURABILITY_STATEMENT],
    ['COVERAGE_GAP_STATEMENT', COVERAGE_GAP_STATEMENT],
  ])('README carries %s verbatim', (_name, statement) => {
    expect(
      doc('README.md'),
      'imported from doctor.ts, never retyped: the point is that the doc and the ' +
        'CLI cannot say different things.',
    ).toContain(statement);
  });
});

describe('the three tiers are named with their roles (Test 2)', () => {
  it.each([
    ['~/.claude/projects', /\bsource\b/i],
    ['~/.agent-lens/archive', /system of record/i],
    ['~/.agent-lens/cache.db', /disposable/i],
  ])('%s is described as its own tier, on its own line', (path, role) => {
    const hits = linesContaining(doc('README.md'), path);
    expect(hits.length, `${path} is not in the README at all`).toBeGreaterThan(0);
    expect(
      hits.some((line) => role.test(line)),
      `no line naming ${path} also states its role (${role}). The inversion is ` +
        'the one fact the front door cannot get wrong.',
    ).toBe(true);
  });

  it('the cache tier says it rebuilds, so nobody treats a delete as data loss', () => {
    const hits = linesContaining(doc('README.md'), '~/.agent-lens/cache.db');
    expect(hits.some((line) => /rebuild/i.test(line))).toBe(true);
  });
});

describe('the retracted figure stays retracted (Test 3)', () => {
  it.each(PUBLIC_DOCS)('%s does not carry "53 of 97"', (name) => {
    expect(
      doc(name),
      'retracted 2026-08-12 and re-measured to four different values since. No ' +
        'measured count belongs in a public doc — cite `agent-lens doctor`.',
    ).not.toMatch(/53 of (the )?97/);
  });
});

describe('no dead install path survives in the public docs (Test 4)', () => {
  // Scoped to AC3's literal words. `installer` and `uninstall` are anchored so
  // they never match the `npm install` CONTRIBUTING.md legitimately documents.
  const TERMS: ReadonlyMap<string, RegExp> = new Map([
    ['settings.json', /settings\.json/],
    ['installer', /\binstallers?\b/i],
    ['uninstall', /\buninstall\w*\b/i],
    ['consent', /\bconsents?\b|\bconsented\b/i],
    ['PreToolUse', /\bPreToolUse\b/],
    ['PostToolUse', /\bPostToolUse\b/],
    ['SessionStart', /\bSessionStart\b/],
    ['agent-lens hook', /agent-lens hook/],
  ]);

  it('the hit set is empty — no suppressions table, by ruling', () => {
    const hits: string[] = [];
    for (const name of PUBLIC_DOCS) {
      doc(name)
        .split('\n')
        .forEach((line, index) => {
          for (const [term, pattern] of TERMS) {
            if (pattern.test(line)) hits.push(`${name}:${index + 1}  ${term}  ${line.trim()}`);
          }
        });
    }
    expect(
      hits,
      'Hooks are gone. A public doc that still names the harness settings file, ' +
        'an installer, an uninstaller or a hook event is documenting a product ' +
        'that no longer exists.',
    ).toEqual([]);
  });

  it('the tracked tree no longer ships a harness-settings snippet', () => {
    expect(
      trackedFiles(),
      'a live hook-install snippet naming a command that no longer exists',
    ).not.toContain('fixtures/claude-settings.snippet.json');
  });
});

describe('the quickstart is zero-configuration (Test 5)', () => {
  const readme = doc('README.md');
  const firstBlock = /```bash\n([\s\S]*?)```/.exec(readme);

  it('the first shell block in the README is the quickstart, and it is npx', () => {
    expect(firstBlock?.[1]?.trim(), 'the README has no shell block at all').toBe('npx agent-lens');
  });

  it('no setup command runs before it', () => {
    // Falls back to the WHOLE README, never to the empty string: a missing block
    // must red this test rather than pass it vacuously.
    const preamble = readme.slice(0, firstBlock?.index ?? readme.length);
    expect(
      preamble,
      'a setup step above the quickstart makes "zero configuration" a lie',
    ).not.toMatch(/npm (install|ci|i)\b|npm run \w/i);
  });
});

describe('SECURITY.md carries the whole trust boundary (Test 6)', () => {
  const security = prose('SECURITY.md');

  it.each([
    ['the traced agent can read the trace API', /traced agent.{0,40}read the trace API/i],
    ['the loopback default', /loopback/i],
    ['the bind address', /127\.0\.0\.1/],
    ['the Host-header allowlist', /Host-header allowlist/i],
    ['the DNS-rebinding rationale', /DNS rebinding/i],
    ['the token header', /x-agentlens-token/],
    ['constant-time comparison', /constant-time/i],
    ['401 on mismatch', /\b401\b/],
    // Asserted as the PROPERTY, not as the phrase `same-`+the harness field name
    // `one-door.test.ts` polices. Its `\borigin\b` term matches inside that
    // hyphenated word, and quieting a correct hit with a suppression to keep a
    // nicer regex would spend the allowlist on nothing. SECURITY.md still spells
    // the phrase out for the reader.
    ['the static page is not token-guarded', /static page.{0,30}not.{0,20}token-guarded/i],
    ['the token bootstrap that replaces it', /token injected/i],
    // Task 3.5 (finding F1): the spill containment boundary, at both times.
    ['the spill-path containment', /realpath-resolves inside the transcript root or the archive/i],
    ['the spill check at projection and serve time', /projection time.{0,120}serve time/i],
  ])('discloses %s', (_label, pattern) => {
    expect(security).toMatch(pattern);
  });

  it('says where to report a vulnerability privately', () => {
    expect(security).toMatch(/security\/advisories\/new/);
    expect(security).toMatch(/do not open a public issue/i);
  });
});

describe('the tracer-bullet ruling is a fact on disk, not a promise (Test 7)', () => {
  const tracked = trackedFiles();

  it('experiments/tracer-bullet/ is retired from the working tree', () => {
    expect(
      tracked.filter((file) => file.startsWith('experiments/tracer-bullet/')),
      'retired to the `archive/tracer-bullet-experiment` tag: history keeps it, ' +
        'the working tree stops advertising a dead install path.',
    ).toEqual([]);
  });

  it('the scrubbed transcripts are retained as projector fixtures', () => {
    // The retained half of the ruling. `golden.ts` has 7 importers including
    // production `src/transcript/human.ts`, and `golden-replay.test.ts` runs its
    // whole suite over these — deleting them would destroy working coverage.
    const transcripts = tracked.filter(
      (file) => file.startsWith('fixtures/scrubbed/') && file.endsWith('.jsonl'),
    );
    expect(transcripts.length).toBeGreaterThan(0);
  });

  it('vitest no longer includes a glob that matches nothing', () => {
    expect(doc('vitest.config.ts')).not.toContain('experiments/');
  });
});

describe('no public doc links into a git-ignored directory (Test 8)', () => {
  // `internal_docs/` is globally git-ignored with zero tracked files, so a link
  // into it 404s on every clone. CONTRIBUTING.md names the directory in prose —
  // it has to, to explain why the parity tests fail on a fresh clone — so the
  // gate is on the LINK, which is the thing that actually breaks.
  it.each(PUBLIC_DOCS)('%s has no markdown link resolving into internal_docs/', (name) => {
    expect(doc(name)).not.toMatch(/\]\(\.?\/?internal_docs\//);
  });

  it('the README does not mention internal_docs at all', () => {
    expect(doc('README.md')).not.toContain('internal_docs');
  });
});

describe('the archive outlives the source (Test 9, opt-in)', () => {
  // Opt-in per `real-corpus.test.ts:14`: the corpus is not a fixture and moves
  // daily. The assertion is the INVARIANT — full mirror coverage, and a
  // non-empty archive-only set — never a count, which is what four bad
  // measurements of one quantity bought this project.
  const runIt = process.env.AGENT_LENS_REAL_CORPUS === '1' ? it : it.skip;

  runIt('every source transcript has an archive counterpart, and some have no source', () => {
    const { coverage } = buildDoctorReport();
    expect(coverage.found, 'no source transcripts found — nothing was asserted').toBeGreaterThan(0);
    expect(coverage.unmirrored, 'a source file the archive has not captured yet').toEqual([]);
    expect(coverage.mirrored).toBe(coverage.found);
    expect(
      coverage.archiveOnly,
      'the archive holds nothing the source has lost — either the corpus is ' +
        'younger than the retention cliff, or mirroring is not actually winning.',
    ).toBeGreaterThan(0);
  });
});
