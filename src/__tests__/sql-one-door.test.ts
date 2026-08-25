// AC1's other half: **zero SQL outside `src/db/`**. That invariant is stated at
// `db/index.ts:18` ("the ONLY module that touches SQL") and, until this file, was
// a comment and nothing else — grepped `src/*.test.ts` and `src/__tests__/`, no
// test enforced it. The route layer stays thin enough to be worth testing only
// while it holds.
//
// Sibling of `one-door.test.ts` and deliberately the same shape: a text grep, a
// quarantine keyed by FILE, and non-vacuity controls that drive the same helpers
// the real assertions call.
//
// ★ MULTI-WORD PATTERNS ONLY, AND THE SET IS NOT PROSE-PROOF. Bare keywords are
// unusable — `schema.ts:50` says "Claude Code DELETES this" in English. Even the
// calibrated set below matches prose: `ROLLBACK` hits three comments in
// `ingest.ts` (`:42`, `:206`, `:319`). That is fine and must not be "fixed",
// because the quarantine is keyed on the FILE, which is the granularity the
// allowlist needs. Do NOT claim every hit is real SQL.
//
// MEASURED on `task-4.2-db-read-layer`: 17 hits outside `src/db/`, all in the one
// quarantined file; 212 inside it. The floor below is 100, not 212, so landing a
// new query in `src/db/` never reds this.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The door. Every pattern is multi-word or punctuated; none is a bare verb. */
const SQL_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ['SELECT', /\bSELECT\s/],
  ['INSERT INTO', /\bINSERT INTO\b/],
  ['INSERT OR REPLACE', /\bINSERT OR REPLACE\b/],
  ['UPDATE SET', /\bUPDATE\s+\w+\s+SET\b/],
  ['DELETE FROM', /\bDELETE FROM\b/],
  ['CREATE', /\bCREATE (TABLE|INDEX|UNIQUE|VIRTUAL)\b/],
  ['DROP', /\bDROP (TABLE|INDEX)\b/],
  ['GROUP BY', /\bGROUP BY\b/],
  ['ORDER BY', /\bORDER BY\b/],
  ['JOIN', /\b(LEFT|INNER|CROSS) JOIN\b/],
  ['PRAGMA', /\bPRAGMA\s+\w+/],
  ['MATCH ?', /\bMATCH \?/],
  ['SAVEPOINT', /\bSAVEPOINT\s/],
  ['RELEASE', /\bRELEASE\s/],
  ['ROLLBACK', /\bROLLBACK\b/],
  ['BEGIN', /'BEGIN'/],
]);

interface Hit {
  file: string;
  pattern: string;
  line: number;
  text: string;
}

/** A whole module quarantined by path until Task 4.5 deletes it. */
interface LegacyEntry {
  file: string;
  why: string;
}

// Keyed on the FILE, never on line numbers — they move. This file is on Task
// 4.5's published deletion list, so the stale check below fires the moment 4.5
// deletes it and the quarantine dismantles itself.
const LEGACY_SQL: readonly LegacyEntry[] = [
  {
    file: 'server/ingest.ts',
    why: 'the /api/ingest transaction verbs (TXN_TOP/TXN_NESTED/TXN_ROLLUP) plus three prose comments about them. RFC 002 closes the hook path; Task 4.5 deletes this module with the route (task-4.5-cutover.md:19).',
  },
];

/** Every non-test `.ts` under `src/`, OUTSIDE the one SQL door. */
function sourceFiles(): string[] {
  return allFiles().filter((name) => !name.startsWith('db/'));
}

/** The same tree, unfiltered — `dbFiles` is what the non-vacuity floor counts. */
function allFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.split('\\').join('/'))
    .filter((name) => !name.endsWith('.test.ts') && !name.includes('__tests__/'))
    .sort();
}

function dbFiles(): string[] {
  return allFiles().filter((name) => name.startsWith('db/'));
}

