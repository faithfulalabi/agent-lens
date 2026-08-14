// RFC §7's one door: every read of a harness-supplied field lives in
// `src/transcript/`. Plan 001 proved the convention loses on its own — harness
// fields ended up read across 45 files — so this is the enforcement that makes
// the rule a fact. It is deliberately a text grep, not an AST pass: an AST
// version would be the "sophistication that becomes a hole" the door exists to
// avoid, and a name in a comment is exactly the kind of drift worth seeing.
//
// MEASURED ON `main` @0903699. 402 hit lines across 50 files: 152 production,
// 250 test. Production splits 132 (12 quarantined files, by path) + 20
// (reviewed suppressions, in 8 surviving files).
//
// Those three totals count DISTINCT LINES, deduplicated across terms — that is
// what makes 132 + 20 = 152 exact. The scanner below emits one hit per term, so
// it reports 136 for the same 12 quarantined files: 4 of their lines carry two
// different terms each. The suppression count is 20 either way, because no line
// in the 8 surviving files carries two terms. Neither number is wrong; do not
// "fix" one to match the other.
//
// A HIT IS ONE MATCHING LINE PER TERM. A line carrying the same term twice is
// one hit, and the ordinal counts over matching lines, never over occurrences.
// Counting occurrences instead gives 440/163/277 and 22 suppressions, and it
// breaks the key: two entries on one line would store an identical line, and
// the re-binding assertion below could not tell them apart. The two real cases
// are `render-gate/report.ts:166` and `server/start.ts:162`.
//
// THE KEY IS `<file>#<term>#<ordinal>`, never `<file>:<line>` —
// `fs-write-sites.test.ts:1-6` already recorded that a line key "would red on
// line shifts". An ordinal is a POSITION, though, and a position is a stable
// identity only while nothing is inserted above it. So each suppression also
// stores the trimmed matched line, and A SUPPRESSION EXEMPTS A HIT ONLY WHEN
// THE KEY AND THE STORED LINE BOTH MATCH. Without that, inserting a new
// `origin` read above a suppressed one lets the new, unreviewed read inherit
// `#N` while the reviewed read shifts to `#N+1` and reds; a developer adds
// `#N+1`, the door is open, and the suite is fully green.
//
// WORD-BOUNDARY ANCHORING IS NOT THE FORBIDDEN RELAXATION. `\borigin\b` drops
// 23+ `original`/`originalDir`/`originalSize` substring artifacts with zero
// loss of real coverage — it is why this measures 402 where an unanchored scan
// measured 444. Weakening a TERM would be the relaxation; every suppression is
// a reviewed artifact with a written reason, and that is the only legal way to
// quiet a hit.
//
// TEST FILES ARE OUT OF SCOPE, by the repo's own precedent (`sourceFiles()`,
// `fs-write-sites.test.ts:388-394`) and by a forcing case: Task 3.1's AC2
// requires a differential test against the `parentUuid` ancestor walk, a test
// that must name `parentUuid` outside the door by design. In scope, 3.1 is
// born red at its own acceptance criteria. That removes 250 of 402 hits, and
// Task 4.5 owns re-examining the exemption once the plan-001 test tree is
// ported.
//
// NEW SUPPRESSIONS IN PHASE 4 ARE EXPECTED, NOT MISCALIBRATION. `data-model-v2`
// puts `<project>/<sessionId>/…` path math in `src/corpus/paths.ts`, which
// trips `sessionId` when Task 4.1 lands. A filename stem read from the corpus
// IS harness-supplied, so the gate is doing its job; review the read and add an
// entry. NEVER add a file to `LEGACY_TREES`: that list is closed, only ever
// shrinks, and Task 4.5 deletes it outright.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The door. Ten identifier-shaped names anchored; `message.content` literal. */
const TERMS = [
  'sessionId',
  'parentUuid',
  'toolUseResult',
  'promptId',
  'isSidechain',
  'tool_use_id',
  'requestId',
  'message.content',
  'attachment',
  'origin',
  'isMeta',
] as const;

const PATTERNS: ReadonlyMap<string, RegExp> = new Map(
  TERMS.map((term) => [
    term,
    term === 'message.content' ? /message\.content/ : new RegExp(`\\b${term}\\b`),
  ]),
);

