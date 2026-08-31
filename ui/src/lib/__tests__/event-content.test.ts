import { describe, it, expect } from 'vitest';

import { contentStateOf, storageOf, type ContentStorage } from '../event-content';
import { makeEventContent, makeEventRow } from './fixtures';

/*
 * AC3 — six labelled states, and the bytes check that runs before them.
 *
 * ===========================================================================
 * THE ORDER OF THE TWO STEPS IS THE THING UNDER TEST.
 * ===========================================================================
 * A dispatch on `output_storage` alone is green against most of these cases and
 * still blanks 1,596 rows of the measured corpus, because 1,579 NULL-storage
 * rows hold no body and 17 `inline` rows carry the zero-length string. So the
 * first four suites below feed the storage value and the bytes SEPARATELY, and
 * assert the arm each combination produces — which is the only way to see that
 * the bytes were consulted at all.
 *
 * Nothing here renders. `contentStateOf` is a pure three-argument function
 * precisely so the "Show full" behaviour — an effect this project can never fire
 * — is drivable by calling it twice with different third arguments.
 */

describe('storageOf narrows the wire word (AC3)', () => {
  it('keeps the four values that mean something different to a reader', () => {
    for (const known of ['inline', 'line_ref', 'spill', 'missing'] as const) {
      expect(storageOf(known)).toBe(known);
    }
  });

  it('merges NULL, `absent` and the unrecognised into one unclassified arm', () => {
    // Ruled 2026-08-30. All 67 `absent` rows carry a null `text`, and
    // `src/content/resolve.ts:255-257` already merges NULL and `absent` on the
    // input half — so once the no-body sentence stops naming `raw_type`,
    // nothing tells the two apart. A word this build has never seen joins them.
    const merged: ContentStorage = 'unclassified';
    expect(storageOf(null)).toBe(merged);
    expect(storageOf('absent')).toBe(merged);
    expect(storageOf('a_value_the_schema_gains_later')).toBe(merged);
  });

  it('never coalesces an unknown storage to a confident one', () => {
    // `turn-tree.ts:73-81` refuses to fabricate an `ok` status for the same
    // reason: a default that looks like a real reading is worse than an honest
    // "nobody classified this".
    expect(storageOf(null)).not.toBe('inline');
    expect(storageOf('absent')).not.toBe('inline');
  });
});

describe('the bytes check runs before the storage check (AC3)', () => {
  it('a NULL-storage row with text returns the body, not a blank', () => {
    // 4,585 rows: the assistant's own prose, which the projector never
    // classified because `pipeline.ts:490` writes the column on tool calls only.
    const event = makeEventRow({ output_storage: null, text: 'I will read the plan first.' });
    const state = contentStateOf(event, 'text', null);

    expect(state.kind).toBe('unclassified');
    expect(state.body).toBe('I will read the plan first.');
    expect(state.note).toBeNull();
  });

  it('a NULL-storage row with no text returns the empty arm, not a blank body', () => {
    // 1,579 rows. Under a storage-only dispatch this prints nothing at all,
    // which is the defect the pane exists to remove.
    const event = makeEventRow({ output_storage: null, text: null });
    const state = contentStateOf(event, 'text', null);

    expect(state.kind).toBe('empty');
    expect(state.body).toBeNull();
    expect(state.note).toBe('Nothing was recorded for this half.');
  });

  it('an `inline` row whose text is the empty string returns the empty arm', () => {
    // The 17-row case, and the one a six-value dispatch still gets wrong: the
    // column says `inline` with total confidence and holds nothing.
    const state = contentStateOf(
      makeEventRow({ output_storage: 'inline', text: '' }),
      'text',
      null,
    );

    expect(state.kind).toBe('empty');
    expect(state.body).toBeNull();
  });

  it('names no raw_type in the no-body sentence, whatever the row is', () => {
    // Ruled 2026-08-30. The arm fires on the input half of 14,211 rows, and
    // `raw_type` is `assistant` on 12,008 of them — a word that tells a reader
    // nothing. `attachment` and `system` are projector vocabulary.
    const notes = (['assistant', 'attachment', 'user', 'system'] as const).map(
      (raw_type) =>
        contentStateOf(makeEventRow({ raw_type, input: null, input_storage: null }), 'input', null)
          .note,
    );

    expect(new Set(notes).size).toBe(1);
    for (const raw_type of ['assistant', 'attachment', 'user', 'system']) {
      expect(notes[0]).not.toContain(raw_type);
    }
  });
});