/**
 * Every SQL-shaped line in `file`, one hit per matching line per pattern.
 * `text` is defaulted rather than read inline so a control can feed the scanner
 * a fixture without touching disk — `one-door.test.ts:317-321`'s reason exactly.
 */
function scanFile(file: string, text = readFileSync(join(SRC_DIR, file), 'utf8')): Hit[] {
  const lines = text.split('\n');
  const hits: Hit[] = [];
  for (const [pattern, regex] of SQL_PATTERNS) {
    for (const [index, line] of lines.entries()) {
      if (!regex.test(line)) continue;
      hits.push({ file, pattern, line: index + 1, text: line.trim() });
    }
  }
  return hits;
}

function scanAll(files: readonly string[] = sourceFiles()): Hit[] {
  return files.flatMap((file) => scanFile(file));
}

function describeHit(hit: Hit): string {
  return `${hit.file}:${hit.line}:${hit.pattern} — ${hit.text}`;
}

/** Unreviewed SQL, plus the rot direction of the quarantine. */
function unreviewed(
  hits: readonly Hit[] = scanAll(),
  legacy: readonly LegacyEntry[] = LEGACY_SQL,
): { unexpected: string[]; staleLegacy: string[] } {
  const quarantined = new Set(legacy.map((entry) => entry.file));
  return {
    unexpected: hits
      .filter((hit) => !quarantined.has(hit.file))
      .map(describeHit)
      .sort(),
    staleLegacy: legacy
      .filter((entry) => !hits.some((hit) => hit.file === entry.file))
      .map((entry) => entry.file)
      .sort(),
  };
}

describe('AC1 — src/db is the only module that touches SQL', () => {
  it('finds no SQL outside src/db/', () => {
    const { unexpected, staleLegacy } = unreviewed();

    expect(
      unexpected,
      'SQL outside src/db/. The one legal response is to move the query into a ' +
        'src/db/ module and export a typed reader — db/read.ts for a SELECT, ' +
        'db/write.ts for anything else. Never add a file to LEGACY_SQL.',
    ).toEqual([]);

    expect(
      staleLegacy,
      'task 4.5 deleted this — delete the quarantine entry. LEGACY_SQL only ever shrinks.',
    ).toEqual([]);
  });

  it('every quarantine entry carries a written reason', () => {
    for (const entry of LEGACY_SQL) {
      expect(entry.why.length, `${entry.file} needs a justification`).toBeGreaterThan(0);
    }
  });
});