/** One matching line, keyed the way the suppression list keys it. */
interface Hit {
  key: string;
  file: string;
  term: string;
  line: number;
  /** The trimmed source line. This is what re-binds an ordinal to content. */
  text: string;
}

/** A whole plan-001 module, quarantined by path until Task 4.5 deletes it. */
interface LegacyEntry {
  file: string;
  why: string;
}

/** One reviewed hit. `line` is the trimmed source text the review looked at. */
interface Suppression {
  key: string;
  line: string;
  why: string;
}

// Quarantine by PATH, not by line: a 132-entry line-keyed list is a second copy
// of the codebase, not a review artifact. Every file here is on Task 4.5's
// published deletion list (`task-4.5-cutover.md:19`), so the stale check below
// fires the moment 4.5 deletes one and the block dismantles itself.
const LEGACY_TREES: readonly LegacyEntry[] = [
  {
    file: 'db/index.ts',
    why: 'plan-001 SQLite schema and writers for raw_events/spans/messages, which take harness fields straight off the hook envelope. Task 4.5 deletes the module and those tables.',
  },
  {
    file: 'capture/merge.ts',
    why: 'plan-001 transcript/hook merge. The Phase 3 projector replaces it wholesale; Task 4.5 deletes it and ports its truncation, tool-join and is_error assertions.',
  },
  {
    file: 'cli/hook.ts',
    why: 'the hook entry point itself. RFC 002 closes the hook path; Task 4.5 deletes this module.',
  },
  {
    file: 'capture/normalizer.ts',
    why: 'turns hook envelopes into spans, so every harness name in it is a genuine read of the path RFC 002 closes. Task 4.5 deletes it.',
  },
  {
    file: 'db/reads.ts',
    why: 'plan-001 read queries over the tables db/index.ts owns. Task 4.5 deletes it with them.',
  },
  {
    file: 'db/seed.ts',
    why: 'demo seeding for the plan-001 schema. Task 4.5 deletes it.',
  },
  {
    file: 'capture/tailer.ts',
    why: 'plan-001 JSONL tailer, carrying its own line classification. `src/transcript/line.ts` supersedes that half; Task 4.5 deletes the module.',
  },
  {
    file: 'server/ingest.ts',
    why: 'the /api/ingest envelope path. Task 4.5 deletes it with the route.',
  },
  {
    file: 'capture/spool.ts',
    why: 'spools hook envelopes when the server is down — hook-path only. Task 4.5 deletes it.',
  },
  {
    file: 'capture/transcript-line.ts',
    why: "plan-001's transcript line shape, superseded by `src/transcript/raw-types.ts`. Task 4.5 deletes it.",
  },
  {
    file: 'db/rollups.ts',
    why: 'per-session rollups over the plan-001 tables. Task 4.5 deletes it.',
  },
  {
    file: 'shared/event-id.ts',
    why: 'derives event ids from harness envelope fields. Task 4.5 deletes it.',
  },
];

