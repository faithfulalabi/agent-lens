// Task 3.2 — the merge policy's unit surface: the truncation-signal gate,
// never-downgrade, lifecycle immutability, provenance, tokens/cost, and the
// messages projection. The cross-cutting end-to-end guards (rollup flush,
// transcript-only turns, both correlation paths, FK safety, and the real
// `large-output` capture) live in `merge-e2e.test.ts`.
//
// ## Where the harness fields go, and why it matters
//
// Merge runs inside the TRANSCRIPT branch of `normalize`, which receives only
// the transcript envelope. Every truncation-signal fixture therefore places
// `persistedOutputPath` / `persistedOutputSize` / a 30,000-byte `stdout` on the
// LINE's `toolUseResult`, mirroring them onto the hook envelope where that is
// realistic. `toolUseResult` was measured byte-identical to the hook's
// `tool_response` on 7/7 paired calls, so this is the same object, not a second
// read path — but a fixture that set them on the hook alone would leave the gate
// blind and go RED for entirely the wrong reason.
//
// ## AC1 after the 2026-08-02 ruling
//
// AC1 is never-downgrade + tag + pointer. "Upgrade to full content" moved to
// Task 3.4, so nothing here upgrades a stored output and nothing here ever
// writes `source: 'merged'` — asserted directly in test 2 and again over the
// real capture in `merge-e2e.test.ts`.

import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, PRICING_TABLE, PRICING_VERSION } from '../../shared/index.js';
import type { Envelope } from '../../shared/index.js';
import { recomputeRollups } from '../../db/index.js';
import { BATCH_SIZE, ingestBatch } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';
import { normalize } from '../normalizer.js';
import { discoverGoldenFixtures, loadFixtureEnvelopes } from './golden.js';
import {
  at,
  attrsOf,
  first,
  freshDb,
  hookEnvelope,
  messages,
  only,
  payloads,
  sessions,
  spans,
  tagsOf,
  toolResultLine,
  traces,
  transcriptEnvelope,
  SESSION,
  type Row,
} from './fixtures.js';

const PROMPT = 'p1';
const TOOL = 'toolu_1';

/** A real absolute sidecar path, copied verbatim from the `large-output` capture. */
const SIDECAR =
  '/home/USER/.claude/projects/-Users-USER-Desktop-agent-lens-experiments-tracer-bullet' +
  '-scratch-project/0f4b75bd-214b-4364-8983-d4741ec23c9f/tool-results/bpm6s2ql8.txt';

let db: DatabaseSync;
beforeEach(() => {
  db = freshDb();
});

// --- Fixture plumbing ------------------------------------------------------

/** SessionStart + UserPromptSubmit: a hook-owned turn for the merge to meet. */
function hookTurn(): void {
  normalize(db, hookEnvelope('SessionStart', { cwd: '/proj' }));
  normalize(db, hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: PROMPT }));
}

/** A closed hook tool call whose `tool_response` becomes the stored output. */
function hookToolCall(
  toolResponse: unknown,
  opts: { hook?: string; extra?: Record<string, unknown> } = {},
): void {
  normalize(
    db,
    hookEnvelope(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: { command: 'emit' } },
      { tool_use_id: TOOL, prompt_id: PROMPT, ts: at(1) },
    ),
  );
  normalize(
    db,
    hookEnvelope(
      opts.hook ?? 'PostToolUse',
      { tool_name: 'Bash', tool_response: toolResponse, ...opts.extra },
      { tool_use_id: TOOL, prompt_id: PROMPT, ts: at(2) },
    ),
  );
}

/** Merge one `tool_result` transcript line onto {@link TOOL}. */
function mergeToolResult(input: {
  content: unknown;
  toolUseResult?: unknown;
  is_error?: boolean;
  uuid?: string;
}): void {
  normalize(
    db,
    transcriptEnvelope(
      toolResultLine({
        tool_use_id: TOOL,
        promptId: PROMPT,
        uuid: input.uuid ?? 'line-result',
        ...input,
      }),
      { ts: at(3) },
    ),
  );
}

const toolSpan = (): Row => only(spans(db), (row) => row.id === TOOL);

