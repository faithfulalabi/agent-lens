// Task 3.2 — the merge's cross-cutting guards, all driven through a REAL path:
// `tailOnce` reading a real file, or `ingestBatch` over real envelopes. A merge
// test that called `normalize` directly would certify the policy and skip the
// pipeline; these certify the pipeline.
//
// Test 23 replays Task 1.7's captured `large-output` session. Its `describe` —
// and ONLY its `describe` — is guarded on the capture being present, because the
// capture is untracked until 1.7's HITL sign-off. Tests 12 and 17-19 are fully
// synthetic and run unconditionally: a whole-file guard would silently disable
// the only cover for the `touched()` rollup regression, and this repo has
// already ruled that "an acceptance criterion that skips itself is worse than no
// test at all" (`golden-replay.test.ts`).

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../../shared/index.js';
import type { Envelope } from '../../shared/index.js';
import { ingestHealth, readTailerOffset, upsertSession } from '../../db/index.js';
import { BATCH_SIZE, ingestBatch } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';
import { canonicalizeTranscriptPath, tailOnce } from '../tailer.js';
import {
  attrsOf,
  first,
  freshDb,
  messages,
  only,
  sessions,
  spans,
  tagsOf,
  traces,
  TS,
} from './fixtures.js';
import { loadFixtureEnvelopes, repoRoot } from './golden.js';

const SESSION = 'sess-merge-e2e';
const SLUG = '-Users-dev-proj';
const PROMPT = 'pe-1';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// --- Fixture plumbing ------------------------------------------------------

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-lens-merge-'));
  dirs.push(root);
  return root;
}

/** Write a transcript file and tell the DB where it lives (discovery source 1). */
function writeTranscript(
  db: DatabaseSync,
  root: string,
  lines: readonly Record<string, unknown>[],
  session = SESSION,
): string {
  mkdirSync(join(root, SLUG), { recursive: true });
  const path = join(root, SLUG, `${session}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  upsertSession(db, {
    id: session,
    harness: 'claude-code',
    project_path: '/Users/dev/proj',
    started_at: TS,
    status: 'live',
    capture_mode: 'full',
    transcript_path: path,
  });
  return path;
}

function tail(db: DatabaseSync, root: string): void {
  tailOnce(db, new Broadcaster(), { transcriptRoot: root });
}

function ingestAll(db: DatabaseSync, envelopes: readonly Envelope[]): void {
  const broadcaster = new Broadcaster();
  for (let i = 0; i < envelopes.length; i += BATCH_SIZE) {
    ingestBatch(
      db,
      broadcaster,
      envelopes.slice(i, i + BATCH_SIZE).map((envelope) => ({ envelope })),
    );
  }
}

/** An assistant transcript line carrying usage and optional content blocks. */
function assistant(input: {
  uuid: string;
  parentUuid?: string;
  promptId?: string;
  model?: string;
  usage?: Record<string, number>;
  content?: unknown[];
  session?: string;
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: 'assistant',
    uuid: input.uuid,
    sessionId: input.session ?? SESSION,
    cwd: '/Users/dev/proj',
    timestamp: TS,
    message: {
      model: input.model ?? 'claude-fable-5',
      role: 'assistant',
      content: input.content ?? [{ type: 'text', text: 'done' }],
      usage: input.usage ?? { input_tokens: 100, output_tokens: 20 },
    },
  };
  if (input.parentUuid !== undefined) line.parentUuid = input.parentUuid;
  if (input.promptId !== undefined) line.promptId = input.promptId;
  return line;
}

/** A string-content user transcript line — the one that carries `promptId`. */
function userPrompt(input: {
  uuid: string;
  promptId: string;
  text?: string;
  session?: string;
}): Record<string, unknown> {
  return {
    type: 'user',
    uuid: input.uuid,
    sessionId: input.session ?? SESSION,
    cwd: '/Users/dev/proj',
    timestamp: TS,
    promptId: input.promptId,
    message: { role: 'user', content: input.text ?? 'do the thing' },
  };
}

// --- 12: the `touched()` rollup regression ---------------------------------

describe('AC3 — rollups actually flush', () => {
  it('12. trace and session totals are non-zero after a tail pass', () => {
    // *THE* guard for the one-line regression that hides best: if the transcript
    // branch returns a bare `OK`, `dirty.traces` stays empty at `ingest.ts:343`,
    // every span's tokens are correct, and every TRACE total silently reads 0.
    const db = freshDb();
    const root = makeRoot();
    writeTranscript(db, root, [
      userPrompt({ uuid: 'e-u1', promptId: PROMPT }),
      assistant({
        uuid: 'e-a1',
        parentUuid: 'e-u1',
        usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 40 },
      }),
    ]);

    tail(db, root);

    const trace = first(traces(db));
    expect(trace.total_tokens).toBe(620);
    expect(trace.tokens_cache_read).toBe(40);
    expect(Number(trace.est_cost)).toBeGreaterThan(0);
    expect(Number(first(sessions(db)).est_cost)).toBeGreaterThan(0);
    db.close();
  });
});

// --- 17: transcript-only turns ---------------------------------------------

describe('AC1 + AC4 — a session with zero hook events still projects', () => {
  it('17. transcript-only turns create traces, tagged spans and messages', () => {
    // Task 3.3's AC3 substrate, delivered here: install agent-lens mid-session
    // and the transcript is the only surface there is.
    const db = freshDb();
    const root = makeRoot();
    writeTranscript(db, root, [
      userPrompt({ uuid: 'o-u1', promptId: PROMPT }),
      assistant({
        uuid: 'o-a1',
        parentUuid: 'o-u1',
        content: [
          { type: 'text', text: 'listing' },
          { type: 'tool_use', id: 'toolu_only', name: 'Bash', input: { command: 'ls' } },
        ],
      }),
    ]);

    tail(db, root);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM raw_events WHERE source = 'hook'`).get()).toEqual({
      n: 0,
    });
    const trace = first(traces(db));
    expect(trace.turn_seq).toBe(1);
    expect(trace.id).toBe(`${SESSION}:1`);

    for (const span of spans(db)) {
      expect(span.source, String(span.id)).toBe('transcript');
      expect(tagsOf(span), String(span.id)).toContain('transcript_only');
    }
    expect(spans(db).map((row) => row.span_type).sort()).toEqual(['llm_call', 'tool_call']);
    expect(messages(db).map((row) => row.role)).toEqual(['user', 'assistant', 'tool_use']);
    db.close();
  });
});

