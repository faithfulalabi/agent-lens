// RFC §7's one door: every read of a harness-supplied field lives in
// `src/transcript/`. Plan 001 proved the convention loses on its own — harness
// fields ended up read across 45 files — so this is the enforcement that makes
// the rule a fact. It is deliberately a text grep, not an AST pass: an AST
// version would be the "sophistication that becomes a hole" the door exists to
// avoid, and a name in a comment is exactly the kind of drift worth seeing.
//
// MEASURED ON `main` @0903699, before the cutover: 402 hit lines across 50
// files — 152 production (132 quarantined by path + 20 reviewed) and 250 test.
// Task 4.5 deleted the 12 quarantined modules, dismantled `LEGACY_TREES`
// outright, and brought the test tree INTO scope, which is why the only
// allowlist left is `SUPPRESSIONS` and why it now covers both trees.
//
// A HIT IS ONE MATCHING LINE PER TERM. A line carrying the same term twice is
// one hit, and the ordinal counts over matching lines, never over occurrences.
// Counting occurrences instead breaks the key: two entries on one line would
// store an identical line, and the re-binding assertion below could not tell
// them apart. `render-gate/report.ts:166` is the surviving real case — the
// second, `server/start.ts:162`, sat inside a doc comment task 4.5 deleted.
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
// ★ TEST FILES ARE IN SCOPE, as of Task 4.5, and the exemption is NOT permanent.
// Task 2.5 excused them on volume (250 of 402 hits) and on a forcing case:
// Task 3.1's AC2 requires a differential against the `parentUuid` ancestor walk,
// a test that must name `parentUuid` outside the door by design. Both reasons
// shrank with the plan-001 test tree. The forcing case is now ONE file —
// `project/__tests__/segmentation.differential.test.ts`, 4 hits — which is four
// reviewed suppressions, not a reason to excuse a whole tree. AC6 of task 4.5
// required either this or a written statement that the exemption stands forever;
// this is the answer it chose.
//
// The two guards that scan the tree are excluded from their OWN scan by name, in
// `sourceFiles()` below. That clause exists only because tests came in scope:
// this file stores every term it polices as data, and `projector-version.test.ts`
// names them while explaining itself, so each would otherwise report itself.
//
// NEW SUPPRESSIONS ARE EXPECTED, NOT MISCALIBRATION. A filename stem read from
// the corpus IS harness-supplied, so the gate is doing its job; review the read
// and add an entry. There is no path quarantine to add a file to — `LEGACY_TREES`
// was deleted with the modules it covered.

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

/** One reviewed hit. `line` is the trimmed source text the review looked at. */
interface Suppression {
  key: string;
  line: string;
  why: string;
}