describe('every storage value reaches a labelled arm (AC3)', () => {
  /*
   * The whole vocabulary, crossed with "holds bytes" and "holds none". The
   * without-bytes column is where a storage-only dispatch fails, and the
   * with-bytes column is where an over-eager bytes check would.
   */
  const CASES: readonly {
    storage: string | null;
    withBytes: string;
    withoutBytes: string;
  }[] = [
    { storage: 'inline', withBytes: 'inline', withoutBytes: 'empty' },
    { storage: 'line_ref', withBytes: 'line_ref', withoutBytes: 'line_ref' },
    { storage: 'spill', withBytes: 'spill', withoutBytes: 'spill' },
    { storage: 'missing', withBytes: 'missing', withoutBytes: 'missing' },
    { storage: 'absent', withBytes: 'unclassified', withoutBytes: 'empty' },
    { storage: null, withBytes: 'unclassified', withoutBytes: 'empty' },
    { storage: 'not_a_storage_word', withBytes: 'unclassified', withoutBytes: 'empty' },
  ];

  it('maps all seven wire values onto the six arms', () => {
    for (const { storage, withBytes, withoutBytes } of CASES) {
      const full = makeEventRow({ output_storage: storage, text: 'bytes' });
      const bare = makeEventRow({ output_storage: storage, text: null });

      expect(contentStateOf(full, 'text', null).kind, `${storage} with bytes`).toBe(withBytes);
      expect(contentStateOf(bare, 'text', null).kind, `${storage} with none`).toBe(withoutBytes);
    }
  });

  it('gives every arm either a body or a sentence, and never silence', () => {
    for (const { storage } of CASES) {
      for (const text of ['bytes', '', null]) {
        const state = contentStateOf(makeEventRow({ output_storage: storage, text }), 'text', null);
        expect(state.body !== null || state.note !== null, `${storage} / ${String(text)}`).toBe(
          true,
        );
      }
    }
  });
});

describe('the reply prose arrives uncut (AC1, AC2)', () => {
  it('returns every character of a 4,000-character body', () => {
    // The restatement of the starred AC: a test that only checks the fetcher
    // exists would pass against a build that renders nothing. This one reads
    // the body back.
    const text = 'x'.repeat(3_999) + 'Z';
    const state = contentStateOf(makeEventRow({ output_storage: null, text }), 'text', null);

    expect(state.body).toBe(text);
    expect(state.body).toHaveLength(4_000);
    expect(state.truncated).toBe(false);
  });
});

describe('the states that point somewhere else (AC3)', () => {
  it('a spill row with no text keeps its own arm and offers the refetch', () => {
    // 55 rows. `tools.ts:160-162` nulls the column when it writes the file, so
    // the pane has nothing to preview — but "empty" would be a lie about a body
    // that is sitting on disk.
    const event = makeEventRow({ output_storage: 'spill', text: null, spill_path: 'a/b.txt' });
    const state = contentStateOf(event, 'text', null);

    expect(state.kind).toBe('spill');
    expect(state.canRefetch).toBe(true);
    expect(state.note).not.toBeNull();
  });

  it('a missing row reads as normal, carries no error word and offers no refetch', () => {
    // Two rows of 30,286. `resolve.ts:14-19` and `api.ts:460-467` both answer
    // 200 for it, so the pane spends no error vocabulary here either.
    const state = contentStateOf(
      makeEventRow({ output_storage: 'missing', text: null }),
      'text',
      null,
    );

    expect(state.kind).toBe('missing');
    expect(state.note).toBe('Full output no longer on disk.');
    expect(state.canRefetch).toBe(false);
    expect(state.note?.toLowerCase()).not.toMatch(/error|fail|broken/);
  });
});

describe('folding a refetched body in is the whole of "Show full" (AC3)', () => {
  const head = 'HEAD-'.repeat(10);

  it('offers the control against the stored preview', () => {
    const event = makeEventRow({ output_storage: 'line_ref', text: head });
    const state = contentStateOf(event, 'text', null);

    expect(state.kind).toBe('line_ref');
    expect(state.body).toBe(head);
    expect(state.truncated).toBe(true);
    expect(state.canRefetch).toBe(true);
  });

  it('returns the full body and drops the control once one arrives', () => {
    // The button's entire behaviour, driven directly. No effect fires in this
    // project, so this is the only place it could be observed.
    const event = makeEventRow({ id: 'ev-9', output_storage: 'line_ref', text: head });
    const fetched = makeEventContent({ id: 'ev-9', field: 'text', content: 'the whole 68 KB' });
    const state = contentStateOf(event, 'text', fetched);

    expect(state.body).toBe('the whole 68 KB');
    expect(state.truncated).toBe(false);
    expect(state.canRefetch).toBe(false);
  });

  it('fills a spill row from the fetched body and retires its refetch', () => {
    const event = makeEventRow({ id: 'ev-9', output_storage: 'spill', text: null });
    const fetched = makeEventContent({
      id: 'ev-9',
      field: 'text',
      storage: 'spill',
      content: 'the resolved file',
    });
    const state = contentStateOf(event, 'text', fetched);

    expect(state.kind).toBe('spill');
    expect(state.body).toBe('the resolved file');
    expect(state.canRefetch).toBe(false);
  });

  it('ignores a body naming another event or another field', () => {
    // The selection moves faster than the network. A body that does not name
    // this event and this field is dropped by the decision, so no wiring
    // upstream has to guard the race.
    const event = makeEventRow({ id: 'ev-9', output_storage: 'line_ref', text: head });

    for (const fetched of [
      makeEventContent({ id: 'ev-OTHER', field: 'text', content: 'not this row' }),
      makeEventContent({ id: 'ev-9', field: 'input', content: 'not this half' }),
    ]) {
      const state = contentStateOf(event, 'text', fetched);
      expect(state.body).toBe(head);
      expect(state.canRefetch).toBe(true);
    }
  });
});

describe('the input half reads its own column (AC1)', () => {
  it('reads input/input_storage, never the output pair', () => {
    const event = makeEventRow({
      input: '{"file_path":"a.txt"}',
      input_storage: 'inline',
      text: null,
      output_storage: null,
    });

    expect(contentStateOf(event, 'input', null).body).toBe('{"file_path":"a.txt"}');
    expect(contentStateOf(event, 'text', null).kind).toBe('empty');
  });
});