/** The stored blob behind a payload id, parsed back out of canonical JSON. */
function payloadContent(id: unknown): unknown {
  const row = db.prepare('SELECT content FROM payloads WHERE id = ?').get(String(id)) as
    | { content: string }
    | undefined;
  expect(row, 'no payload row for the id under test').toBeDefined();
  return JSON.parse(row!.content) as unknown;
}

/** `tool_response` for a call the harness spilled to a sidecar. */
function spilled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stdout: 'x'.repeat(30000),
    stderr: '',
    interrupted: false,
    isImage: false,
    persistedOutputPath: SIDECAR,
    persistedOutputSize: 102400,
    ...overrides,
  };
}

/**
 * The harness's spill marker, decomposed exactly as measured: a header naming
 * the size and the absolute path, a preview of EXACTLY 2,000 bytes (the "2KB"
 * label is decimal and approximate), and a 24-byte footer.
 */
function markerBlock(path: string, label = '100KB'): string {
  const header = `<persisted-output>\nOutput too large (${label}). Full output saved to: ${path}\n\nPreview (first 2KB):\n`;
  return `${header}${'p'.repeat(2000)}\n...\n</persisted-output>`;
}

/** Drive envelopes through the production funnel, chunked as spool replay is. */
function ingestAll(target: DatabaseSync, envelopes: readonly Envelope[]): void {
  const broadcaster = new Broadcaster();
  for (let i = 0; i < envelopes.length; i += BATCH_SIZE) {
    ingestBatch(
      target,
      broadcaster,
      envelopes.slice(i, i + BATCH_SIZE).map((envelope) => ({ envelope })),
    );
  }
}

/** An assistant line carrying `message.usage`, for the token/cost tests. */
function assistantLine(input: {
  uuid: string;
  model?: string;
  usage?: Record<string, number>;
  content?: unknown[];
  promptId?: string;
  parentUuid?: string;
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: 'assistant',
    uuid: input.uuid,
    cwd: '/proj',
    message: {
      model: input.model,
      role: 'assistant',
      content: input.content ?? [{ type: 'text', text: 'ok' }],
      ...(input.usage === undefined ? {} : { usage: input.usage }),
    },
  };
  if (input.promptId !== undefined) line.promptId = input.promptId;
  if (input.parentUuid !== undefined) line.parentUuid = input.parentUuid;
  return line;
}

// --- AC1: never downgrade, tag, pointer ------------------------------------

