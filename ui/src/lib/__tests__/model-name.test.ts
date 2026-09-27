// Task 0.17 — the session list's Model cell. Kept out of format.test.ts on
// purpose: this file reads no spec doc, so it runs everywhere.

import { describe, expect, it } from 'vitest';
import { modelCell, shortModelName } from '../format';

describe('shortModelName', () => {
  it.each([
    ['claude-opus-5', 'Opus 5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-opus-5-5[1m]', 'Opus 5.5'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['us.anthropic.claude-haiku-4-5', 'Haiku 4.5'],
    ['us.anthropic.claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude-3-5-haiku', 'Haiku 3.5'],
    // A family nobody priced still names itself: the shape is what matters.
    ['claude-quill-6', 'Quill 6'],
  ])('%j -> %j', (raw, short) => {
    expect(shortModelName(raw)).toBe(short);
  });

  it.each(['opus', 'gpt-4o', 'claude-opus', 'a-model-nobody-has-priced', ''])(
    'an unrecognised id %j comes back verbatim, never dropped',
    (raw) => {
      expect(shortModelName(raw)).toBe(raw);
    },
  );
});

describe('modelCell', () => {
  it('no model at all is the em dash, with no title', () => {
    expect(modelCell([], [])).toEqual({ text: '—', title: undefined });
  });

  it('one model is its short name, and the title is the full id', () => {
    expect(modelCell(['claude-opus-5-5'], [])).toEqual({
      text: 'Opus 5.5',
      title: 'claude-opus-5-5',
    });
  });

  it('★ two own models: dominant first, +1, both full ids on hover', () => {
    expect(modelCell(['claude-opus-5-5', 'claude-fable-5-1'], [])).toEqual({
      text: 'Opus 5.5 +1',
      title: 'claude-opus-5-5, claude-fable-5-1',
    });
  });

  it('a sub-agent-only model counts in +N and is named apart on hover', () => {
    expect(modelCell(['claude-opus-5-5'], ['claude-haiku-4-5'])).toEqual({
      text: 'Opus 5.5 +1',
      title: 'claude-opus-5-5 · sub-agents: claude-haiku-4-5',
    });
  });

  it('a sub-agent model the main session also used is not counted twice', () => {
    expect(modelCell(['claude-opus-5-5'], ['claude-opus-5-5'])).toEqual({
      text: 'Opus 5.5',
      title: 'claude-opus-5-5',
    });
  });

  it('a session whose only models are its sub-agents still names one', () => {
    expect(modelCell([], ['claude-haiku-4-5'])).toEqual({
      text: 'Haiku 4.5',
      title: 'sub-agents: claude-haiku-4-5',
    });
  });

  it('<synthetic> in either list never reaches the text or the title', () => {
    const cell = modelCell(['<synthetic>', 'claude-opus-5'], ['<synthetic>']);
    expect(cell).toEqual({ text: 'Opus 5', title: 'claude-opus-5' });
    expect(modelCell(['<synthetic>'], ['<synthetic>'])).toEqual({ text: '—', title: undefined });
  });

  it('two ids with the same short name count once', () => {
    expect(modelCell(['claude-opus-5', 'claude-opus-5-20260101'], []).text).toBe('Opus 5');
  });

  it('an unknown id is shown verbatim', () => {
    expect(modelCell(['gpt-4o'], [])).toEqual({ text: 'gpt-4o', title: 'gpt-4o' });
  });
});
