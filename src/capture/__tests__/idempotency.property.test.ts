// Task 2.6a — AC2: "replay-twice, resume-from-any-point, spool-then-live-mix all
// converge", plus the shuffled-within-trace property the What section asks for.
//
// ## What a "generated session" is
//
// `arbScript` describes a session at the level a human would: N turns, each with
// some tools that may fail or be denied, maybe a sub-agent, maybe a compaction,
// maybe a hook this build does not know, and maybe a `Stop`. `renderScript` turns
// that into a real `Envelope[]` with monotonic timestamps, and every property
// below drives those envelopes through the production `ingestBatch` funnel.
//
// **Correlators are index-derived, never generated.** `deriveEventId` folds a
// duplicate `tool_use_id` into the same `event_id` (`event-id.ts:86-90`), so
// random ids would silently collapse envelopes and the properties would test
// nothing. `Stop` carries its turn's `prompt_id` for the same reason: with an
// identical payload every `Stop` in a session would hash to one `event_id` and
// only the first turn would ever close. The normalizer ignores a `Stop` payload
// entirely (`closeActiveTrace` reads only the envelope), so this is inert.
//
// ## What these properties deliberately do NOT do
//
// They never permute the arrival order of two `UserPromptSubmit`s, and never swap
// a Pre/Post pair for one `tool_use_id`. Both are genuine, designed
// non-convergences rather than gaps:
//   - `turn_seq` is allocated `maxTurnSeq(...)+1` at projection time
//     (`normalizer.ts:201-202`), so reordering two prompts renames every trace.
//     Trace identity is arrival-derived BY DESIGN; the frozen ordering rule
//     governs which stable key we then order BY, not that identity is order-free.
//   - `upsertSpan` never rewrites `started_at`, and a Post-first arrival correctly
//     tags `synthetic_open` (`normalizer.ts:254,268`). The divergence is pinned by
//     an example-based test at the bottom of this file so nobody later "fixes" it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Envelope } from '../../shared/index.js';
import { recomputeRollups } from '../../db/index.js';
import { BATCH_SIZE, ingestBatch } from '../../server/ingest.js';
import { Broadcaster } from '../../server/sse.js';
import { normalize } from '../normalizer.js';
import { replaySpool } from '../replay.js';
import { spoolFile } from '../spool.js';
import { at, freshDb, hookEnvelope, SESSION } from './fixtures.js';
import { projectionSnapshot } from './golden.js';

/**
 * Fixed seed and run count, both named on purpose. This repo has already been
 * burned once by a nondeterministic test (Task 2.4 review, pass-1 finding #1), so
 * a property that fails on Tuesday and passes on Wednesday is worse than no
 * property. fast-check prints the failing counterexample either way, and a
 * reviewer chasing one can raise NUM_RUNS or vary SEED locally.
 *
 * NUM_RUNS was measured, not guessed: at the ruling's starting value of 100 this
 * file cost **5.5 s** in isolation — nearly doubling a 5 s suite and making it the
 * slowest file by a wide margin — which trips the "revisit past ~3 s" budget. At
 * 50 it costs **~2.8 s** and still drives ~300 generated sessions (~15k envelopes)
 * through the full funnel. The seed is fixed, so 50 runs is exactly the first half
 * of the 100-run sequence: raising it explores strictly more, never different.
 *
 * Every property here was soaked before merge at **1000 runs** on this seed and at
 * 300 runs on seeds 1 / 42 / 987654321 — all green, so none of them holds by luck
 * of a seed prefix. If you raise NUM_RUNS locally, raise the test timeout too:
 * vitest's default is 5 s per test and each property costs roughly 8 s at 1000
 * runs, so you get an opaque "Test timed out" rather than a counterexample.
 */
const SEED = 20260726;
const NUM_RUNS = 50;

/** Upper bound on permutable groups in one turn: 5 tools + subagent + compact + unknown. */
const GROUPS_PER_TURN = 8;
const MAX_TURNS = 4;

// --- Generators ------------------------------------------------------------

