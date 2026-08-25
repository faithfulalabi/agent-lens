// AC2/AC3: the `EXPLAIN QUERY PLAN` suite for the session list, and the mutation
// controls that prove each assertion is load-bearing. Split from `read.test.ts`
// because this is the criterion the list-performance bet is either kept or
// silently lost by, and it should be readable on its own.
//
// ★ NO ASSERTION HERE COMPARES A WHOLE PLAN ROW BY EQUALITY. `EXPLAIN QUERY
// PLAN` output is NOT part of SQLite's compatibility contract — 3.36 changed
// `SCAN TABLE x USING INDEX y` to `SCAN x USING INDEX y` — and `package.json:7-9`
// declares `"node": ">=24"`, so CI may bundle a different SQLite than the 3.53.1
// these were measured on. What is asserted instead: the ROW COUNT, the INDEX
// NAME (ours, and it cannot drift), and the ABSENCE of the three degradation
// markers. `^(SCAN|SEARCH)\b` is the anchor; never `^SCAN TABLE`.
//
// ★ SQLite does NOT annotate partial-index use. `SCAN sessions USING INDEX
// idx_sessions_recent` is the same text a NON-partial index would produce, so no
// plan assertion can prove `WHERE parent_session_id IS NULL` is present. Test 8
// asserts it textually and Test 10 drops it to prove it is what buys the index.

import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEventPageSql,
  buildProjectsSql,
  buildSessionListSql,
  readSessionList,
  type SessionListQuery,
  type SqlQuery,
} from '../read.js';
import { openCache, seedSessionRow, seedSidecarRow } from './fixtures/index.js';

const READ_TS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'read.ts');

let db: DatabaseSync;

beforeEach(() => {
  db = openCache();
});

/** `EXPLAIN QUERY PLAN` detail strings for a builder-produced statement. */
function planOf(query: SqlQuery): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as unknown as {
      detail: string;
    }[]
  ).map((row) => row.detail);
}

const PAGE = { limit: 2, offset: 0 };

/** The two filter shapes that carry no `project` term. */
const NO_PROJECT: [string, SessionListQuery][] = [
  ['{}', { ...PAGE }],
  ['{q}', { ...PAGE, q: 'needle' }],
];

/** …and the two that do. */
const WITH_PROJECT: [string, SessionListQuery][] = [
  ['{project}', { ...PAGE, project: '/p' }],
  ['{project,q}', { ...PAGE, project: '/p', q: 'needle' }],
];

const ALL_SHAPES = [...NO_PROJECT, ...WITH_PROJECT];

/** The three markers that mean the single-indexed-pass bet was lost. */
const DEGRADED = /TEMP B-TREE|SUBQUERY|CORRELATED/;

/** Five top-level rows and four sidecars, the sidecars deliberately newer. */
function seedCorpus(): string[] {
  const parents = ['s1', 's2', 's3', 's4', 's5'];
  for (const [index, id] of parents.entries()) {
    seedSessionRow(db, {
      id,
      project_path: '/p',
      last_activity_at: `2026-08-0${index + 1}T09:00:00.000Z`,
    });
  }
  for (let n = 0; n < 4; n += 1) {
    seedSidecarRow(db, 's1', {
      id: `kid-${n}`,
      project_path: '/p',
      last_activity_at: '2026-09-01T09:00:00.000Z',
    });
  }
  return parents;
}

describe('AC2 — Test 7: the session list is one indexed pass at sort=recent', () => {
  it.each(ALL_SHAPES)('%s plans one row, no temp b-tree, no join, no aggregate', (_name, query) => {
    const built = buildSessionListSql(query);
    const plan = planOf(built);

    expect(plan).toHaveLength(1);
    const scans = plan.filter((detail) => /^(SCAN|SEARCH)\b/.test(detail));
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatch(/^(SCAN|SEARCH) sessions\b/);
    expect(plan.filter((detail) => DEGRADED.test(detail))).toHaveLength(0);
    expect(built.sql).not.toMatch(/\b(COUNT|SUM|AVG|GROUP BY|JOIN)\b/i);
  });
});

