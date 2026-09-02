// The drift tally, and NOTHING that reaches the wire. Moved out of `api.ts`
// verbatim (and re-exported from there, so every existing import still resolves)
// for one reason: `api.ts:16` imports `hono/streaming` at RUNTIME, so a caller
// that wants only this function loads the whole HTTP stack to get it.
// `agent-lens doctor` is that caller — a command with no server and no socket —
// and Hono has no business in it.
//
// NO SQL and no `DatabaseSync`: this maps rows `db/read.ts` already selected.

import type { DriftRow } from '../db/read.js';

/** `drift_json` as `transcript/drift.ts:99` serializes it — a superset of `DriftCounts`. */
export interface RawDrift {
  unknown_line_types?: Record<string, number>;
  unknown_block_types?: Record<string, number>;
  unknown_top_level_fields?: Record<string, number>;
  unjoined_tool_uses?: number;
  unresolved_spills?: number;
  sidecar_agent_id_mismatch?: number;
}

export interface DriftSession {
  id: string;
  title: string | null;
  harness_version: string | null;
  counts: RawDrift;
}

/** The `/api/drift` body minus the two version stamps, which come from `meta`. */
export interface DriftReport {
  harness_versions: Record<string, number>;
  unknown_line_types: Record<string, number>;
  unknown_block_types: Record<string, number>;
  unknown_top_level_fields: Record<string, number>;
  unjoined_tool_uses: number;
  unresolved_spills: number;
  sessions_with_drift: DriftSession[];
}

/** A clean session serializes to exactly this (`transcript/drift.ts:90`). */
const NO_DRIFT = '{}';

function mergeBucket(into: Record<string, number>, from: Record<string, number> | undefined): void {
  for (const [key, n] of Object.entries(from ?? {})) into[key] = (into[key] ?? 0) + n;
}

/**
 * Tally every PROJECTED session by harness version, and every DRIFTING one into
 * the buckets, so a Claude Code release that changes the format shows up as one
 * number going 0 -> N against a population that says how big the check was.
 *
 * ★ THE AGGREGATION LIVES HERE, NOT IN THE READER. `data-model-v2.md:305-308`
 * pins the DETAIL response's `drift` at the four keys of `DriftCounts`, while
 * this report needs two more (`unknown_top_level_fields`,
 * `sidecar_agent_id_mismatch`). Widening `parseDrift` would change both, so the
 * extra keys are parsed off the raw text `readDriftRows` returns verbatim —
 * which `read.ts:206` already names as the design.
 *
 * ★ `harness_versions` IS THE CENSUS, NOT THE NUMERATOR. It counts every
 * projected session, clean or not, because `{}` is indistinguishable from a
 * broken endpoint and "0 drifting of 293 projected on 2.1.212" is not. The
 * 0 -> N signal lives in `sessions_with_drift`, which is `[]` on a clean corpus.
 * The cost is per-version attribution: a version's census number moves whether
 * or not it drifted, so `sessions_with_drift[].harness_version` is the only
 * carrier left for "which release did this".
 *
 * Clean rows leave at the writer's own marker, the same test `has_drift` uses,
 * so they reach no bucket and no scalar. Per-session `counts` carry the raw
 * object, extra keys included.
 *
 * ★ THE POPULATION COUNTS SIDECARS, unlike the session list. `readDriftRows`
 * omits the list's `TOP_LEVEL_ONLY` filter (`db/read.ts:614-621`) and keeps it:
 * a sub-agent transcript is a transcript, and drift in one is drift. So this is
 * a count of projected SESSIONS, not of conversations, and it will not match
 * `/api/sessions` — measured 272 of 293 ready rows are children.
 */
export function aggregateDrift(rows: readonly DriftRow[]): DriftReport {
  const report: DriftReport = {
    harness_versions: {},
    unknown_line_types: {},
    unknown_block_types: {},
    unknown_top_level_fields: {},
    unjoined_tool_uses: 0,
    unresolved_spills: 0,
    sessions_with_drift: [],
  };

  for (const row of rows) {
    const version = row.harness_version ?? 'unknown';
    report.harness_versions[version] = (report.harness_versions[version] ?? 0) + 1;

    if (row.drift_json === NO_DRIFT) continue;
    const counts = JSON.parse(row.drift_json) as RawDrift;
    mergeBucket(report.unknown_line_types, counts.unknown_line_types);
    mergeBucket(report.unknown_block_types, counts.unknown_block_types);
    mergeBucket(report.unknown_top_level_fields, counts.unknown_top_level_fields);
    report.unjoined_tool_uses += counts.unjoined_tool_uses ?? 0;
    report.unresolved_spills += counts.unresolved_spills ?? 0;
    report.sessions_with_drift.push({
      id: row.id,
      title: row.title,
      harness_version: row.harness_version,
      counts,
    });
  }
  return report;
}
