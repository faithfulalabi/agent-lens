// Task 5.0 DB-level reads: the null-strip mappers, the AC2 query-plan
// assertions, and byte-exact payload slicing.
//
// The plan assertions are the first `EXPLAIN QUERY PLAN` tests in the repo. They
// prepare `'EXPLAIN QUERY PLAN ' + buildSessionListSql(...).sql` directly rather
// than going through a production helper — AC7 forbids SQL in route handlers,
// not string concatenation in a test onto SQL that `src/db/` produced.

import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  buildSessionListSql,
  buildSessionSpansSql,
  readPayloadMeta,
  readPayloadSlice,
  readSession,
  readSessions,
  readSessionSpans,
  readSessionTraces,
  readTraceMessages,
  type SessionListQuery,
} from '../reads.js';
import { seedInto, type SeedManifest } from '../seed.js';
import { insertPayload } from '../index.js';
import { freshDb } from '../../capture/__tests__/fixtures.js';

let db: DatabaseSync;
let manifest: SeedManifest;

beforeEach(() => {
  db = freshDb();
  manifest = seedInto(db, { sessions: 4, tracesPerSession: 2, spansPerTrace: 3 });
});

/** `EXPLAIN QUERY PLAN` detail strings for a builder-produced statement. */
function planOf(query: { sql: string; params: (string | number)[] }): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as unknown as {
      detail: string;
    }[]
  ).map((row) => row.detail);
}

const PAGE = { limit: 50, offset: 0 };
const FROM = '2026-07-01T00:00:00.000Z';
const TO = '2026-12-31T00:00:00.000Z';

/** The four filter shapes that carry no `project` term. */
const NO_PROJECT: [string, SessionListQuery][] = [
  ['default', { ...PAGE }],
  ['from', { ...PAGE, from: FROM }],
  ['to', { ...PAGE, to: TO }],
  ['from+to', { ...PAGE, from: FROM, to: TO }],
];

/** The four filter shapes that do. */
const WITH_PROJECT: [string, SessionListQuery][] = [
  ['project', { ...PAGE, project: '/p' }],
  ['project+from', { ...PAGE, project: '/p', from: FROM }],
  ['project+to', { ...PAGE, project: '/p', to: TO }],
  ['project+from+to', { ...PAGE, project: '/p', from: FROM, to: TO }],
];

describe('AC2 — Test 2: the session list is one indexed pass, no aggregation', () => {
  it.each(NO_PROJECT)(
    'uses idx_sessions_started_at with no aggregate, join, or temp b-tree (%s)',
    (_name, query) => {
      const built = buildSessionListSql(query);
      const plan = planOf(built);

      expect(plan.filter((d) => /USING INDEX idx_sessions_started_at/.test(d))).toHaveLength(1);
      expect(plan.filter((d) => /TEMP B-TREE|SUBQUERY|CORRELATED/.test(d))).toHaveLength(0);
      expect(built.sql).not.toMatch(/\b(COUNT|SUM|AVG|GROUP BY|JOIN)\b/i);
    },
  );
});

describe('AC2 — Test 2b: a project filter must reach the composite index', () => {
  // This is the load-bearing half. The `? IS NULL OR col = ?` anti-pattern
  // yields a single clean `SCAN sessions USING INDEX idx_sessions_started_at`
  // row with no temp b-tree — it PASSES Test 2 — but it can never name the
  // project index, which is what this catches.
  it.each(WITH_PROJECT)(
    'uses idx_sessions_project_started (%s)',
    (_name, query) => {
      const built = buildSessionListSql(query);
      const plan = planOf(built);

      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatch(/USING INDEX idx_sessions_project_started/);
      expect(plan.filter((d) => /TEMP B-TREE|SUBQUERY|CORRELATED/.test(d))).toHaveLength(0);
    },
  );

  it('never emits the `? IS NULL OR col = ?` predicate that kills the index', () => {
    for (const [, query] of [...NO_PROJECT, ...WITH_PROJECT]) {
      expect(buildSessionListSql(query).sql).not.toMatch(/IS NULL OR/i);
    }
  });
});

