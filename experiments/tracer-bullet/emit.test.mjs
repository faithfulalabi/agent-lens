import { describe, it, expect } from 'vitest';
import { buildPayload, parseSize, SIZE_BANDS } from './emit.mjs';

describe('parseSize', () => {
  it.each([
    ['1KB', 1024],
    ['100KB', 102400],
    ['1MB', 1048576],
    ['10MB', 10485760],
    ['1kb', 1024],
    ['777', 777],
  ])('resolves %s to %d bytes', (arg, expected) => {
    expect(parseSize(arg)).toBe(expected);
  });

  it.each([
    ['', 'size required'],
    ['0', 'invalid'],
    ['abc', 'invalid'],
  ])('throws on %s', (arg) => {
    expect(() => parseSize(arg)).toThrow();
  });
});

describe('buildPayload', () => {
  it.each(Object.entries(SIZE_BANDS))('emits EXACTLY the band length for %s', (_label, bytes) => {
    expect(buildPayload(bytes).length).toBe(bytes);
  });

  it('emits exactly N bytes for arbitrary N', () => {
    for (const n of [1, 7, 63, 511, 512, 513, 999]) {
      expect(buildPayload(n).length).toBe(n);
    }
  });

  it('embeds byte-offset markers for truncation forensics', () => {
    const payload = buildPayload(2048);
    // A marker at offset 0 and 512 should be present so a truncated capture
    // reveals the cutoff offset.
    expect(payload).toContain('<<@000000000>>');
    expect(payload).toContain('<<@000000512>>');
  });

  it.each([[0], [-5], [1.5]])('rejects non-positive-integer byte count %s', (n) => {
    expect(() => buildPayload(n)).toThrow();
  });
});
