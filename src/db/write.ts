// The only module that writes a projection.
//
// `projectSession` is ONE unit of work — drop, project, insert, roll up, stamp —
// inside a SAVEPOINT. Anything less and a throw half way through leaves a
// half-session on disk behind a valid-looking freshness stamp, and the next read
// serves it.
//
// SAVEPOINT, NEVER `BEGIN`. Measured on node:sqlite v26 / SQLite 3.53.1: a
// nested `BEGIN` throws `cannot start a transaction within a transaction`, so a
// `BEGIN` here would make this function uncallable from the batching sweep that
// owns the corpus walk. A savepoint is atomic standalone and composes inside a
// caller's transaction.
//
// `deleteSessionProjection` runs the FTS5 external-content 'delete' idiom FIRST.
// The idiom READS the rows it de-indexes, so after the DELETE it is a silent
// no-op and the index keeps pointing at rowids that are gone. Nothing else
// dictates the order: the DDL declares zero REFERENCES clauses, so foreign keys
// are inert here in both directions.

import type { DatabaseSync } from 'node:sqlite';
import { type ProjectedEvent, type ProjectedTurn, runPipeline } from '../project/pipeline.js';
import {
  linkSubagents,
  type SidecarDescriptor,
  type SidecarSessionRow,
} from '../project/subagents.js';
import type { DriftCounter } from '../transcript/drift.js';
import type { ParsedLine } from '../transcript/line.js';
import { resolvePersistedOutput, type ResolveEnv, type SpillState } from '../transcript/spill.js';
import { PROJECTOR_VERSION } from '../transcript/version.js';
import { estimateCost } from '../shared/pricing.js';
import type { ArchiveFold } from './freshness.js';

/**
 * The three reads a projection needs, injected so this module opens no
 * transcript and every test is hermetic. The corpus sweep supplies all three.
 */
export interface ProjectionEnv {
  /**
   * The parsed lines AND the counter that parsing filled. Returning the lines
   * alone drops two of the three drift buckets on the floor: `noteLine` and
   * `noteUnknownType` fire during the read, and only `noteUnknownBlock` fires
   * inside `runPipeline`.
   */
  readLines(archivePath: string): { lines: readonly ParsedLine[]; drift: DriftCounter };
  /**
   * The spill probe for this transcript. Its `exists` must answer true for a
   * path present only as `<p>.zst`, or every sealed spill reports missing.
   */
  spillEnv(archivePath: string): ResolveEnv;
  /**
   * The sub-agent transcripts this session's `Agent` calls started. REQUIRED,
   * not optional: sidecars are 65% of the corpus by bytes, and an env that
   * quietly omitted them would project every session 2-6x cheap with nothing to
   * show for it.
   */
  sidecars(
    archivePath: string,
    sourcePath: string,
    toolUseIds: ReadonlySet<string>,
  ): SidecarDescriptor[];
}

/** Every `sessions` column that is NOT NULL and has no DDL default, plus the id. */
export interface SessionIndexRow {
  id: string;
  source_path: string;
  archive_path: string;
  file_mtime_ms: number;
  file_size: number;
  project_path: string;
  started_at: string;
  last_activity_at: string;
}

const UPSERT_INDEX_SQL = `INSERT INTO sessions
    (id, source_path, archive_path, file_mtime_ms, file_size,
     project_path, started_at, last_activity_at)
  VALUES
    (:id, :source_path, :archive_path, :file_mtime_ms, :file_size,
     :project_path, :started_at, :last_activity_at)
  ON CONFLICT(id) DO UPDATE SET
    source_path      = excluded.source_path,
    archive_path     = excluded.archive_path,
    file_mtime_ms    = excluded.file_mtime_ms,
    file_size        = excluded.file_size,
    project_path     = excluded.project_path,
    started_at       = excluded.started_at,
    last_activity_at = excluded.last_activity_at`;

/** The Tier-A writer. Touches no Tier-B stamp, so it never invalidates by accident. */
export function upsertSessionIndex(db: DatabaseSync, row: SessionIndexRow): void {
  db.prepare(UPSERT_INDEX_SQL).run({ ...row });
}