const arbTool = fc.record({
  fails: fc.boolean(),
  denied: fc.boolean(),
  name: fc.constantFrom('Bash', 'Read', 'Edit'),
  gapSec: fc.integer({ min: 0, max: 5 }),
});

const arbTurn = fc.record({
  tools: fc.array(arbTool, { maxLength: 5 }),
  subagent: fc.boolean(),
  compact: fc.boolean(),
  unknownHook: fc.boolean(),
  /** false => this turn never gets a Stop, so it is still live at the end. */
  closes: fc.boolean(),
});

const arbScript = fc.record({
  turns: fc.array(arbTurn, { minLength: 1, maxLength: MAX_TURNS }),
  endsSession: fc.boolean(),
  /** Sort keys for P4's within-turn group permutation; unused by P1-P3. */
  permKeys: fc.array(fc.nat({ max: 999 }), {
    minLength: MAX_TURNS * GROUPS_PER_TURN,
    maxLength: MAX_TURNS * GROUPS_PER_TURN,
  }),
});

type Script = ReturnType<typeof arbScript.generate> extends fc.Value<infer T> ? T : never;

/** `arbScript` with every turn closed — see P1's projection arm for why. */
const arbClosedScript = arbScript.map((script) => ({
  ...script,
  turns: script.turns.map((turn) => ({ ...turn, closes: true })),
}));

// --- Rendering -------------------------------------------------------------

/**
 * Render a script to envelopes, twice: in canonical arrival order, and with each
 * turn's tool/sub-agent/compaction groups permuted as WHOLE units. Both arrays
 * hold the SAME envelope objects — identical `event_id`s and identical `ts` — so
 * the only difference is arrival order, which is exactly what P4 tests.
 */
function renderScript(script: Script): { envelopes: Envelope[]; shuffled: Envelope[] } {
  const ordered: Envelope[] = [];
  const shuffled: Envelope[] = [];
  let tick = 0;

  const env = (
    hook: string,
    payload: Record<string, unknown>,
    ids: { tool_use_id?: string; prompt_id?: string } = {},
  ): Envelope => hookEnvelope(hook, payload, { ...ids, ts: at(tick++) });

  /** Emitted at the same position in both orders — lifecycle events stay pinned. */
  const pin = (e: Envelope): void => {
    ordered.push(e);
    shuffled.push(e);
  };

  pin(env('SessionStart', { cwd: '/tmp/p', transcript_path: '/tmp/t' }));

  script.turns.forEach((turn, ti) => {
    const prompt_id = `p${ti + 1}`;
    pin(env('UserPromptSubmit', { prompt: `turn ${ti + 1}` }, { prompt_id }));

    const groups: Envelope[][] = [];
    turn.tools.forEach((tool, tj) => {
      const tool_use_id = `t${ti + 1}-${tj + 1}`;
      const pre = env(
        'PreToolUse',
        { tool_name: tool.name, tool_input: { command: `run ${tool_use_id}` } },
        { tool_use_id, prompt_id },
      );
      tick += tool.gapSec;
      const post = tool.fails
        ? env(
            'PostToolUseFailure',
            { tool_name: tool.name, tool_response: {}, error: 'boom' },
            { tool_use_id, prompt_id },
          )
        : env(
            'PostToolUse',
            tool.denied
              ? { tool_name: tool.name, tool_response: {}, permissionDecision: 'deny' }
              : { tool_name: tool.name, tool_response: { ok: true } },
            { tool_use_id, prompt_id },
          );
      groups.push([pre, post]);
    });

    if (turn.subagent) {
      const agent_id = `a${ti + 1}`;
      groups.push([
        env('SubagentStart', { agent_id, agent_type: 'worker' }, { prompt_id }),
        env('SubagentStop', { agent_id, agent_type: 'worker' }, { prompt_id }),
      ]);
    }
    if (turn.compact) {
      groups.push([
        env('PreCompact', { trigger: 'auto' }, { prompt_id }),
        env('PostCompact', { trigger: 'auto', compact_summary: 'squashed' }, { prompt_id }),
      ]);
    }
    if (turn.unknownHook) {
      groups.push([env('SomeFutureHook_v9', { novel: ti }, { prompt_id })]);
    }

    for (const group of groups) ordered.push(...group);
    for (const group of permuteGroups(groups, script.permKeys, ti)) shuffled.push(...group);

    // Stop runs `closeRunningSpans`, so moving a group across it would legitimately
    // change span statuses. It stays pinned in both orders.
    if (turn.closes) pin(env('Stop', { stop_hook_active: true }, { prompt_id }));
  });

  if (script.endsSession) pin(env('SessionEnd', { reason: 'clear' }));
  return { envelopes: ordered, shuffled };
}