describe('AC1 — a transcript version never downgrades a stored payload', () => {
  it('1. a truncated hook payload is NOT upgraded, even by a much larger block', () => {
    // Rescoped by the 2026-08-02 founder ruling on Open Question 0(b), option
    // (A): the "upgrade to full content" half of AC1 moved to Task 3.4, which
    // owns it byte-exact against the sidecar. The shape below is SYNTHETIC by
    // necessity — Claude Code cannot produce it, because the 30,000-byte cap is
    // applied before either surface sees the output, so `truncated ∧ transcript
    // strictly larger` is unsatisfiable (measured 0 of 7 hook-paired calls).
    // 3.2's job here is to refuse the write and record where the rest lives.
    hookTurn();
    hookToolCall(spilled());
    const stored = toolSpan().output_payload_id;

    mergeToolResult({ content: 'y'.repeat(90000), toolUseResult: spilled() });

    const span = toolSpan();
    expect(span.output_payload_id).toBe(stored);
    expect(tagsOf(span)).toContain('truncated_by_harness');
    expect(attrsOf(span).persisted_output_path).toBe(SIDECAR);
  });

  it('2. provenance is `hook` when untouched and `transcript` when created — never `merged`', () => {
    // RED if merge routed content through `upsertSpan`, whose ON CONFLICT list
    // omits `source`: the span would silently keep whichever value its creator
    // wrote and the assertion below could not distinguish the two cases.
    //
    // The `merged` half is the OQ0(b)/(a) pin. With no upgrade branch left there
    // is no moment at which provenance is genuinely mixed, so `merged` stays a
    // valid SpanSource that Task 3.4 will be the first to write.
    hookTurn();
    hookToolCall({ stdout: 'small', stderr: '' });
    const stored = toolSpan().output_payload_id;

    mergeToolResult({ content: 'small', toolUseResult: { stdout: 'small', stderr: '' } });

    // The negative control is `persistedOutputPath` ABSENT — the real
    // non-truncated case. An "equal size" control would be meaningless: JSON
    // escaping alone made a byte-identical transcript look larger.
    expect(toolSpan().source).toBe('hook');
    expect(toolSpan().output_payload_id).toBe(stored);

    normalize(
      db,
      transcriptEnvelope(assistantLine({ uuid: 'a1', promptId: PROMPT, model: 'claude-fable-5' }), {
        ts: at(4),
      }),
    );
    expect(only(spans(db), (row) => row.span_type === 'llm_call').source).toBe('transcript');
    expect(spans(db).map((row) => row.source)).not.toContain('merged');
  });

  it('3. a less complete transcript version is not even inserted', () => {
    hookTurn();
    hookToolCall(spilled({ stdout: 'x'.repeat(90000) }));
    const stored = toolSpan().output_payload_id;
    const before = payloads(db).length;

    mergeToolResult({ content: 'y'.repeat(30000), toolUseResult: spilled({ stdout: 'x'.repeat(90000) }) });

    const span = toolSpan();
    expect(span.output_payload_id).toBe(stored);
    expect(span.source).toBe('hook');
    // Not "written and ignored" — never serialized at all. `payloads` is
    // insert-only and content-addressed, so an unreferenced row is permanent.
    expect(payloads(db)).toHaveLength(before);
  });

  it('4. merge never rewrites lifecycle', () => {
    // RED the moment merge calls `upsertSpan` on an existing span: its conflict
    // clause sets `status = excluded.status`, so a transcript block whose natural
    // status is `ok` would clobber a hook-recorded `error`.
    hookTurn();
    hookToolCall({ stdout: 'boom' }, { hook: 'PostToolUseFailure', extra: { error: 'boom' } });
    const before = toolSpan();
    expect(before.status).toBe('error');

    mergeToolResult({ content: 'boom', toolUseResult: { stdout: 'boom', stderr: '' } });

    const after = toolSpan();
    expect(after.status).toBe('error');
    expect(after.ended_at).toBe(before.ended_at);
    expect(after.started_at).toBe(before.started_at);
    expect(after.trace_id).toBe(before.trace_id);
  });

  it('5. exactly 30,000 bytes is a deliberate conservative over-tag', () => {
    // KNOWN OVER-TAG, documented rather than hidden. `<= 30,000` bytes is passed
    // through WHOLE with no sidecar written at all, so 30,000/30,000 is not a
    // truncation — but it is the largest inline-able size and the last point at
    // which a genuine spill is indistinguishable from a complete payload without
    // the structured field. Fallback clause 1.3 tags it and invents nothing.
    hookTurn();
    const response = { stdout: 'x'.repeat(30000), stderr: '' };
    hookToolCall(response);
    const stored = toolSpan().output_payload_id;
    const before = payloads(db).length;

    mergeToolResult({ content: 'preview', toolUseResult: response });

    const span = toolSpan();
    expect(tagsOf(span)).toContain('truncated_by_harness');
    expect(span.output_payload_id).toBe(stored);
    expect(span.source).toBe('hook');
    expect(payloads(db)).toHaveLength(before);
    // An over-tag must never invent a path it does not have.
    expect(attrsOf(span)).not.toHaveProperty('persisted_output_path');
  });

  it('20. a multibyte truncation is still tagged', () => {
    // The stored PREFIX is what ends in U+FFFD, not the source string: the cap
    // counts bytes and can cut mid-character.
    const prefix = Buffer.from(`x${'中'.repeat(20000)}`)
      .subarray(0, 30000)
      .toString('utf8');
    // Guard the fixture itself. RED against a `=== 30000` byte detector, and RED
    // against a `.length >= 30000` char-count detector: only 10,001 chars.
    expect(Buffer.byteLength(prefix, 'utf8')).toBe(30001);
    expect(prefix.length).toBe(10001);
    expect(prefix.at(-1)).toBe('�');

    hookTurn();
    const response = { stdout: prefix, stderr: '' };
    hookToolCall(response);
    mergeToolResult({ content: 'preview', toolUseResult: response });

    expect(tagsOf(toolSpan())).toContain('truncated_by_harness');
  });

  describe('21. the sidecar pointer is recorded verbatim, never gated behind a size test', () => {
    it('records the absolute path and the exact size, and reads no sidecar', () => {
      hookTurn();
      hookToolCall(spilled());
      const stored = toolSpan().output_payload_id;
      const marker = markerBlock(SIDECAR);
      // The measured block: header 254 + preview exactly 2,000 + footer 24.
      expect(Buffer.byteLength(marker, 'utf8')).toBe(2278);

      mergeToolResult({ content: marker, toolUseResult: spilled() });

      const span = toolSpan();
      expect(span.output_payload_id).toBe(stored); // (a) smaller: no upgrade
      expect(attrsOf(span).persisted_output_path).toBe(SIDECAR); // (b) verbatim, absolute
      expect(attrsOf(span).persisted_output_size).toBe(102400); // (c) exact integer
      expect(tagsOf(span)).toContain('truncated_by_harness'); // (d)
      // (e) Following the pointer is Task 3.4's. The path is a scrubbed capture
      // path that does not exist here, and the merge completed regardless.
      expect(existsSync(SIDECAR)).toBe(false);
    });

    it('falls back to the marker when the line carries no `toolUseResult`', () => {
      // The degradation path for older/newer harness builds, not for hook-less
      // sessions: `toolUseResult` is a TRANSCRIPT field and is present whether or
      // not hooks are installed.
      hookTurn();
      hookToolCall(spilled());
      mergeToolResult({ content: markerBlock(SIDECAR) });

      const span = toolSpan();
      expect(tagsOf(span)).toContain('truncated_by_harness');
      expect(attrsOf(span).persisted_output_path).toBe(SIDECAR);
      // Absent, NOT null — `json_patch` treats a null value as a key deletion.
      expect(attrsOf(span)).not.toHaveProperty('persisted_output_size');
    });

    it('does not tag a marker that appears mid-string', () => {
      // `startsWith`, never `includes`. The same literal occurs in an assistant
      // `text` block and in `Stop.last_assistant_message`, so a substring test
      // would tag the model talking ABOUT truncation. Measured at index 0, 3/3.
      hookTurn();
      hookToolCall({ stdout: 'fine', stderr: '' });
      mergeToolResult({
        content: `Note that <persisted-output> is what the harness writes when output spills.`,
      });

      expect(tagsOf(toolSpan())).not.toContain('truncated_by_harness');
      expect(attrsOf(toolSpan())).not.toHaveProperty('persisted_output_path');

      // And the same literal on an assistant `text` block touches no tool span.
      normalize(
        db,
        transcriptEnvelope(
          assistantLine({
            uuid: 'a-prose',
            promptId: PROMPT,
            model: 'claude-fable-5',
            content: [{ type: 'text', text: 'It emits <persisted-output> markers.' }],
          }),
          { ts: at(4) },
        ),
      );
      expect(spans(db).flatMap(tagsOf)).not.toContain('truncated_by_harness');
    });
  });

  it('22. the four real non-truncated shapes do NOT upgrade', () => {
    // THE Finding-B regression. The struck `outputTextOf` byte comparator
    // upgraded every one of these — none of them truncated — because it fired on
    // representation rather than completeness: JSON escaping for the two
    // byte-identical Bash calls, `stdout`/`stderr` flattening for the third, and
    // a `cat -n` rendering vs a structured object for the Read.
    const cases: {
      name: string;
      response: Record<string, unknown>;
      transcript: string;
      retains: (blob: Record<string, unknown>) => void;
    }[] = [
      {
        name: 'Bash, byte-identical 1,405 B',
        response: { stdout: 'a'.repeat(1405), stderr: '', interrupted: false },
        transcript: 'a'.repeat(1405),
        retains: (blob) => expect(blob.stderr).toBe(''),
      },
      {
        name: 'Bash, byte-identical 1,024 B',
        response: { stdout: 'b'.repeat(1024), stderr: '', interrupted: false },
        transcript: 'b'.repeat(1024),
        retains: (blob) => expect(blob.stdout).toHaveLength(1024),
      },
      {
        name: 'Bash, stdout 85 B + stderr 95 B flattened to 180 B',
        response: { stdout: 'c'.repeat(85), stderr: 'd'.repeat(95), interrupted: false },
        transcript: `${'c'.repeat(85)}${'d'.repeat(95)}`,
        // The flattening is the loss: the concatenation cannot be split again.
        retains: (blob) => expect(blob.stderr).toBe('d'.repeat(95)),
      },
      {
        name: 'Read, structured object vs `N\\t` rendering',
        response: {
          type: 'text',
          file: {
            filePath: '/proj/src/app.ts',
            content: 'e'.repeat(3006),
            numLines: 86,
            startLine: 1,
            totalLines: 86,
          },
        },
        transcript: `f${'g'.repeat(3254)}`,
        retains: (blob) => {
          const file = blob.file as Record<string, unknown>;
          expect(file.filePath).toBe('/proj/src/app.ts');
          expect(file.totalLines).toBe(86);
        },
      },
    ];

    for (const scenario of cases) {
      db = freshDb();
      hookTurn();
      hookToolCall(scenario.response);
      const stored = toolSpan().output_payload_id;
      const tagsBefore = tagsOf(toolSpan());
      const payloadsBefore = payloads(db).length;

      mergeToolResult({ content: scenario.transcript, toolUseResult: scenario.response });

      const span = toolSpan();
      expect(span.output_payload_id, scenario.name).toBe(stored);
      expect(span.source, scenario.name).toBe('hook');
      expect(tagsOf(span), scenario.name).toEqual(tagsBefore);
      expect(payloads(db), scenario.name).toHaveLength(payloadsBefore);
      // Structure survived: the merge did not flatten the object away.
      scenario.retains(payloadContent(stored) as Record<string, unknown>);
    }
  });
});

