// The minimal fixture seeder (Task 5.0): build a realistic session/trace/span/
// message/payload graph so the read API has something to read.
//
// **Contains ZERO SQL, by design.** It composes the existing writers —
// `upsertSession`, `upsertTrace`, `insertPayload`, `upsertSpan`,
// `insertMessage`, `recordSpanUsage`, `recomputeRollups` — which is what keeps
// `src/db/index.ts`'s "only module that touches SQL" boundary intact AND what
// makes the fixture trustworthy: a seeded DB is byte-indistinguishable from one
// built by real ingest, including the rollup columns.
//
// **`recordSpanUsage` on `llm_call` spans is mandatory, not decorative.** It is
// the single entry point for token data (`rollups.ts:31-33`); skip it and every
// rollup column stays 0, which would make the read tests assert nothing.
//
// It carries its own `SEED_EPOCH` rather than importing
// `src/capture/__tests__/fixtures.ts` — that module does `import { expect } from
// 'vitest'` at its top, so production code must never reach for it.
//
// Ships in `dist` alongside `sqliteSmoke` (`db/index.ts:579-593`), the existing
// precedent for a test/dev helper in the published package.
//
// The `index.ts` <-> `seed.ts` import cycle (index re-exports this module, this
// module imports index's writers) is safe and deliberate: every reference is
// inside a function body, so it resolves at call time, long after both modules
// have finished evaluating. Nothing here runs at module scope.

import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '../shared/entities.js';
import {
  insertMessage,
  insertPayload,
  openDb,
  upsertSession,
  upsertSpan,
  upsertTrace,
} from './index.js';
import { recomputeRollups, recordSpanUsage } from './rollups.js';

/** Deterministic base timestamp — the seeder's private copy. */
export const SEED_EPOCH = '2026-07-01T00:00:00.000Z';

/** A model absent from `PRICING_TABLE`, so `estimateCost` returns `null`. */
const UNKNOWN_MODEL = 'mystery-model-9';

/** A model present in `PRICING_TABLE`, so `est_cost` is a real number. */
const KNOWN_MODEL = 'claude-sonnet-5';

/** Multi-byte UTF-8, so byte offsets and character offsets genuinely differ. */
const UNICODE_CONTENT = JSON.stringify({ note: 'héllo wörld ✅', emoji: '🎉' });

/** How much graph to build. Defaults are small enough to seed in milliseconds. */
export interface SeedOptions {
  sessions?: number;
  tracesPerSession?: number;
  spansPerTrace?: number;
  /**
   * Slide every timestamp so the LAST session starts here. Default: absent,
   * meaning `SEED_EPOCH` — byte-identical to what this seeder has always
   * written, which is what keeps every existing test unchanged.
   *
   * Exists because the UI's time-range control is unverifiable without it:
   * `SEED_EPOCH` is 2026-07-01, so `{sessions: 300}` covers 2026-07-01 to
   * 07-13 and falls entirely outside a 3d/7d/30d window measured from a real
   * clock. A browser pointed at that fixture shows an out-of-range empty state
   * rather than 300 rows, and the manual pass proves nothing.
   */
  nowAnchor?: Date;
  /**
   * Add the two shapes the uniform fixture lacks: one `transcript_only`
   * session, and one failed span so that `error_count > 0` exists somewhere.
   * Default: absent, and then nothing changes.
   *
   * Without it every seeded session is `capture_mode: 'full'` and every span is
   * `ok` or `running`, so the degraded-capture chip and the error affordance
   * have no input to render from at all.
   */
  variants?: boolean;
}

/** Ids and counts a test needs to assert against what was written. */
export interface SeedManifest {
  sessionIds: string[];
  traceIds: string[];
  spanIds: string[];
  messageIds: string[];
  payloadIds: string[];
  /** The distinct `project_path` values, for exercising the project filter. */
  projects: string[];
  /** The still-open session: no `ended_at`/`git_branch`/`model`/`transcript_path`. */
  liveSessionId: string;
  /** The still-open trace (no `ended_at`), inside {@link liveSessionId}. */
  liveTraceId: string;
  /** An `llm_call` priced with an unknown model: tokens set, `est_cost` NULL. */
  unpricedSpanId: string;
  /** A trace-root span: no `parent_span_id`. */
  rootSpanId: string;
  /** A `running` span: no `ended_at`, no `output_payload_id`. */
  openSpanId: string;
  /** Payload whose content is multi-byte UTF-8. */
  unicodePayloadId: string;
  counts: {
    sessions: number;
    traces: number;
    spans: number;
    messages: number;
  };
}

