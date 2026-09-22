// The spill index: the bodies of spilled tool output, searchable.
//
// A spill row keeps `text` NULL by contract (`write.ts`, the comment on the
// `text` bind in `insertEvents`), so its body never reaches `events_fts`. This
// module copies each body into `spill_fts` (`schema.ts`) and is the ONLY writer
// of that table — insert and delete alike.
//
// ★ OUTSIDE THE PROJECTION, ON PURPOSE. `projectSession` stays a pure function of
// the transcript bytes plus a boolean existence probe; nothing here runs inside
// its savepoint, and nothing the projection writes depends on this having run.
// The drain is a pure function of the `events` rows and the files they point at,
// so running it after any projection, any number of times, converges.
//
// ★ RECONCILE FIRST, BY RE-PROBING EVERY INDEXED ROW. A reconcile keyed on
// `events` flipping to `missing` would have a hole exactly where most spills sit:
// a sub-agent's body lives under its GRANDPARENT's `tool-results/`, deleting it
// moves the parent's fold but never the sub-agent's, and the sub-agent's row
// stays `spill` for good. So every pass asks the locator — the same question the
// detail screen asks — about every indexed row, at two existence probes each.
//
// IT NEVER POINTS AT `src/content/`. The env is declared here, structurally, the
// way `content/resolve.ts` declares `ResolvedContent` rather than importing it.
// The caller binds `createContentResolver` and `createSpillLocator` into it, so
// the index holds exactly the bytes the detail screen would serve.

import type { DatabaseSync } from 'node:sqlite';
import { EVENT_CONTENT_COLUMNS, type EventContentRow } from './read.js';

/**
 * 8 MiB. A body larger than this is skipped by path rather than indexed. An
 * index policy, not a decompression guard — the reader's own 64 MB bound is that.
 */
export const SPILL_INDEX_MAX_BYTES = 8 * 1024 * 1024;

/** The two halves of the detail screen's spill arm, bound by the caller. */
export interface SpillIndexEnv {
  /** Reads the whole body. `storage` is `'spill'` only when it was readable. */
  resolve(
    row: EventContentRow,
    field: 'text',
  ): { storage: string; content: string; byte_size: number };
  /** Where the body is readable NOW, or `undefined`. Probes only; reads nothing. */
  locate(row: EventContentRow): string | undefined;
}

export interface SpillIndexOptions {
  /** Omit all three for an unbudgeted pass (the CLI `warm`). */
  now?: () => number;
  startedAt?: number;
  deadlineMs?: number;
}

export interface SpillIndexReport {
  /** Bodies written this pass. */
  indexed: number;
  /** Rows the reconcile deleted this pass. */
  removed: number;
  /** Spill pointers left unindexed this pass — unreadable or over the cap — by path. */
  skipped: string[];
}

interface IndexedRow {
  rowid: number;
  event_id: string;
  spill_path: string;
  /** The live `events` row's columns, NULL when that row is gone. */
  current_storage: string | null;
  current_path: string | null;
}

const INDEXED_SQL = `SELECT f.rowid AS rowid, f.event_id AS event_id, f.spill_path AS spill_path,
    e.output_storage AS current_storage, e.spill_path AS current_path
  FROM spill_fts f LEFT JOIN events e ON e.id = f.event_id
  ORDER BY f.rowid`;

const CANDIDATES_SQL = `SELECT ${EVENT_CONTENT_COLUMNS} FROM events
  WHERE output_storage = 'spill' AND spill_path IS NOT NULL
  ORDER BY session_id, seq`;

const CONTENT_ROW_SQL = `SELECT ${EVENT_CONTENT_COLUMNS} FROM events WHERE id = ?`;

const DELETE_SQL = `DELETE FROM spill_fts WHERE rowid = ?`;

const INSERT_SQL = `INSERT INTO spill_fts(event_id, session_id, spill_path, text, input)
  VALUES (?, ?, ?, ?, NULL)`;

function keyOf(event_id: string, spill_path: string): string {
  return `${event_id}\u0000${spill_path}`;
}

/**
 * One pass: reconcile every indexed row, then index the spill bodies not yet in.
 *
 * The reconcile runs whole and unbudgeted — it is probes, never bodies. The
 * deadline is checked BETWEEN bodies and never before the first, the shape wave 2
 * uses between trees, so a pass that starts past its deadline still makes
 * progress at exactly one body. Never throws for an unreadable body: that is a
 * skip, named by path, and retried next pass.
 */
export function indexSpills(
  db: DatabaseSync,
  env: SpillIndexEnv,
  options: SpillIndexOptions = {},
): SpillIndexReport {
  const report: SpillIndexReport = { indexed: 0, removed: 0, skipped: [] };

  const indexed = new Set<string>();
  const remove = db.prepare(DELETE_SQL);
  const contentRow = db.prepare(CONTENT_ROW_SQL);
  /** The row leaves the index when its event, its pointer or its file is gone. */
  const isStale = (row: IndexedRow): boolean => {
    if (row.current_storage !== 'spill' || row.current_path !== row.spill_path) return true;
    const content = contentRow.get(row.event_id) as unknown as EventContentRow | undefined;
    return content === undefined || env.locate(content) === undefined;
  };
  for (const row of db.prepare(INDEXED_SQL).all() as unknown as IndexedRow[]) {
    if (isStale(row)) {
      remove.run(row.rowid);
      report.removed += 1;
    } else {
      indexed.add(keyOf(row.event_id, row.spill_path));
    }
  }

  const { now, startedAt, deadlineMs } = options;
  const budgeted = now !== undefined && startedAt !== undefined && deadlineMs !== undefined;
  const insert = db.prepare(INSERT_SQL);
  let bodies = 0;
  for (const row of db.prepare(CANDIDATES_SQL).all() as unknown as EventContentRow[]) {
    const path = row.spill_path!;
    if (indexed.has(keyOf(row.id, path))) continue;
    if (budgeted && bodies > 0 && now() - startedAt >= deadlineMs) break;

    // The DECLARED size, when the harness gave one, rules a body out unread.
    if (row.spill_bytes !== null && row.spill_bytes > SPILL_INDEX_MAX_BYTES) {
      report.skipped.push(path);
      continue;
    }

    let body: { storage: string; content: string; byte_size: number };
    try {
      body = env.resolve(row, 'text');
    } catch {
      // The resolver never throws by contract; an injected one that does must
      // not take the sweep's tick with it.
      report.skipped.push(path);
      continue;
    }
    if (body.storage !== 'spill') {
      report.skipped.push(path);
      continue;
    }
    bodies += 1;
    if (body.byte_size > SPILL_INDEX_MAX_BYTES) {
      report.skipped.push(path);
      continue;
    }
    insert.run(row.id, row.session_id, path, body.content);
    indexed.add(keyOf(row.id, path));
    report.indexed += 1;
  }

  return report;
}