// --- AC2: idempotency ------------------------------------------------------

describe('AC2 — re-merging converges', () => {
  /** A hook turn plus the transcript lines that describe it, as envelopes. */
  function stream(): { hooks: Envelope[]; transcripts: Envelope[] } {
    const hooks = [
      hookEnvelope('SessionStart', { cwd: '/proj' }, { ts: at(0) }),
      hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: PROMPT, ts: at(1) }),
      hookEnvelope(
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { command: 'emit' } },
        { tool_use_id: TOOL, prompt_id: PROMPT, ts: at(2) },
      ),
      hookEnvelope(
        'PostToolUse',
        { tool_name: 'Bash', tool_response: spilled() },
        { tool_use_id: TOOL, prompt_id: PROMPT, ts: at(3) },
      ),
    ];
    const transcripts = [
      transcriptEnvelope(
        {
          type: 'user',
          uuid: 'u1',
          promptId: PROMPT,
          cwd: '/proj',
          message: { role: 'user', content: 'go' },
        },
        { ts: at(4), line_offset: 0 },
      ),
      transcriptEnvelope(
        assistantLine({
          uuid: 'a1',
          parentUuid: 'u1',
          model: 'claude-fable-5',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig' },
            { type: 'text', text: 'running it' },
            { type: 'tool_use', id: TOOL, name: 'Bash', input: { command: 'emit' } },
          ],
        }),
        { ts: at(5), line_offset: 200 },
      ),
      transcriptEnvelope(
        toolResultLine({
          tool_use_id: TOOL,
          uuid: 'u2',
          parentUuid: 'a1',
          content: markerBlock(SIDECAR),
          toolUseResult: spilled(),
        }),
        { ts: at(6), line_offset: 400 },
      ),
    ];
    return { hooks, transcripts };
  }

  /** Snapshot of everything the merge writes, keyed stably. */
  function projection(target: DatabaseSync): string {
    return canonicalJson({
      traces: target.prepare('SELECT * FROM traces ORDER BY id').all(),
      spans: target
        .prepare('SELECT * FROM spans ORDER BY id')
        .all()
        .map((row) => ({ ...(row as Row), tags: tagsOf(row as Row).sort() })),
      messages: target.prepare('SELECT * FROM messages ORDER BY trace_id, seq').all(),
      payloads: target.prepare('SELECT id, byte_size FROM payloads ORDER BY id').all(),
    });
  }

  it('6. re-ingesting the same transcript is byte-for-byte a no-op', () => {
    const { hooks, transcripts } = stream();
    const all = [...hooks, ...transcripts];
    ingestAll(db, all);

    // Without this the test would pass against a NO-OP merge — two empty
    // projections are trivially identical — and would only certify
    // `insertRawEvent`'s dedupe, which is already Task 2.6a's.
    expect(spans(db).length).toBeGreaterThan(0);
    expect(messages(db).length).toBeGreaterThan(0);

    const before = projection(db);
    ingestAll(db, all);
    expect(projection(db)).toBe(before);
  });

  it('7. a direct double-`normalize` of one line converges', () => {
    // Deliberately bypasses the archive dedupe, so every write really does run
    // twice. Pins that `recordSpanUsage` is a snapshot and not an accumulator,
    // and that `insertMessage`'s DO NOTHING is reached via a deterministic id.
    hookTurn();
    const line = transcriptEnvelope(
      assistantLine({
        uuid: 'a1',
        promptId: PROMPT,
        model: 'claude-fable-5',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { ts: at(2) },
    );

    normalize(db, line);
    const once = projection(db);
    normalize(db, line);

    expect(projection(db)).toBe(once);
    expect(spans(db).filter((row) => row.span_type === 'llm_call')).toHaveLength(1);
    expect(messages(db)).toHaveLength(1);
    expect(first(messages(db)).seq).toBe(1);
    expect(only(spans(db), (row) => row.span_type === 'llm_call').tokens_in).toBe(10);
  });

  it('8. property: replay converges under every hook/transcript interleaving', () => {
    // **Scope, stated rather than assumed.** Cross-ORDERING snapshot identity is
    // false here by design, exactly as `idempotency.property.test.ts` records for
    // Pre/Post swaps: whichever surface creates a span owns its `source`,
    // `started_at` and `transcript_only` tag, and whichever opens a turn owns its
    // `prompt_preview`. That is arrival-derived identity, not drift. What must
    // hold for every arm is (a) replay convergence — re-ingesting the whole
    // stream changes nothing — and (b) the order-independent content: the same
    // messages, the same span ids, the same token totals, and never `merged`.
    const { hooks, transcripts } = stream();
    const arms = ['hook-first', 'transcript-first', 'interleaved', 'replay-all'] as const;

    const invariants: string[] = [];
    fc.assert(
      fc.property(fc.constantFrom(...arms), (arm) => {
        const target = freshDb();
        try {
          const order =
            arm === 'hook-first'
              ? [...hooks, ...transcripts]
              : arm === 'transcript-first'
                ? [...transcripts, ...hooks]
                : arm === 'interleaved'
                  ? interleave(hooks, transcripts)
                  : [...hooks, ...transcripts];
          ingestAll(target, order);
          if (arm === 'replay-all') {
            // `replaySpool` restamps every envelope `source: 'spool_replay'`,
            // which would route transcript lines away from the merge branch
            // entirely. Re-ingest through `ingestBatch` — the 2.6a-mandated
            // funnel — is the honest form of this arm.
            ingestAll(target, order);
          }
          const settled = projection(target);
          ingestAll(target, order);
          expect(settled, `${arm} did not converge on replay`).toBe(projection(target));

          expect(
            (target.prepare('SELECT source FROM spans').all() as Row[]).map((r) => r.source),
            `${arm} wrote source: 'merged'`,
          ).not.toContain('merged');
          invariants.push(
            canonicalJson({
              messages: target.prepare('SELECT id, role, seq FROM messages ORDER BY id').all(),
              spans: target.prepare('SELECT id FROM spans ORDER BY id').all(),
              tokens: target
                .prepare('SELECT SUM(tokens_in) AS i, SUM(tokens_out) AS o FROM spans')
                .get(),
            }),
          );
        } finally {
          target.close();
        }
      }),
      { numRuns: 40, seed: 20260802 },
    );

    expect(new Set(invariants).size, 'the order-independent content diverged').toBe(1);
  });

  it('9. a fingerprint-mismatch re-read does not corrupt trace closure', () => {
    // The 2.6a scenario. RED if merge is ever moved OUT of `normalize`: a
    // post-hoc pass would re-project already-archived events and would have to
    // re-establish this by hand.
    const { hooks, transcripts } = stream();
    const withStop = [
      ...hooks,
      ...transcripts,
      hookEnvelope('Stop', { stop_hook_active: true }, { prompt_id: PROMPT, ts: at(7) }),
    ];
    ingestAll(db, withStop);
    const before = canonicalJson(traces(db));

    // A re-read after a fingerprint reset re-delivers every line from byte 0.
    ingestAll(db, withStop);
    expect(canonicalJson(traces(db))).toBe(before);
  });
});