// The 20 production hits in files Task 4.5 does NOT delete, so none may be
// quarantined by path. Nineteen are homonyms — the archive's own failure
// provenance, the render gate's own report, the browser sense of "origin". One
// is not, and says so.
const SUPPRESSIONS: readonly Suppression[] = [
  {
    key: 'archive/mirror.ts#origin#1',
    line: '* fail-safe default. Published: `origin` reaches any consumer of',
    why: "doc comment on ArchiveErrorOrigin — the archive's own failure provenance enum (source/archive/log), named before the transcript corpus is involved at all",
  },
  {
    key: 'archive/mirror.ts#origin#2',
    line: 'origin: ArchiveErrorOrigin;',
    why: 'the ArchiveError field itself; its type is the archive-local enum, never a harness value',
  },
  {
    key: 'archive/mirror.ts#origin#3',
    line: '// result gets one. `origin` is `archive` rather than left to the per-entry',
    why: 'comment explaining why the whole-pass failure defaults to the `archive` side',
  },
  {
    key: 'archive/mirror.ts#origin#4',
    line: "errors: [{ path: dataDir, message: String(error), origin: 'archive' }],",
    why: 'constructs an ArchiveError with the fail-safe default; a literal from the local enum',
  },
  {
    key: 'archive/mirror.ts#origin#5',
    line: 'const origin: ArchiveErrorOrigin =',
    why: 'classifies which side of the pass a failing syscall was on, from the errno path',
  },
  {
    key: 'archive/mirror.ts#origin#6',
    line: 'result.errors.push({ path: entry.sourcePath, message: String(error), origin });',
    why: 'pushes the ArchiveError built at #5; the shorthand property is the local const',
  },
  {
    key: 'archive/mirror.ts#origin#7',
    line: "origin: 'log',",
    why: 'the third enum literal, for a failure on the archive log write',
  },
  {
    key: 'cli/commands/archive.ts#origin#1',
    line: '//      that is the failure worth waking someone for. `ArchiveError.origin`',
    why: "comment stating the CLI's exit contract over the archive-local enum",
  },
  {
    key: 'cli/commands/archive.ts#origin#2',
    line: "return result.errors.some((e) => e.origin === 'archive') ? EXIT_ARCHIVE_ERRORS : EXIT_OK;",
    why: 'the exit-code predicate reading that same enum off the archive result',
  },
  {
    key: 'render-gate/index.ts#sessionId#1',
    line: 'const sessionId = await openFirstSession(page);',
    why: "the gate's own return from clicking the first row in the UI it drives — read out of the browser, not out of a transcript",
  },
  {
    key: 'render-gate/index.ts#sessionId#2',
    line: 'sessionId,',
    why: 'puts that browser-read value into the gate Observations record',
  },
  {
    key: 'render-gate/index.ts#sessionId#3',
    line: "console.log(`  session:  ${report.sessionId ?? '(none)'}`);",
    why: "prints the gate's own report field to the console summary",
  },
  {
    key: 'render-gate/report.ts#sessionId#1',
    line: 'sessionId: string;',
    why: "the Observations field declaration — the render gate's own record of what it saw on screen",
  },
  {
    key: 'render-gate/report.ts#sessionId#2',
    line: 'sessionId: string | null;',
    why: 'the same field on the persisted GateReport, nullable because the drive can fail before it opens a session',
  },
  {
    key: 'render-gate/report.ts#sessionId#3',
    line: 'sessionId: result?.sessionId ?? null,',
    why: 'copies Observations to GateReport. One hit, not two: the line matches `sessionId` twice and a hit is one matching LINE per term',
  },
  {
    key: 'render-gate/report.ts#sessionId#4',
    line: "`<p>${esc(report.startedAt)} · session <code>${esc(report.sessionId ?? '(none)')}</code>` +",
    why: "renders that same report field into the gate's HTML contact sheet",
  },
  {
    key: 'server/app.ts#sessionId#1',
    line: "sessionId: readString(body, 'session_id'),",
    why: 'GENUINE HARNESS READ, not a homonym — the one entry here that is not a naming coincidence. It reads session_id off a hook envelope on the `invalid envelope shape` dead-letter path. It is suppressed only because it had no removal owner: RFC 002 closes the hook path, and TASK 4.5 OWNS DELETING THIS BLOCK (task-4.5-cutover.md:49-58) along with /api/ingest and server/ingest.ts. Not legitimate, just scheduled.',
  },
  {
    key: 'server/middleware/token-auth.ts#origin#1',
    line: '// applied to the static page (which bootstraps the token same-origin instead).',
    why: 'the browser sense of origin, in a comment about same-origin token bootstrap',
  },
  {
    key: 'server/start.ts#origin#1',
    line: '* sweep-origin and ingest-origin deltas are one code path.',
    why: 'doc comment naming two delta sources. One hit, not two: the line matches `origin` twice and a hit is one matching LINE per term',
  },
  {
    key: 'shared/entities.ts#tool_use_id#1',
    line: '/** `tool_use_id` where available, else derived from the opening raw event. */',
    why: 'doc comment on Span.id describing where the id comes from; the read itself lives in the plan-001 modules quarantined above',
  },
];

