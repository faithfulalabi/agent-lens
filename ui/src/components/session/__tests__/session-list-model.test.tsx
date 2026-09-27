import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { makeSessionRow } from '../../../lib/__tests__/fixtures';
import type { SessionListRow } from '../../../lib/api';
import { SessionListView } from '../SessionListView';

/*
 * Task 0.17 — the Model column. Split from session-list.test.tsx so it reads no
 * spec doc: every assertion here runs on any checkout.
 */

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function markupOf(rows: SessionListRow[]): string {
  return renderToStaticMarkup(
    <SessionListView
      rows={rows}
      sort="last_activity_at"
      direction="desc"
      onSortChange={() => undefined}
      cursor={-1}
      now={NOW}
    />,
  );
}

/** Each row anchor's `data-column="model"` cells, as `{ text, title }`. */
function modelCells(markup: string): Array<{ count: number; text: string; title?: string }> {
  const links = markup.match(/<a\b[^>]*>.*?<\/a>/g) ?? [];
  return links.map((link) => {
    const cells = [...link.matchAll(/<span data-column="model"([^>]*)>([^<]*)<\/span>/g)];
    const attrs = cells[0]?.[1] ?? '';
    const title = /title="([^"]*)"/.exec(attrs)?.[1];
    return { count: cells.length, text: cells[0]?.[2] ?? '', ...(title && { title }) };
  });
}

describe('the session list shows a Model column (Task 0.17)', () => {
  it('★ one cell per row: single model, two models dominant first, and none', () => {
    const markup = markupOf([
      makeSessionRow({ id: 'one' }),
      makeSessionRow({
        id: 'two',
        model: 'claude-opus-5-5',
        models: ['claude-opus-5-5', 'claude-fable-5-1'],
      }),
      makeSessionRow({ id: 'none', model: null, models: [], sub_models: [] }),
    ]);

    expect(markup).toContain('>Model</span>');
    expect(modelCells(markup)).toEqual([
      { count: 1, text: 'Sonnet 5', title: 'claude-sonnet-5' },
      { count: 1, text: 'Opus 5.5 +1', title: 'claude-opus-5-5, claude-fable-5-1' },
      { count: 1, text: '—' },
    ]);
  });

  it('<synthetic> never appears anywhere in the markup', () => {
    const markup = markupOf([
      makeSessionRow({ models: ['<synthetic>', 'claude-opus-5'], sub_models: ['<synthetic>'] }),
    ]);
    expect(markup).not.toContain('synthetic');
    expect(modelCells(markup)[0]!.text).toBe('Opus 5');
  });

  it('an unknown id renders verbatim, with the id on hover', () => {
    const markup = markupOf([makeSessionRow({ model: 'gpt-4o', models: ['gpt-4o'] })]);
    expect(modelCells(markup)).toEqual([{ count: 1, text: 'gpt-4o', title: 'gpt-4o' }]);
  });

  it('sub-agent models are counted and named apart on hover', () => {
    const markup = markupOf([
      makeSessionRow({ models: ['claude-opus-5-5'], sub_models: ['claude-haiku-4-5'] }),
    ]);
    expect(modelCells(markup)).toEqual([
      {
        count: 1,
        text: 'Opus 5.5 +1',
        title: 'claude-opus-5-5 · sub-agents: claude-haiku-4-5',
      },
    ]);
  });
});
