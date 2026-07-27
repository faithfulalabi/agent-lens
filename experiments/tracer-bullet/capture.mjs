// Capture harness — snapshot everything a scratch Claude Code session produced
// into <repo>/fixtures/raw/<exp>/ so it can be scrubbed and promoted to a
// golden fixture. Sources snapshotted:
//   1. raw_events rows from the collector DB (the archived envelopes)
//   2. the spool dir (any envelopes the adapter could not POST)
//   3. the parent transcript + any sub-agent transcripts and their .meta.json
//   4. the session's tool-results/ sidecars (full pre-cap tool output)
//   5. a manifest.json binding the set together (session, versions, path_map)
//
// Output lands under fixtures/raw/ which is git-ignored — the un-scrubbed data
// can never be committed. Run scrub.mjs to promote to fixtures/scrubbed/.
//
// Run: node capture.mjs --exp subagent --session <id> --data-dir "$AGENT_LENS_DIR" \
//        --transcript "<parent.jsonl>" [--subagent-dir "<session-dir>/subagents"] \
//        [--tool-results-dir "<session-dir>/tool-results"] [--claude-version 2.1.197]
// Importable: `import { selectSessionRows, buildManifest } from "./capture.mjs"`.

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { parseArgs } from './scrub.mjs';

/** Sub-agent sidecars worth carrying: the transcript and its toolUseId join. */
const SUBAGENT_SUFFIXES = ['.jsonl', '.meta.json'];

/**
 * Read all raw_events rows for a session (or every row when sessionId is
 * omitted), newest-schema-agnostic: selects the columns the Phase-1 schema
 * defines. Pure w.r.t. the injected db so it is unit-testable.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [sessionId]
 * @returns {Array<Record<string, unknown>>}
 */
export function selectSessionRows(db, sessionId) {
  if (sessionId) {
    return db
      .prepare(
        'SELECT id, session_id, source, hook_name, received_at, status, raw FROM raw_events WHERE session_id = ? ORDER BY received_at',
      )
      .all(sessionId);
  }
  return db
    .prepare(
      'SELECT id, session_id, source, hook_name, received_at, status, raw FROM raw_events ORDER BY received_at',
    )
    .all();
}

/**
 * Reconstruct the committed envelope shape from an archived raw_events row.
 *
 * Adopts the shape check from `src/capture/reprocess.ts:76` — but where the
 * product code falls back to rebuilding from the row's columns (it must heal
 * old rows), a fixture capture must NOT. `raw` held only `raw_payload` before
 * Task 2.3 (`062cc6a:src/db/index.ts:53`), and a rebuilt-from-columns envelope
 * is not what the session actually emitted. Silently accepting one produces
 * fixtures that 400 at /api/ingest and fail AC4 — discovered in Phase 2, weeks
 * later. So this throws, loudly, at capture time.
 *
 * @param {{id: string, raw: string}} row
 * @returns {Record<string, unknown>}
 */
export function rowToEnvelope(row) {
  const parsed = JSON.parse(row.raw);
  if (parsed !== null && typeof parsed === 'object' && typeof parsed.event_id === 'string') {
    return parsed;
  }
  throw new Error(
    `raw_events row ${row.id} does not hold a full envelope (no string event_id). ` +
      'The collector that wrote it predates Task 2.3, which changed src/db/index.ts to ' +
      'store the whole envelope instead of just raw_payload. Rebuild (npm run build), ' +
      'restart the collector, and re-capture — fixtures from this row would 400 at /api/ingest.',
  );
}

/** Absolute path to the repo root, derived from this file — never from cwd. */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Where an experiment's un-scrubbed capture lands. Anchored to the repo, not
 * `process.cwd()`: the runbook tells the operator to `cd scratch-project`, and
 * a cwd-relative outDir put Task 1.5's real capture at
 * `experiments/tracer-bullet/scratch-project/fixtures/raw/<exp>` — a path the
 * old root-anchored `.gitignore` entry did not cover. Belt to `.gitignore`'s
 * braces; both are asserted by tests.
 *
 * @param {string} exp
 * @returns {string}
 */
export function rawOutDir(exp) {
  return join(repoRoot(), 'fixtures', 'raw', exp);
}

/**
 * Build the fixture set's manifest. Minimal by design — the fields Phase 2-4
 * genuinely cannot reconstruct from the data files themselves.
 *
 * `path_map` is the important one: it maps each captured absolute path, exactly
 * as that string appears inside the envelopes, to its fixture-relative file.
 * Phase 3's tailer tests resolve a `transcript_path` that no longer exists on
 * the machine running them, and cannot do it without this. The keys are written
 * un-anonymized here on purpose — scrub.mjs then rewrites manifest.json and
 * envelopes.jsonl with the same rules, so the two sides stay joinable.
 *
 * Deterministic and key-sorted so a re-capture of the same session produces a
 * byte-identical manifest.
 *
 * @param {{exp:string, sessionId:string, envelopes:Array<{hook_name?:string}>,
 *          pathMap:Record<string,string>, claudeCodeVersion?:string, nodeVersion?:string}} input
 */