// --- 18: both correlation paths --------------------------------------------

describe('AC2 + AC4 — correlation is deterministic, not lookup-based', () => {
  it('18a. a `promptId` line attaches to ITS turn, not the latest open one', () => {
    const db = freshDb();
    const root = makeRoot();
    // Two turns open. A lookup-based resolution would glue everything onto the
    // most recent one; `latestOpenTraceId` is deliberately not in this chain.
    writeTranscript(db, root, [
      userPrompt({ uuid: 'c-u1', promptId: 'turn-1' }),
      userPrompt({ uuid: 'c-u2', promptId: 'turn-2' }),
      userPrompt({ uuid: 'c-u3', promptId: 'turn-1', text: 'still turn one' }),
    ]);

    tail(db, root);

    expect(traces(db)).toHaveLength(2);
    const late = only(messages(db), (row) => String(row.id).includes(':msg:c-u3:'));
    expect(late.trace_id).toBe(`${SESSION}:1`);
    db.close();
  });

  it('18b. an assistant line resolves through the `parentUuid` chain', () => {
    // The branch real data ALWAYS takes: 0 of 2,041 measured assistant lines
    // carry a `promptId`. The chain must also survive lines that project nothing
    // themselves — `attachment` parents ~10% of assistant lines — which is why
    // it walks the raw archive rather than a side table of projected rows.
    const db = freshDb();
    const root = makeRoot();
    writeTranscript(db, root, [
      userPrompt({ uuid: 'h-u1', promptId: 'turn-1' }),
      userPrompt({ uuid: 'h-u2', promptId: 'turn-2' }),
      // An `attachment` line: archived, never projected, and still walkable.
      {
        type: 'attachment',
        uuid: 'h-att',
        parentUuid: 'h-u1',
        sessionId: SESSION,
        cwd: '/Users/dev/proj',
        timestamp: TS,
      },
      assistant({ uuid: 'h-a1', parentUuid: 'h-att' }),
    ]);

    tail(db, root);

    const llm = only(spans(db), (row) => row.span_type === 'llm_call');
    expect(llm.trace_id).toBe(`${SESSION}:1`);
    // The attachment itself stayed archive-only.
    expect(messages(db).some((row) => String(row.id).includes(':msg:h-att:'))).toBe(false);
    db.close();
  });
});

// --- 19: FK safety ---------------------------------------------------------

describe('AC2 — unattributable lines project nothing and never throw', () => {
  it('19. cwd-less and session-less lines dead-letter nothing and still advance', () => {
    // Guards against an FK violation dead-lettering real lines: `traces`,
    // `spans` and `messages` all NOT NULL REFERENCE a parent, and
    // `PRAGMA foreign_keys=ON`, so projecting for a session with no row throws.
    const db = freshDb();
    const root = makeRoot();
    mkdirSync(join(root, SLUG), { recursive: true });
    const path = join(root, SLUG, `${SESSION}.jsonl`);
    writeFileSync(
      path,
      `${[
        { type: 'mode', mode: 'default', sessionId: SESSION },
        { type: 'file-history-snapshot', messageId: 'm1', sessionId: SESSION },
        { type: 'ai-title', title: 'a session', sessionId: SESSION },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`,
    );
    // No `sessions` row at all: discovery falls back to the filesystem scan.
    tail(db, root);

    expect(traces(db)).toHaveLength(0);
    expect(spans(db)).toHaveLength(0);
    expect(messages(db)).toHaveLength(0);
    expect(ingestHealth(db).dead_letter).toBe(0);
    const offset = readTailerOffset(db, canonicalizeTranscriptPath(path));
    expect(offset?.committed_offset).toBeGreaterThan(0);
    db.close();
  });
});

