// Migration registry: the ordered list the runner applies. Migrations are
// TS-wrapped DDL (not loose `.sql` files) so they ship inside `dist/` with no
// bundling/`files` changes and stay inside the `src/db/` SQL boundary.

import type { DatabaseSync } from 'node:sqlite';
import { migration001 } from './001-initial-schema.js';

/** One numbered migration. `up` runs inside the runner's transaction. */
export interface Migration {
  /** Monotonic schema version this migration brings the DB to. */
  version: number;
  /** Human-readable slug, for logs. */
  name: string;
  /** Apply the migration's DDL. Must not manage its own transaction. */
  up(db: DatabaseSync): void;
}

/** All migrations in ascending `version` order. */
export const MIGRATIONS: readonly Migration[] = [migration001];
