import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { activitySummary, buildThread, groupThread } from '@/lib/thread';
import { makeEventRow, makeSessionRow } from '@/lib/__tests__/fixtures';
import { ThreadView } from '../ThreadView';
import { MessageContent } from '../MessageContent';
import { SessionHeader } from '../SessionHeader';

const startedAt = '2026-09-12T10:00:00Z';

describe('conversation grouping', () => {
  it('preserves every event in sequence, including records outside turns', () => {
    const kinds = [
      'unknown',
      'prompt',
      'thinking',
      'tool_call',
      'unknown',
      'text',
      'error',
      'compaction',
      'unknown',
      'prompt',
    ];
    const rows = buildThread(
      kinds.map((kind, seq) =>
        makeEventRow({ id: `e${seq}`, seq, kind, turn_id: 'unmatched-turn' }),
      ),
    );
    const sections = groupThread(rows);
    expect(
      sections.flatMap((section) => (section.kind === 'message' ? [section.row] : section.rows)),
    ).toEqual(rows);
    expect(sections.map((section) => section.kind)).toEqual([
      'activity',
      'message',
      'activity',
      'message',
      'message',
      'message',
      'activity',
      'message',
    ]);
  });

  it('keeps the activity key stable when live events append', () => {
    const first = makeEventRow({ id: 'first', kind: 'tool_call', seq: 1 });
    const second = makeEventRow({ id: 'second', kind: 'thinking', seq: 2 });
    expect(groupThread(buildThread([first]))[0]?.id).toBe(
      groupThread(buildThread([first, second]))[0]?.id,
    );
    expect(groupThread([])).toEqual([]);
  });

  it('summarizes tool calls, linked agents, reasoning and raw records', () => {
    const rows = buildThread([
      makeEventRow({ kind: 'tool_call', child_session_id: 'child' }),
      makeEventRow({ kind: 'thinking' }),
      makeEventRow({ kind: 'unknown' }),
    ]);
    expect(activitySummary(rows)).toBe('1 tool call · 1 subagent · reasoning · 1 record');
  });
});

describe('progressive disclosure', () => {
  it('starts activity, tools and real reasoning closed while preserving the complete recorded text', () => {
    const reasoning = 'Recorded reasoning. '.repeat(100);
    const output = 'Long output. '.repeat(100);
    const rows = buildThread([
      makeEventRow({ id: 'p', seq: 1, kind: 'prompt', text: 'Please help' }),
      makeEventRow({ id: 'r', seq: 2, kind: 'thinking', text: reasoning }),
      makeEventRow({
        id: 't',
        seq: 3,
        kind: 'tool_call',
        text: output,
        status: 'error',
        child_session_id: 'child/1',
      }),
      makeEventRow({ id: 'a', seq: 4, kind: 'text', text: 'All done' }),
    ]);
    const markup = renderToStaticMarkup(<ThreadView rows={rows} startedAt={startedAt} />);
    expect(markup).toContain('>You<');
    expect(markup).toContain('>Claude<');
    expect(markup).toContain('>Errors<');
    expect(markup).toContain('data-slot="thread-activity"');
    expect(markup).toContain('data-slot="thread-tool-detail"');
    expect(markup).toContain('data-slot="thread-reasoning"');
    expect(markup).not.toMatch(/<details[^>]*\bopen(?:=|>)/);
    expect(markup).toContain(reasoning);
    expect(markup).toContain(output);
    expect(markup).toContain('href="/session/child%2F1"');
    expect(markup).toContain('Open subagent thread');
  });

  it('provides an explicit empty state', () => {
    expect(renderToStaticMarkup(<ThreadView rows={[]} startedAt={startedAt} />)).toContain(
      'No messages recorded yet.',
    );
  });

  it('shows the session title and a way back from subagents', () => {
    const markup = renderToStaticMarkup(
      <SessionHeader
        session={makeSessionRow({ title: 'Fix the compiler' })}
        parentSessionId="root-session"
        now={0}
      />,
    );
    expect(markup).toContain('Fix the compiler');
    expect(markup).toContain('Back to parent session');
    expect(markup).toContain('href="/session/root-session"');
  });
});

it('uses the recorded subagent description instead of a directory fallback', () => {
  const markup = renderToStaticMarkup(
    <SessionHeader
      session={{
        ...makeSessionRow({ title: null, preview: null }),
        agent_description: 'Inspect archive retention',
      }}
      now={0}
    />,
  );
  expect(markup).toMatch(/<h1[^>]*>Inspect archive retention<\/h1>/);
});

describe('safe transcript Markdown', () => {
  it('renders headings, lists, fenced code and tables', () => {
    const markup = renderToStaticMarkup(
      <MessageContent
        text={
          '## Result\n\n**Done**\n\n- First\n- Second\n\n```sh\necho hello\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'
        }
      />,
    );
    expect(markup).toContain('<h2>Result</h2>');
    expect(markup).toContain('<strong>Done</strong>');
    expect(markup).toContain('<li>First</li>');
    expect(markup).toContain('<pre><code');
    expect(markup).toContain('<table>');
  });

  it('never loads transcript images or executes raw HTML and unsafe links', () => {
    const markup = renderToStaticMarkup(
      <MessageContent
        text={
          '![private](https://example.com/track)\n\n<img src="https://example.com/raw">\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n[docs](https://example.com/docs)'
        }
      />,
    );
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain('[Image: private]');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});