/** Alternate two streams, preserving each one's internal order. */
function interleave(a: readonly Envelope[], b: readonly Envelope[]): Envelope[] {
  const out: Envelope[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== undefined) out.push(a[i]!);
    if (b[i] !== undefined) out.push(b[i]!);
  }
  return out;
}

// --- AC3: tokens, model, cost ----------------------------------------------

describe('AC3 — tokens, model and cost land on the right rows', () => {
  /** Merge assistant lines and flush the rollups the ingest funnel would. */
  function mergeAssistants(lines: readonly Record<string, unknown>[]): void {
    const touched = new Set<string>();
    lines.forEach((line, i) => {
      const verdict = normalize(db, transcriptEnvelope(line, { ts: at(3 + i) }));
      for (const id of verdict.traceIds ?? []) touched.add(id);
    });
    recomputeRollups(db, touched, [SESSION]);
  }

  it('10. usage maps onto the llm_call span, and the tool span keeps null tokens', () => {
    hookTurn();
    hookToolCall({ stdout: 'ok' });
    mergeAssistants([
      assistantLine({
        uuid: 'a1',
        promptId: PROMPT,
        model: 'claude-fable-5',
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 300,
        },
      }),
    ]);

    const llm = only(spans(db), (row) => row.span_type === 'llm_call');
    expect(llm.tokens_in).toBe(120);
    expect(llm.tokens_out).toBe(45);
    expect(llm.tokens_cache_read).toBe(900);
    expect(llm.tokens_cache_write).toBe(300);
    expect(llm.model).toBe('claude-fable-5');
    // Hooks carry no tokens; a tool span must never inherit the turn's usage.
    expect(toolSpan().tokens_in).toBeNull();
  });

  it('11. session cost matches a value hand-computed from PRICING_TABLE', () => {
    // Computed FROM the table, never from public list prices: the rates carry a
    // `TODO(founder)` and are explicitly unverified, so this certifies the
    // arithmetic and the plumbing — not the numbers themselves.
    hookTurn();
    const usage = [
      { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 400 },
      { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    ];
    mergeAssistants(
      usage.map((u, i) =>
        assistantLine({ uuid: `a${i + 1}`, promptId: PROMPT, model: 'claude-fable-5', usage: u }),
      ),
    );

    const rates = PRICING_TABLE['claude-fable-5']!;
    const expected = usage.reduce(
      (sum, u) =>
        sum +
        (u.input_tokens * rates.input +
          u.output_tokens * rates.output +
          u.cache_read_input_tokens * rates.cache_read +
          u.cache_creation_input_tokens * rates.cache_write) /
          1_000_000,
      0,
    );

    const llmSpans = spans(db).filter((row) => row.span_type === 'llm_call');
    expect(llmSpans).toHaveLength(2);
    expect(sum(llmSpans.map((row) => Number(row.est_cost)))).toBeCloseTo(expected, 12);
    expect(Number(first(traces(db)).est_cost)).toBeCloseTo(expected, 12);
    expect(Number(first(sessions(db)).est_cost)).toBeCloseTo(expected, 12);
    expect(attrsOf(first(llmSpans)).pricing_version).toBe(PRICING_VERSION);
  });

  it('13. an unknown model prices to NULL, never 0, and traces sum priced siblings only', () => {
    hookTurn();
    mergeAssistants([
      assistantLine({
        uuid: 'a1',
        promptId: PROMPT,
        model: 'claude-fable-5',
        usage: { input_tokens: 1000, output_tokens: 0 },
      }),
      assistantLine({
        uuid: 'a2',
        promptId: PROMPT,
        model: 'some-future-model-9',
        usage: { input_tokens: 1000, output_tokens: 0 },
      }),
    ]);

    const unknown = only(spans(db), (row) => row.model === 'some-future-model-9');
    expect(unknown.est_cost).toBeNull();
    expect(attrsOf(unknown).pricing_status).toBe('unknown_model');

    const priced = only(spans(db), (row) => row.model === 'claude-fable-5');
    expect(Number(first(traces(db)).est_cost)).toBeCloseTo(Number(priced.est_cost), 12);
  });
});

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