describe('AC2 — Test 3: the session list touches only the sessions table', () => {
  it.each([...NO_PROJECT, ...WITH_PROJECT])(
    'plans exactly one SCAN/SEARCH row, on sessions (%s)',
    (_name, query) => {
      const scans = planOf(buildSessionListSql(query)).filter((d) =>
        /^(SCAN|SEARCH)\b/.test(d),
      );
      expect(scans).toHaveLength(1);
      expect(scans[0]).toMatch(/^(SCAN|SEARCH) sessions\b/);
    },
  );
});

describe('AC1 — Test 1b: the null-strip mapper omits keys, never emits null or 0', () => {
  it('a span with a NULL est_cost comes back with the key absent', () => {
    const page = readSessionSpans(db, 'seed-s0', { ...PAGE, trace: 'seed-s0:1' });
    const span = page.items.find((s) => s.id === manifest.unpricedSpanId)!;

    expect(span).toBeDefined();
    expect('est_cost' in span).toBe(false);
    expect(span.est_cost).not.toBe(null);
    expect(span.est_cost).not.toBe(0);
    // "Unpriced", not "no usage": the token columns ARE populated.
    expect(span.tokens_in).toBeGreaterThan(0);
  });

  it('a trace-root span omits parent_span_id, an open span omits ended_at', () => {
    const root = readSessionSpans(db, 'seed-s0', { ...PAGE, trace: 'seed-s0:1' }).items.find(
      (s) => s.id === manifest.rootSpanId,
    )!;
    expect('parent_span_id' in root).toBe(false);

    const openTrace = manifest.liveTraceId;
    const open = readSessionSpans(db, manifest.liveSessionId, {
      ...PAGE,
      trace: openTrace,
    }).items.find((s) => s.id === manifest.openSpanId)!;
    expect('ended_at' in open).toBe(false);
    expect('output_payload_id' in open).toBe(false);
  });

  it('a live session omits its four nullable columns; a complete one carries them', () => {
    const live = readSession(db, manifest.liveSessionId)!;
    for (const key of ['ended_at', 'git_branch', 'model', 'transcript_path'] as const) {
      expect(key in live).toBe(false);
    }

    const complete = readSession(db, 'seed-s0')!;
    expect(complete.ended_at).toBeDefined();
    expect(complete.git_branch).toBe('main');
    expect(complete.transcript_path).toContain('seed-s0');
  });

  it('a live trace omits ended_at; a message with no span link omits span_id', () => {
    const live = readSessionTraces(db, manifest.liveSessionId, PAGE).items.find(
      (t) => t.id === manifest.liveTraceId,
    )!;
    expect('ended_at' in live).toBe(false);

    const messages = readTraceMessages(db, 'seed-s0:1', PAGE).items;
    expect('span_id' in messages[0]!).toBe(false);
    expect(messages[1]!.span_id).toBe('seed-s0:1:sp0');
  });

  it('parses the JSON-in-TEXT columns: tags is an array, attrs an object', () => {
    const span = readSessionSpans(db, 'seed-s0', { ...PAGE, trace: 'seed-s0:1' }).items[0]!;
    expect(Array.isArray(span.tags)).toBe(true);
    expect(span.tags).toContain('seeded');
    expect(typeof span.attrs).toBe('object');
    expect(span.attrs.seed).toBe(true);
    // Set by `recordSpanUsage`, so the fixture really went through the writers.
    expect(span.attrs.pricing_version).toBeDefined();
  });
});

