// Migration 002 — the rollup columns migration 001 left out. `spans` already
// carries `tokens_in/out/cache_read/cache_write`, but their parents do not:
// `traces` has none of the four, and `sessions` is missing the two cache ones.
// Task 2.4's "tokens in/out/cache on traces and sessions" cannot be satisfied
// without them.
//
// Every added column is `NOT NULL DEFAULT 0` with a CONSTANT default, so SQLite
// applies each `ADD COLUMN` as an O(1) catalog edit — no table rebuild, no data
// migration, no index churn. Deliberately nothing else lands here: `est_cost`
// stays `NOT NULL DEFAULT 0` on both parents (SQLite cannot relax `NOT NULL`
// without a 12-step rebuild, and the null-not-zero guarantee is span-level per
// spec/data-model.md:175), and no speculative `unpriced_span_count` — Phase 5
// owns that display question and a migration 003 is cheap.

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './index.js';

/** The six additive rollup columns. Runs inside the runner's transaction. */
function up(db: DatabaseSync): void {
  db.exec(`ALTER TABLE traces ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE traces ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE traces ADD COLUMN tokens_cache_read INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE traces ADD COLUMN tokens_cache_write INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE sessions ADD COLUMN tokens_cache_read INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE sessions ADD COLUMN tokens_cache_write INTEGER NOT NULL DEFAULT 0`);
}

/** Migration 002: rollup token columns on `traces` and `sessions`. */
export const migration002: Migration = {
  version: 2,
  name: 'rollup-columns',
  up,
};
