import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import {
  emptyResultCopy,
  hitsBySession,
  revealStep,
  scopeLine,
  searchIntent,
  splitSnippet,
  warmLabel,
  warmState,
  type RevealLatch,
} from '../search';
import type { SearchHitRow } from '../api';
import type { Row } from '../turn-tree';

/*
 * Task 7.2's decisions, all of them pure.
 *
 * The `ui` project has no DOM, so this file is where the screen is actually
 * asserted: the snippet split, the scope sentence, the empty-state copy, the
 * warm fold and the reveal latch. The components next door pin their markup;
 * nothing else can pin behaviour.
 */

const MARK_OPEN = '<mark>';
const MARK_CLOSE = '</mark>';
const mark = (text: string): string => `${MARK_OPEN}${text}${MARK_CLOSE}`;

function makeHit(overrides: Partial<SearchHitRow> = {}): SearchHitRow {
  return {
    session_id: 's-1',
    session_title: 'a session',
    project_path: '/repo',
    turn_id: 't-1',
    event_id: 'ev-1',
    seq: 1,
    kind: 'tool_call',
    name: 'Bash',
    ts: '2026-09-01T00:00:00.000Z',
    snippet: 'nothing marked',
    ...overrides,
  };
}

/** An event row of the flattened tree, reduced to what `revealStep` reads. */
function eventRow(id: string): Row {
  return { kind: 'event', id } as unknown as Row;
}

/* ------------------------------------------------------- Tests 1 and 2 --- */

describe('splitSnippet separates matched text from unmatched text (Test 1)', () => {
  it.each([
    {
      name: 'no markers',
      snippet: 'plain text',
      expected: [{ text: 'plain text', matched: false }],
    },
    {
      name: 'one match',
      snippet: `before ${mark('hit')} after`,
      expected: [
        { text: 'before ', matched: false },
        { text: 'hit', matched: true },
        { text: ' after', matched: false },
      ],
    },
    {
      name: 'several matches',
      snippet: `${mark('a')} mid ${mark('b')}`,
      expected: [
        { text: 'a', matched: true },
        { text: ' mid ', matched: false },
        { text: 'b', matched: true },
      ],
    },
    {
      name: 'a match at each end',
      snippet: `${mark('start')}middle${mark('end')}`,
      expected: [
        { text: 'start', matched: true },
        { text: 'middle', matched: false },
        { text: 'end', matched: true },
      ],
    },
    { name: 'null', snippet: null, expected: [] },
    { name: 'empty', snippet: '', expected: [] },
    {
      // MEASURED: 10 of 30,286 event rows carry a literal marker in `text` or
      // `input`, so an unterminated one is reachable from real content. It
      // degrades to plain text; the worst case is one run not highlighted.
      name: 'unterminated',
      snippet: `before ${MARK_OPEN}never closed`,
      expected: [{ text: `before ${MARK_OPEN}never closed`, matched: false }],
    },
    {
      // The inner opener came from the transcript, so it is shown rather than
      // recursed on — the highlight is approximate, the text is exact.
      name: 'nested',
      snippet: `${MARK_OPEN}outer ${MARK_OPEN}inner${MARK_CLOSE} tail${MARK_CLOSE}`,
      expected: [
        { text: `outer ${MARK_OPEN}inner`, matched: true },
        { text: ` tail${MARK_CLOSE}`, matched: false },
      ],
    },
  ])('$name', ({ snippet, expected }) => {
    expect(splitSnippet(snippet)).toEqual(expected);
  });
});

describe('splitSnippet never yields markup, on adversarial real content (Test 2)', () => {
  /*
   * ★ THE MEASUREMENT THIS TEST EXISTS FOR, RECORDED SO IT REPRODUCES.
   *
   * Run `searchEvents` (`src/db/read.ts:583`) against `.agent-lens-dev/cache.db`
   * — 293 sessions, 30,286 events — with `q=script` and `limit=300`. Strip the
   * two marker literals from each returned `snippet`, then count:
   *
   *     300 rows returned
   *      81 contain a raw `<`            (27%)
   *      67 contain a literal `<script`  (22%)
   *
   * Query, limit and strip rule are stated beside the numbers on purpose: a bare
   * figure is an unreproducible claim. That is why the screen splits the snippet
   * into TEXT runs instead of inserting it as HTML — on 22% of one ordinary
   * query's results, `dangerouslySetInnerHTML` is an injection vector.
   */
  const ADVERSARIAL = `const x = ${mark('<script>alert(1)</script>')} && a < b`;

  it('every returned run is plain text, markers and all', () => {
    for (const part of splitSnippet(ADVERSARIAL)) {
      expect(part.text).not.toContain(MARK_OPEN);
      expect(part.text).not.toContain(MARK_CLOSE);
    }
    expect(
      splitSnippet(ADVERSARIAL)
        .map((part) => part.text)
        .join(''),
    ).toBe('const x = <script>alert(1)</script> && a < b');
  });

  it('a static render escapes the tag rather than emitting one', () => {
    const markup = renderToStaticMarkup(
      createElement(
        'p',
        null,
        splitSnippet(ADVERSARIAL).map((part, index) =>
          createElement(part.matched ? 'mark' : 'span', { key: index }, part.text),
        ),
      ),
    );
    expect(markup, 'the entity is what proves React treated it as text').toContain(
      '&lt;script&gt;',
    );
    expect(markup, 'a live tag here would be the injection').not.toContain('<script>');
    // The highlight IS an element — drawn by the component, not sent by SQLite.
    expect(markup).toContain('<mark>');
  });
});

