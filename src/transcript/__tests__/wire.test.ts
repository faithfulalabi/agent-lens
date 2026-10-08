// The wire-form door: `wireInputOf` reads one harness field, `sameValue` decides
// whether it disagrees with the model's own request.
//
// The comparison is STRUCTURAL and that is the substance of this file. Measured
// on the local corpus, one deep-equal pair differs in key order alone — a `Bash`
// call whose `timeout` and `run_in_background` the harness swapped — so a
// `JSON.stringify` comparison reports a divergence that is not one, on a row
// nothing should render anything extra for.

import { describe, expect, it } from 'vitest';
import { sameValue, wireInputOf } from '../wire.js';

describe('wireInputOf', () => {
  const line = {
    type: 'assistant',
    wireToolInputs: {
      toolu_a: { command: 'cd /Users/dev/proj && ls' },
      toolu_b: { file_path: '/tmp/x' },
    },
  };

  it('answers the entry keyed by the tool_use id', () => {
    expect(wireInputOf(line, 'toolu_a')).toEqual({ command: 'cd /Users/dev/proj && ls' });
    expect(wireInputOf(line, 'toolu_b')).toEqual({ file_path: '/tmp/x' });
  });

  it('answers undefined for an id the field does not key', () => {
    expect(wireInputOf(line, 'toolu_missing')).toBeUndefined();
  });

  it('answers undefined for a line carrying no wireToolInputs', () => {
    expect(wireInputOf({ type: 'assistant' }, 'toolu_a')).toBeUndefined();
  });

  it.each([
    ['a string', 'cd /tmp && ls'],
    ['an array', [{ command: 'ls' }]],
    ['null', null],
    ['a number', 7],
  ])('answers undefined when the field is %s rather than an object', (_label, value) => {
    expect(wireInputOf({ wireToolInputs: value }, 'toolu_a')).toBeUndefined();
  });

  it('answers undefined when the entry is not an object', () => {
    expect(wireInputOf({ wireToolInputs: { toolu_a: 'ls' } }, 'toolu_a')).toBeUndefined();
  });

  it('reads no inherited property, so a prototype key cannot answer an entry', () => {
    expect(wireInputOf({ wireToolInputs: {} }, 'toString')).toBeUndefined();
    expect(wireInputOf({ wireToolInputs: {} }, 'constructor')).toBeUndefined();
  });

  it('answers the SAME reference, never a copy', () => {
    const entry = { command: 'ls' };
    expect(wireInputOf({ wireToolInputs: { toolu_a: entry } }, 'toolu_a')).toBe(entry);
  });
});

describe('sameValue holds on values that agree', () => {
  it.each([
    ['two primitives', 'ls', 'ls'],
    ['two numbers', 7, 7],
    ['two booleans', false, false],
    ['two nulls', null, null],
    ['two undefineds', undefined, undefined],
    ['two empty objects', {}, {}],
    ['two empty arrays', [], []],
    ['equal flat objects', { command: 'ls' }, { command: 'ls' }],
    [
      'equal nested objects',
      { edits: [{ old: 'a', new: 'b' }], count: 1 },
      { edits: [{ old: 'a', new: 'b' }], count: 1 },
    ],
  ])('%s', (_label, a, b) => {
    expect(sameValue(a, b)).toBe(true);
  });

  // The measured case, and the one the obvious implementation fails.
  it('ignores key order, at the top level and nested', () => {
    const request = {
      command: 'ls',
      description: 'list',
      timeout: 900_000,
      run_in_background: true,
    };
    const wire = { command: 'ls', description: 'list', run_in_background: true, timeout: 900_000 };

    expect(sameValue(request, wire)).toBe(true);
    expect(sameValue({ outer: request }, { outer: wire })).toBe(true);
  });
});

describe('sameValue reports values that disagree', () => {
  it.each([
    ['a cd-prefixed command', { command: 'ls' }, { command: 'cd /Users/dev/proj && ls' }],
    ['an omitted key', { file_path: '/a', replace_all: false }, { file_path: '/a' }],
    ['an added key', { file_path: '/a' }, { file_path: '/a', replace_all: false }],
    ['a differing nested value', { edits: [{ old: 'a' }] }, { edits: [{ old: 'b' }] }],
    ['a shorter array', { edits: [1, 2] }, { edits: [1] }],
    ['an object against an array', { 0: 'a' }, ['a']],
    ['an object against a primitive', { command: 'ls' }, 'ls'],
    ['null against an empty object', null, {}],
    ['undefined against an empty object', undefined, {}],
    ['a number against its own digits', 7, '7'],
    ['a boolean against its own word', true, 'true'],
  ])('%s', (_label, a, b) => {
    expect(sameValue(a, b)).toBe(false);
  });

  it('is symmetric on every disagreeing pair', () => {
    expect(sameValue({ command: 'cd /x && ls' }, { command: 'ls' })).toBe(false);
    expect(sameValue({ file_path: '/a' }, { file_path: '/a', replace_all: false })).toBe(false);
  });

  it('separates a missing key from a key holding undefined', () => {
    // `JSON.parse` cannot produce the second, but the signature takes `unknown`
    // and an own key is an own key.
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});