describe('AC2 — Test 7b: the non-project arm names idx_sessions_recent BY NAME', () => {
  // ★ THIS TEST EXISTS BECAUSE TEST 7 ALONE HAS A HOLE. Executed against the
  // real DDL, all three of these pass every assertion in Test 7 while destroying
  // the list-performance bet:
  //
  //   NOT INDEXED WHERE parent_session_id IS NULL  -> ['SCAN sessions']
  //   no ORDER BY                                  -> ['SCAN sessions USING INDEX idx_sessions_project']
  //   ORDER BY id DESC                             -> ['SCAN sessions USING INDEX sqlite_autoindex_sessions_1']
  //
  // The first is a full unindexed scan — exactly "the bet silently lost". The
  // third returns the wrong order and nothing else here would catch it.
  it.each(NO_PROJECT)('%s rides idx_sessions_recent', (_name, query) => {
    expect(planOf(buildSessionListSql(query))[0]).toMatch(/USING INDEX idx_sessions_recent/);
  });

  it('and sort=recent really orders by recency, newest first', () => {
    seedCorpus();
    expect(readSessionList(db, { limit: 10, offset: 0 }).items.map((row) => row.id)).toEqual([
      's5',
      's4',
      's3',
      's2',
      's1',
    ]);
    expect(
      readSessionList(db, { limit: 10, offset: 0, q: 'title' }).items.map((row) => row.id),
    ).toEqual(['s5', 's4', 's3', 's2', 's1']);
  });
});

describe('AC2 — Test 8: the partial predicate is textually present', () => {
  it.each(ALL_SHAPES)('%s carries WHERE parent_session_id IS NULL', (_name, query) => {
    // Necessary because SQLite reports no `(partial)` marker in the plan text.
    expect(buildSessionListSql(query).sql).toContain('parent_session_id IS NULL');
  });

  it('so does the projects aggregate — sidecars are out of that GROUP BY too', () => {
    expect(buildProjectsSql().sql).toContain('parent_session_id IS NULL');
  });
});

describe('AC2 — Test 10: dropping the partial predicate is a real, reproducible red', () => {
  /** The same statement with the partial predicate removed, and nothing else. */
  function withoutPartialPredicate(sql: string): string {
    const stripped = sql
      .replace('WHERE parent_session_id IS NULL AND ', 'WHERE ')
      .replace('WHERE parent_session_id IS NULL ', '');
    expect(stripped, 'the strip found nothing to remove').not.toBe(sql);
    return stripped;
  }

  it.each(ALL_SHAPES)('%s falls to a full scan plus a sort without it', (_name, query) => {
    const built = buildSessionListSql(query);
    const mutated = planOf({ sql: withoutPartialPredicate(built.sql), params: built.params });

    // Without the predicate the planner can use NEITHER partial index.
    expect(mutated.length).toBeGreaterThan(1);
    expect(mutated.filter((detail) => /TEMP B-TREE/.test(detail))).toHaveLength(1);
    expect(mutated.some((detail) => /USING INDEX idx_sessions_/.test(detail))).toBe(false);

    // …and the real statement is the clean one, so the control is not vacuous.
    expect(planOf(built)).toHaveLength(1);
  });
});

describe('AC2 — Test 11: the id tiebreaker costs no temp b-tree', () => {
  it('is in the statement and does not degrade the plan', () => {
    // `schema.ts:132-133` claims the v2 DDL fixed the plan-001 "no tiebreaker"
    // wart. Verified rather than trusted.
    for (const [, query] of ALL_SHAPES) {
      const built = buildSessionListSql(query);
      expect(built.sql).toContain('ORDER BY last_activity_at DESC, id DESC');
      expect(planOf(built).filter((detail) => DEGRADED.test(detail))).toHaveLength(0);
    }
  });
});

