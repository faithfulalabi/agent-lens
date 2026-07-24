// Capture harness — snapshot everything a scratch Claude Code session produced
// into fixtures/raw/<exp>/ so it can be scrubbed and promoted to a golden
// fixture. Sources snapshotted:
//   1. raw_events rows from the collector DB (the archived envelopes)
//   2. the spool dir (any envelopes the adapter could not POST)
//   3. touched transcript JSONL files (parent + any agent_transcript_path)
// Output lands under fixtures/raw/ which is git-ignored — the un-scrubbed data
// can never be committed. Run scrub.mjs to promote to fixtures/scrubbed/.
//
// Run: node capture.mjs --exp subagent --data-dir "$AGENT_LENS_DIR" \
//        --transcripts "/path/a.jsonl,/path/b.jsonl"
// Importable: `import { selectSessionRows } from "./capture.mjs"`.

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import process from 'node:process';

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

/** Reconstruct the committed envelope shape from an archived raw_events row. */
export function rowToEnvelope(row) {
  return JSON.parse(row.raw);
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

/** CLI entry: snapshot DB rows, spool files, and transcripts for one experiment. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const exp = args.exp;
  const dataDir = args['data-dir'] ?? process.env.AGENT_LENS_DIR;
  if (!exp || !dataDir) {
    process.stderr.write(
      'usage: capture.mjs --exp <name> --data-dir <dir> [--session id] [--transcripts a,b]\n',
    );
    process.exitCode = 2;
    return;
  }

  const outDir = join(process.cwd(), 'fixtures', 'raw', exp);
  mkdirSync(join(outDir, 'transcripts'), { recursive: true });

  // 1. DB rows -> envelopes.jsonl
  const dbPath = join(dataDir, 'agent-lens.db');
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = selectSessionRows(db, args.session);
      const lines = rows.map((r) => JSON.stringify(rowToEnvelope(r))).join('\n');
      writeFileSync(join(outDir, 'envelopes.jsonl'), `${lines}\n`);
    } finally {
      db.close();
    }
  }

  // 2. Spool dir snapshot (undelivered envelopes)
  const spool = join(dataDir, 'spool');
  if (existsSync(spool)) {
    for (const name of readdirSync(spool)) {
      copyFileSync(join(spool, name), join(outDir, `spool-${name}`));
    }
  }

  // 3. Touched transcripts (parent + sub-agent), verbatim
  const transcripts = (args.transcripts ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const t of transcripts) {
    if (existsSync(t)) {
      copyFileSync(t, join(outDir, 'transcripts', basename(t)));
    }
  }

  process.stdout.write(`captured experiment "${exp}" -> ${outDir} (git-ignored raw)\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