// Every reviewed hit, in BOTH trees. Measured after task 4.5: 76 hits in 22
// files — 23 production and 53 test.
//
// Production (23): homonyms, almost all of them — the archive's own failure
// provenance, the render gate's own report of what it read out of a browser, the
// browser sense of "origin". Five are SQL comments inside `db/schema.ts`, which
// is a verbatim TRANSPORT of the v2 DDL and reads nothing at all; the spec
// predicts that false positive itself (`data-model-v2.md:415-416`), and stripping
// the comments to quiet the grep would delete the measured provenance the DDL
// exists to carry. The two entries that were NOT homonyms — the `/api/ingest`
// dead-letter read at `server/app.ts` and the sweep-origin doc comment at
// `server/start.ts` — went with the code task 4.5 deleted.
//
// Test (53): three honest categories, and the largest is new. A FIXTURE BUILDER
// CONSTRUCTS harness-shaped input rather than reading it, which is the opposite
// of what the door governs: the door decides who may INTERPRET a harness name,
// and a builder supplies the input `src/transcript/` then interprets. The rest
// are the same homonyms as production, plus four hits in ONE file —
// `project/__tests__/segmentation.differential.test.ts` — which is Task 3.1's
// forcing case: its AC2 requires an independent ancestor walk outside the door,
// because a differential that imported the door's implementation would be
// comparing the door with itself.
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
    key: 'db/schema.ts#sessionId#1',
    line: 'id                    TEXT PRIMARY KEY,   -- sessionId (filename stem), or agentId for a sidecar',
    why: 'a SQL comment in the v2 DDL, naming what the `sessions.id` column holds. The column is snake_case and this module reads nothing — it exports one frozen string and a version number',
  },
  {
    key: 'db/schema.ts#promptId#1',
    line: '-- One row per promptId group. The collapsible header on screen 2.',
    why: 'the same verbatim DDL, describing what one `turns` row groups. The grouping itself is the projector’s, behind the door in src/transcript/',
  },
  {
    key: 'db/schema.ts#requestId#1',
    line: 'tokens_out            INTEGER NOT NULL DEFAULT 0,  -- per-requestId LAST-line fold',
    why: 'DDL comment recording the measured token-fold rule for `sessions.tokens_out`; the fold is the projector’s, not this module’s',
  },
  {
    key: 'db/schema.ts#requestId#2',
    line: 'model              TEXT,                  -- \\\\  stamped on the FIRST event of each requestId',
    why: 'DDL comment opening the `events` token block. The two backslashes are LITERAL: the source escapes them so the template literal is not a LineContinuation, and this entry stores the escaped bytes the file actually holds, never the spec text',
  },
  {
    key: 'db/schema.ts#requestId#3',
    line: 'tokens_cache_write INTEGER,               --  } taken once per requestId.',
    why: 'closes that same DDL comment block; the column beside it is snake_case and nothing here reads either',
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
    key: 'server/middleware/token-auth.ts#origin#1',
    line: '// applied to the static page (which bootstraps the token same-origin instead).',
    why: 'the browser sense of origin, in a comment about same-origin token bootstrap',
  },
  // `shared/entities.ts#tool_use_id#1` WAS HERE, AND ITS THIRD REWRITE WAS ITS
  // DELETION. The entry exempted the doc comment on `Span.id`, and Task 5.2
  // deleted `Span` with the tree that rendered it — so the line the suppression
  // stored no longer exists, the stale check reds on a rewrite, and removing the
  // entry is the only edit that is true. `src/shared/entities.ts` now holds two
  // string unions and names no harness field at all.
  {
    key: 'archive/__tests__/source-readonly.test.ts#origin#1',
    line: 'expect(result.errors[0]?.origin).toBe(\'archive\');',
    why: 'homonym: asserts ArchiveError.origin, the archive\'s own failure-provenance enum (source/archive/log). Same sense as the reviewed cli/commands/archive.ts entries',
  },
  {
    key: 'archive/__tests__/source-readonly.test.ts#origin#2',
    line: 'expect(result.errors[0]?.origin).toBe(\'archive\');',
    why: 'homonym: the same ArchiveError.origin assertion on a second refusal path',
  },
  {
    key: 'archive/__tests__/source-readonly.test.ts#origin#3',
    line: 'expect(result.errors[0]?.origin).toBe(\'archive\');',
    why: 'homonym: the same ArchiveError.origin assertion on a third refusal path',
  },
  {
    key: 'archive/__tests__/source-readonly.test.ts#origin#4',
    line: 'expect(result.errors[0]?.origin).toBe(\'archive\');',
    why: 'homonym: the same ArchiveError.origin assertion on a fourth refusal path',
  },
  {
    key: 'cli/__tests__/archive.test.ts#origin#1',
    line: 'origin: ArchiveResult[\'errors\'][number][\'origin\'],',
    why: 'homonym: the parameter type of a local error builder, taken off ArchiveResult — the archive-local enum, never a harness value',
  },
  {
    key: 'cli/__tests__/archive.test.ts#origin#2',
    line: 'return { path, message: `Error: ${origin} failed`, origin };',
    why: 'homonym: that builder constructing an ArchiveError from the local enum',
  },
  {
    key: 'cli/__tests__/archive.test.ts#origin#3',
    line: 'expect(result.errors[0]?.origin).toBe(\'archive\');',
    why: 'homonym: asserts the exit-code predicate saw an `archive`-side failure',
  },
  {
    key: 'cli/__tests__/archive.test.ts#origin#4',
    line: 'expect(result.errors[0]?.origin).toBe(\'log\');',
    why: 'homonym: the same assertion for the `log` side',
  },
  {
    key: 'cli/__tests__/archive.test.ts#origin#5',
    line: 'expect(result.errors[0]?.origin).toBe(\'source\');',
    why: 'homonym: the same assertion for the `source` side',
  },
  {
    key: 'cli/__tests__/archive.test.ts#origin#6',
    line: 'expect(result.errors[0]?.origin).toBe(\'archive\');',
    why: 'homonym: the same assertion on the spawned-binary arm',
  },
  {
    key: 'cli/__tests__/archive.test.ts#origin#7',
    line: 'expect([leafRun.result.errors[0]?.origin, logRun.result.errors[0]?.origin]).toEqual([',
    why: 'homonym: the two-population divergence assertion, over the same archive-local enum',
  },
  {
    key: 'content/__tests__/resolve.test.ts#sessionId#1',
    line: 'sessionId: SESSION_ID,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. This one builds the session id of a synthetic transcript line',
  },
  {
    key: 'content/__tests__/resolve.test.ts#parentUuid#1',
    line: 'parentUuid: null,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The null root link of that same synthetic line',
  },
  {
    key: 'content/__tests__/resolve.test.ts#toolUseResult#1',
    line: 'toolUseResult: { persistedOutputPath: DECLARED, persistedOutputSize: 999 },',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Builds the structured spill pointer the resolver is asked to follow',
  },
  {
    key: 'content/__tests__/resolve.test.ts#toolUseResult#2',
    line: 'toolUseResult: { persistedOutputPath: spill },',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The same pointer for the resolvable-spill arm',
  },
  {
    key: 'content/__tests__/resolve.test.ts#toolUseResult#3',
    line: 'toolUseResult: { persistedOutputPath: declared },',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The same pointer for the missing-spill arm',
  },
  {
    key: 'content/__tests__/resolve.test.ts#tool_use_id#1',
    line: 'tool_use_id: callId,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Builds the result block that joins to a call id',
  },
  {
    key: 'content/__tests__/resolve.test.ts#requestId#1',
    line: 'requestId: `req-${callId}`,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Builds the assistant response group id',
  },
  {
    key: 'db/__tests__/fixtures/index.ts#sessionId#1',
    line: 'sessionId: SESSION_ID,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The shared envelope builder for the db write and freshness suites',
  },
  {
    key: 'db/__tests__/fixtures/index.ts#parentUuid#1',
    line: 'parentUuid: null,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The null root link that same builder emits',
  },
  {
    key: 'db/__tests__/fixtures/index.ts#promptId#1',
    line: 'promptId: `p-${serial}`,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The prompt group of a synthetic human line',
  },
  {
    key: 'db/__tests__/fixtures/index.ts#promptId#2',
    line: 'promptId: `m-${serial}`,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The prompt group of a synthetic machinery line, which is what makes it segment',
  },
  {
    key: 'db/__tests__/fixtures/index.ts#tool_use_id#1',
    line: 'message: { role: \'user\', content: [{ type: \'tool_result\', tool_use_id: callId, content }] },',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Builds a tool_result block bound to a call id',
  },
  {
    key: 'db/__tests__/fixtures/index.ts#requestId#1',
    line: 'requestId: `req-${serial}`,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Builds the assistant response group id',
  },
  {
    key: 'db/__tests__/fixtures/index.ts#origin#1',
    line: '/** A human prompt. `origin.kind` is what `isHumanPrompt` reads first. */',
    why: 'doc comment on the human-prompt builder, naming the field the projector reads first. Prose about a read, never a read',
  },
  {
    key: 'db/__tests__/fixtures/index.ts#origin#2',
    line: 'origin: { kind: \'human\' },',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Emits the marker that makes a synthetic line a human prompt',
  },
  {
    key: 'db/__tests__/fixtures/index.ts#origin#3',
    line: '* because that is the one variable turn segmentation moves on, and no `origin`,',
    why: 'doc comment on the machinery-line builder, explaining that omitting the field is what makes the line machinery. Prose about a read',
  },
  {
    key: 'db/__tests__/sidecars-corpus.test.ts#tool_use_id#1',
    line: 'for (const block of blocks as { type?: string; id?: string; tool_use_id?: string }[]) {',
    why: 'an opt-in corpus DIAGNOSTIC (AGENT_LENS_REAL_CORPUS=1) that measures the elapsed launch gap a sidecar span replaces. It walks raw blocks because the measurement is about what the projector does NOT use; nothing it reads reaches a column',
  },
  {
    key: 'db/__tests__/sidecars-corpus.test.ts#tool_use_id#2',
    line: 'if (block.type === \'tool_result\' && block.tool_use_id === callId) result ??= line.timestamp;',
    why: 'the second half of that same diagnostic walk, matching the result block to its call',
  },
  {
    key: 'db/__tests__/sidecars-corpus.test.ts#message.content#1',
    line: 'const blocks = Array.isArray(line.message?.content) ? line.message.content : [];',
    why: 'the block list that walk iterates, in the same opt-in diagnostic',
  },
  {
    key: 'db/__tests__/write.test.ts#toolUseResult#1',
    line: 'toolUseResult: {',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Builds the spill claim a projection then resolves',
  },
  {
    key: 'db/__tests__/write.test.ts#toolUseResult#2',
    line: 'toolUseResult: { isAsync: true, agentId },',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Builds the async sub-agent launch marker',
  },
  {
    key: 'db/__tests__/write.test.ts#promptId#1',
    line: '// No `cwd` on any line, and no `origin`/`promptId` either: a bare uuid line.',
    why: 'comment naming the two fields a deliberately bare fixture line omits. Prose about a read',
  },
  {
    key: 'db/__tests__/write.test.ts#origin#1',
    line: '// No `cwd` on any line, and no `origin`/`promptId` either: a bare uuid line.',
    why: 'the same comment, matched a second time under a different term. One line, two terms, two hits',
  },
  {
    key: 'dev/__tests__/dev-server.test.ts#sessionId#1',
    line: 'sessionId: \'sess-dev\',',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The session id of the one archived line the dev-server suite indexes',
  },
  {
    key: 'project/__tests__/idempotency.property.test.ts#tool_use_id#1',
    line: 'content: [{ type: \'tool_result\', tool_use_id: callId, content, is_error: true }],',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The generated failing result block, which must carry `is_error` on the BLOCK where the status ladder reads it',
  },
  {
    key: 'project/__tests__/pipeline.test.ts#promptId#1',
    line: 'const id: unknown = line.raw.promptId;',
    why: 'reads the raw group off a classified line to prove turn segmentation used it. `ParsedLine.raw` is the door’s own published escape hatch for exactly this, and the assertion is about the projector, so it cannot live inside it',
  },
  {
    key: 'project/__tests__/segmentation.differential.test.ts#parentUuid#1',
    line: '// `parentUuid` ancestor walk, and this file is the proof that let the walker be',
    why: 'the FORCING CASE task 2.5 excused the whole test tree for, now reduced to one file. Prose: names the ancestor walk this differential retired',
  },
  {
    key: 'project/__tests__/segmentation.differential.test.ts#parentUuid#2',
    line: 'uuid = rawString(at, \'parentUuid\');',
    why: '★ Task 3.1\'s AC2 REQUIRES this read outside the door. The test re-implements the ancestor walk independently and asserts it agrees with prompt-group segmentation on the real corpus; an implementation that imported the door\'s would be comparing the door with itself',
  },
  {
    key: 'project/__tests__/segmentation.differential.test.ts#promptId#1',
    line: 'const group = rawString(line, \'promptId\');',
    why: 'the prompt-group side of that same differential',
  },
  {
    key: 'project/__tests__/segmentation.differential.test.ts#promptId#2',
    line: 'const group = rawString(at, \'promptId\');',
    why: 'the prompt-group side, read at the ancestor being walked',
  },
  {
    key: 'project/__tests__/tools.test.ts#tool_use_id#1',
    line: 'const parsed: { message?: { content?: { tool_use_id?: unknown }[] } } = JSON.parse(slice);',
    why: 'reads the RESULT LINE BACK OUT of the fixture bytes at the (result_offset, result_len) the projector stored, to prove the coordinate addresses the right line. The read is the assertion — a projected column checked against the source it names — and moving it behind the door would mean the door asserting its own output',
  },
  {
    key: 'project/__tests__/tools.test.ts#tool_use_id#2',
    line: 'expect(parsed.message?.content?.[call.result_block!]?.tool_use_id).toBe(id);',
    why: 'the assertion on the block that read resolved to',
  },
  {
    key: 'render-gate/__tests__/render-gate.test.ts#sessionId#1',
    line: 'sessionId: \'sess-1\',',
    why: 'homonym: the render gate\'s own Observations record of what it read out of the browser, matching the three reviewed render-gate/index.ts entries',
  },
  {
    key: 'server/__tests__/persistence.test.ts#sessionId#1',
    line: 'sessionId: SESSION,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The session id of the one archived line this suite seeds',
  },
  {
    key: 'server/__tests__/persistence.test.ts#parentUuid#1',
    line: 'parentUuid: null,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. That line’s null root link',
  },
  {
    key: 'server/__tests__/persistence.test.ts#promptId#1',
    line: 'promptId: \'p1\',',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. That line’s prompt group',
  },
  {
    key: 'server/__tests__/persistence.test.ts#origin#1',
    line: 'origin: { kind: \'human\' },',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The marker that makes the seeded line a human prompt, so the session gets a turn',
  },
  {
    key: 'server/__tests__/start.test.ts#sessionId#1',
    line: 'sessionId: SESSION,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The session id of the archived lines this suite seeds for the sweep',
  },
  {
    key: 'server/__tests__/start.test.ts#parentUuid#1',
    line: 'parentUuid: null,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Those lines’ null root link',
  },
  {
    key: 'server/__tests__/start.test.ts#promptId#1',
    line: 'promptId: `p${i}`,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. Their prompt groups',
  },
  {
    key: 'server/__tests__/start.test.ts#origin#1',
    line: 'origin: { kind: \'human\' },',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The marker that makes them human prompts',
  },
  {
    key: 'server/__tests__/static-bootstrap.test.ts#origin#1',
    line: '// AC3 (same-origin token bootstrap): the served page must carry the token so',
    why: 'homonym: the browser sense, in a comment about same-origin token bootstrap. Same sense as the reviewed server/middleware/token-auth.ts entry',
  },
  {
    key: 'dev/__tests__/dev-server.test.ts#parentUuid#1',
    line: 'parentUuid: null,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The null root link of the archived line the dev suite seeds.',
  },
  {
    key: 'dev/__tests__/dev-server.test.ts#promptId#1',
    line: 'promptId: `p${i}`,',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. That line\'s prompt group.',
  },
  {
    key: 'dev/__tests__/dev-server.test.ts#origin#1',
    line: 'origin: { kind: \'human\' },',
    why: 'CONSTRUCTS harness-shaped input, never reads it. A builder that writes the field is the opposite of a read behind the door: the door governs who may INTERPRET a harness name, and a fixture that emits one is supplying the input `src/transcript/` then interprets. The marker that makes it a human prompt, so the session gets a turn to list.',
  },
];