const UPSERT_SIDECAR_SQL = `INSERT INTO sessions
    (id, source_path, archive_path, file_mtime_ms, file_size,
     project_path, started_at, last_activity_at,
     parent_session_id, spawned_by_event_id, agent_type, agent_description, spawn_depth)
  VALUES
    (:id, :source_path, :archive_path, :file_mtime_ms, :file_size,
     :project_path, :started_at, :last_activity_at,
     :parent_session_id, :spawned_by_event_id, :agent_type, :agent_description, :spawn_depth)
  ON CONFLICT(id) DO UPDATE SET
    source_path         = excluded.source_path,
    archive_path        = excluded.archive_path,
    file_mtime_ms       = excluded.file_mtime_ms,
    file_size           = excluded.file_size,
    project_path        = excluded.project_path,
    started_at          = excluded.started_at,
    last_activity_at    = excluded.last_activity_at,
    parent_session_id   = excluded.parent_session_id,
    spawned_by_event_id = excluded.spawned_by_event_id,
    agent_type          = excluded.agent_type,
    agent_description   = excluded.agent_description,
    spawn_depth         = excluded.spawn_depth`;

/**
 * The Tier-A writer for a sub-agent, and the whole of "a sidecar IS a `sessions`
 * row". SHALLOW on purpose: the header limbs a full projection owns —
 * `git_branch`, `model`, `title`, the rollups — stay at their defaults until the
 * sidecar is projected in its own right, through this same module.
 *
 * Like `upsertSessionIndex`, it touches no Tier-B stamp, so linking a child
 * never invalidates a projection the child already has.
 */
export function upsertSidecarIndex(db: DatabaseSync, row: SidecarSessionRow): void {
  db.prepare(UPSERT_SIDECAR_SQL).run({
    ...row,
    agent_type: row.agent_type ?? null,
    agent_description: row.agent_description ?? null,
    spawn_depth: row.spawn_depth ?? null,
  });
}

