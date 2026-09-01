// AC3: every param guard is an exported PURE function, unit-tested with no
// server and no DB. The only runtime import below is `api.js` itself — booting a
// server to find out that `limit=abc` is a 400 is what this file exists to stop.
//
// The mappers are here for the same reason: `aggregateDrift` and
// `toDetailProjection` decide two wire contracts each, and both are answerable
// from plain objects.

import { describe, expect, it } from 'vitest';
import type { DriftRow, SessionDetailHeader, SessionProjection } from '../../db/read.js';
import type { ProjectionOutcome } from '../../db/freshness.js';
import {
  DEFAULT_LIMIT,
  EVENT_PAGE_LIMIT,
  LIVE_WINDOW_MS,
  MAX_LIMIT,
  aggregateDrift,
  clampRange,
  isLive,
  parseField,
  parseFromSeq,
  parsePageParams,
  parseRange,
  parseSearchQuery,
  parseSort,
  toDetailProjection,
} from '../api.js';

/** The error string a 400 body carries, or `null` when the guard accepted. */
function errorOf(result: { ok: true } | { ok: false; error: string }): string | null {
  return result.ok ? null : result.error;
}

describe('parsePageParams (AC3)', () => {
  it.each([
    ['0', 'invalid limit'],
    ['-1', 'invalid limit'],
    ['1.5', 'invalid limit'],
    ['1e3', 'invalid limit'],
    ['abc', 'invalid limit'],
    ['+5', 'invalid limit'],
    [' 5', 'invalid limit'],
  ])('rejects limit=%s', (limit, error) => {
    expect(errorOf(parsePageParams({ limit }))).toBe(error);
  });

  it.each([
    ['-1', 'invalid offset'],
    ['1.5', 'invalid offset'],
    ['abc', 'invalid offset'],
  ])('rejects offset=%s', (offset, error) => {
    expect(errorOf(parsePageParams({ offset }))).toBe(error);
  });

  it('rejects an offset past MAX_SAFE_INTEGER rather than letting sqlite throw', () => {
    // `node:sqlite` answers a non-safe integer bind with `datatype mismatch`,
    // which would surface as a 500. AC3 wants a 400.
    const huge = '9007199254740993';
    expect(Number.isSafeInteger(Number(huge))).toBe(false);
    expect(errorOf(parsePageParams({ offset: huge }))).toBe('invalid offset');
  });

  it('clamps a large limit instead of rejecting it — a cap, not a rejection', () => {
    const parsed = parsePageParams({ limit: '99999' });
    expect(parsed).toEqual({ ok: true, value: { limit: MAX_LIMIT, offset: 0 } });
  });

  it('defaults to the caller-supplied fallback, and treats empty as absent', () => {
    expect(parsePageParams({})).toEqual({ ok: true, value: { limit: DEFAULT_LIMIT, offset: 0 } });
    expect(parsePageParams({ limit: '', offset: '' })).toEqual({
      ok: true,
      value: { limit: DEFAULT_LIMIT, offset: 0 },
    });
    expect(parsePageParams({}, EVENT_PAGE_LIMIT)).toEqual({
      ok: true,
      value: { limit: EVENT_PAGE_LIMIT, offset: 0 },
    });
  });

  it('accepts a well-formed pair', () => {
    expect(parsePageParams({ limit: '10', offset: '20' })).toEqual({
      ok: true,
      value: { limit: 10, offset: 20 },
    });
  });
});

describe('parseFromSeq (AC3)', () => {
  it.each(['-1', '1.5', '1e3', 'abc', '9007199254740993'])('rejects from_seq=%s', (raw) => {
    expect(errorOf(parseFromSeq(raw))).toBe('invalid from_seq');
  });

  it('defaults to 0 — the start of the session', () => {
    expect(parseFromSeq(undefined)).toEqual({ ok: true, value: 0 });
    expect(parseFromSeq('')).toEqual({ ok: true, value: 0 });
    expect(parseFromSeq('0')).toEqual({ ok: true, value: 0 });
    expect(parseFromSeq('42')).toEqual({ ok: true, value: 42 });
  });
});