// The helpers below are what the real assertions and their mutation controls
// share. A control that re-derives the comparison inline proves nothing about
// the assertion it protects. Parameters are DEFAULTED so each real assertion
// reads as an argument-free call: there is no call-site expression for a future
// `.filter(...)` to hide in.

/**
 * Every `.ts` under `src/`, outside the door. Repo-relative, sorted.
 *
 * ★ TESTS ARE IN SCOPE (task 4.5), which is why the two self-exclusions below
 * exist. This file stores all eleven terms as data and `projector-version.test.ts`
 * names several while explaining itself, so each would report ITSELF as an
 * unreviewed read of every term it polices — a guard that must suppress its own
 * source is not policing anything. Nothing else is excused by name.
 */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.split('\\').join('/'))
    .filter((name) => !name.includes('one-door') && !name.includes('projector-version'))
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
 * Every unreviewed hit, plus the rot direction of the allowlist.
 * A suppression exempts a hit only when the KEY and the STORED LINE both match:
 * checking the key alone would let a read inserted above a suppressed one
 * inherit its ordinal while only the stale limb reds.
 */
function unreviewed(
  hits: readonly Hit[] = scanAll(),
  suppressions: readonly Suppression[] = SUPPRESSIONS,
): { unexpected: string[]; staleSuppressions: string[] } {
  const stored = new Map(suppressions.map((entry) => [entry.key, entry.line]));

  return {
    unexpected: hits
      .filter((hit) => stored.get(hit.key) !== hit.text)
      .map(describeHit)
      .sort(),
    staleSuppressions: suppressions
      .filter((entry) => !hits.some((hit) => hit.key === entry.key && hit.text === entry.line))
      .map((entry) => entry.key)
      .sort(),
  };
}

