// The spill index: copies spilled tool-output bodies (whose `events.text` stays
// NULL) into `spill_fts`, and is the only writer of that table.
//
// It runs OUTSIDE the projection on purpose, so `projectSession` stays a pure
// function of the transcript bytes. The reconcile re-probes EVERY indexed row
// rather than trusting `events` to flip: a sub-agent's body lives under its
// grandparent's `tool-results/`, and deleting it never reprojects the sub-agent.
// The env is declared here, not imported, so `db/` never points at `content/`.

import type { DatabaseSync } from 'node:sqlite';
import { EVENT_CONTENT_COLUMNS, type EventContentRow } from './read.js';

/** A body over this is skipped by path. An index policy, not a decompression guard. */
export const SPILL_INDEX_MAX_BYTES = 8 * 1024 * 1024;

type ResolvedBody = { storage: string; content: string; byte_size: number };

/** The detail screen's spill arm, bound by the caller. */
export interface SpillIndexEnv {
  resolve(row: EventContentRow, field: 'text'): ResolvedBody;
  /** Where the body is readable now, or `undefined`. Probes only. */
  locate(row: EventContentRow): string | undefined;
}

/** Omit all three for an unbudgeted pass (the CLI `warm`). */
export interface SpillIndexOptions {
  now?: () => number;
  startedAt?: number;
  deadlineMs?: number;
}

export interface SpillIndexReport {
  indexed: number;
  removed: number;
  /** Unreadable or over the cap, by path. */
  skipped: string[];
}

interface IndexedRow {
  rowid: number;
  event_id: string;
  spill_path: string;
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

const keyOf = (event_id: string, spill_path: string): string => `${event_id}\u0000${spill_path}`;

/**
 * One pass: reconcile every indexed row (whole, unbudgeted: probes only), then
 * index the bodies not yet in. The deadline is checked between bodies and never
 * before the first, so a late pass still indexes one. Never throws for an
 * unreadable body: that is a skip, retried next pass.
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
  for (const row of db.prepare(INDEXED_SQL).all() as unknown as IndexedRow[]) {
    const content =
      row.current_storage === 'spill' && row.current_path === row.spill_path
        ? (contentRow.get(row.event_id) as unknown as EventContentRow | undefined)
        : undefined;
    if (content === undefined || env.locate(content) === undefined) {
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

    // A declared size over the cap rules the body out unread.
    if (row.spill_bytes !== null && row.spill_bytes > SPILL_INDEX_MAX_BYTES) {
      report.skipped.push(path);
      continue;
    }

    let body: ResolvedBody;
    try {
      body = env.resolve(row, 'text');
    } catch {
      // The real resolver never throws; an injected one must not take the tick down.
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
