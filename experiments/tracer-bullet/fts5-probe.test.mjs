import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runFts5Probe } from './fts5-probe.mjs';

describe('runFts5Probe', () => {
  it('returns a definitive PASS with a sqlite version when FTS5 works', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const result = runFts5Probe(db);
      // On the ratified runtime (node:sqlite, Node >=24) FTS5 is bundled.
      expect(result.verdict).toBe('PASS');
      expect(result.sqlite).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.detail).toContain('MATCH');
    } finally {
      db.close();
    }
  });

  it('yields a definitive verdict (never throws) on a closed db', () => {
    const db = new DatabaseSync(':memory:');
    db.close();
    const result = runFts5Probe(db);
    expect(result.verdict).toBe('FAIL');
    expect(typeof result.detail).toBe('string');
  });
});
