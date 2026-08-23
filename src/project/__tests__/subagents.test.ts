// AC1, AC2, AC3, AC4 — the linker's half, decided without a filesystem.
//
// Every descriptor here is hand-built, which is the point: `linkSubagents` is
// the code that decides what links to what, and it can be driven to every arm —
// sync, agreeing, disagreeing, keyless, depth 3 — with no directory anywhere.
// The resolver that produces a descriptor is `db/__tests__/sidecars.test.ts`.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMeta } from '../../transcript/agents.js';
import { DriftCounter } from '../../transcript/drift.js';
import { runPipeline, type ProjectedEvent, type Projection } from '../pipeline.js';
import {
  linkSubagents,
  type SidecarDescriptor,
  type SidecarEnvelope,
  type SidecarSessionRow,
} from '../subagents.js';
import { classifyProjectFixture } from './fixtures.js';

const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = dirname(PROJECT_DIR);
const SUBAGENTS_SOURCE = readFileSync(join(PROJECT_DIR, 'subagents.ts'), 'utf8');

const SESSION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** Every non-test `.ts` under one tree — the same filter the standing guards use. */
function sources(tree: string): string[] {
  return readdirSync(tree, { recursive: true, encoding: 'utf8' })
    .map((name) => name.split('\\').join('/'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .filter((name) => !name.endsWith('.test.ts') && !name.includes('__tests__/'))
    .map((name) => join(tree, name))
    .sort();
}

/** One `file:line` per matching line. Defaulted so a control can drive it too. */
function scanFiles(files: readonly string[], pattern: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        pattern.test(line) ? [`${file.slice(SRC_DIR.length + 1)}:${index + 1}`] : [],
      ),
  );
}

/** The two trees the greps are scoped to: behind the door, and the projector. */
function scanTrees(pattern: RegExp): string[] {
  return scanFiles(
    [...sources(join(SRC_DIR, 'transcript')), ...sources(join(SRC_DIR, 'project'))],
    pattern,
  );
}

function project(name: string, session = SESSION): Projection & { drifter: DriftCounter } {
  const { lines, drift } = classifyProjectFixture(name);
  return { ...runPipeline(lines, { session_id: session, drift }), drifter: drift };
}

function callAt(result: Projection, id: string): ProjectedEvent {
  const event = result.events.find((candidate) => candidate.id === id);
  if (event === undefined) throw new Error(`no tool call ${id}`);
  return event;
}

/** One resolved sidecar. Every arm below varies exactly one field of this. */
function descriptor(
  agentId: string,
  toolUseId: string | undefined,
  meta: Partial<AgentMeta> = {},
  envelope: Partial<SidecarEnvelope> = {},
): SidecarDescriptor {
  return {
    agent_id: agentId,
    archive_path: `/archive/subagents/agent-${agentId}.jsonl`,
    source_path: `/source/subagents/agent-${agentId}.jsonl`,
    mtime_ms: 1_700_000_000_000,
    size: 4096,
    meta: {
      agentType: 'Explore',
      description: 'look around',
      toolUseId,
      spawnDepth: 1,
      parentAgentId: undefined,
      ...meta,
    },
    envelope: {
      project_path: '/Users/dev/proj',
      started_at: '2026-08-14T09:00:02.000Z',
      last_activity_at: '2026-08-14T09:04:02.000Z',
      ...envelope,
    },
  };
}

/** The keyless shape: the whole of all 12 measured `wf_*` metas. */
function keyless(agentId: string): SidecarDescriptor {
  return descriptor(agentId, undefined, {
    agentType: 'workflow-subagent',
    description: undefined,
  });
}

