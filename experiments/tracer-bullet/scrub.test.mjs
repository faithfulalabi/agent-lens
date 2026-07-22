import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules, scrubText } from './scrub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'scrub.config.json'), 'utf8'));
const rules = compileRules(config);
const anon = {
  home: '/Users/realperson',
  user: 'realperson',
  homePlaceholder: config.anonymize.homePlaceholder,
  userPlaceholder: config.anonymize.userPlaceholder,
};

/** Secret shapes that must NOT survive scrubbing (matches SCRUBBING.md greps). */
const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

describe('scrubText redacts known secret shapes to zero hits', () => {
  it.each([
    'sk-ant-abcd1234EFGH5678ijkl',
    'sk-abcd1234EFGH5678ijklmnop',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnop1234567890',
    'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT',
  ])('leaves no residue for %s', (secret) => {
    const input = `{"tool_output":"leak=${secret} more text"}`;
    const out = scrubText(input, rules, anon);
    for (const shape of SECRET_SHAPES) {
      expect(shape.test(out)).toBe(false);
    }
  });

  it('redacts bearer and x-agentlens-token headers', () => {
    const input = 'Authorization: Bearer supersecretvalue123\nx-agentlens-token: tok_abc123';
    const out = scrubText(input, rules, anon);
    expect(out).not.toContain('supersecretvalue123');
    expect(out).not.toContain('tok_abc123');
    expect(out).toContain('Bearer REDACTED');
  });

  it('redacts key/token/secret/password assignments', () => {
    const input = '{"API_KEY":"deadbeef","PASSWORD":"hunter2","X_SECRET":"nope"}';
    const out = scrubText(input, rules, anon);
    expect(out).not.toContain('deadbeef');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('nope');
  });

  it('anonymizes home dir and username', () => {
    const input = '/Users/realperson/.claude/projects/x by realperson';
    const out = scrubText(input, rules, anon);
    expect(out).not.toContain('/Users/realperson');
    expect(out).not.toContain('realperson');
    expect(out).toContain('/home/USER');
  });

  it('redacts emails and private IPs', () => {
    const input = 'from a@corp.io at 10.1.2.3 and 192.168.5.9';
    const out = scrubText(input, rules, anon);
    expect(out).not.toContain('a@corp.io');
    expect(out).not.toContain('10.1.2.3');
    expect(out).not.toContain('192.168.5.9');
  });

  it('is deterministic and preserves JSON shape', () => {
    const input = '{"a":1,"b":{"c":"sk-ant-abcdefgh1234"}}';
    const first = scrubText(input, rules, anon);
    const second = scrubText(input, rules, anon);
    expect(first).toBe(second);
    expect(() => JSON.parse(first)).not.toThrow();
  });

  it('preserves Q3 size markers (non-secret content survives)', () => {
    const input = 'prefix <<@000000512>> suffix';
    expect(scrubText(input, rules, anon)).toContain('<<@000000512>>');
  });
});