// --- 23: the real `large-output` capture -----------------------------------

/**
 * Task 1.7's captured sets are untracked until their HITL sign-off, so this ONE
 * describe is conditional. Everything above runs on a clean checkout.
 */
const CAPTURE = join(repoRoot, 'fixtures', 'scrubbed', 'large-output');
const CAPTURED = existsSync(join(CAPTURE, 'envelopes.jsonl'));

describe.skipIf(!CAPTURED)('AC1 — the real `large-output` capture (Task 1.7)', () => {
  /** The three spilled calls, with the exact bytes measured on the capture. */
  const SPILLED: Record<string, { basename: string; size: number }> = {
    toolu_019P1ZcpTFv4ngbXMcswNG6g: { basename: 'bpm6s2ql8.txt', size: 102400 },
    toolu_016VB118ypzHnEPTJUCar34u: { basename: 'bcy4frfr0.txt', size: 1048576 },
    toolu_013HsZ2ygR5JKH3ozy7UGZ5K: { basename: 'b3rotzf8t.txt', size: 10485760 },
  };

  /** The seven tool calls that have BOTH a hook `PostToolUse` and a transcript. */
  const HOOK_PAIRED = [
    ...Object.keys(SPILLED),
    'toolu_01Qn1XYZZAgd9ar21sHwSzq1',
    'toolu_01CUPW2DmBsX3Bt2pGFvDEwv',
    'toolu_01VHwJgEPBwTLp1Rvjg31BKt',
    'toolu_01E6EGmzCRBqn86CFwRBVir3',
  ];

  it('23. tags exactly the three spilled calls and upgrades nothing', () => {
    const db = freshDb();
    const envelopes = loadFixtureEnvelopes(CAPTURE);
    expect(envelopes).toHaveLength(81);

    // The hook `PostToolUse` payloads, so the "unchanged" assertion below names
    // the exact blob the hook stored rather than merely "whatever was there".
    const hookOutputs = new Map<string, string>();
    for (const envelope of envelopes) {
      if (envelope.hook_name !== 'PostToolUse') continue;
      const payload = envelope.raw_payload as Record<string, unknown>;
      const id = payload.tool_use_id;
      if (typeof id === 'string' && payload.tool_response !== undefined) {
        hookOutputs.set(id, sha256(canonicalJson(payload.tool_response)));
      }
    }
    expect(hookOutputs.size).toBe(7);

    // Which surface named each call FIRST. Derived from the capture rather than
    // hard-coded, because it is the thing under test: whoever creates a span owns
    // its `source`, and merge never rewrites it afterwards. Two of the seven
    // paired calls really do reach us from the transcript first.
    const firstSurface = firstSurfacePerTool(envelopes);
    expect([...firstSurface.values()].filter((s) => s === 'transcript')).toHaveLength(2);

    ingestAll(db, envelopes);

    const tagged = spans(db).filter((row) => tagsOf(row).includes('truncated_by_harness'));
    expect(tagged.map((row) => String(row.id)).sort()).toEqual(Object.keys(SPILLED).sort());

    for (const span of tagged) {
      const expected = SPILLED[String(span.id)]!;
      const attrs = attrsOf(span);
      expect(String(attrs.persisted_output_path).split('/').pop()).toBe(expected.basename);
      // Absolute and verbatim — Task 3.4's resolver must be able to tell that a
      // scrubbed path is not valid locally and re-resolve it.
      expect(String(attrs.persisted_output_path).startsWith('/')).toBe(true);
      expect(attrs.persisted_output_size).toBe(expected.size);
    }

    // Provenance: `merged` is Task 3.4's to write, never 3.2's.
    expect(spans(db).map((row) => row.source)).not.toContain('merged');

    // And the transcript pass wrote no output over a hook-stored one, on any of
    // the seven paired calls — not for the spills, and not for the four
    // untruncated ones the struck byte comparator would have upgraded.
    for (const toolUseId of HOOK_PAIRED) {
      const span = only(spans(db), (row) => row.id === toolUseId);
      expect(span.output_payload_id, toolUseId).toBe(hookOutputs.get(toolUseId));
      expect(span.source, toolUseId).toBe(firstSurface.get(toolUseId));
    }
    db.close();
  });
});

/** Which surface named each `tool_use_id` first, in arrival order. */
function firstSurfacePerTool(
  envelopes: readonly Envelope[],
): Map<string, 'hook' | 'transcript'> {
  const seen = new Map<string, 'hook' | 'transcript'>();
  const note = (id: unknown, surface: 'hook' | 'transcript'): void => {
    if (typeof id === 'string' && !seen.has(id)) seen.set(id, surface);
  };
  for (const envelope of envelopes) {
    const payload = envelope.raw_payload as Record<string, unknown>;
    if (envelope.source === 'hook') {
      note(payload.tool_use_id, 'hook');
      continue;
    }
    const content = (payload.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      note(block.type === 'tool_use' ? block.id : block.tool_use_id, 'transcript');
    }
  }
  return seen;
}

/** `payloads.id` for a blob — mirrors `insertPayload`'s content addressing. */
function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