/** Stable-sort a turn's groups by its slice of the generated key array. */
function permuteGroups(groups: Envelope[][], keys: number[], ti: number): Envelope[][] {
  return groups
    .map((group, i) => ({ group, i, key: keys[ti * GROUPS_PER_TURN + i] ?? 0 }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((entry) => entry.group);
}

// --- Drivers ---------------------------------------------------------------

let dataDir: string;
beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-prop-'));
});
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Run `body` against a fresh migrated in-memory DB and return its snapshot. */
function withDb(body: (db: DatabaseSync) => void, normalizeSource = false): string {
  const db = freshDb();
  try {
    body(db);
    return projectionSnapshot(db, { normalizeSource });
  } finally {
    db.close();
  }
}

/** Ingest through the production funnel, chunked exactly as spool replay is. */
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

/** Append envelopes to the session spool file, as the adapter does when down. */
function spool(envelopes: readonly Envelope[]): void {
  const path = spoolFile(SESSION, dataDir);
  mkdirSync(dirname(path), { recursive: true });
  for (const envelope of envelopes) appendFileSync(path, `${JSON.stringify(envelope)}\n`);
}

/** Replay (and delete) whatever is spooled — what `startServer` does before binding. */
function drainSpool(db: DatabaseSync): void {
  replaySpool(db, new Broadcaster(), dataDir);
}

function assertProperty<T>(arb: fc.Arbitrary<T>, predicate: (value: T) => void): void {
  fc.assert(fc.property(arb, predicate), { numRuns: NUM_RUNS, seed: SEED });
}

// --- P1: replay twice ------------------------------------------------------

describe('P1 — replaying the same sequence twice converges (AC2)', () => {
  it('archive arm: the insertRawEvent dupe short-circuit makes ingest idempotent', () => {
    assertProperty(arbScript, (script) => {
      const { envelopes } = renderScript(script);
      const once = withDb((db) => ingestAll(db, envelopes));
      const twice = withDb((db) => {
        ingestAll(db, envelopes);
        ingestAll(db, envelopes);
      });
      expect(twice).toBe(once);
    });
  });

  it('projection arm: the writes converge even with the archive dedupe bypassed', () => {
    // The arm that actually proves something. Calling `normalize` directly skips
    // `insertRawEvent`'s ON CONFLICT DO NOTHING, so every upsert really does run
    // twice — delta arithmetic (`SET n = n + 1`) fails this, recompute-from-
    // children passes it. Same reasoning as the Task 2.4 rollup idempotency test.
    //
    // Each envelope is applied twice IN PLACE, which is what a duplicate delivery
    // looks like. The generator forces every turn to close: `closeActiveTrace` is
    // a LOOKUP ("the latest open trace"), not an identified write, so with two
    // turns live at once a duplicated `Stop` closes the older one. That boundary
    // is pinned by the example below; the archive arm above covers the unclosed
    // shapes, which is where production's protection actually lives.
    assertProperty(arbClosedScript, (script) => {
      const { envelopes } = renderScript(script);
      const project = (passes: number) =>
        withDb((db) => {
          const traces = new Set<string>();
          for (const envelope of envelopes) {
            for (let p = 0; p < passes; p++) {
              for (const id of normalize(db, envelope).traceIds ?? []) traces.add(id);
            }
          }
          recomputeRollups(db, traces, [SESSION]);
        });
      expect(project(2)).toBe(project(1));
    });
  });

  it('a duplicated Stop with two turns live closes the older one — the known boundary', () => {
    // A finding from writing the property above, pinned so it is a documented
    // boundary rather than a trap for the next reader. `closeActiveTrace` closes
    // "the latest OPEN trace" (`normalizer.ts:314-316`); it cannot name the turn
    // the harness meant, because `Stop` carries no correlator the projection
    // trusts. Apply it twice while turn 1 is still open and the second call
    // closes turn 1.
    //
    // Production cannot reach this: `insertRawEvent` is ON CONFLICT DO NOTHING
    // and `ingestOne` returns BEFORE `normalize` on a duplicate
    // (`ingest.ts:263-267`), so an already-archived envelope is never projected
    // twice — which is exactly what the archive arm above proves over the full
    // generator. The constraint this records is for future callers: **anything
    // that re-projects already-projected events (a Phase-3 merge, a backfill)
    // must go through `ingestBatch`, not around it.** Dead-letter reprocess is
    // safe by construction — a dead letter was never projected in the first place.
    const script: Script = {
      // Turn 1 never closes, turn 2 does: two traces live when the Stop lands.
      turns: [emptyTurn(false), emptyTurn(true)],
      endsSession: false,
      permKeys: Array<number>(MAX_TURNS * GROUPS_PER_TURN).fill(0),
    };
    const { envelopes } = renderScript(script);
    const project = (stopPasses: number) =>
      withDb((db) => {
        for (const envelope of envelopes) {
          const passes = envelope.hook_name === 'Stop' ? stopPasses : 1;
          for (let p = 0; p < passes; p++) normalize(db, envelope);
        }
      });

    const once = project(1);
    const twice = project(2);
    expect(twice).not.toBe(once);
    // One Stop leaves turn 1 live (plus the session); two leave only the session.
    expect(once.split('"status": "live"')).toHaveLength(3);
    expect(twice.split('"status": "live"')).toHaveLength(2);
  });
});