describe('the door reds when the property it protects is broken', () => {
  const SCRATCH = 'scratch/planted.ts';

  // Controls drive the same helpers the real assertions call. Re-deriving the
  // comparison inline would prove nothing: softening a real body would leave an
  // inline control green.

  it('(a) the scan reaches a real tree', () => {
    expect(sourceFiles().length).toBeGreaterThan(20);

    // Every quarantined file is reachable, so a filter that quietly dropped one
    // would red here instead of passing vacuously.
    const scanned = new Set(sourceFiles());
    for (const entry of LEGACY_SQL) {
      expect(scanned.has(entry.file), `${entry.file} is quarantined but never scanned`).toBe(true);
    }
  });

  it('(b) the same patterns find ≥ 100 hits INSIDE src/db/', () => {
    // ★ The limb that catches a pattern set accidentally softened to match
    // nothing — without it every assertion above is trivially green. A FLOOR,
    // never today's number (212), so a new query in src/db/ never reds this.
    expect(scanAll(dbFiles()).length).toBeGreaterThanOrEqual(100);
    expect(dbFiles().length).toBeGreaterThan(3);
    expect(scanFile('db/read.ts').length).toBeGreaterThan(0);
  });

  it('(c) planted SQL reds, and the same text without it greens', () => {
    const planted = scanFile(SCRATCH, 'const q = `SELECT id FROM sessions`;\n');
    const { unexpected } = unreviewed(planted);

    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toContain(`${SCRATCH}:1:SELECT`);

    expect(unreviewed(scanFile(SCRATCH, 'const q = 1;\n')).unexpected).toEqual([]);
  });

  it('each pattern reds on its own', () => {
    const samples: [string, string][] = [
      ['SELECT', 'db.prepare(`SELECT id FROM sessions`)'],
      ['INSERT INTO', 'db.exec(`INSERT INTO events (id) VALUES (?)`)'],
      ['INSERT OR REPLACE', 'db.exec(`INSERT OR REPLACE INTO meta VALUES (?,?)`)'],
      ['UPDATE SET', 'db.exec(`UPDATE sessions SET title = ?`)'],
      ['DELETE FROM', 'db.exec(`DELETE FROM turns WHERE id = ?`)'],
      ['CREATE', 'db.exec(`CREATE TABLE t (a)`)'],
      ['DROP', 'db.exec(`DROP INDEX idx_x`)'],
      ['GROUP BY', 'const s = `... GROUP BY project_path`'],
      ['ORDER BY', 'const s = `... ORDER BY seq`'],
      ['JOIN', 'const s = `... LEFT JOIN sessions s ON s.id = e.session_id`'],
      ['PRAGMA', 'db.exec(`PRAGMA journal_mode = WAL`)'],
      ['MATCH ?', 'const s = `WHERE events_fts MATCH ?`'],
      ['SAVEPOINT', "db.exec('SAVEPOINT x')"],
      ['RELEASE', "db.exec('RELEASE x')"],
      ['ROLLBACK', "db.exec('ROLLBACK')"],
      ['BEGIN', "db.exec('BEGIN')"],
    ];
    expect(samples).toHaveLength(SQL_PATTERNS.size);

    for (const [pattern, line] of samples) {
      const hits = scanFile(SCRATCH, `${line}\n`);
      expect(
        hits.map((hit) => hit.pattern),
        `${pattern} did not red`,
      ).toContain(pattern);
    }
  });

  it('prose that merely names a table or a verb does not red', () => {
    // The calibration that makes a multi-word set usable where a bare-keyword
    // set is not. `\bDELETE\b` alone would red on the DDL's own provenance.
    expect(scanFile(SCRATCH, '// Claude Code DELETES this after 41 days\n')).toEqual([]);
    expect(scanFile(SCRATCH, '// the update path writes a sessions row\n')).toEqual([]);
    expect(scanFile(SCRATCH, 'const selected = rows.filter(Boolean);\n')).toEqual([]);
  });

  it('src/db/ is exempt by directory, and one directory up is not', () => {
    const text = 'const q = `SELECT id FROM sessions`;\n';
    expect(unreviewed(scanFile('server/elsewhere.ts', text)).unexpected).toHaveLength(1);
    expect(sourceFiles().filter((file) => file.startsWith('db/'))).toEqual([]);

    // …and the exemption removes REAL matches rather than being vacuous.
    expect(scanFile('db/write.ts').length).toBeGreaterThan(0);
  });

  it('a stale quarantine reds — the coverage-restoration hook for 4.5', () => {
    const hits = scanFile(SCRATCH, 'const q = `SELECT 1`;\n');

    expect(unreviewed(hits, [{ file: 'server/ingest.ts', why: 'control' }]).staleLegacy).toEqual([
      'server/ingest.ts',
    ]);
    expect(unreviewed(hits, [{ file: SCRATCH, why: 'control' }]).staleLegacy).toEqual([]);
  });

  it('test files are out of scope, both ways', () => {
    const files = sourceFiles();
    expect(files.filter((file) => file.endsWith('.test.ts'))).toEqual([]);
    expect(files.filter((file) => file.includes('__tests__/'))).toEqual([]);
    expect(files.filter((file) => file.endsWith('.d.ts'))).toEqual([]);

    // This guard lives at src/__tests__/, so the filter above already removes
    // it — which is what lets the controls above hold SQL fixtures at all.
    expect(files.filter((file) => file.includes('sql-one-door'))).toEqual([]);
  });
});