describe('parseSort (AC3)', () => {
  it.each(['recent', 'cost', 'tokens', 'errors'])('accepts sort=%s', (sort) => {
    expect(parseSort(sort)).toEqual({ ok: true, value: sort });
  });

  it.each(['bogus', 'RECENT', 'last_activity_at', 'id DESC'])('rejects sort=%s', (sort) => {
    // ★ Rejected HERE so it never reaches `buildSessionListSql`, whose own throw
    // (`read.ts:325`) would surface as a 500 instead of a 400.
    expect(errorOf(parseSort(sort))).toBe('invalid sort');
  });

  it('defaults to recent, the only sort that rides an index', () => {
    expect(parseSort(undefined)).toEqual({ ok: true, value: 'recent' });
    expect(parseSort('')).toEqual({ ok: true, value: 'recent' });
  });
});

describe('parseField (AC3)', () => {
  it.each(['text', 'input'])('accepts field=%s', (field) => {
    expect(parseField(field)).toEqual({ ok: true, value: field });
  });

  it.each(['body', 'TEXT', 'output', 'text,input'])('rejects field=%s', (field) => {
    expect(errorOf(parseField(field))).toBe('invalid field');
  });

  it('defaults to text', () => {
    expect(parseField(undefined)).toEqual({ ok: true, value: 'text' });
  });
});

describe('parseRange (AC3)', () => {
  it.each(['5-2', '-1-5', 'abc', '5', '-', '5-2-3', '1.5-3'])('rejects range=%s', (raw) => {
    expect(errorOf(parseRange(raw))).toBe('invalid range');
  });

  it('accepts an omitted end, and absent means the whole field', () => {
    expect(parseRange('1024-')).toEqual({ ok: true, value: { start: 1024 } });
    expect(parseRange(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseRange('')).toEqual({ ok: true, value: undefined });
    expect(parseRange('0-9')).toEqual({ ok: true, value: { start: 0, end: 9 } });
  });

  it('rejects a non-safe integer bound', () => {
    expect(errorOf(parseRange('9007199254740993-9007199254740999'))).toBe('invalid range');
  });
});

describe('clampRange (AC3)', () => {
  it.each([
    // [range, byteSize, expected]
    [undefined, 10, { start: 0, end: 9, length: 10 }],
    [{ start: 2, end: 5 }, 10, { start: 2, end: 5, length: 4 }],
    [{ start: 2 }, 10, { start: 2, end: 9, length: 8 }],
    // Past the end clamps to an empty slice and still answers 200.
    [{ start: 50, end: 60 }, 10, { start: 10, end: 9, length: 0 }],
    [{ start: 0, end: 999 }, 10, { start: 0, end: 9, length: 10 }],
    // An empty field cannot produce a negative length.
    [{ start: 0, end: 5 }, 0, { start: 0, end: -1, length: 0 }],
  ])('clamps %j onto %i bytes', (range, byteSize, expected) => {
    expect(clampRange(range, byteSize)).toEqual(expected);
  });
});

describe('parseSearchQuery (AC3)', () => {
  it('requires a non-empty q', () => {
    expect(errorOf(parseSearchQuery({}))).toBe('invalid q');
    expect(errorOf(parseSearchQuery({ q: '' }))).toBe('invalid q');
  });

  it('carries the page error through rather than inventing its own', () => {
    expect(errorOf(parseSearchQuery({ q: 'x', limit: 'abc' }))).toBe('invalid limit');
  });

  it('omits session when absent, so the reader is never scoped by an empty string', () => {
    expect(parseSearchQuery({ q: 'hello' })).toEqual({
      ok: true,
      value: { q: 'hello', limit: DEFAULT_LIMIT },
    });
    expect(parseSearchQuery({ q: 'hello', session: '' })).toEqual({
      ok: true,
      value: { q: 'hello', limit: DEFAULT_LIMIT },
    });
    expect(parseSearchQuery({ q: 'hello', session: 's1', limit: '5' })).toEqual({
      ok: true,
      value: { q: 'hello', session: 's1', limit: 5 },
    });
  });
});

describe('isLive — stamped by the server, never a column (spec:278)', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');

  it.each([
    ['2026-08-20T11:59:59.000Z', true],
    ['2026-08-20T12:00:00.000Z', true],
    ['2026-08-20T11:59:01.000Z', true],
    // Exactly the window is NOT live: the boundary is strict.
    ['2026-08-20T11:59:00.000Z', false],
    ['2026-08-20T10:00:00.000Z', false],
  ])('%s -> %s', (at, expected) => {
    expect(isLive(at, now)).toBe(expected);
  });

  it('is false for an unparseable timestamp rather than NaN-true', () => {
    expect(isLive('not a date', now)).toBe(false);
  });

  it('measures against LIVE_WINDOW_MS', () => {
    expect(LIVE_WINDOW_MS).toBe(60_000);
    expect(isLive(new Date(now - LIVE_WINDOW_MS + 1).toISOString(), now)).toBe(true);
    expect(isLive(new Date(now - LIVE_WINDOW_MS).toISOString(), now)).toBe(false);
  });
});