/** How far apart consecutive seeded sessions start. */
const SESSION_STRIDE_SECONDS = 3600;

/** ISO timestamp `seconds` after `epochMs`. */
function seedAt(epochMs: number, seconds: number): string {
  return new Date(epochMs + seconds * 1000).toISOString();
}

/**
 * The epoch every timestamp is measured from: {@link SEED_EPOCH} by default,
 * or whatever puts the last session's start exactly on `nowAnchor`.
 */
function epochFor(sessionCount: number, nowAnchor: Date | undefined): number {
  if (nowAnchor === undefined) return Date.parse(SEED_EPOCH);
  return nowAnchor.getTime() - (sessionCount - 1) * SESSION_STRIDE_SECONDS * 1000;
}

/**
 * Seed an already-open DB. Deterministic: ids are
 * `seed-s{i}` / `seed-s{i}:{turn}` / `seed-s{i}:{turn}:sp{j}`, timestamps derive
 * from {@link SEED_EPOCH} (or from `nowAnchor`, when one is given), and every
 * writer involved is an upsert, so seeding twice converges on the same rows
 * instead of doubling them.
 *
 * Both `nowAnchor` and `variants` default to the behaviour this seeder has
 * always had, so calling it with no options — or with only the three count
 * options — writes byte-identical rows.
 *
 * The LAST session is deliberately left live — no `ended_at`, `git_branch`,
 * `model`, or `transcript_path`, with a live final trace and a `running` final
 * span. That is what gives the null-strip mapper real NULLs to prove itself
 * against; without it every optional column would be populated and the
 * key-absent behaviour would be untested.
 */
