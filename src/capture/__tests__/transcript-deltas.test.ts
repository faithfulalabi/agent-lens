// Task 6.1a — the transcript half of the delta stream.
//
// Task 6.1 built `Touched`/`markSpan`/`stageSpanDeltas` and wired every HOOK
// span writer to them; `mergeTranscriptLine` (Task 3.2) marked nothing, so every
// transcript-sourced span — every token, every dollar, every thinking block, and
// the completion of every tool call in a hookless session — was written to the DB
// and never put on the wire. Nothing errored, so nothing was red.
//
// **Subscribe FIRST, always.** `DeltaPublisher.publishTo` returns silently when
// no scope exists (lazy allocation), so a test that ingests before subscribing
// sees zero deltas and passes any "expect nothing surprising" assertion. Every
// harness below allocates the scope before the first envelope.
//
// These tests hand `ingestBatch` a publisher directly and are therefore
// structurally blind to whether PRODUCTION ever passes one — that is the
// transport hole, and only `stream-deltas.test.ts`'s end-to-end tailer test can
// fail on it.

import { describe, expect, it } from 'vitest';
import type { Delta } from '../../shared/delta.js';
import type { Span } from '../../shared/entities.js';
import type { Envelope } from '../../shared/index.js';
import { ingestBatch } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';
import { DeltaPublisher } from '../../server/deltas.js';
import {
  freshDb,
  hookEnvelope,
  SESSION,
  toolResultLine,
  transcriptEnvelope,
} from './fixtures.js';

const CWD = '/proj';
const PROMPT = 'p1';
/** The turn every line below resolves to: `openTranscriptTurn` mints seq 1. */
const TRACE = `${SESSION}:1`;

/** A subscribed publisher over a fresh DB. The subscribe is the load-bearing part. */
function harness() {
  const db = freshDb();
  const bc = new Broadcaster();
  const deltas = new DeltaPublisher();
  const seen: Delta[] = [];
  deltas
    .subscribe(SESSION, {
      write: async (delta) => {
        seen.push(delta);
      },
      end: async () => {},
    })
    .start();
  return { db, bc, deltas, seen };
}

const items = (envelopes: Envelope[]) => envelopes.map((envelope) => ({ envelope }));
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Narrow to the three span arms of `Delta` — the only ones carrying a `Span`. */
const isSpanDelta = (d: Delta): d is Delta & { span: Span } =>
  d.kind === 'span_opened' || d.kind === 'span_updated' || d.kind === 'span_closed';

/** `[span id, kind]` for every span delta, in publish order. */
function spanDeltas(seen: Delta[]): string[] {
  return seen.filter(isSpanDelta).map((d) => `${d.span.id} ${d.kind}`);
}

/** The single span delta for one id, asserted unique. */
function spanDelta(seen: Delta[], id: string): Delta & { span: Span } {
  const hits = seen.filter(isSpanDelta).filter((d) => d.span.id === id);
  expect(hits, id).toHaveLength(1);
  return hits[0]!;
}

/** An assistant transcript line carrying usage, plus whatever blocks are asked for. */
function assistantLine(input: {
  uuid: string;
  content?: unknown[];
  usage?: Record<string, number>;
}): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: input.uuid,
    cwd: CWD,
    // Real assistant lines resolve through `parentUuid`; a fixture carrying
    // `promptId` outright resolves the same trace in one hop. WITHOUT one of the
    // two, `mergeTranscriptLine` returns `[]` and writes nothing at all — the
    // silent way to make every assertion below vacuous.
    promptId: PROMPT,
    message: {
      model: 'claude-fable-5',
      role: 'assistant',
      content: input.content ?? [{ type: 'text', text: 'done' }],
      usage: input.usage ?? { input_tokens: 100, output_tokens: 20 },
    },
  };
}

/** A `tool_result` user line for one call, resolving to the same turn. */
function resultLine(input: {
  uuid: string;
  tool_use_id: string;
  is_error?: boolean;
}): Record<string, unknown> {
  return toolResultLine({
    tool_use_id: input.tool_use_id,
    content: 'output',
    is_error: input.is_error,
    uuid: input.uuid,
    promptId: PROMPT,
    cwd: CWD,
  });
}

