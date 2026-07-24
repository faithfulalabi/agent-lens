import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { sqliteSmoke } from './index.js';

describe('node:sqlite runtime', () => {
  it('opens and closes an in-memory database', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => db.close()).not.toThrow();
  });

  it('round-trips a table + FTS5 virtual table', () => {
    expect(sqliteSmoke()).toBe(true);
  });
});
