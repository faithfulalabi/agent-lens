// AC4 (CLI parsing): `parseHost` mirrors `parsePort` — supports `--host <h>` and
// `--host=<h>`, returns undefined when absent (default loopback bind), and errors
// on a missing value.

import { describe, expect, it } from 'vitest';
import { parseHost } from '../commands/start.js';

describe('parseHost', () => {
  it('returns undefined when --host is absent (default loopback bind)', () => {
    expect(parseHost([])).toBeUndefined();
    expect(parseHost(['--port', '4470'])).toBeUndefined();
  });

  it('parses the space-separated form: --host <h>', () => {
    expect(parseHost(['--host', '0.0.0.0'])).toBe('0.0.0.0');
    expect(parseHost(['--port', '4470', '--host', '192.168.1.5'])).toBe('192.168.1.5');
  });

  it('parses the equals form: --host=<h>', () => {
    expect(parseHost(['--host=0.0.0.0'])).toBe('0.0.0.0');
  });

  it('throws when --host has no value', () => {
    expect(() => parseHost(['--host'])).toThrow(/--host requires a value/);
    expect(() => parseHost(['--host='])).toThrow(/--host requires a value/);
  });
});