/* ------------------------------------------------------------- Test 4 --- */

describe('hitsBySession groups by session and keeps rank order (Test 4)', () => {
  it('preserves first-appearance order of groups and rank order within them', () => {
    const groups = hitsBySession([
      makeHit({ session_id: 'a', event_id: 'a1', seq: 1 }),
      makeHit({ session_id: 'b', event_id: 'b1', seq: 2 }),
      makeHit({ session_id: 'a', event_id: 'a2', seq: 3 }),
    ]);

    expect(groups.map((group) => group.sessionId)).toEqual(['a', 'b']);
    expect(groups[0]?.hits.map((hit) => hit.event_id)).toEqual(['a1', 'a2']);
    expect(groups[1]?.hits.map((hit) => hit.event_id)).toEqual(['b1']);
  });

  it('answers an empty list for no hits', () => {
    expect(hitsBySession([])).toEqual([]);
  });
});

/* ------------------------------------------------------------- Test 6 --- */

describe('revealStep is one-shot ON DELIVERY (Test 6)', () => {
  const latch: RevealLatch = { turnId: 't-1', eventId: 'ev-7' };

  it('(a) a null latch asks for no scroll', () => {
    expect(revealStep(null, [eventRow('ev-7')])).toEqual({ latch: null, revealIndex: undefined });
  });

  it('(b) a row still absent KEEPS the latch and asks for no scroll', () => {
    // The turn is opening. Dropping the latch here would lose the jump for good.
    expect(revealStep(latch, [eventRow('ev-1'), eventRow('ev-2')])).toEqual({
      latch,
      revealIndex: undefined,
    });
  });

  it('(c) the row found answers index, selection and focus, and drops the latch', () => {
    expect(revealStep(latch, [eventRow('ev-1'), eventRow('ev-7'), eventRow('ev-9')])).toEqual({
      latch: null,
      revealIndex: 1,
      selectedId: 'ev-7',
      focusedIndex: 1,
    });
  });

  it('(d) ★ the target MOVING in a grown rows array re-fires nothing', () => {
    /*
     * THE LOAD-BEARING CASE, and the one a derived index fails.
     *
     * Start from the state (c) returns — the latch is spent — then grow `rows`
     * the way opening any turn grows it, so the target sits at a different
     * index. `rows` is memoised on `nav.expandedIds` (`SessionView.tsx:205-208`)
     * and is rebuilt on every expand and collapse, so this is the ordinary case,
     * not an edge one. `revealIndex = rows.findIndex(...)` would answer 4 here,
     * `SpanTree`'s effect deps `[revealIndex, virtualizer]` would change, and
     * the scroller would yank a reader who only opened a turn — the exact
     * failure `SpanTree.tsx:79-85` documents `followIndex` existing to prevent.
     *
     * Test 25(d) cannot cover this: `aria-selected` is true whether or not the
     * scroll fired.
     */
    const delivered = revealStep(latch, [eventRow('ev-1'), eventRow('ev-7'), eventRow('ev-9')]);
    expect(delivered.revealIndex, 'the precondition: (c) delivered once').toBe(1);

    const grown = [
      eventRow('ev-1'),
      eventRow('ev-3'),
      eventRow('ev-4'),
      eventRow('ev-5'),
      eventRow('ev-7'),
      eventRow('ev-9'),
    ];
    expect(
      grown.findIndex((row) => row.id === 'ev-7'),
      'the target really moved',
    ).toBe(4);

    const after = revealStep(delivered.latch, grown);
    expect(after.revealIndex, 'a spent latch must never scroll again').toBeUndefined();
    expect(after.latch).toBeNull();
  });

  it('holds the latch across many renders until the row arrives', () => {
    // The absent arm is not a one-render window: a sub-agent's rows land a
    // request later, so the latch has to survive every render in between.
    let held: RevealLatch | null = latch;
    for (let render = 0; render < 5; render += 1) {
      const step: ReturnType<typeof revealStep> = revealStep(held, [eventRow('ev-1')]);
      expect(step.revealIndex).toBeUndefined();
      held = step.latch;
    }
    expect(held).toBe(latch);
    expect(revealStep(held, [eventRow('ev-7')]).revealIndex).toBe(0);
  });
});