describe('toDetailProjection — the gate outcome overrides the column (AC5)', () => {
  const STORED: SessionProjection = {
    state: 'ready',
    projector_version: 1,
    projected_at: '2026-08-14T09:05:00.000Z',
    drift: {
      unknown_line_types: {},
      unknown_block_types: {},
      unjoined_tool_uses: 0,
      unresolved_spills: 0,
    },
  };

  function headerWith(projection: SessionProjection): SessionDetailHeader {
    return { projection } as SessionDetailHeader;
  }

  it("★ a 'failed' gate relabels a column that still reads 'ready'", () => {
    // `foldArchive` returning undefined answers 'failed' BEFORE any write, so the
    // column is untouched and would otherwise report a verified projection for a
    // session whose bytes are gone. This override is the whole point of AC5.
    const mapped = toDetailProjection(headerWith(STORED), 'failed');
    expect(mapped.state).toBe('failed');
    expect(mapped.error).toBeTypeOf('string');
    expect(mapped.error).not.toBe('');
    // Everything else survives: the projection itself is still readable.
    expect(mapped.projected_at).toBe(STORED.projected_at);
    expect(mapped.drift).toEqual(STORED.drift);
  });

  it("a 'failed' gate keeps the writer's own error message when there is one", () => {
    const stored = { ...STORED, state: 'failed' as const, error: 'Error: bad line 7' };
    expect(toDetailProjection(headerWith(stored), 'failed').error).toBe('Error: bad line 7');
  });

  it.each(['hit', 'projected'] as const)('%s passes the stored state through', (outcome) => {
    expect(toDetailProjection(headerWith(STORED), outcome)).toEqual(STORED);
  });

  it.each(['none', 'ready', 'failed', 'empty'] as const)(
    "keeps '%s' — all FOUR states, not the spec's two",
    (state) => {
      // ⚠️ SPEC DEVIATION, asserted on purpose. `data-model-v2.md:303` declares
      // two values; the column, `read.ts:96` and a probe of a SUCCESSFUL gate
      // call all carry four. Folding 'none'/'empty' onto 'ready' would tell the
      // browser a session is projected when it is not.
      expect(toDetailProjection(headerWith({ ...STORED, state }), 'hit').state).toBe(state);
    },
  );

  it('never emits a state outside the four, whatever the column holds', () => {
    // `schema.ts:123` gives the column a DDL default and NO check constraint, so
    // an unrecognised value is reachable — and must never leave as one.
    const rogue = { ...STORED, state: 'in-progress' as SessionProjection['state'] };
    const outcomes: ProjectionOutcome[] = ['hit', 'projected', 'failed'];
    for (const outcome of outcomes) {
      expect(['none', 'ready', 'failed', 'empty']).toContain(
        toDetailProjection(headerWith(rogue), outcome).state,
      );
    }
    expect(toDetailProjection(headerWith(rogue), 'hit').state).toBe('none');
  });
});