describe('a transcript line publishes the spans it writes (AC1)', () => {
  it('emits exactly one delta per span write, with the kind the write implies', async () => {
    const { db, bc, deltas, seen } = harness();

    // Two batches, deliberately. Within ONE batch a connection coalesces by
    // entity key (`deltas.ts` `enqueue`), so `toolu_1`'s `span_opened` would be
    // superseded by its `span_closed` before either reached the wire — which is
    // by design (`ingest.ts`: "coalescing may supersede a `span_opened`, so
    // consumers apply any span delta for an unknown id as an insert") and would
    // hide a missing `span_opened` here rather than pin it.
    ingestBatch(
      db,
      bc,
      items([
        transcriptEnvelope(
          assistantLine({
            uuid: 'a1',
            content: [
              { type: 'thinking', thinking: 'weighing it up', signature: 'sig' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { cmd: 'ls' } },
            ],
          }),
        ),
      ]),
      { deltas },
    );
    await settle();
    ingestBatch(
      db,
      bc,
      items([transcriptEnvelope(resultLine({ uuid: 'u1', tool_use_id: 'toolu_1' }))]),
      { deltas },
    );
    await settle();

    // The WHOLE list, sorted — never `.some(...)`, which one stray hook envelope
    // anywhere in a batch would satisfy forever.
    expect(spanDeltas(seen).sort()).toEqual(
      [
        `${SESSION}:llm:a1 span_opened`,
        `${SESSION}:think:a1:0 span_opened`,
        'toolu_1 span_opened',
        'toolu_1 span_closed',
      ].sort(),
    );
    db.close();
  });

  it('publishes the post-usage llm span and the post-flush trace (AC2)', async () => {
    const { db, bc, deltas, seen } = harness();

    ingestBatch(
      db,
      bc,
      items([
        transcriptEnvelope(
          assistantLine({
            uuid: 'a1',
            usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 40 },
          }),
        ),
      ]),
      { deltas },
    );
    await settle();

    // `recordSpanUsage` runs AFTER the `upsertSpan` that the mark precedes, so
    // these numbers exist only because the delta body is built from a post-commit
    // RE-READ rather than captured at mark time. Build it at mark time and this
    // ships zeros.
    const llm = spanDelta(seen, `${SESSION}:llm:a1`);
    expect(llm.kind).toBe('span_opened');
    expect(llm.span.tokens_in).toBe(500);
    expect(llm.span.tokens_out).toBe(120);
    expect(llm.span.est_cost).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM traces WHERE id = ?').get(TRACE) as Record<
      string,
      unknown
    >;
    const traceDeltas = seen.filter(
      (d): d is Delta & { kind: 'trace_updated' } => d.kind === 'trace_updated',
    );
    // One rollup flush per batch means one parent delta per batch.
    expect(traceDeltas).toHaveLength(1);
    expect(traceDeltas[0]!.trace.total_tokens).toBe(row.total_tokens);
    expect(traceDeltas[0]!.trace.total_tokens).toBe(620);
    expect(traceDeltas[0]!.trace.est_cost).toBeGreaterThan(0);
    db.close();
  });
});

describe('the four `created` branches (AC1)', () => {
  it('(a) opens a transcript-only tool span `running`', async () => {
    const { db, bc, deltas, seen } = harness();

    ingestBatch(
      db,
      bc,
      items([
        transcriptEnvelope(
          assistantLine({
            uuid: 'a1',
            content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { cmd: 'ls' } }],
          }),
        ),
      ]),
      { deltas },
    );
    await settle();

    const delta = spanDelta(seen, 'toolu_a');
    expect(delta.kind).toBe('span_opened');
    // A `tool_use` block says the call was ISSUED and nothing about how it went.
    expect(delta.span.status).toBe('running');
    db.close();
  });

  it.each([
    { is_error: undefined, status: 'ok' },
    { is_error: true, status: 'error' },
  ])('(b) closes it from its later tool_result ($status)', async ({ is_error, status }) => {
    const { db, bc, deltas, seen } = harness();

    ingestBatch(
      db,
      bc,
      items([
        transcriptEnvelope(
          assistantLine({
            uuid: 'a1',
            content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { cmd: 'ls' } }],
          }),
        ),
      ]),
      { deltas },
    );
    await settle();
    seen.length = 0;

    ingestBatch(
      db,
      bc,
      items([transcriptEnvelope(resultLine({ uuid: 'u1', tool_use_id: 'toolu_b', is_error }))]),
      { deltas },
    );
    await settle();

    // The delta that ends the spin in a hookless session. Without it a live view
    // spins forever on a call that finished minutes ago.
    const delta = spanDelta(seen, 'toolu_b');
    expect(delta.kind).toBe('span_closed');
    expect(delta.span.status).toBe(status);
    db.close();
  });

  it('(c) only UPDATES a hook-created span that is still running', async () => {
    const { db, bc, deltas, seen } = harness();

    ingestBatch(
      db,
      bc,
      items([
        hookEnvelope('SessionStart', { cwd: CWD }),
        hookEnvelope('UserPromptSubmit', { prompt: 'go' }, { prompt_id: PROMPT }),
        hookEnvelope(
          'PreToolUse',
          { tool_name: 'Bash', tool_input: { cmd: 'ls' } },
          { tool_use_id: 'toolu_c', prompt_id: PROMPT },
        ),
      ]),
      { deltas },
    );
    await settle();
    seen.length = 0;

    ingestBatch(
      db,
      bc,
      items([
        transcriptEnvelope(
          assistantLine({
            uuid: 'a1',
            content: [{ type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { cmd: 'ls' } }],
          }),
        ),
      ]),
      { deltas },
    );
    await settle();

    // Hooks own lifecycle: content arrived, the span is still open. `span_opened`
    // here would tell a client to re-insert a row it already has as new.
    const delta = spanDelta(seen, 'toolu_c');
    expect(delta.kind).toBe('span_updated');
    expect(delta.span.status).toBe('running');
    db.close();
  });

  it('(d) OPENS a span a tool_result created already closed', async () => {
    const { db, bc, deltas, seen } = harness();

    ingestBatch(
      db,
      bc,
      items([transcriptEnvelope(resultLine({ uuid: 'u1', tool_use_id: 'toolu_d' }))]),
      { deltas },
    );
    await settle();

    // First-writer-wins: an envelope that opens AND closes a span in one pass is
    // still that span's FIRST appearance, so the client inserts rather than
    // hunting for a row it never received.
    const delta = spanDelta(seen, 'toolu_d');
    expect(delta.kind).toBe('span_opened');
    expect(delta.span.status).toBe('ok');
    db.close();
  });
});