describe('RFC §7 — harness fields are read behind the one door', () => {
  it('finds no unreviewed harness read outside src/transcript/', () => {
    const { unexpected, staleSuppressions } = unreviewed();

    expect(
      unexpected,
      'harness-supplied name(s) read outside src/transcript/. Two legal responses: move the ' +
        'read into src/transcript/, or add a reviewed SUPPRESSIONS entry with a written reason. ' +
        'The file:line:term printed above is PROSE, not the key — the key is <file>#<term>#<ordinal> ' +
        'and the entry must also store the trimmed line.',
    ).toEqual([]);

    expect(
      staleSuppressions,
      'SUPPRESSIONS entries that exempt nothing — the hit moved, changed, or went away. If a ' +
        'read was inserted above this one, the entry now points at a DIFFERENT line: re-review ' +
        'both, do not just renumber.',
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

  it('every allowlist entry carries a written reason', () => {
    for (const entry of SUPPRESSIONS) {
      expect(entry.why.length, `${entry.key} needs a justification`).toBeGreaterThan(0);
      expect(entry.line.length, `${entry.key} must store the matched line`).toBeGreaterThan(0);
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

  it('test files are IN scope, and only the two guards excuse themselves', () => {
    // The inversion task 4.5 made, asserted in both directions so the exemption
    // cannot quietly come back.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((file) => file.endsWith('.test.ts')).length).toBeGreaterThan(20);
    expect(files.filter((file) => file.includes('__tests__/')).length).toBeGreaterThan(20);
    expect(files.filter((file) => file.endsWith('.d.ts'))).toEqual([]);

    // The self-exclusion clause `sourceFiles()` now carries, and nothing beyond
    // it: a guard that stores every term it polices would otherwise report
    // itself, which polices nothing.
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

  it('a stale suppression reds', () => {
    const hits = scanFile(SCRATCH, 'const a = origin;\n');

    const gone: Suppression = {
      key: `${SCRATCH}#origin#9`,
      line: 'const z = origin;',
      why: 'control',
    };
    expect(unreviewed(hits, [gone]).staleSuppressions).toEqual([`${SCRATCH}#origin#9`]);
    // …and a live one does not, so the limb above discriminates.
    const live: Suppression = { key: `${SCRATCH}#origin#1`, line: 'const a = origin;', why: 'c' };
    expect(unreviewed(hits, [live]).staleSuppressions).toEqual([]);
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
