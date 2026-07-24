// Q7 probe — Is FTS5 compiled into node:sqlite on this runtime?
//
// This is the ONE tracer-bullet question that is fully answerable by code
// alone: no Claude Code session required. It creates an FTS5 virtual table,
// inserts a row, runs a MATCH query, and records a definitive PASS/FAIL plus
// the node + sqlite versions for provenance. If FTS5 is absent, Phase-3/7
// search must fall back (better-sqlite3 or a hand-rolled index) — a plan-level
// decision escalated to Task 1.6.
//
// Run: node experiments/tracer-bullet/fts5-probe.mjs
// Importable: `import { runFts5Probe } from "./fts5-probe.mjs"` for tests.

import { DatabaseSync } from 'node:sqlite';
import process from 'node:process';

/**
 * Exercise FTS5 against a live node:sqlite database. Pure w.r.t. the injected
 * db: creates a virtual table, inserts one row, and verifies MATCH round-trips.
 * Returns a definitive verdict object; never throws (SQL errors become FAIL).
 *
 * @param {import('node:sqlite').DatabaseSync} db - an open database handle.
 * @returns {{ verdict: 'PASS' | 'FAIL', detail: string, sqlite: string }}
 */
export function runFts5Probe(db) {
  let sqlite = 'unknown';
  try {
    sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
  } catch {
    // Version read is best-effort; a failure here does not decide the verdict.
  }

  try {
    db.exec('CREATE VIRTUAL TABLE probe_fts USING fts5(body)');
    db.prepare('INSERT INTO probe_fts(body) VALUES (?)').run('hello world agent lens tracing');
    const row = db.prepare('SELECT body FROM probe_fts WHERE probe_fts MATCH ?').get('agent');
    if (row && typeof row.body === 'string' && row.body.includes('agent')) {
      return {
        verdict: 'PASS',
        detail: 'FTS5 virtual table created and MATCH returned the indexed row',
        sqlite,
      };
    }
    return {
      verdict: 'FAIL',
      detail: 'FTS5 vtable created but MATCH returned no matching row',
      sqlite,
    };
  } catch (err) {
    return { verdict: 'FAIL', detail: err.message, sqlite };
  }
}

/** CLI entry: open an in-memory db, run the probe, print JSON, exit 0/1. */
function main() {
  const db = new DatabaseSync(':memory:');
  try {
    const probe = runFts5Probe(db);
    const report = {
      question: 'Q7: FTS5 present in node:sqlite',
      node: process.versions.node,
      sqlite: probe.sqlite,
      verdict: probe.verdict,
      detail: probe.detail,
      capturedAt: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = probe.verdict === 'PASS' ? 0 : 1;
  } finally {
    db.close();
  }
}

// Only run the CLI when invoked directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
