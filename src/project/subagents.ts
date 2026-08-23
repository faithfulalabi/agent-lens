// A sidecar IS a `sessions` row. This module is the half of that claim which can
// be decided without a filesystem: given the parent's rows and a flat list of
// resolved sidecars, it links each `Agent` call to the sub-agent it started and
// hands back the shallow rows the writer upserts.
//
// Pure, like the rest of this tree: no filesystem, no clock, no randomness, and
// no `node:` import at any depth. The head/tail read that produces a
// `SidecarDescriptor` lives in `src/db/sidecars.ts` and is injected, exactly as
// `spill.ts` injects its `exists` probe.
//
// ★ ONE JOIN KEY, AND NO DEPTH ANYWHERE. `meta.toolUseId` against the id
// `runPipeline` already minted for a `tool_use` block — nothing else. No
// `spawnDepth` branch and no "am I a sidecar" branch, which is exactly why a
// sub-agent that spawns a sub-agent projects through this same function at depth
// 3 with no new code: a sidecar's own `Agent` rows join the same way, against
// the same flat directory listing.
//
// THE SPAN IS THE SUB-AGENT'S OWN, and it overwrites `elapsed` UNCONDITIONALLY.
// There is no async/sync branch: 41 of 258 measured `Agent` calls are
// synchronous and carry no launch marker at all, so a branch on launch presence
// would leave every one of them labelled with the handshake it replaces.

import type { AgentMeta } from '../transcript/agents.js';
import type { DriftCounter } from '../transcript/drift.js';
import { epochMs, type ProjectedEvent } from './pipeline.js';

/**
 * The three `sessions` columns a sidecar row cannot be written without, already
 * narrowed. All three are `TEXT NOT NULL`, so a resolver that cannot fill them
 * must omit the descriptor; this type is what makes that gate typechecked rather
 * than remembered.
 */
export interface SidecarEnvelope {
  project_path: string;
  started_at: string;
  last_activity_at: string;
}

/**
 * One resolved `agent-<id>.jsonl` + `agent-<id>.meta.json` pair. Primitive
 * fields only, so this tree still imports nothing that can reach a filesystem.
 */
export interface SidecarDescriptor {
  /** The filename stem, which becomes `sessions.id`. 270 of 270 measured distinct. */
  agent_id: string;
  archive_path: string;
  source_path: string;
  mtime_ms: number;
  size: number;
  meta: AgentMeta;
  envelope: SidecarEnvelope;
}

/** The shallow `sessions` row one linked sidecar becomes. */
export interface SidecarSessionRow {
  id: string;
  source_path: string;
  archive_path: string;
  file_mtime_ms: number;
  file_size: number;
  project_path: string;
  started_at: string;
  last_activity_at: string;
  parent_session_id: string;
  /** The `Agent` `events` row that started it. */
  spawned_by_event_id: string;
  agent_type: string | undefined;
  agent_description: string | undefined;
  /** RECORDED, never enforced. Nothing in this module reads it back. */
  spawn_depth: number | undefined;
}

/**
 * Link every sidecar to the `Agent` call that started it.
 *
 * Mutates the matched rows IN PLACE and adds, removes, reorders and re-parents
 * nothing — the same contract `joinToolCalls` keeps — so every turn window the
 * pipeline computed stays valid untouched.
 *
 * `launches` is the cross-check, never the gate. A disagreement is counted and
 * the link is still made on the `toolUseId` key.
 */
export function linkSubagents(
  events: readonly ProjectedEvent[],
  sidecars: readonly SidecarDescriptor[],
  launches: ReadonlyMap<string, string>,
  drift: DriftCounter,
): SidecarSessionRow[] {
  // FILTERED BEFORE IT IS KEYED: 12 of 269 measured metas carry no `toolUseId`
  // at all, and keying them would put `undefined` in the map for the next
  // unnamed call to collide with.
  const byToolUseId = new Map<string, SidecarDescriptor>();
  for (const sidecar of sidecars) {
    const key = sidecar.meta.toolUseId;
    if (key !== undefined) byToolUseId.set(key, sidecar);
  }

  const rows: SidecarSessionRow[] = [];
  for (const event of events) {
    if (event.kind !== 'tool_call') continue;
    const sidecar = byToolUseId.get(event.id);
    if (sidecar === undefined) continue;

    const launched = launches.get(event.id);
    if (launched !== undefined && launched !== sidecar.agent_id) drift.noteSidecarMismatch();

    event.child_session_id = sidecar.agent_id;
    event.agent_type = sidecar.meta.agentType;
    event.duration_ms =
      epochMs(sidecar.envelope.last_activity_at) - epochMs(sidecar.envelope.started_at);
    event.duration_source = 'sidecar_span';

    rows.push({
      id: sidecar.agent_id,
      source_path: sidecar.source_path,
      archive_path: sidecar.archive_path,
      file_mtime_ms: sidecar.mtime_ms,
      file_size: sidecar.size,
      project_path: sidecar.envelope.project_path,
      started_at: sidecar.envelope.started_at,
      last_activity_at: sidecar.envelope.last_activity_at,
      parent_session_id: event.session_id,
      spawned_by_event_id: event.id,
      agent_type: sidecar.meta.agentType,
      agent_description: sidecar.meta.description,
      spawn_depth: sidecar.meta.spawnDepth,
    });
  }
  return rows;
}