/* ---------------------------------------------------------- Test 10-12 --- */

describe('searchIntent fires no request for an empty query (Test 10)', () => {
  it.each(['', '   ', '\t\n'])('%j is idle', (raw) => {
    expect(searchIntent(raw)).toEqual({ kind: 'idle' });
  });

  it.each([
    { raw: 'ENOENT', q: 'ENOENT' },
    { raw: '  foo-bar  ', q: 'foo-bar' },
    // 7.1's phrase fallback returns 200 for all of these, so none is a client
    // concern — the only param errors left are a missing `q` and a NUL.
    { raw: 'src/db/read.ts', q: 'src/db/read.ts' },
    { raw: 'C++', q: 'C++' },
    { raw: 'AND', q: 'AND' },
  ])('$raw searches for $q', ({ raw, q }) => {
    expect(searchIntent(raw)).toEqual({ kind: 'search', q });
  });
});

describe('scopeLine states the scope the API answered with (Tests 11, 12)', () => {
  it('says "this session" for the session scope', () => {
    expect(scopeLine('session')).toContain('this session');
  });

  it('names the projected transcript scope, and the sidecars in it', () => {
    const line = scopeLine('projected');
    expect(line).toContain('projected');
    expect(line).toContain('sub-agent');
  });

  it('★ never says "sessions" for the projected scope (Test 12)', () => {
    /*
     * A NEGATIVE ASSERTION, because that one word is the specific falsehood.
     *
     * MEASURED against `.agent-lens-dev/cache.db`: 293 sessions, of which 21 are
     * top-level and 272 are sub-agent sidecars the session list never shows. For
     * `q=ENOENT` — 623 matching events, 105 of them top-level — 47 of the first
     * 50 hits BY RANK come from a sidecar. So the majority of a reader's first
     * search is content that is not a session they can see, and calling the
     * scope "sessions" would make the count read as a bug to anyone who counts
     * the list. 7.1's founder ruling 3 names this screen as where the ambiguity
     * becomes user-visible.
     */
    expect(scopeLine('projected')).not.toContain('sessions');
  });
});

/* ---------------------------------------------------- Tests 19, 21, 23 --- */

describe('emptyResultCopy tells "no match" apart from "not searched" (Test 23)', () => {
  it('says nothing at all before anything is typed', () => {
    expect(emptyResultCopy({ kind: 'idle' }, 0, 12)).toBeNull();
  });

  it('says nothing while there are hits to show', () => {
    expect(emptyResultCopy({ kind: 'search', q: 'x' }, 3, 12)).toBeNull();
  });

  it('names the query when the whole corpus was searched and nothing matched', () => {
    const copy = emptyResultCopy({ kind: 'search', q: 'zzz' }, 0, 0);
    expect(copy).toContain('zzz');
    expect(copy, 'nothing is unindexed, so no caveat is owed').not.toContain('not indexed');
  });

  it('admits the residual when part of the corpus is not indexed', () => {
    // The whole honesty requirement in one sentence: "no matches" over a
    // partial corpus is the answer a reader takes for "it never happened".
    const copy = emptyResultCopy({ kind: 'search', q: 'zzz' }, 0, 12);
    expect(copy).toContain('12');
    expect(copy).toContain('not indexed');
  });
});

describe('warmState folds progress monotonically (Test 21)', () => {
  it('seeds from the first reading', () => {
    expect(warmState(null, { done: 3, total: 10 })).toEqual({ done: 3, total: 10 });
  });

  it('advances', () => {
    expect(warmState({ done: 3, total: 10 }, { done: 4, total: 10 })).toEqual({
      done: 4,
      total: 10,
    });
  });

  it('ignores a reading that moved backwards', () => {
    // Frames are one-way notifications with no ordering guarantee. A count that
    // walked backwards on screen would read as a failure rather than a reorder.
    expect(warmState({ done: 7, total: 10 }, { done: 4, total: 10 })).toEqual({
      done: 7,
      total: 10,
    });
  });

  it('starts over when the total changes, because that is a new run', () => {
    expect(warmState({ done: 7, total: 10 }, { done: 1, total: 4 })).toEqual({ done: 1, total: 4 });
  });

  it('settles at done === total', () => {
    const settled = warmState({ done: 9, total: 10 }, { done: 10, total: 10 });
    expect(settled).toEqual({ done: 10, total: 10 });
    expect(warmState(settled, { done: 10, total: 10 })).toEqual({ done: 10, total: 10 });
  });
});

describe('warmLabel says what the control will do, then how far it got', () => {
  it('offers the residual before a run starts', () => {
    expect(warmLabel(12, null)).toContain('12');
  });

  it('counts through a run', () => {
    expect(warmLabel(12, { done: 4, total: 12 })).toContain('4');
  });

  it('reports a finished run', () => {
    expect(warmLabel(0, { done: 12, total: 12 })).toContain('12');
  });
});