describe('AC2 — Test 12: the plans do not move under ANALYZE', () => {
  it('is identical before and after, so no CI flake rides on sqlite_stat1', () => {
    for (let n = 0; n < 500; n += 1) {
      seedSessionRow(db, {
        id: `bulk-${String(n).padStart(4, '0')}`,
        project_path: n % 3 === 0 ? '/p' : '/other',
        last_activity_at: `2026-08-14T09:${String(n % 60).padStart(2, '0')}:00.000Z`,
      });
    }

    const before = ALL_SHAPES.map(([, query]) => planOf(buildSessionListSql(query)));
    db.exec('ANALYZE');
    const after = ALL_SHAPES.map(([, query]) => planOf(buildSessionListSql(query)));

    expect(after).toEqual(before);
    expect(before.every((plan) => plan.length === 1)).toBe(true);
  });
});

describe('AC3 — Test 13: the project arm names idx_sessions_project specifically', () => {
  it.each(WITH_PROJECT)('%s rides idx_sessions_project', (_name, query) => {
    // ★ THE DISCRIMINATING ASSERTION. This exact string is the ONLY thing that
    // differs between the correct predicate and the anti-pattern below.
    expect(planOf(buildSessionListSql(query))[0]).toMatch(/USING INDEX idx_sessions_project/);
  });
});

describe('AC3 — Test 14: the anti-pattern control', () => {
  // ★ THE WHOLE POINT OF AC3. `AND (? IS NULL OR project_path = ?)` is CORRECT
  // and CLEAN-LOOKING: one plan row, no temp b-tree, no join, and byte-identical
  // rows. It passes every naive assertion while never touching the project index.
  const FORBIDDEN_SQL =
    `SELECT id FROM sessions WHERE parent_session_id IS NULL` +
    ` AND (? IS NULL OR project_path = ?)` +
    ` ORDER BY last_activity_at DESC, id DESC LIMIT ? OFFSET ?`;

  const GOOD_SQL =
    `SELECT id FROM sessions WHERE parent_session_id IS NULL AND project_path = ?` +
    ` ORDER BY last_activity_at DESC, id DESC LIMIT ? OFFSET ?`;

  it('(a) satisfies the NAIVE plan assertion — which is why Test 7 cannot catch it', () => {
    const plan = planOf({ sql: FORBIDDEN_SQL, params: ['/p', '/p', 2, 0] });

    expect(plan).toHaveLength(1);
    expect(plan.filter((detail) => /^(SCAN|SEARCH)\b/.test(detail))).toHaveLength(1);
    expect(plan.filter((detail) => DEGRADED.test(detail))).toHaveLength(0);
  });

  it('(b) returns exactly the same rows as the correct form, and as the builder', () => {
    seedCorpus();
    const ids = (sql: string, params: (string | number)[]): unknown[] =>
      (db.prepare(sql).all(...params) as unknown as { id: string }[]).map((row) => row.id);

    const bad = ids(FORBIDDEN_SQL, ['/p', '/p', 2, 0]);
    expect(bad).toEqual(ids(GOOD_SQL, ['/p', 2, 0]));
    expect(bad).toEqual(
      readSessionList(db, { limit: 2, offset: 0, project: '/p' }).items.map((row) => row.id),
    );
    expect(bad).toEqual(['s5', 's4']);

    // Identical plan whether the guard parameter is bound NULL or bound a path.
    expect(planOf({ sql: FORBIDDEN_SQL, params: ['/p', '/p', 2, 0] })).toEqual(
      planOf({ sql: FORBIDDEN_SQL, params: [null as unknown as string, '/p', 2, 0] }),
    );
  });

  it('(c) FAILS Test 13 — it never names idx_sessions_project', () => {
    const plan = planOf({ sql: FORBIDDEN_SQL, params: ['/p', '/p', 2, 0] });

    expect(plan[0]).not.toMatch(/USING INDEX idx_sessions_project/);
    expect(plan[0]).toMatch(/USING INDEX idx_sessions_recent/);

    // The correct form, same shape, does name it — so limb (c) is a real contrast.
    expect(planOf({ sql: GOOD_SQL, params: ['/p', 2, 0] })[0]).toMatch(
      /USING INDEX idx_sessions_project/,
    );
  });
});

