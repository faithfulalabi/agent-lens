// Task 3.3's corpus half. Opt-in via `AGENT_LENS_REAL_CORPUS=1`, the same gate
// as `freshness-corpus.test.ts`.
//
// Reads `~/.agent-lens/archive` and NEVER `~/.claude/projects`. EVERY assertion
// is a PROPERTY or a LOWER BOUND. Two re-measures twenty minutes apart under the
// 15-minute cron already disagreed by one file (257 -> 258 metas, 269 -> 270
// sidecars), so an absolute count here would red on a clean checkout.
//
// The two figures the task file quoted as literals are NOT asserted anywhere:
// the "156 ms" async-launch gap is false (measured min 40 ms, range 40–3,263),
// and the "median ratio 1.00 over 70 agents" is unreproduced. Both are struck.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createArchiveReader } from '../../archive/read.js';
import { parseAgentMeta, type AgentMeta } from '../../transcript/agents.js';
import { classifyLine } from '../../transcript/line.js';
import { DriftCounter } from '../../transcript/drift.js';
import { readSidecars } from '../sidecars.js';

const ENABLED = process.env.AGENT_LENS_REAL_CORPUS === '1';
const runIt = ENABLED ? it : it.skip;

const ARCHIVE_ROOT = join(homedir(), '.agent-lens', 'archive');

/** Well under what was measured on 2026-08-23 (258 keyed metas of 270). */
const MIN_KEYED_METAS = 200;

const META_EXT = '.meta.json';

interface Found {
  metaPath: string;
  transcript: string;
  meta: AgentMeta;
}

/** Every `agent-*.meta.json` in the archive, parsed through the production reader. */
function corpusMetas(): Found[] {
  const found: Found[] = [];
  const reader = createArchiveReader();
  let names: string[];
  try {
    names = readdirSync(ARCHIVE_ROOT, { recursive: true, encoding: 'utf8' });
  } catch {
    return found;
  }

  for (const raw of names) {
    const name = raw.split('\\').join('/');
    const leaf = name.slice(name.lastIndexOf('/') + 1);
    if (!leaf.startsWith('agent-') || !leaf.endsWith(META_EXT)) continue;

    const metaPath = join(ARCHIVE_ROOT, name);
    const meta = parseAgentMeta(
      JSON.parse(reader.read(metaPath, 0, reader.size(metaPath)).toString()),
    );
    if (meta === undefined) continue;
    found.push({ metaPath, transcript: `${metaPath.slice(0, -META_EXT.length)}.jsonl`, meta });
  }
  return found;
}

/** The `subagents/` ancestor of a meta path, and the parent transcript above it. */
function parentOf(metaPath: string): string | undefined {
  const at = metaPath.lastIndexOf('/subagents/');
  return at === -1 ? undefined : `${metaPath.slice(0, at)}.jsonl`;
}

/**
 * The transcript whose `Agent` call started this sub-agent.
 *
 * A depth-1 agent was started by the session above it. A DEPTH-2 agent was
 * started by a SIBLING sidecar — its `parentAgentId` — which is exactly why the
 * resolver reads the whole enclosing `subagents/` listing and lets the caller's
 * own tool-use ids narrow it, rather than looking one level up.
 */
function spawnerOf(entry: Found, byAgentId: ReadonlyMap<string, string>): string | undefined {
  if (entry.meta.parentAgentId === undefined) return parentOf(entry.metaPath);
  return byAgentId.get(entry.meta.parentAgentId);
}

/** `agentId -> its own transcript`, keyed off the filename stem. */
function transcriptsByAgentId(found: readonly Found[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of found) {
    const leaf = entry.transcript.slice(entry.transcript.lastIndexOf('/') + 1);
    map.set(leaf.slice('agent-'.length, -'.jsonl'.length), entry.transcript);
  }
  return map;
}

function lines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

/** The sub-agent's own span, from its first and last top-level stamps. */
function endStamps(transcript: string): number | undefined {
  const rows = lines(transcript);
  if (rows.length < 2) return undefined;
  const first = (JSON.parse(rows[0]!) as { timestamp?: string }).timestamp;
  const last = (JSON.parse(rows[rows.length - 1]!) as { timestamp?: string }).timestamp;
  if (first === undefined || last === undefined) return undefined;
  return Date.parse(last) - Date.parse(first);
}

/** The elapsed gap between a call and its result — what `sidecar_span` replaces. */
function launchGap(parent: string, callId: string): number | undefined {
  let call: string | undefined;
  let result: string | undefined;
  for (const row of lines(parent)) {
    if (!row.includes(callId)) continue;
    const line = JSON.parse(row) as { timestamp?: string; message?: { content?: unknown } };
    const blocks = Array.isArray(line.message?.content) ? line.message.content : [];
    for (const block of blocks as { type?: string; id?: string; tool_use_id?: string }[]) {
      if (block.type === 'tool_use' && block.id === callId) call ??= line.timestamp;
      if (block.type === 'tool_result' && block.tool_use_id === callId) result ??= line.timestamp;
    }
  }
  if (call === undefined || result === undefined) return undefined;
  return Date.parse(result) - Date.parse(call);
}