// --- AC4: the messages projection ------------------------------------------

describe('AC4 — the messages projection reproduces the conversation', () => {
  it('14. a golden session reproduces the full conversation in order', () => {
    // The committed snapshot for this fixture is asserted by
    // `golden-replay.test.ts`; this test owns the human-readable claim.
    const envelopes = loadGolden();
    ingestAll(db, envelopes);

    const rows = messages(db);
    expect(rows.map((row) => row.role)).toEqual([
      'user',
      'thinking',
      'assistant',
      'tool_use',
      'tool_result',
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(rows.map((row) => row.trace_id)).size).toBe(1);
  });

  it('15. every message links to its span, except a bare user prompt', () => {
    const envelopes = loadGolden();
    ingestAll(db, envelopes);

    const spanIds = new Set(spans(db).map((row) => row.id));
    for (const row of messages(db)) {
      if (row.role === 'user') {
        // `Message.span_id` is optional: a string-content user line describes no
        // agent activity, so there is no span for it to point at.
        expect(row.span_id).toBeNull();
        continue;
      }
      expect(row.span_id, `message ${String(row.id)} has no span`).not.toBeNull();
      expect(spanIds).toContain(row.span_id);
    }
  });

  it('16. a thinking block becomes both a span and a message', () => {
    hookTurn();
    normalize(
      db,
      transcriptEnvelope(
        assistantLine({
          uuid: 'a1',
          promptId: PROMPT,
          model: 'claude-fable-5',
          content: [{ type: 'thinking', thinking: 'weighing it up', signature: 'sig-1' }],
        }),
        { ts: at(2) },
      ),
    );

    const thinking = only(spans(db), (row) => row.span_type === 'thinking');
    const llm = only(spans(db), (row) => row.span_type === 'llm_call');
    expect(thinking.parent_span_id).toBe(llm.id);
    expect(attrsOf(thinking).signature).toBe('sig-1');

    const message = only(messages(db), (row) => row.role === 'thinking');
    expect(message.span_id).toBe(thinking.id);
    expect(message.payload_id).toBe(thinking.input_payload_id);

    // RED against `json_patch`'s delete semantics: a null-valued attrs key would
    // erase whatever the key already held rather than storing a null.
    normalize(
      db,
      transcriptEnvelope(
        assistantLine({
          uuid: 'a2',
          promptId: PROMPT,
          model: 'claude-fable-5',
          content: [{ type: 'thinking', thinking: 'no signature here', signature: null }],
        }),
        { ts: at(3) },
      ),
    );
    const unsigned = only(spans(db), (row) => String(row.id).includes(':think:a2:'));
    expect(Object.values(attrsOf(unsigned))).not.toContain(null);
    expect(attrsOf(unsigned)).not.toHaveProperty('signature');
  });
});

/** The `transcript-merge` seed fixture, loaded through the golden harness. */
function loadGolden(): Envelope[] {
  const fixture = discoverGoldenFixtures().find((f) => f.id === 'seed/transcript-merge');
  expect(fixture, 'the transcript-merge seed fixture is missing').toBeDefined();
  return loadFixtureEnvelopes(fixture!.dir);
}