describe('AC1 — Test 13b: the trace-filtered span list is one indexed search', () => {
  it('plans a single SEARCH spans USING INDEX idx_spans_trace_started', () => {
    const plan = planOf(
      buildSessionSpansSql('seed-s0', { ...PAGE, trace: 'seed-s0:1' }),
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatch(/SEARCH spans USING INDEX idx_spans_trace_started/);
  });

  it('returns only that trace’s spans', () => {
    const page = readSessionSpans(db, 'seed-s0', { ...PAGE, trace: 'seed-s0:1' });
    expect(page.items).toHaveLength(3);
    expect(new Set(page.items.map((s) => s.trace_id))).toEqual(new Set(['seed-s0:1']));
  });

  it('returns every span in the session when no trace filter is given', () => {
    const page = readSessionSpans(db, 'seed-s0', PAGE);
    expect(page.items).toHaveLength(6);
    expect(new Set(page.items.map((s) => s.trace_id)).size).toBe(2);
  });
});

describe('AC3 — the Page envelope and the limit+1 probe', () => {
  it('reports has_more only while rows remain', () => {
    const first = readSessions(db, { limit: 2, offset: 0 });
    expect(first.items).toHaveLength(2);
    expect(first.has_more).toBe(true);

    const last = readSessions(db, { limit: 2, offset: 2 });
    expect(last.items).toHaveLength(2);
    expect(last.has_more).toBe(false);
  });

  it('orders sessions newest-first', () => {
    const page = readSessions(db, { limit: 10, offset: 0 });
    const times = page.items.map((s) => s.started_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('applies the project filter without a join', () => {
    const project = manifest.projects[0]!;
    const page = readSessions(db, { limit: 10, offset: 0, project });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((s) => s.project_path === project)).toBe(true);
  });

  it('returns an empty page past the end, not an error', () => {
    const page = readSessions(db, { limit: 10, offset: 1000 });
    expect(page).toEqual({ items: [], limit: 10, offset: 1000, has_more: false });
  });
});

describe('AC4 — Test 9: payload offsets are UTF-8 BYTES, not characters', () => {
  const CONTENT = '{"héllo":1}';

  it('byte_size matches Buffer.byteLength, and a byte slice differs from a char slice', () => {
    const id = insertPayload(db, CONTENT);
    const meta = readPayloadMeta(db, id)!;

    expect(meta.byte_size).toBe(Buffer.byteLength(CONTENT, 'utf8'));
    expect(meta.byte_size).toBe(12);
    expect(CONTENT.length).toBe(11); // characters, not bytes
    expect(meta.mime_hint).toBe('application/json');

    const bytes = readPayloadSlice(db, id, 0, meta.byte_size)!;
    expect(bytes).toHaveLength(12);
    expect(new TextDecoder().decode(bytes)).toBe(CONTENT);
  });

  it('splitting a multi-byte sequence decodes to U+FFFD rather than throwing', () => {
    const id = insertPayload(db, CONTENT);
    // `é` occupies bytes 3-4, so a 4-byte slice keeps only its lead byte.
    const bytes = readPayloadSlice(db, id, 0, 4)!;
    expect(bytes).toHaveLength(4);
    expect(new TextDecoder().decode(bytes)).toContain('�');
  });
});

describe('AC4 — Test 8: SQLite clamps substr natively, so reads never throw', () => {
  it('a start past the end yields an empty slice', () => {
    const id = insertPayload(db, '{"a":1}');
    expect(readPayloadSlice(db, id, 9999, 10)).toHaveLength(0);
  });

  it('a length beyond the end truncates to what exists', () => {
    const content = '{"a":1}';
    const id = insertPayload(db, content);
    const bytes = readPayloadSlice(db, id, 0, 9999)!;
    expect(bytes).toHaveLength(Buffer.byteLength(content, 'utf8'));
  });

  it('a zero length yields an empty slice', () => {
    const id = insertPayload(db, '{"a":1}');
    expect(readPayloadSlice(db, id, 0, 0)).toHaveLength(0);
  });

  it('an unknown payload id reads back as undefined, not a throw', () => {
    expect(readPayloadMeta(db, 'nope')).toBeUndefined();
    expect(readPayloadSlice(db, 'nope', 0, 10)).toBeUndefined();
  });
});