describe('aggregateDrift — the tally is the mapper’s, not the reader’s (spec:382-392)', () => {
  function row(id: string, harness_version: string | null, drift: object): DriftRow {
    return { id, title: `title ${id}`, harness_version, drift_json: JSON.stringify(drift) };
  }

  it('counts a clean session in the census, and skips it everywhere else', () => {
    // `harness_versions` is the CENSUS: the projected population per version,
    // so a zero report still says how many sessions were checked and on which
    // release. Every OTHER field still exits at the writer's own marker, which
    // is what keeps `sessions_with_drift` the thing that goes 0 -> N.
    const report = aggregateDrift([row('clean', '2.1.212', {})]);
    expect(report.harness_versions).toEqual({ '2.1.212': 1 });
    expect(report.sessions_with_drift).toEqual([]);
    expect(report.unknown_line_types).toEqual({});
    expect(report.unknown_block_types).toEqual({});
    expect(report.unknown_top_level_fields).toEqual({});
    expect(report.unjoined_tool_uses).toBe(0);
    expect(report.unresolved_spills).toBe(0);
  });

  it('★ names the drifting version through sessions_with_drift, never the census', () => {
    /*
     * ★ THE CENSUS CANNOT ATTRIBUTE, AND THAT IS THE COST OF THE HOIST.
     * `harness_versions` counts clean AND drifting rows, so an assertion over it
     * passes identically whether or not the session drifted — the two rows below
     * are proof: one clean, one drifting, one census entry each.
     * `sessions_with_drift[].harness_version` is the sole surviving carrier of
     * "which release did this", so every attribution assertion aims there.
     */
    const report = aggregateDrift([
      row('clean', '2.1.212', {}),
      row('drifty', '2.2.0', { unknown_line_types: { widget_frame: 1 } }),
    ]);

    expect(report.harness_versions).toEqual({ '2.1.212': 1, '2.2.0': 1 });
    expect(report.unknown_line_types).toEqual({ widget_frame: 1 });
    expect(report.sessions_with_drift).toHaveLength(1);
    expect(report.sessions_with_drift[0]!.harness_version).toBe('2.2.0');
  });

  it('★ carries unknown_top_level_fields and sidecar_agent_id_mismatch', () => {
    // Both are dropped by `db/read.ts`'s `parseDrift`, which is pinned at the
    // four keys the DETAIL response declares (spec:305-308). spec:390 needs
    // `unknown_top_level_fields` by name, so it is parsed off the raw text here.
    const report = aggregateDrift([
      row('a', '2.1.212', {
        unknown_top_level_fields: { newField: 3 },
        sidecar_agent_id_mismatch: 2,
      }),
    ]);
    expect(report.unknown_top_level_fields).toEqual({ newField: 3 });
    expect(report.sessions_with_drift[0]!.counts).toEqual({
      unknown_top_level_fields: { newField: 3 },
      sidecar_agent_id_mismatch: 2,
    });
  });

  it('merges buckets and sums scalars across sessions', () => {
    const report = aggregateDrift([
      row('a', '2.1.212', {
        unknown_line_types: { summary: 2 },
        unknown_block_types: { widget: 1 },
        unjoined_tool_uses: 3,
        unresolved_spills: 1,
      }),
      row('b', '2.1.212', {
        unknown_line_types: { summary: 5, digest: 1 },
        unjoined_tool_uses: 4,
      }),
      row('c', '2.2.0', { unknown_block_types: { widget: 7 } }),
    ]);

    expect(report.unknown_line_types).toEqual({ summary: 7, digest: 1 });
    expect(report.unknown_block_types).toEqual({ widget: 8 });
    expect(report.unjoined_tool_uses).toBe(7);
    expect(report.unresolved_spills).toBe(1);
    // The census, which here happens to equal the drifting count: all three
    // rows carry drift. The clean-row case above is what separates the two.
    expect(report.harness_versions).toEqual({ '2.1.212': 2, '2.2.0': 1 });
    expect(report.sessions_with_drift.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('buckets a null harness_version rather than dropping the session', () => {
    const report = aggregateDrift([row('a', null, { unjoined_tool_uses: 1 })]);
    expect(report.harness_versions).toEqual({ unknown: 1 });
    expect(report.sessions_with_drift[0]!.harness_version).toBeNull();
  });
});