/** The three statements, in this order and no other. See the module header. */
export function deleteSessionProjection(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO events_fts(events_fts, rowid, text, input)
       SELECT 'delete', rowid, text, input FROM events WHERE session_id = ?`,
  ).run(id);
  db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM turns  WHERE session_id = ?').run(id);
}

const INSERT_TURN_SQL = `INSERT INTO turns
    (id, session_id, seq, kind, parent_event_id, title, started_at, ended_at,
     duration_ms, duration_source, tokens_in, tokens_out, tokens_cache_read,
     tokens_cache_write, tool_call_count, error_count, first_seq, last_seq)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const INSERT_EVENT_SQL = `INSERT INTO events
    (id, session_id, turn_id, seq, kind, ts, request_id, block_index, name, status,
     duration_ms, duration_source, input, input_bytes, input_storage, text, text_bytes,
     output_storage, spill_path, spill_bytes, src_offset, src_len, result_offset,
     result_len, result_block, tokens_in, tokens_out, tokens_cache_read,
     tokens_cache_write, child_session_id, agent_type, agent_status, raw_type,
     raw_subtype, attrs)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

// FTS population costs 8-14x the rest of the SQLite write (5.6 -> 43.8 ms
// measured). It belongs in this transaction, and Phase 7 must keep it out of the
// 1 Hz live loop — stated here so that cost is not discovered there.
const POPULATE_FTS_SQL = `INSERT INTO events_fts(rowid, text, input)
  SELECT rowid, text, input FROM events WHERE session_id = ?`;

const WRITE_HEADER_SQL = `UPDATE sessions SET
    project_path     = COALESCE(:project_path, project_path),
    git_branch       = :git_branch,
    model            = :model,
    harness_version  = :harness_version,
    title            = :title,
    preview          = :preview,
    started_at       = :started_at,
    last_activity_at = :last_activity_at
  WHERE id = :id`;

const STAMP_SQL = `UPDATE sessions SET
    drift_json         = :drift_json,
    projected_mtime_ms = :mtime_ms,
    projected_size     = :size,
    projector_version  = :version,
    projected_at       = :projected_at,
    projection_state   = :state,
    projection_error   = NULL
  WHERE id = :id`;

const SAVEPOINT = 'agent_lens_projection';

/** `ready` wrote a session; `empty` tombstoned a file that projected nothing. */
export type ProjectionState = 'ready' | 'empty';

/**
 * Reproject one session whole, atomically. Rethrows on failure — the throw is
 * the contract a caller can rely on, the `failed` row is best effort.
 *
 * `fold` is the caller's, never re-taken here: both callers already hold one,
 * and taking a second would fold the same tree twice per miss.
 */
export function projectSession(
  db: DatabaseSync,
  id: string,
  env: ProjectionEnv,
  fold: ArchiveFold,
): ProjectionState {
  // `source_path` is selected because the sidecar resolver derives each child's
  // source path from the parent's. The mirror is path-identical below the two
  // roots, so the anchor is the only thing it cannot compute — and taking it off
  // the row keeps the resolver hermetic where re-deriving the root would read
  // ambient config.
  const row = db.prepare('SELECT archive_path, source_path FROM sessions WHERE id = ?').get(id) as
    { archive_path: string; source_path: string } | undefined;
  if (row === undefined) throw new Error(`no sessions row to project: ${id}`);

  db.exec(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const state = writeProjection(db, id, row.archive_path, row.source_path, env, fold);
    db.exec(`RELEASE ${SAVEPOINT}`);
    return state;
  } catch (error) {
    // `ROLLBACK TO` does not pop the savepoint; the `RELEASE` after it does.
    db.exec(`ROLLBACK TO ${SAVEPOINT}`);
    db.exec(`RELEASE ${SAVEPOINT}`);
    recordFailure(db, id, error);
    throw error;
  }
}

function writeProjection(
  db: DatabaseSync,
  id: string,
  archivePath: string,
  sourcePath: string,
  env: ProjectionEnv,
  fold: ArchiveFold,
): ProjectionState {
  deleteSessionProjection(db, id);

  const read = env.readLines(archivePath);
  const projection = runPipeline(read.lines, { session_id: id, drift: read.drift });

  // AFTER the pipeline, because the ids the resolver narrows on are the ids the
  // pipeline just minted. The `Agent` gate is what makes the resolver's cost
  // proportional to a session's OWN children rather than to the whole enclosing
  // tree — a leaf sub-agent asks for nothing and the resolver returns before its
  // readdir.
  const toolUseIds = new Set(
    projection.events
      .filter((event) => event.kind === 'tool_call' && event.name === 'Agent')
      .map((event) => event.id),
  );
  const sidecarRows = linkSubagents(
    projection.events,
    env.sidecars(archivePath, sourcePath, toolUseIds),
    projection.launches,
    read.drift,
  );

  const spills = resolveSpills(read.lines, env.spillEnv(archivePath));
  // `read.drift`, NOT `projection.drift`: the same counter object went into
  // `runPipeline`, and the link above may have bumped it since. The snapshot
  // taken at the pipeline's return cannot carry a key counted after it.
  const drift = withUnresolvedSpills(read.drift.serialize(), spills.unresolved);

  const header = projection.header;
  if (header === undefined) {
    // A TOMBSTONE, never a row deletion: the row belongs to the corpus sweep,
    // and `header === undefined` means "emitted nothing OR carried no top-level
    // timestamp", which is wider than the delete it replaces. The freshness
    // triple is stamped either way, so the file is not re-read on every request.
    stamp(db, id, fold, 'empty', drift);
    return 'empty';
  }

  db.prepare(WRITE_HEADER_SQL).run({
    // `project_path` is READ off the row the sweep wrote and never derived: the
    // archive stores the ENCODED project name while this column is the session's
    // own cwd, and the encoding maps `/` to `-` with no escaping, so decoding is
    // lossy and a minority of files disagree with their own slug. This COALESCE
    // is what corrects the sweep's best-effort seed; it leaves the seed in place
    // when the fold supplied no cwd. (A ratio was quoted here and rotted within
    // a week — the corpus grows hourly. The PROPERTY is what holds.)
    project_path: header.project_path ?? null,
    git_branch: header.git_branch ?? null,
    model: header.model ?? null,
    harness_version: header.harness_version ?? null,
    title: header.title ?? null,
    preview: header.preview ?? null,
    started_at: header.started_at,
    last_activity_at: header.last_activity_at,
    id,
  });

  // BEFORE the events, so `events.child_session_id` never points at a row that
  // does not exist yet inside this savepoint. Safe against the drop above, which
  // touches only `events`/`turns` for the parent id.
  for (const sidecar of sidecarRows) upsertSidecarIndex(db, sidecar);

  insertTurns(db, projection.turns);
  insertEvents(db, projection.events, spills.byOffset);
  db.prepare(POPULATE_FTS_SQL).run(id);
  recomputeSessionRollups(db, id);
  stamp(db, id, fold, 'ready', drift);
  return 'ready';
}

/** The freshness triple and the drift report, written once on every path. */
function stamp(
  db: DatabaseSync,
  id: string,
  fold: ArchiveFold,
  state: ProjectionState,
  drift: string,
): void {
  db.prepare(STAMP_SQL).run({
    drift_json: drift,
    mtime_ms: fold.mtime_ms,
    size: fold.size,
    version: PROJECTOR_VERSION,
    projected_at: new Date().toISOString(),
    state,
    id,
  });
}

/**
 * Best effort, and knowingly so: nested inside a caller's transaction that later
 * rolls back, this record goes with it and the writer cannot tell. Nothing reads
 * the column yet, so the cost is a repeated reprojection, not a wrong answer.
 * Any backoff over it belongs to the sweep, which is the only code that batches.
 */
function recordFailure(db: DatabaseSync, id: string, error: unknown): void {
  try {
    db.prepare(
      `UPDATE sessions SET projection_state = 'failed', projection_error = ? WHERE id = ?`,
    ).run(String(error), id);
  } catch {
    // A failure record that throws would replace the real error with itself.
  }
}

function insertTurns(db: DatabaseSync, turns: readonly ProjectedTurn[]): void {
  const insert = db.prepare(INSERT_TURN_SQL);
  for (const turn of turns) {
    insert.run(
      turn.id,
      turn.session_id,
      turn.seq,
      turn.kind,
      turn.parent_event_id ?? null,
      turn.title,
      turn.started_at,
      turn.ended_at,
      turn.duration_ms ?? null,
      turn.duration_source,
      turn.tokens_in,
      turn.tokens_out,
      turn.tokens_cache_read,
      turn.tokens_cache_write,
      turn.tool_call_count,
      turn.error_count,
      turn.first_seq,
      turn.last_seq,
    );
  }
}

function insertEvents(
  db: DatabaseSync,
  events: readonly ProjectedEvent[],
  spills: ReadonlyMap<number, SpillState>,
): void {
  const insert = db.prepare(INSERT_EVENT_SQL);
  for (const event of events) {
    const output = spillColumns(event, spills);
    insert.run(
      event.id,
      event.session_id,
      event.turn_id,
      event.seq,
      event.kind,
      event.ts,
      event.request_id ?? null,
      event.block_index,
      event.name ?? null,
      event.status ?? null,
      event.duration_ms ?? null,
      event.duration_source ?? null,
      event.input ?? null,
      event.input_bytes ?? null,
      event.input_storage ?? null,
      // NULL on every spill row, resolved and missing alike. Filling it would
      // mean opening the spill file, which the boolean-probe contract forbids
      // and which would make the projection time-varying. `spill_path` IS the
      // body's address; the content resolver dereferences it on demand.
      event.text ?? null,
      event.text_bytes ?? null,
      output.output_storage,
      output.spill_path,
      output.spill_bytes,
      event.src_offset,
      event.src_len,
      event.result_offset ?? null,
      event.result_len ?? null,
      event.result_block ?? null,
      event.tokens_in ?? null,
      event.tokens_out ?? null,
      event.tokens_cache_read ?? null,
      event.tokens_cache_write ?? null,
      event.child_session_id ?? null,
      event.agent_type ?? null,
      event.agent_status ?? null,
      event.raw_type,
      event.raw_subtype ?? null,
      event.attrs,
    );
  }
}

interface OutputColumns {
  output_storage: string | null;
  spill_path: string | null;
  spill_bytes: number | null;
}

/**
 * Resolve the spill half of the seam the projector marks. No path is ever
 * written that the probe did not confirm: an unreachable declared path is
 * reported through the `unresolved_spills` drift key, never through
 * `spill_path`, which the DDL documents as the RESOLVED path.
 */
function spillColumns(
  event: ProjectedEvent,
  spills: ReadonlyMap<number, SpillState>,
): OutputColumns {
  if (event.output_storage !== 'spill' || event.result_offset === undefined) {
    // Nothing was claimed here: the row keeps exactly what the projector emitted.
    return { output_storage: event.output_storage ?? null, spill_path: null, spill_bytes: null };
  }

  const state = spills.get(event.result_offset);
  if (state?.kind === 'resolved') {
    return {
      output_storage: 'spill',
      spill_path: state.path,
      // A marker-only claim declares no size, and the probe is a boolean, so
      // nothing here stats the file to invent one.
      spill_bytes: state.declaredSize ?? null,
    };
  }
  // `missing`, and the unresolvable claim too: a marked row with no confirmed
  // path is a lost body, never a spill row pointing at nothing.
  return { output_storage: 'missing', spill_path: null, spill_bytes: null };
}

interface SpillResolution {
  byOffset: ReadonlyMap<number, SpillState>;
  unresolved: number;
}

/**
 * ONE walk over the lines: the resolutions the insert needs, keyed by the byte
 * offset of the line that carried the claim, and the count the drift report
 * needs. Matching on that coordinate rather than on the harness's join field is
 * what keeps this module outside the door.
 */
function resolveSpills(lines: readonly ParsedLine[], env: ResolveEnv): SpillResolution {
  const byOffset = new Map<number, SpillState>();
  let unresolved = 0;
  for (const line of lines) {
    const state = resolvePersistedOutput(line.raw, env);
    if (state.kind === 'none') continue;
    byOffset.set(line.byte_offset, state);
    if (state.kind === 'missing') unresolved += 1;
  }
  return { byOffset, unresolved };
}

/**
 * Add the `unresolved_spills` KEY to the drift object — never a column; nothing
 * in the schema names it. Safe to append because `unresolved_spills` sorts after
 * every `unknown_*` key, so the column stays a deterministic sorted string, and
 * it is omitted at zero so `'{}'` keeps meaning "clean".
 */
function withUnresolvedSpills(drift: string, unresolved: number): string {
  if (unresolved === 0) return drift;
  const counted = JSON.parse(drift) as Record<string, unknown>;
  counted['unresolved_spills'] = unresolved;
  return JSON.stringify(counted);
}

const ROLLUP_SQL = `UPDATE sessions SET
    turn_count         = COALESCE((SELECT count(*)                FROM turns WHERE session_id = :id AND kind = 'human'), 0),
    tool_call_count    = COALESCE((SELECT sum(tool_call_count)    FROM turns WHERE session_id = :id), 0),
    error_count        = COALESCE((SELECT sum(error_count)        FROM turns WHERE session_id = :id), 0),
    tokens_in          = COALESCE((SELECT sum(tokens_in)          FROM turns WHERE session_id = :id), 0),
    tokens_out         = COALESCE((SELECT sum(tokens_out)         FROM turns WHERE session_id = :id), 0),
    tokens_cache_read  = COALESCE((SELECT sum(tokens_cache_read)  FROM turns WHERE session_id = :id), 0),
    tokens_cache_write = COALESCE((SELECT sum(tokens_cache_write) FROM turns WHERE session_id = :id), 0)
  WHERE id = :id`;

interface RollupRow {
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

/**
 * Recompute the own-file aggregates from `turns`, never delta arithmetic: a
 * recompute is idempotent, and every reprojection re-runs it. Every aggregate is
 * COALESCEd because `SUM`/`COUNT` over zero children returns NULL into a NOT
 * NULL column.
 *
 * The `sub_*` columns and `rollup_state` stay at their DDL defaults here.
 * `recomputeSubagentRollups` below owns them, and the corpus sweep's second wave
 * calls it only after every child of `id` is projected — a parent's total means
 * nothing before that.
 */
export function recomputeSessionRollups(db: DatabaseSync, id: string): void {
  // HUMAN turns only. The plain count is ~19x high: 101 human prompts against
  // 1,934 user lines in the measured session.
  db.prepare(ROLLUP_SQL).run({ id });

  const row = db
    .prepare(
      `SELECT model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write
       FROM sessions WHERE id = ?`,
    )
    .get(id) as RollupRow | undefined;
  if (row === undefined) return;

  // NULL for an unpriceable model, never 0: a zero silently under-reports every
  // total instead of showing the UI it has no price.
  const cost = estimateCost(row.model ?? undefined, {
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    cache_read: row.tokens_cache_read,
    cache_write: row.tokens_cache_write,
  });
  db.prepare('UPDATE sessions SET est_cost = ? WHERE id = ?').run(cost, id);
}

// TRANSITIVE: every aggregate sums each child's OWN column plus that child's own
// `sub_*`, so a depth-2 grandchild reaches the top-level total. A direct-children
// sum silently drops them, and the UI shows one number per top-level session.
// This is why the sweep must project children before parents.
//
// `sub_est_cost` is deliberately NOT `COALESCE`d to 0. It mirrors `est_cost`,
// whose DDL says "NULL = unpriceable model, NEVER 0"; the WHERE limb is what
// keeps a tree of entirely unpriceable children NULL instead of a confident
// zero. It sums the children's own costs rather than re-pricing summed tokens,
// because children routinely run a different model from their parent.
const SUBAGENT_ROLLUP_SQL = `UPDATE sessions SET
    agent_count            = COALESCE((SELECT sum(1 + c.agent_count)                                FROM sessions c WHERE c.parent_session_id = :id), 0),
    sub_tool_call_count    = COALESCE((SELECT sum(c.tool_call_count    + c.sub_tool_call_count)     FROM sessions c WHERE c.parent_session_id = :id), 0),
    sub_error_count        = COALESCE((SELECT sum(c.error_count        + c.sub_error_count)         FROM sessions c WHERE c.parent_session_id = :id), 0),
    sub_tokens_in          = COALESCE((SELECT sum(c.tokens_in          + c.sub_tokens_in)           FROM sessions c WHERE c.parent_session_id = :id), 0),
    sub_tokens_out         = COALESCE((SELECT sum(c.tokens_out         + c.sub_tokens_out)          FROM sessions c WHERE c.parent_session_id = :id), 0),
    sub_tokens_cache_read  = COALESCE((SELECT sum(c.tokens_cache_read  + c.sub_tokens_cache_read)   FROM sessions c WHERE c.parent_session_id = :id), 0),
    sub_tokens_cache_write = COALESCE((SELECT sum(c.tokens_cache_write + c.sub_tokens_cache_write)  FROM sessions c WHERE c.parent_session_id = :id), 0),
    sub_est_cost           =          (SELECT sum(COALESCE(c.est_cost, 0) + COALESCE(c.sub_est_cost, 0))
                                         FROM sessions c
                                        WHERE c.parent_session_id = :id
                                          AND (c.est_cost IS NOT NULL OR c.sub_est_cost IS NOT NULL))
  WHERE id = :id`;

/**
 * Recompute the sub-agent aggregates of one session from its child rows.
 *
 * A recompute, never delta arithmetic, so running it twice changes nothing. It
 * does NOT touch `rollup_state` — flipping that is the sweep's statement that
 * the whole descendant fixpoint was reached, which this function cannot know.
 */
export function recomputeSubagentRollups(db: DatabaseSync, id: string): void {
  db.prepare(SUBAGENT_ROLLUP_SQL).run({ id });
}