export function seedInto(db: DatabaseSync, options: SeedOptions = {}): SeedManifest {
  const sessionCount = options.sessions ?? 3;
  const tracesPerSession = options.tracesPerSession ?? 2;
  const spansPerTrace = options.spansPerTrace ?? 3;
  const variants = options.variants ?? false;
  const epochMs = epochFor(sessionCount, options.nowAnchor);
  const at = (seconds: number): string => seedAt(epochMs, seconds);

  const manifest: SeedManifest = {
    sessionIds: [],
    traceIds: [],
    spanIds: [],
    messageIds: [],
    payloadIds: [],
    projects: [],
    liveSessionId: '',
    liveTraceId: '',
    unpricedSpanId: '',
    rootSpanId: '',
    openSpanId: '',
    unicodePayloadId: insertPayload(db, UNICODE_CONTENT),
    counts: { sessions: 0, traces: 0, spans: 0, messages: 0 },
  };
  // Payloads are content-addressed, so identical content collides to one row —
  // collect the ids as a set rather than reporting a phantom duplicate.
  const payloadIds = new Set<string>([manifest.unicodePayloadId]);

  for (let i = 0; i < sessionCount; i++) {
    const sessionId = `seed-s${i}`;
    const project = `/tmp/agent-lens/project-${i % 2}`;
    const live = i === sessionCount - 1;
    const sessionStart = i * SESSION_STRIDE_SECONDS;
    // Exactly one degraded session, and only under `variants` — the first, so
    // it exists at any session count.
    const degraded = variants && i === 0;

    upsertSession(db, {
      id: sessionId,
      harness: 'claude-code',
      project_path: project,
      started_at: at(sessionStart),
      status: live ? 'live' : 'complete',
      capture_mode: degraded ? 'transcript_only' : 'full',
      ...(live
        ? {}
        : {
            git_branch: 'main',
            model: KNOWN_MODEL,
            ended_at: at(sessionStart + 1800),
            transcript_path: `/tmp/agent-lens/transcripts/${sessionId}.jsonl`,
          }),
    });
    manifest.sessionIds.push(sessionId);
    if (!manifest.projects.includes(project)) manifest.projects.push(project);
    if (live) manifest.liveSessionId = sessionId;

    for (let turn = 1; turn <= tracesPerSession; turn++) {
      const traceId = `${sessionId}:${turn}`;
      const liveTrace = live && turn === tracesPerSession;
      const traceStart = sessionStart + turn * 60;

      upsertTrace(db, {
        id: traceId,
        session_id: sessionId,
        turn_seq: turn,
        trigger: 'user_prompt',
        prompt_preview: `Seeded prompt ${turn} for ${sessionId}`,
        started_at: at(traceStart),
        status: liveTrace ? 'live' : 'complete',
        ...(liveTrace ? {} : { ended_at: at(traceStart + 30) }),
      });
      manifest.traceIds.push(traceId);
      if (liveTrace) manifest.liveTraceId = traceId;

      let rootSpanId = '';
      for (let j = 0; j < spansPerTrace; j++) {
        const spanId = `${traceId}:sp${j}`;
        const openSpan = liveTrace && j === spansPerTrace - 1;
        const isRoot = j === 0;
        const spanStart = traceStart + j;
        // The very first llm_call gets an unpriced model so `est_cost` is a real
        // NULL somewhere in every seeded DB, however small the options.
        const unpriced = i === 0 && turn === 1 && isRoot;
        // One failed span under `variants`, so `error_count > 0` exists at all.
        // `rollups.ts:102` counts `error` and `denied`; every span this seeder
        // writes is otherwise `ok` or `running`.
        const failed = variants && i === 0 && turn === 1 && j === spansPerTrace - 1 && !openSpan;

        const inputPayloadId = unpriced
          ? manifest.unicodePayloadId
          : insertPayload(db, JSON.stringify({ span: spanId, direction: 'input' }));
        const outputPayloadId = openSpan
          ? undefined
          : insertPayload(db, JSON.stringify({ span: spanId, direction: 'output' }));

        upsertSpan(db, {
          id: spanId,
          trace_id: traceId,
          span_type: isRoot ? 'llm_call' : 'tool_call',
          name: isRoot ? 'assistant turn' : `Bash #${j}`,
          status: openSpan ? 'running' : failed ? 'error' : 'ok',
          started_at: at(spanStart),
          source: 'hook',
          tags: ['seeded'],
          attrs: { seed: true, turn },
          input_payload_id: inputPayloadId,
          ...(isRoot ? {} : { parent_span_id: rootSpanId }),
          ...(openSpan ? {} : { ended_at: at(spanStart + 1) }),
          ...(outputPayloadId === undefined ? {} : { output_payload_id: outputPayloadId }),
        });

        if (isRoot) {
          // The single entry point for token data — skip it and every rollup is 0.
          recordSpanUsage(db, spanId, {
            model: unpriced ? UNKNOWN_MODEL : KNOWN_MODEL,
            tokens_in: 1000,
            tokens_out: 200,
            cache_read: 50,
            cache_write: 10,
          });
          rootSpanId = spanId;
          if (manifest.rootSpanId === '') manifest.rootSpanId = spanId;
        }
        if (unpriced) manifest.unpricedSpanId = spanId;
        if (openSpan) manifest.openSpanId = spanId;
        manifest.spanIds.push(spanId);
        payloadIds.add(inputPayloadId);
        if (outputPayloadId !== undefined) payloadIds.add(outputPayloadId);
      }

      // Two thread-view messages per trace: a user turn with no span link, and
      // an assistant turn attached to the trace root. Nothing in production
      // writes `messages` until Task 3.2, so the seeder is their only source.
      for (const [seq, role, spanLink] of [
        [1, 'user', undefined],
        [2, 'assistant', rootSpanId],
      ] as const) {
        const messageId = `${traceId}:m${seq}`;
        const payloadId = insertPayload(
          db,
          JSON.stringify({ message: messageId, role }),
        );
        const message: Message = {
          id: messageId,
          trace_id: traceId,
          seq,
          role,
          payload_id: payloadId,
        };
        if (spanLink !== undefined && spanLink !== '') message.span_id = spanLink;
        insertMessage(db, message);
        manifest.messageIds.push(messageId);
        payloadIds.add(payloadId);
      }
    }
  }

  // Traces first, then sessions — sessions aggregate traces (`rollups.ts:145`).
  recomputeRollups(db, manifest.traceIds, manifest.sessionIds);

  manifest.payloadIds = [...payloadIds];
  manifest.counts = {
    sessions: manifest.sessionIds.length,
    traces: manifest.traceIds.length,
    spans: manifest.spanIds.length,
    messages: manifest.messageIds.length,
  };
  return manifest;
}

/**
 * Seed the on-disk DB in `dataDir`, then close the handle and return the
 * manifest. Callers must seed BEFORE booting a server on the same dir — WAL
 * permits one writer, and `startServer`'s `openDb` re-running migrations over a
 * seeded file is a verified no-op (`migrate.ts:117-118`).
 */
export function seedFixtureDb(dataDir: string, options: SeedOptions = {}): SeedManifest {
  const db = openDb(dataDir);
  try {
    return seedInto(db, options);
  } finally {
    db.close();
  }
}