function rowFor(rows: readonly SidecarSessionRow[], id: string): SidecarSessionRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no sidecar row ${id}`);
  return row;
}

describe('AC1 — one join key, and the row it writes', () => {
  it('links the sidecar onto the Agent call its meta names', () => {
    const result = project('subagent-launch.jsonl');
    const rows = linkSubagents(
      result.events,
      [descriptor('AGREE01', 'toolu_agree')],
      result.launches,
      result.drifter,
    );

    const call = callAt(result, 'toolu_agree');
    expect(call.child_session_id).toBe('AGREE01');
    expect(call.agent_type).toBe('Explore');
    expect(rows).toHaveLength(1);
  });

  it('the row carries the parentage, the linkage and the envelope verbatim', () => {
    const result = project('subagent-launch.jsonl');
    const rows = linkSubagents(
      result.events,
      [descriptor('AGREE01', 'toolu_agree')],
      result.launches,
      result.drifter,
    );

    expect(rowFor(rows, 'AGREE01')).toStrictEqual({
      id: 'AGREE01',
      source_path: '/source/subagents/agent-AGREE01.jsonl',
      archive_path: '/archive/subagents/agent-AGREE01.jsonl',
      file_mtime_ms: 1_700_000_000_000,
      file_size: 4096,
      project_path: '/Users/dev/proj',
      started_at: '2026-08-14T09:00:02.000Z',
      last_activity_at: '2026-08-14T09:04:02.000Z',
      parent_session_id: SESSION,
      spawned_by_event_id: 'toolu_agree',
      agent_type: 'Explore',
      agent_description: 'look around',
      spawn_depth: 1,
    });
  });

  it('every other row is left exactly as the pipeline emitted it', () => {
    const result = project('subagent-launch.jsonl');
    linkSubagents(
      result.events,
      [descriptor('AGREE01', 'toolu_agree')],
      result.launches,
      result.drifter,
    );

    for (const event of result.events) {
      if (event.id === 'toolu_agree') continue;
      expect(event.child_session_id, event.id).toBeUndefined();
      expect(event.agent_type, event.id).toBeUndefined();
      expect(event.duration_source, event.id).not.toBe('sidecar_span');
    }
  });

  it('adds, removes, reorders and re-parents nothing', () => {
    const result = project('subagent-launch.jsonl');
    const before = result.events.map((event) => `${event.id}:${event.seq}:${event.turn_id}`);

    linkSubagents(
      result.events,
      [descriptor('AGREE01', 'toolu_agree')],
      result.launches,
      result.drifter,
    );

    expect(result.events.map((event) => `${event.id}:${event.seq}:${event.turn_id}`)).toStrictEqual(
      before,
    );
  });

  it('a descriptor nothing in this file launched links nothing', () => {
    const result = project('subagent-launch.jsonl');
    const rows = linkSubagents(
      result.events,
      [descriptor('STRANGER', 'toolu_from_another_session')],
      result.launches,
      result.drifter,
    );

    expect(rows).toStrictEqual([]);
    expect(result.events.every((event) => event.child_session_id === undefined)).toBe(true);
  });

  it('no sidecar at all leaves the Agent rows on their elapsed span', () => {
    const result = project('subagent-launch.jsonl');
    expect(linkSubagents(result.events, [], result.launches, result.drifter)).toStrictEqual([]);
    expect(callAt(result, 'toolu_agree').duration_source).toBe('elapsed');
  });
});

describe('AC1 — depth is recorded, never branched on', () => {
  it('a sidecar that spawns a sidecar links through the same function', () => {
    // The SAME `linkSubagents` call, over a sub-agent's OWN transcript. Nothing
    // is passed to say which generation this is, and depth 3 is unwitnessed in
    // the corpus (1 x253, 2 x17), so the fixture must be synthetic.
    const result = project('subagent-depth3.jsonl', 'DEPTH2AGENT');
    const rows = linkSubagents(
      result.events,
      [descriptor('DEPTH3AGENT', 'toolu_deep', { spawnDepth: 3 })],
      result.launches,
      result.drifter,
    );

    expect(callAt(result, 'toolu_deep').child_session_id).toBe('DEPTH3AGENT');
    expect(rowFor(rows, 'DEPTH3AGENT').parent_session_id).toBe('DEPTH2AGENT');
    // RECORDED, and nothing consulted it: the arms above linked a depth-1
    // descriptor through this same call and this same key.
    expect(rowFor(rows, 'DEPTH3AGENT').spawn_depth).toBe(3);
  });

  it('the module names no depth at all in a comparison', () => {
    // The structural half of "no depth-specific branch": the linker cannot be
    // branching on a generation it never tests.
    expect(SUBAGENTS_SOURCE).not.toMatch(/spawnDepth\s*[=!<>]/);
    expect(SUBAGENTS_SOURCE).not.toMatch(/spawn_depth\s*[=!<>]/);
  });
});

describe('AC2 — the agent id is a cross-check, never a gate', () => {
  it('a synchronous Agent call, with no launch marker at all, still links', () => {
    const result = project('subagent-launch.jsonl');
    // 41 of 258 measured `Agent` calls are synchronous and carry no agent id, so
    // a linker gated on the launch would drop every one of them.
    expect(result.launches.has('toolu_sync')).toBe(false);

    const rows = linkSubagents(
      result.events,
      [descriptor('SYNC01', 'toolu_sync')],
      result.launches,
      result.drifter,
    );

    expect(callAt(result, 'toolu_sync').child_session_id).toBe('SYNC01');
    expect(rows).toHaveLength(1);
    expect(result.drifter.serialize()).not.toContain('sidecar_agent_id_mismatch');
  });

  it('an agreeing agent id links and bumps nothing', () => {
    const result = project('subagent-launch.jsonl');
    expect(result.launches.get('toolu_agree')).toBe('AGREE01');

    linkSubagents(
      result.events,
      [descriptor('AGREE01', 'toolu_agree')],
      result.launches,
      result.drifter,
    );

    expect(result.drifter.serialize()).not.toContain('sidecar_agent_id_mismatch');
  });

  it('a disagreeing agent id still links, and is counted', () => {
    const result = project('subagent-launch.jsonl');
    expect(result.launches.get('toolu_disagree')).toBe('SOMEONEELSE');

    const rows = linkSubagents(
      result.events,
      [descriptor('ONDISK', 'toolu_disagree')],
      result.launches,
      result.drifter,
    );

    // Linked on the meta's key, which is the only key there is.
    expect(callAt(result, 'toolu_disagree').child_session_id).toBe('ONDISK');
    expect(rowFor(rows, 'ONDISK').spawned_by_event_id).toBe('toolu_disagree');
    expect(JSON.parse(result.drifter.serialize())).toMatchObject({
      sidecar_agent_id_mismatch: 1,
    });
  });

  it('the mismatch key sorts before every other drift key', () => {
    const drift = new DriftCounter();
    drift.noteSidecarMismatch();
    drift.noteUnjoinedToolUse();
    drift.noteUnknownBlock('a_new_block');
    drift.noteUnknownType('a_new_type');

    const keys = Object.keys(JSON.parse(drift.serialize()) as Record<string, unknown>);
    expect(keys[0]).toBe('sidecar_agent_id_mismatch');
    expect(keys).toStrictEqual([...keys].sort());
  });

  it('a clean counter still serializes to exactly {}', () => {
    expect(new DriftCounter().serialize()).toBe('{}');
  });
});

describe('AC3 — the span is the sub-agent’s own', () => {
  it('is the envelope subtraction, stamped sidecar_span', () => {
    const result = project('subagent-launch.jsonl');
    linkSubagents(
      result.events,
      [descriptor('AGREE01', 'toolu_agree')],
      result.launches,
      result.drifter,
    );

    const call = callAt(result, 'toolu_agree');
    expect(call.duration_source).toBe('sidecar_span');
    // 09:00:02.000 -> 09:04:02.000, off the sidecar's own two end stamps.
    expect(call.duration_ms).toBe(240_000);
  });

  it('no emitted span equals the elapsed gap it replaces', () => {
    const result = project('subagent-launch.jsonl');
    const gaps = new Map(
      ['toolu_sync', 'toolu_agree', 'toolu_disagree'].map((id) => [
        id,
        callAt(result, id).duration_ms,
      ]),
    );

    linkSubagents(
      result.events,
      [
        descriptor('SYNC01', 'toolu_sync'),
        descriptor('AGREE01', 'toolu_agree'),
        descriptor('ONDISK', 'toolu_disagree'),
      ],
      result.launches,
      result.drifter,
    );

    for (const [id, gap] of gaps) {
      const call = callAt(result, id);
      expect(call.duration_source, id).toBe('sidecar_span');
      // THE PROPERTY, never a literal. The measured launch gap ranges
      // 40–3,263 ms, so the "156 ms" the task file quoted is false today; and
      // the "median ratio 1.00 over 70 agents" figure is unreproduced, so no
      // arm here asserts it either.
      expect(call.duration_ms, id).not.toBe(gap);
      expect(call.duration_ms!, id).toBeGreaterThan(gap!);
    }
  });

  it('overwrites elapsed with no async/sync branch', () => {
    const result = project('subagent-launch.jsonl');
    expect(callAt(result, 'toolu_sync').duration_source).toBe('elapsed');

    linkSubagents(
      result.events,
      [descriptor('SYNC01', 'toolu_sync')],
      result.launches,
      result.drifter,
    );

    // The sync arm is exactly the one a launch-gated linker leaves behind.
    expect(callAt(result, 'toolu_sync').duration_source).toBe('sidecar_span');
  });
});

describe('AC2 — a meta with no join key is not a descriptor', () => {
  it('is skipped, and never becomes an undefined map key', () => {
    const result = project('subagent-launch.jsonl');
    const rows = linkSubagents(
      result.events,
      [keyless('WORKFLOW01'), descriptor('AGREE01', 'toolu_agree')],
      result.launches,
      result.drifter,
    );

    expect(rows.map((row) => row.id)).toStrictEqual(['AGREE01']);
    expect(result.events.filter((event) => event.child_session_id !== undefined)).toHaveLength(1);
  });

  it('two keyless metas do not collide with each other', () => {
    const result = project('subagent-launch.jsonl');
    expect(
      linkSubagents(
        result.events,
        [keyless('WF1'), keyless('WF2')],
        result.launches,
        result.drifter,
      ),
    ).toStrictEqual([]);
  });
});

describe('AC4 — the spawning tool is the literal Agent', () => {
  it('no Task tool-name literal survives behind the door or in the projector', () => {
    // Plan 001's RFC and its task 4.1 both named `Task`. Measured archive-wide
    // it is `Agent` 258 of 258 and `Task` 0, so anything inherited from them is
    // wrong.
    expect(scanTrees(/(['"`])Task\1/)).toStrictEqual([]);
  });

  it('…and the scan is not vacuous: the Agent literal IS in those trees', () => {
    expect(scanTrees(/'Agent'/).length).toBeGreaterThan(0);
  });

  it('SubagentStart and SubagentStop are read nowhere in either tree', () => {
    // Measured mismatched, not merely unreliable: Start fired for #1, Stop for
    // the nested #2, and #3 got neither.
    expect(scanTrees(/Subagent(Start|Stop)/)).toStrictEqual([]);
  });

  it('…and the same scanner over the quarantined module DOES hit', () => {
    // Non-vacuity. `capture/normalizer.ts` holds the only occurrences in `src/`
    // and is `LEGACY_TREES`-quarantined until task 4.5, so a scope that hid a
    // live read would look identical to a clean one without this control.
    expect(
      scanFiles([join(SRC_DIR, 'capture', 'normalizer.ts')], /Subagent(Start|Stop)/).length,
    ).toBeGreaterThan(0);
  });
});
