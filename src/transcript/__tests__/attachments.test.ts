import { describe, expect, it } from 'vitest';
import { attachmentRecord } from '../attachments.js';
import { classifyLine, type ParsedLine } from '../line.js';
import { classifyFixture, ctx } from './fixtures.js';

function attachment(raw: Record<string, unknown>): ParsedLine {
  return classifyLine({ type: 'attachment', uuid: 'u', ...raw }, ctx());
}

const WRAPPED = '<system-reminder>\na.ts was read\n</system-reminder>';

describe('attachmentRecord answers only for attachment lines', () => {
  it.each(['assistant', 'user', 'system', 'mode', 'ai-title', 'cost-state'])(
    'a %s line answers undefined',
    (type) => {
      expect(attachmentRecord(classifyLine({ type, uuid: 'u' }, ctx()))).toBeUndefined();
    },
  );

  it('an attachment line always answers a record', () => {
    expect(attachmentRecord(attachment({}))).toEqual({ subtype: '', text: '[attachment]' });
  });
});

describe('rendered is a one-element array of {content}, never a string', () => {
  it('reads content out of the measured shape', () => {
    const record = attachmentRecord(attachment({ rendered: [{ content: WRAPPED }] }));
    expect(record?.text).toBe(WRAPPED);
  });

  it('keeps the system-reminder envelope verbatim', () => {
    const record = attachmentRecord(attachment({ rendered: [{ content: WRAPPED }] }));
    expect(record?.text?.startsWith('<system-reminder>')).toBe(true);
    expect(record?.text?.trimEnd().endsWith('</system-reminder>')).toBe(true);
  });

  it('reads only the first element when the harness sends more', () => {
    const record = attachmentRecord(
      attachment({ rendered: [{ content: 'first' }, { content: 'second' }] }),
    );
    expect(record?.text).toBe('first');
  });

  it.each([
    ['a bare string', 'plain text'],
    ['an empty array', []],
    ['a non-object element', ['plain text']],
    ['a null element', [null]],
    ['an element with no content', [{}]],
    ['a non-string content', [{ content: 42 }]],
    ['an object rather than an array', { content: WRAPPED }],
    ['null', null],
  ])('falls back to the placeholder when rendered is %s', (_label, rendered) => {
    const record = attachmentRecord(attachment({ attachment: { type: 'date' }, rendered }));
    expect(record?.text).toBe('[attachment date]');
  });
});

describe('the placeholder names the subtype when there is no rendered text', () => {
  it.each([
    'deferred_tools_record',
    'batching_reminder_sent',
    'prompt_snapshot',
    'credential_org',
    'command_permissions',
    'thinking_drop',
    'hook_system_message',
  ])('%s projects a placeholder naming itself', (type) => {
    const record = attachmentRecord(attachment({ attachment: { type } }));
    expect(record).toEqual({ subtype: type, text: `[attachment ${type}]` });
  });

  it.each([
    ['a missing attachment payload', undefined],
    ['a non-object payload', 'file'],
    ['a payload with no type', {}],
    ['a non-string type', { type: 42 }],
    ['a null type', { type: null }],
  ])('%s yields the bare placeholder and an empty subtype', (_label, payload) => {
    expect(attachmentRecord(attachment({ attachment: payload }))).toEqual({
      subtype: '',
      text: '[attachment]',
    });
  });
});

describe('subtype passes attachment.type through verbatim', () => {
  it.each(['total_tokens_reminder', 'edited_text_file', 'task_reminder', 'file', 'a type nobody'])(
    '%s survives unaltered',
    (type) => {
      expect(attachmentRecord(attachment({ attachment: { type } }))?.subtype).toBe(type);
    },
  );
});

describe('renderedInHumanTurn is read by nothing', () => {
  const RIHT = '<system-reminder>\nthe other rendering\n</system-reminder>';

  it('a line carrying both answers the text from rendered alone', () => {
    const record = attachmentRecord(
      attachment({ rendered: [{ content: WRAPPED }], renderedInHumanTurn: [{ content: RIHT }] }),
    );
    expect(record?.text).toBe(WRAPPED);
  });

  it('cannot stand in for an absent rendered', () => {
    const record = attachmentRecord(
      attachment({
        attachment: { type: 'queued_command' },
        renderedInHumanTurn: [{ content: RIHT }],
      }),
    );
    expect(record?.text).toBe('[attachment queued_command]');
  });
});

describe('every read is total', () => {
  it.each([
    ['a revoked proxy payload', Proxy.revocable({}, {}).proxy],
    ['a payload inheriting a type', Object.create({ type: 'inherited' })],
  ])('%s cannot throw', (_label, payload) => {
    expect(() => attachmentRecord(attachment({ attachment: payload }))).not.toThrow();
  });
});

describe('the measured fixture carries the shape this module reads', () => {
  it('its attachment line yields the rendered content, not the placeholder', () => {
    const { lines } = classifyFixture('harness-2-1-2xx.jsonl');
    const line = lines.find((candidate) => candidate.kind === 'attachment');
    expect(line).toBeDefined();
    const record = attachmentRecord(line!);
    expect(record?.subtype).toBe('file');
    expect(record?.text).toContain('a.ts was read');
    expect(record?.text).not.toContain('[attachment');
  });
});