/** A turn with no tools/sub-agent/compaction — just a prompt and maybe a Stop. */
function emptyTurn(closes: boolean): Script['turns'][number] {
  return { tools: [], subagent: false, compact: false, unknownHook: false, closes };
}

// --- P2: resume from any point ---------------------------------------------

describe('P2 — resuming from any prefix converges (AC2)', () => {
  // `k` SLICES the sequence, it never permutes it: the frozen ordering rule is
  // untouched by construction. `spans_lite.seq` is excluded from the snapshot and
  // `archive[].source` is normalized only where a spool is involved.
  const arbCut = fc.tuple(arbScript, fc.nat({ max: 128 }));

  it('re-ingesting the whole sequence after a prefix changes nothing', () => {
    assertProperty(arbCut, ([script, rawK]) => {
      const { envelopes } = renderScript(script);
      const k = rawK % (envelopes.length + 1);
      // Both arms are all-`hook`, so this is asserted WITHOUT normalizeSource —
      // a strictly stronger claim than the spool arm below can make.
      const resumed = withDb((db) => {
        ingestAll(db, envelopes.slice(0, k));
        ingestAll(db, envelopes);
      });
      expect(resumed).toBe(withDb((db) => ingestAll(db, envelopes)));
    });
  });

  it('spool form: prefix live, everything spooled, replay -> same projection', () => {
    // The property-shaped version of kill-collector.test.ts: the adapter cannot
    // know which envelopes the collector already accepted, so it spools all of
    // them and replay must dedupe the overlap.
    assertProperty(arbCut, ([script, rawK]) => {
      const { envelopes } = renderScript(script);
      const k = rawK % (envelopes.length + 1);
      const recovered = withDb((db) => {
        ingestAll(db, envelopes.slice(0, k));
        spool(envelopes);
        drainSpool(db);
      }, true);
      expect(recovered).toBe(withDb((db) => ingestAll(db, envelopes), true));
    });
  });
});

// --- P3: spool / live mix --------------------------------------------------