// The helpers below are what the real assertions and their mutation controls
// share. A control that re-derives the comparison inline proves nothing about
// the assertion it protects. Parameters are DEFAULTED so each real assertion
// reads as an argument-free call: there is no call-site expression for a future
// `.filter(...)` to hide in.

/** Every non-test `.ts` under `src/`, outside the door. Repo-relative, sorted. */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.split('\\').join('/'))
    .filter((name) => !name.endsWith('.test.ts') && !name.includes('__tests__/'))
    .filter((name) => !name.startsWith('transcript/'))
    .sort();
}

/**
 * Every harness name in `file`, one hit per matching line per term.
 * `text` is defaulted rather than read inline so a control can feed the scanner
 * a fixture without touching disk.
 */
function scanFile(file: string, text = readFileSync(join(SRC_DIR, file), 'utf8')): Hit[] {
  const lines = text.split('\n');
  const hits: Hit[] = [];
  for (const term of TERMS) {
    const pattern = PATTERNS.get(term)!;
    let ordinal = 0;
    for (const [index, line] of lines.entries()) {
      if (!pattern.test(line)) continue;
      ordinal += 1;
      hits.push({
        key: `${file}#${term}#${ordinal}`,
        file,
        term,
        line: index + 1,
        text: line.trim(),
      });
    }
  }
  return hits;
}

function scanAll(files: readonly string[] = sourceFiles()): Hit[] {
  return files.flatMap((file) => scanFile(file));
}

/** Human-readable, and deliberately NOT the key — see `unreviewed`. */
function describeHit(hit: Hit): string {
  return `${hit.file}:${hit.line}:${hit.term} — ${hit.text}`;
}

/** The file half of a `<file>#<term>#<ordinal>` key. */
function fileOf(entry: Suppression): string {
  return entry.key.slice(0, entry.key.indexOf('#'));
}

/**
 * Every unreviewed hit, plus both rot directions of the two allowlists.
 * A suppression exempts a hit only when the KEY and the STORED LINE both match:
 * checking the key alone would let a read inserted above a suppressed one
 * inherit its ordinal while only the stale limb reds.
 */
function unreviewed(
  hits: readonly Hit[] = scanAll(),
  suppressions: readonly Suppression[] = SUPPRESSIONS,
  legacy: readonly LegacyEntry[] = LEGACY_TREES,
): { unexpected: string[]; staleSuppressions: string[]; staleLegacy: string[] } {
  const quarantined = new Set(legacy.map((entry) => entry.file));
  const policed = hits.filter((hit) => !quarantined.has(hit.file));
  const stored = new Map(suppressions.map((entry) => [entry.key, entry.line]));

  return {
    unexpected: policed
      .filter((hit) => stored.get(hit.key) !== hit.text)
      .map(describeHit)
      .sort(),
    staleSuppressions: suppressions
      .filter((entry) => !policed.some((hit) => hit.key === entry.key && hit.text === entry.line))
      .map((entry) => entry.key)
      .sort(),
    staleLegacy: legacy
      .filter((entry) => !hits.some((hit) => hit.file === entry.file))
      .map((entry) => entry.file)
      .sort(),
  };
}

