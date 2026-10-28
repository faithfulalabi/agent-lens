import { describe, it, expect } from 'vitest';

import {
  contentStateOf,
  imageViewsOf,
  permissionOf,
  storageOf,
  unrecognisedFieldsOf,
  wireDivergenceOf,
  type ContentStorage,
} from '../event-content';
import { makeEventContent, makeEventRow, makeUnrecognisedFields } from './fixtures';

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

describe('storageOf narrows the wire word', () => {
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
    //
    // Never coalesced to a confident arm such as `inline`: `turn-tree.ts:73-81`
    // refuses to fabricate an `ok` status for the same reason — a default that
    // looks like a real reading is worse than an honest "nobody classified this".
    const merged: ContentStorage = 'unclassified';
    expect(storageOf(null)).toBe(merged);
    expect(storageOf('absent')).toBe(merged);
    expect(storageOf('a_value_the_schema_gains_later')).toBe(merged);
  });
});

describe('the bytes check runs before the storage check', () => {
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

  it('an `inline` tool result that held only an image shows its placeholder, not the empty arm', () => {
    const state = contentStateOf(
      makeEventRow({
        kind: 'tool_call',
        output_storage: 'inline',
        text: '[image image/png, 131.4 KB]',
      }),
      'text',
      null,
    );

    expect(state.kind).toBe('inline');
    expect(state.body).toBe('[image image/png, 131.4 KB]');
    expect(state.note).not.toBe('Nothing was recorded for this half.');
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

describe('every storage value reaches a labelled arm', () => {
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

describe('the reply prose arrives uncut', () => {
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

describe('the states that point somewhere else', () => {
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

describe('folding a refetched body in is the whole of "Show full"', () => {
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

describe('the input half reads its own column', () => {
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

describe('the wire half is shown only where the harness rewrote the call', () => {
  it('answers the executed form when the column holds one', () => {
    const event = makeEventRow({
      input: '{"command":"ls"}',
      wire_input: '{"command":"cd /Users/dev/proj && ls"}',
      wire_input_storage: 'inline',
    });

    expect(wireDivergenceOf(event)).toEqual({
      body: '{"command":"cd /Users/dev/proj && ls"}',
      note: null,
    });
  });

  it.each([
    ['the column is NULL — the two agreed', null, null],
    ['the column holds the empty string', '', 'inline'],
  ])('answers null when %s', (_label, wire_input, wire_input_storage) => {
    // AC2: no new noise on the agreeing case, which is the majority.
    expect(wireDivergenceOf(makeEventRow({ wire_input, wire_input_storage }))).toBeNull();
  });

  it('notes a stored head, and only on line_ref', () => {
    const head = 'x'.repeat(64);
    const noteOf = (storage: string): string | null =>
      wireDivergenceOf(makeEventRow({ wire_input: head, wire_input_storage: storage }))?.note ??
      null;

    // The same sentence the INPUT and OUTPUT halves print, from the same source.
    expect(noteOf('line_ref')).toBe(
      contentStateOf(makeEventRow({ input: head, input_storage: 'line_ref' }), 'input', null).note,
    );
    expect(noteOf('inline')).toBeNull();
  });

  it('shows a body under an unrecognised storage word rather than hiding it', () => {
    // The column is the only source this half has, so a word this build does not
    // know must not blank bytes that are sitting right there.
    expect(
      wireDivergenceOf(
        makeEventRow({ wire_input: '{"a":1}', wire_input_storage: 'something-new' }),
      ),
    ).toEqual({ body: '{"a":1}', note: null });
  });

  it('reads the wire column and never the request column', () => {
    const event = makeEventRow({
      input: '{"command":"ls"}',
      input_storage: 'inline',
      wire_input: null,
      wire_input_storage: null,
    });

    // A predicate keyed on `input` would answer a body here and put the request
    // on screen twice.
    expect(wireDivergenceOf(event)).toBeNull();
  });
});

describe('imageViewsOf draws a fetched image or says why it cannot', () => {
  const event = makeEventRow({ id: 'ev-shot', image_count: 2 });

  it('has no slot at all for an event that carries no image', () => {
    expect(imageViewsOf(makeEventRow({ image_count: 0 }), null)).toEqual([]);
  });

  it('holds one empty slot per image while the fetch is in flight', () => {
    expect(imageViewsOf(event, null)).toEqual([
      { url: null, note: null },
      { url: null, note: null },
    ]);
  });

  it('ignores images fetched for a different event', () => {
    const stale = { eventId: 'ev-previous', outcomes: [{ url: 'blob:x' }, { url: 'blob:y' }] };
    expect(imageViewsOf(event, stale).map((view) => view.url)).toEqual([null, null]);
  });

  it.each([
    [410, 'Image no longer on disk.'],
    [413, 'Image too large to serve.'],
    [415, 'Image type not displayable.'],
    [500, 'Image could not be read.'],
    [null, 'Image could not be read.'],
  ])('states a refusal of %j as %j and offers no url to draw', (status, note) => {
    const views = imageViewsOf(event, {
      eventId: 'ev-shot',
      outcomes: [{ url: 'blob:first' }, { status }],
    });
    expect(views).toEqual([
      { url: 'blob:first', note: null },
      { url: null, note },
    ]);
  });
});

describe('the unrecognised fields are shown only for the event they were asked about', () => {
  const FIELD = { line: 'emitting', name: 'futureHarnessField', value: '"m"' } as const;

  it('answers the fields for the selected event', () => {
    const body = makeUnrecognisedFields({ fields: [FIELD] });
    expect(unrecognisedFieldsOf(makeEventRow(), body)).toEqual([FIELD]);
  });

  it('answers null for no body, an empty list, and a body for another event', () => {
    const event = makeEventRow();
    expect(unrecognisedFieldsOf(event, null)).toBeNull();
    expect(unrecognisedFieldsOf(event, makeUnrecognisedFields())).toBeNull();
    expect(
      unrecognisedFieldsOf(event, makeUnrecognisedFields({ id: 'ev-2', fields: [FIELD] })),
    ).toBeNull();
  });
});

describe('the permission grounds are shown only on a call that stated them', () => {
  it.each([
    ['neither', null, null, null],
    ['a source only', 'user_temporary', null, { source: 'user_temporary', reason: null }],
    ['a reason only', null, 'mode', { source: null, reason: 'mode' }],
    ['both', 'config', 'classifier', { source: 'config', reason: 'classifier' }],
  ])('answers %s verbatim', (_label, permission_source, permission_reason_type, expected) => {
    expect(permissionOf(makeEventRow({ permission_source, permission_reason_type }))).toEqual(
      expected,
    );
  });
});
