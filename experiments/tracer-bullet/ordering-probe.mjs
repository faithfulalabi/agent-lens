// Q6 probe — does `async: true` preserve hook-arrival ordering, or can hooks
// land out of order at the collector? This builds the comparison table the
// findings doc needs: for a captured session, it pairs each hook envelope's
// COLLECTOR arrival order (raw_events.received_at / spans_lite.seq) against the
// LOGICAL order implied by the transcript (turn/line sequence). Any inversion
// is evidence that `async:true` is fire-and-forget with no arrival-order
// guarantee — which Phase 2's normalizer must tolerate (sort by a stable key,
// never trust arrival seq for causality).
//
// This probe is data-driven: it needs a real captured session to produce a
// verdict. The pure `detectInversions` core is unit-testable with synthetic
// input; the CLI wires it to a live capture.
//
// Run: node ordering-probe.mjs --data-dir "$AGENT_LENS_DIR" --session <id>
// Importable: `import { detectInversions } from "./ordering-probe.mjs"`.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Given events already ordered by COLLECTOR arrival (seq ascending), each
 * carrying a `logical` index (its position in transcript/turn order), count how
 * many arrive out of logical order. Zero inversions => arrival order matched
 * logical order for this run. Pure and deterministic.
 *
 * @param {Array<{event_id:string, seq:number, logical:number}>} arrivals
 * @returns {{inversions:number, pairs:Array<{event_id:string, seq:number, logical:number}>}}
 */
export function detectInversions(arrivals) {
  let maxLogical = -Infinity;
  let inversions = 0;
  const pairs = [];
  for (const ev of arrivals) {
    if (ev.logical < maxLogical) {
      inversions += 1;
      pairs.push(ev);
    } else {
      maxLogical = ev.logical;
    }
  }
  return { inversions, pairs };
}

/** Parse `--flag value` pairs into a map. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (key?.startsWith('--')) args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

/** CLI entry: read arrival order from the collector DB and report inversions. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args['data-dir'] ?? process.env.AGENT_LENS_DIR;
  if (!dataDir || !args.session) {
    process.stderr.write('usage: ordering-probe.mjs --data-dir <dir> --session <id>\n');
    process.exitCode = 2;
    return;
  }
  const dbPath = join(dataDir, 'agent-lens.db');
  if (!existsSync(dbPath)) {
    process.stderr.write(`no collector db at ${dbPath}; run a session first\n`);
    process.exitCode = 1;
    return;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT seq, event_id, ts FROM spans_lite WHERE session_id = ? ORDER BY seq')
      .all(args.session);
    // Logical order = sort by the envelope ts (transcript/turn time); arrival
    // order = seq. A stable ts sort gives the intended logical sequence.
    const byTs = [...rows].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const logicalIndex = new Map(byTs.map((r, i) => [r.event_id, i]));
    const arrivals = rows.map((r) => ({
      event_id: r.event_id,
      seq: r.seq,
      logical: logicalIndex.get(r.event_id),
    }));
    const { inversions, pairs } = detectInversions(arrivals);
    const report = {
      question: 'Q6: async:true ordering',
      session: args.session,
      events: rows.length,
      inversions,
      verdict:
        rows.length === 0
          ? 'inconclusive (no events captured)'
          : inversions === 0
            ? 'arrival order matched logical order for this run (single run — not a guarantee)'
            : `${inversions} inversion(s) observed — arrival order is NOT reliable`,
      invertedEvents: pairs,
      capturedAt: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