describe('RFC §7 — harness fields are read behind the one door', () => {
  it('finds no unreviewed harness read outside src/transcript/', () => {
    const { unexpected, staleSuppressions, staleLegacy } = unreviewed();

    expect(
      unexpected,
      'harness-supplied name(s) read outside src/transcript/. Two legal responses: move the ' +
        'read into src/transcript/, or add a reviewed SUPPRESSIONS entry with a written reason. ' +
        'The file:line:term printed above is PROSE, not the key — the key is <file>#<term>#<ordinal> ' +
        'and the entry must also store the trimmed line. Never add a file to LEGACY_TREES.',
    ).toEqual([]);

    expect(
      staleSuppressions,
      'SUPPRESSIONS entries that exempt nothing — the hit moved, changed, or went away. If a ' +
        'read was inserted above this one, the entry now points at a DIFFERENT line: re-review ' +
        'both, do not just renumber.',
    ).toEqual([]);

    expect(
      staleLegacy,
      'task 4.5 deleted this — delete the quarantine entry. LEGACY_TREES only ever shrinks.',
    ).toEqual([]);
  });

  it('the scan is not silently empty', () => {
    // Non-vacuity: every assertion above is trivially green over an empty scan.
    // Bounded by what survives Task 4.5, never by today's violation count — a
    // threshold like "more than 100 hits" would red the moment 4.5 deletes the
    // quarantined modules, which is the one change this file must not obstruct.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);

    // Every suppressed file is reachable by the scan, so a filter that quietly
    // dropped one would red here instead of passing vacuously.
    const scanned = new Set(files);
    for (const entry of SUPPRESSIONS) {
      expect(scanned.has(fileOf(entry)), `${fileOf(entry)} is suppressed but never scanned`).toBe(
        true,
      );
    }

    expect(scanAll().length).toBeGreaterThanOrEqual(SUPPRESSIONS.length);
  });

  it('every allowlist entry carries a written reason, and the two lists are disjoint', () => {
    for (const entry of SUPPRESSIONS) {
      expect(entry.why.length, `${entry.key} needs a justification`).toBeGreaterThan(0);
      expect(entry.line.length, `${entry.key} must store the matched line`).toBeGreaterThan(0);
    }
    for (const entry of LEGACY_TREES) {
      expect(entry.why.length, `${entry.file} needs a justification`).toBeGreaterThan(0);
    }

    // An overlap would hide a suppression's staleness behind the path quarantine.
    const quarantined = new Set(LEGACY_TREES.map((entry) => entry.file));
    for (const entry of SUPPRESSIONS) {
      expect(quarantined.has(fileOf(entry)), `${entry.key} is already quarantined by path`).toBe(
        false,
      );
    }
  });

  it('every suppression still stores the line the review looked at', () => {
    // The positive limb of the re-binding rule, over the REAL tree: without it
    // the strict exemption could be vacuously green on an empty scan.
    const byKey = new Map(scanAll().map((hit) => [hit.key, hit]));
    expect(SUPPRESSIONS.length).toBeGreaterThan(0);

    for (const entry of SUPPRESSIONS) {
      const hit = byKey.get(entry.key);
      expect(hit, `${entry.key} matches no hit at all`).toBeDefined();
      expect(hit?.text, `${entry.key} no longer stores the line at that ordinal`).toBe(entry.line);
    }
  });
});