describe('P3 — a flapping collector converges on the never-down run (AC2)', () => {
  /** Per-envelope "collector was down" mask; 80 >= the longest script this generates. */
  const arbMask = fc.array(fc.boolean(), { minLength: 80, maxLength: 80 });

  it('every outage replays before the next live event, and the projection matches', () => {
    // **Why outages are replayed per reconnect rather than all at the end.**
    // A restart runs `replaySpool` BEFORE it binds (`start.ts:104`), so a spooled
    // run always lands ahead of the live events that follow it and total arrival
    // order is preserved. Partitioning the sequence into one live channel and one
    // spool channel appended afterwards — the obvious reading of "spool-then-live
    // mix" — would instead PERMUTE the sequence, moving a `UserPromptSubmit`
    // behind a `PostToolUse` and splitting Pre/Post pairs. That does not converge,
    // by the same design the header describes, and asserting it would be asserting
    // something false.
    assertProperty(fc.tuple(arbScript, arbMask), ([script, down]) => {
      const { envelopes } = renderScript(script);
      const flapped = withDb((db) => {
        let i = 0;
        while (i < envelopes.length) {
          const isDown = down[i] === true;
          let j = i;
          while (j < envelopes.length && (down[j] === true) === isDown) j++;
          const run = envelopes.slice(i, j);
          if (isDown) {
            spool(run);
            drainSpool(db); // the reconnect
          } else {
            ingestAll(db, run);
          }
          i = j;
        }
        // The adapter retried everything after the last reconnect: all duplicates.
        ingestAll(db, envelopes);
      }, true);
      expect(flapped).toBe(withDb((db) => ingestAll(db, envelopes), true));
    });
  });
});

// --- P4: shuffle where the rules allow -------------------------------------

describe('P4 — permuting whole tool groups within a turn converges (AC2)', () => {
  it('groups with distinct correlators are freely reorderable inside a turn', () => {
    // Legal because each span carries its own started_at/ended_at, `payloads` is
    // content-addressed, and every rollup is recompute-from-children over
    // order-free aggregates (`rollups.ts:90-111`). Lifecycle events stay pinned;
    // see the file header for why that is a design fact, not a cop-out.
    let reordered = 0;
    assertProperty(arbScript, (script) => {
      const { envelopes, shuffled } = renderScript(script);
      if (shuffled.some((envelope, i) => envelope !== envelopes[i])) reordered += 1;
      expect(withDb((db) => ingestAll(db, shuffled))).toBe(
        withDb((db) => ingestAll(db, envelopes)),
      );
    });
    // Anti-vacuity: a turn with fewer than two groups permutes to itself, so
    // without this the whole property could quietly degrade to `x === x`.
    expect(reordered, 'the generator produced no reorderings at all').toBeGreaterThan(NUM_RUNS / 4);
  });

  it('but swapping ONE Pre/Post pair diverges — and that is the intended behaviour', () => {
    // Example-based on purpose: this is a pinned divergence, not a property.
    // `upsertSpan`'s conflict clause never rewrites `started_at`, so a Post that
    // arrives first sets the span's start to its OWN ts and is tagged
    // `synthetic_open` — an honest "we never saw the open" rather than a
    // fabricated one. Task 2.3 review, pass-1 finding #4.
    const prompt_id = 'p1';
    const tool_use_id = 't1';
    const ups = hookEnvelope('UserPromptSubmit', { prompt: 'x' }, { prompt_id, ts: at(0) });
    const pre = hookEnvelope(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      { tool_use_id, prompt_id, ts: at(1) },
    );
    const post = hookEnvelope(
      'PostToolUse',
      { tool_name: 'Bash', tool_response: { ok: true } },
      { tool_use_id, prompt_id, ts: at(2) },
    );

    const inOrder = withDb((db) => ingestAll(db, [ups, pre, post]));
    const swapped = withDb((db) => ingestAll(db, [ups, post, pre]));

    expect(swapped).not.toBe(inOrder);
    expect(inOrder).toContain('"started_at": "2026-07-26T00:00:01.000Z"');
    expect(swapped).toContain('synthetic_open');
    // Both still reach the same terminal status: the terminal-status guard means
    // the late `running` open does not revert the closed span.
    expect(swapped).toContain('"status": "ok"');
  });
});