export function buildManifest({
  exp,
  sessionId,
  envelopes,
  pathMap,
  claudeCodeVersion,
  nodeVersion,
}) {
  const hookCounts = {};
  for (const envelope of envelopes) {
    const name = envelope.hook_name ?? 'unknown';
    hookCounts[name] = (hookCounts[name] ?? 0) + 1;
  }
  return {
    exp,
    session_id: sessionId,
    claude_code_version: claudeCodeVersion ?? 'unknown',
    node_version: nodeVersion ?? process.version,
    hook_counts: sortKeys(hookCounts),
    path_map: sortKeys(pathMap),
  };
}

/** Rebuild an object with its keys in sorted order (JSON.stringify honors it). */
function sortKeys(source) {
  return Object.fromEntries(Object.entries(source).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Copy `src` to `<outDir>/<relDest>`, recording the path_map entry. */
function snapshot(src, outDir, relDest, pathMap) {
  const dest = join(outDir, relDest);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  pathMap[src] = relDest;
}

/** CLI entry: snapshot DB rows, spool, transcripts, tool-results, manifest. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const exp = args.exp;
  const session = args.session;
  const dataDir = args['data-dir'] ?? process.env.AGENT_LENS_DIR;
  if (!exp || !dataDir || !session) {
    // --session is mandatory: without it selectSessionRows dumps EVERY row in
    // the DB, which is how Task 1.5's four experiments ended up muddled into
    // one reused session (findings :349-354).
    process.stderr.write(
      'usage: capture.mjs --exp <name> --session <id> --data-dir <dir> \\\n' +
        '         [--transcript <parent.jsonl>] [--transcripts a,b] \\\n' +
        '         [--subagent-dir <dir>] [--tool-results-dir <dir>] [--claude-version v]\n',
    );
    process.exitCode = 2;
    return;
  }

  const outDir = rawOutDir(exp);
  mkdirSync(join(outDir, 'transcripts'), { recursive: true });
  const pathMap = {};
  let envelopes = [];

  // 1. DB rows -> envelopes.jsonl (spool-file format; see src/capture/spool.ts:41)
  const dbPath = join(dataDir, 'agent-lens.db');
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      envelopes = selectSessionRows(db, session).map(rowToEnvelope);
    } catch (err) {
      // A stack trace buries the one line the operator needs to act on.
      process.stderr.write(`capture: ${err.message}\n`);
      process.exitCode = 1;
      return;
    } finally {
      db.close();
    }
    const lines = envelopes.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(join(outDir, 'envelopes.jsonl'), envelopes.length > 0 ? `${lines}\n` : '');
  } else {
    process.stderr.write(`capture: WARNING no collector DB at ${dbPath} — no envelopes captured\n`);
  }

  // 2. Spool dir snapshot (undelivered envelopes)
  const spool = join(dataDir, 'spool');
  if (existsSync(spool)) {
    for (const name of readdirSync(spool)) {
      copyFileSync(join(spool, name), join(outDir, `spool-${name}`));
    }
  }

  // 3. Parent transcript -> transcripts/parent.jsonl (fixed name; the layout
  //    contract 2.6/3.x code against), plus any extra transcripts by basename.
  if (args.transcript && existsSync(args.transcript)) {
    snapshot(args.transcript, outDir, join('transcripts', 'parent.jsonl'), pathMap);
  }
  for (const t of (args.transcripts ?? '').split(',').map((s) => s.trim())) {
    if (t && existsSync(t)) snapshot(t, outDir, join('transcripts', basename(t)), pathMap);
  }

  // 4. Sub-agent transcripts + their .meta.json (the toolUseId join 4.2/4.3
  //    parent on; SubagentStop is unreliable — findings :339-344).
  const subagentDir = args['subagent-dir'];
  if (subagentDir && existsSync(subagentDir)) {
    for (const name of readdirSync(subagentDir)) {
      if (!SUBAGENT_SUFFIXES.some((s) => name.endsWith(s))) continue;
      snapshot(join(subagentDir, name), outDir, join('transcripts', 'subagents', name), pathMap);
    }
  }

  // 5. tool-results/ sidecars. Task 1.6 decision #1 said output above 30KB was
  //    unrecoverable; that was false — Claude Code persists the complete output
  //    here and points at it from the transcript. Without these the restored
  //    Phase-3 backfill work would ship with no golden test.
  const toolResultsDir = args['tool-results-dir'];
  if (toolResultsDir && existsSync(toolResultsDir)) {
    for (const name of readdirSync(toolResultsDir)) {
      snapshot(join(toolResultsDir, name), outDir, join('tool-results', name), pathMap);
    }
  }

  // 6. Manifest
  const manifest = buildManifest({
    exp,
    sessionId: session,
    envelopes,
    pathMap,
    claudeCodeVersion: args['claude-version'],
  });
  // 2-space + trailing newline is byte-identical to what `prettier --write .`
  // (package.json:24's format script) produces for JSON, so the one .json in a
  // fixture set survives a repo-wide format untouched and needs no
  // .prettierignore. `.jsonl` is invisible to Prettier entirely
  // (`--file-info` reports `inferredParser: null`).
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `captured experiment "${exp}" session ${session} -> ${outDir} (git-ignored raw)\n` +
      `  envelopes: ${envelopes.length}  files mapped: ${Object.keys(pathMap).length}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