describe('the door reds when the property it protects is broken', () => {
  const SCRATCH = 'scratch/planted.ts';

  // Controls drive the same helpers the real assertions call. Re-deriving the
  // comparison inline would prove nothing: softening a real body would leave an
  // inline control green.

  it('each of the 11 names reds on its own, and removing it greens', () => {
    for (const term of TERMS) {
      const planted = scanFile(SCRATCH, `const x = ${term};\n`);
      const { unexpected } = unreviewed(planted);

      expect(unexpected, `${term} did not red`).toHaveLength(1);
      expect(unexpected[0]).toContain(term);
      expect(unexpected[0]).toContain(`${SCRATCH}:1:`);

      const clean = scanFile(SCRATCH, 'const x = 1;\n');
      expect(unreviewed(clean).unexpected, `${term} still red after removal`).toEqual([]);
    }
  });

  it('src/transcript/ is exempt, and one directory up is not', () => {
    // The exemption is by directory, so the same text reds outside it.
    const text = 'const id = sessionId;\n';
    expect(unreviewed(scanFile('db/elsewhere.ts', text)).unexpected).toHaveLength(1);

    expect(sourceFiles().filter((file) => file.startsWith('transcript/'))).toEqual([]);

    // …and the exemption removes REAL matches rather than being vacuous.
    expect(scanFile('transcript/accessors.ts').length).toBeGreaterThan(0);
  });

  it('test files are out of scope, both ways', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((file) => file.endsWith('.test.ts'))).toEqual([]);
    expect(files.filter((file) => file.includes('__tests__/'))).toEqual([]);
    expect(files.filter((file) => file.endsWith('.d.ts'))).toEqual([]);

    // Both guards live at src/__tests__/*.test.ts, so the filter above already
    // removes them — no separate self-exclusion clause exists or is needed.
    expect(files.filter((file) => file.includes('one-door'))).toEqual([]);
    expect(files.filter((file) => file.includes('projector-version'))).toEqual([]);
  });

  it('a suppression covers exactly one hit and leaves its sibling red', () => {
    const text = 'const a = origin;\nconst b = origin;\n';
    const hits = scanFile(SCRATCH, text);
    const first: Suppression = {
      key: `${SCRATCH}#origin#1`,
      line: 'const a = origin;',
      why: 'control',
    };

    const { unexpected, staleSuppressions } = unreviewed(hits, [first]);
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toContain(`${SCRATCH}:2:origin`);
    expect(staleSuppressions).toEqual([]);
  });

  it('a stale suppression and a stale quarantine both red', () => {
    const hits = scanFile(SCRATCH, 'const a = origin;\n');

    const gone: Suppression = {
      key: `${SCRATCH}#origin#9`,
      line: 'const z = origin;',
      why: 'control',
    };
    expect(unreviewed(hits, [gone]).staleSuppressions).toEqual([`${SCRATCH}#origin#9`]);

    // The coverage-restoration hook: 4.5 deletes the file, the entry reds.
    const deleted: LegacyEntry = { file: 'db/index.ts', why: 'control' };
    expect(unreviewed(hits, [], [deleted]).staleLegacy).toEqual(['db/index.ts']);
    expect(unreviewed(hits, [], [{ file: SCRATCH, why: 'control' }]).staleLegacy).toEqual([]);
  });

  it('an inserted read cannot inherit the suppression above it', () => {
    // ★ The defect this guard exists to stop. Insert a NEW matching line above a
    // suppressed one: the reviewed read shifts from #1 to #2, and checking the
    // key alone would leave the new, unreviewed read silently exempt.
    const reviewed: Suppression = {
      key: `${SCRATCH}#origin#1`,
      line: 'const reviewed = origin;',
      why: 'control',
    };

    const before = scanFile(SCRATCH, 'const reviewed = origin;\n');
    expect(unreviewed(before, [reviewed]).unexpected).toEqual([]);

    const after = scanFile(SCRATCH, 'const inserted = origin;\nconst reviewed = origin;\n');
    const { unexpected, staleSuppressions } = unreviewed(after, [reviewed]);

    // The NEW read must not come back suppressed. Asserting only that the entry
    // went stale would pass even with the key-only exemption.
    expect(unexpected).toContain(`${SCRATCH}:1:origin — const inserted = origin;`);
    expect(staleSuppressions).toEqual([`${SCRATCH}#origin#1`]);

    // Re-storing the new line under #1 greens nothing: the reviewed read is now
    // at #2 with no entry, so it surfaces as unreviewed instead.
    const renumbered: Suppression = { ...reviewed, line: 'const inserted = origin;' };
    const rebound = unreviewed(after, [renumbered]);
    expect(rebound.unexpected).toEqual([`${SCRATCH}:2:origin — const reviewed = origin;`]);
    expect(rebound.staleSuppressions).toEqual([]);
  });

  it('a hit is one matching line per term, never one per occurrence', () => {
    // Per-occurrence counting would give this line two hits, break the ordinal,
    // and store an identical line under both keys.
    const twice = scanFile(SCRATCH, 'sessionId: result?.sessionId ?? null,\n');
    expect(twice).toHaveLength(1);
    expect(twice[0]!.key).toBe(`${SCRATCH}#sessionId#1`);

    // Two DISTINCT terms on one line stay two hits — one per term.
    const both = scanFile(SCRATCH, 'const x = { sessionId, parentUuid };\n');
    expect(both.map((hit) => hit.term).sort()).toEqual(['parentUuid', 'sessionId']);
  });

  it('word boundaries drop substring artifacts without dropping real reads', () => {
    // The anchoring that takes 444 hits down to 402. Dropping a TERM would be
    // the forbidden relaxation; this is not that.
    expect(scanFile(SCRATCH, 'const d = originalDir;\nconst s = originalSize;\n')).toEqual([]);
    expect(scanFile(SCRATCH, 'const o = origin;\n')).toHaveLength(1);
    expect(scanFile(SCRATCH, 'const p = payload.tool_use_id;\n')).toHaveLength(1);
  });
});