describe('sidecar linkage over the real archive (opt-in via AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt('at least 200 metas carry a join key, and every one of them is a string', () => {
    const keyed = corpusMetas().filter((entry) => entry.meta.toolUseId !== undefined);
    expect(keyed.length).toBeGreaterThanOrEqual(MIN_KEYED_METAS);
    for (const entry of keyed) expect(typeof entry.meta.toolUseId, entry.metaPath).toBe('string');
  });

  runIt('a meta with no join key also carries no description', () => {
    // The 12 measured `wf_*` metas are the whole file
    // `{"agentType":"workflow-subagent","spawnDepth":1}`. This is the property,
    // not the count: 3.3 links what has a key, and 4.1 indexes the rest.
    for (const entry of corpusMetas()) {
      if (entry.meta.toolUseId !== undefined) continue;
      expect(entry.meta.description, entry.metaPath).toBeUndefined();
      expect(entry.metaPath).toContain('/subagents/workflows/');
    }
  });

  runIt('every meta that carries a key RESOLVES against the transcript that spawned it', () => {
    // Measured 257/257, then 258/258 twenty minutes later. The assertion is
    // `unresolved === 0`, which is a PROPERTY; the totals are diagnostics.
    const metas = corpusMetas();
    const byAgentId = transcriptsByAgentId(metas);
    const unresolved: string[] = [];
    let resolved = 0;
    let deep = 0;

    const bySpawner = new Map<string, Found[]>();
    for (const entry of metas) {
      if (entry.meta.toolUseId === undefined) continue;
      const spawner = spawnerOf(entry, byAgentId);
      if (spawner === undefined) continue;
      if (entry.meta.parentAgentId !== undefined) deep += 1;
      bySpawner.set(spawner, [...(bySpawner.get(spawner) ?? []), entry]);
    }

    for (const [spawner, entries] of bySpawner) {
      let text: string;
      try {
        text = readFileSync(spawner, 'utf8');
      } catch {
        // A spawner that is sealed or expired is not a linkage failure.
        continue;
      }
      for (const entry of entries) {
        if (text.includes(entry.meta.toolUseId!)) resolved += 1;
        else unresolved.push(entry.metaPath);
      }
    }

    expect(unresolved).toStrictEqual([]);
    expect(resolved).toBeGreaterThanOrEqual(MIN_KEYED_METAS);
    // Non-vacuity: the depth-2 arm is what a parent-only lookup gets wrong, so
    // the corpus must actually contain some.
    expect(deep).toBeGreaterThan(0);
    console.log(`[diagnostic] ${resolved} keyed metas resolved, 0 unresolved; ${deep} at depth 2+`);
  });

  runIt('every sidecar carries a cwd and a timestamp at BOTH ends', () => {
    // The NOT NULL gate's premise, measured 269/269 — which is exactly why it
    // ships as a guard rather than as an assumption.
    const drift = new DriftCounter();
    let checked = 0;

    for (const entry of corpusMetas()) {
      let text: string;
      try {
        text = readFileSync(entry.transcript, 'utf8');
      } catch {
        continue;
      }
      const rows = text.split('\n').filter((line) => line !== '');
      if (rows.length === 0) continue;

      for (const line of [rows[0]!, rows[rows.length - 1]!]) {
        const parsed = classifyLine(JSON.parse(line), {
          byteOffset: 0,
          byteLength: line.length,
          drift,
        });
        expect(parsed.timestamp, entry.transcript).toBeDefined();
        expect(parsed.raw.cwd, entry.transcript).toBeDefined();
      }
      checked += 1;
    }

    expect(checked).toBeGreaterThanOrEqual(MIN_KEYED_METAS);
  });

  runIt('the resolver reads far fewer bytes than the transcripts hold', () => {
    // Head/tail across all 270 sidecars measured 15.1 MB against 169.0 MB for a
    // full read. A ratio, never either figure.
    const parents = new Set<string>();
    const keys = new Map<string, Set<string>>();
    for (const entry of corpusMetas()) {
      const parent = parentOf(entry.metaPath);
      if (parent === undefined || entry.meta.toolUseId === undefined) continue;
      parents.add(parent);
      keys.set(parent, (keys.get(parent) ?? new Set()).add(entry.meta.toolUseId));
    }

    let descriptors = 0;
    let bytes = 0;
    const reader = createArchiveReader();
    const counting = {
      read: (path: string, offset: number, length: number) => {
        const buf = reader.read(path, offset, length);
        bytes += buf.length;
        return buf;
      },
      size: (path: string) => reader.size(path),
      stats: () => reader.stats(),
    };

    let total = 0;
    for (const parent of parents) {
      const found = readSidecars(parent, parent, keys.get(parent)!, counting);
      descriptors += found.length;
      for (const entry of found) total += entry.size;
    }

    expect(descriptors).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(total);
    console.log(
      `[diagnostic] ${descriptors} descriptors resolved from ${bytes} bytes read ` +
        `against ${total} bytes of transcript`,
    );
  });

  runIt('no sidecar span equals the elapsed gap it replaces', () => {
    // Measured 0 of 257. The task file's "no emitted span equals 156 ms" is
    // FALSE as a literal — the gap ranges 40–3,263 ms — so this asserts the
    // property the founder ruled on, over the two stamps each span is built
    // from, and never either quoted figure.
    let compared = 0;
    const equal: string[] = [];
    const metas = corpusMetas();
    const byAgentId = transcriptsByAgentId(metas);

    for (const entry of metas) {
      const spawner = spawnerOf(entry, byAgentId);
      if (spawner === undefined || entry.meta.toolUseId === undefined) continue;

      const span = endStamps(entry.transcript);
      const gap = launchGap(spawner, entry.meta.toolUseId);
      if (span === undefined || gap === undefined) continue;

      if (span === gap) equal.push(entry.transcript);
      compared += 1;
    }

    expect(equal).toStrictEqual([]);
    expect(compared).toBeGreaterThan(0);
    console.log(`[diagnostic] ${compared} spans compared against their own launch gap`);
  });
});