describe('AC3 — Test 15: the null-guard disjunction appears nowhere', () => {
  // ★ THE TRAILING `\b` IS LOAD-BEARING, and the unanchored pattern the AC is
  // worded with is a FALSE POSITIVE. `WHERE parent_session_id IS NULL ORDER BY`
  // contains the substring "IS NULL OR" — so `/IS NULL OR/i` reds on the
  // CORRECT statement. `\bOR\b` fails on "ORDER" and matches the real
  // disjunction. Do not drop the anchor to "simplify" this.
  const NULL_GUARD = /\bIS NULL\s+OR\b/i;

  it('is absent from every builder output and from the module source', () => {
    for (const [, query] of ALL_SHAPES) {
      expect(buildSessionListSql(query).sql).not.toMatch(NULL_GUARD);
    }
    expect(buildProjectsSql().sql).not.toMatch(NULL_GUARD);
    expect(buildEventPageSql('s1', { from_seq: 0, limit: 2 }).sql).not.toMatch(NULL_GUARD);
    expect(readFileSync(READ_TS, 'utf8')).not.toMatch(NULL_GUARD);
  });

  it('and the pattern still catches the real thing, on both anchors', () => {
    // Non-vacuity: an anchor tightened until it matches nothing would green the
    // assertion above over any source at all.
    expect('AND (? IS NULL OR project_path = ?)').toMatch(NULL_GUARD);
    expect('WHERE x IS NULL or y = ?').toMatch(NULL_GUARD);
    expect('WHERE parent_session_id IS NULL ORDER BY id DESC').not.toMatch(NULL_GUARD);
  });
});

describe('AC3 — Test 16: the other three sorts pay a temp b-tree, and it is ASSERTED', () => {
  // A comment is not an assertion. Without this limb nothing reds if the plan
  // shifts or if someone adds the three missing indexes, and the "accepted cost"
  // quietly becomes folklore.
  it.each(['cost', 'tokens', 'errors'] as const)('sort=%s sorts through a temp b-tree', (sort) => {
    const plan = planOf(buildSessionListSql({ ...PAGE, sort }));

    expect(plan).toContain('USE TEMP B-TREE FOR ORDER BY');
    expect(plan.filter((detail) => /^(SCAN|SEARCH)\b/.test(detail))).toHaveLength(1);

    // The DDL has no index on these columns; sort=recent is the only indexed one.
    expect(planOf(buildSessionListSql({ ...PAGE, sort: 'recent' }))).toHaveLength(1);
  });
});

describe('AC2 — the other families plan as the approach measured them', () => {
  it('the event page reaches idx_events_session_seq on (session_id, seq)', () => {
    const plan = planOf(buildEventPageSql('s1', { from_seq: 5, limit: 10 }));

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatch(/USING INDEX idx_events_session_seq/);
    expect(plan.filter((detail) => DEGRADED.test(detail))).toHaveLength(0);
  });

  it('projects is a GROUP BY, so its temp b-tree is correct and expected', () => {
    // AC2's no-aggregate clause is about the SESSION LIST only. `data-model-v2.md:288-290`
    // specifies this one as an aggregate, so the sort through a b-tree is the spec's cost.
    const plan = planOf(buildProjectsSql());

    expect(plan.filter((detail) => /^(SCAN|SEARCH)\b/.test(detail))).toHaveLength(1);
    expect(plan).toContain('USE TEMP B-TREE FOR ORDER BY');
  });
});
