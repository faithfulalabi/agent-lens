// The v2 cache schema, carried verbatim from the data-model spec.
//
// Two mechanical escapes are applied to the SOURCE bytes and nothing else:
// a backslash becomes two, and a backtick is escaped. Both are byte-neutral at
// runtime, so the evaluated string equals the spec. The first one is not
// cosmetic: a lone trailing backslash inside a template literal is a
// LineContinuation, which folds the next line into a comment and silently drops
// the `file_size` column. `__tests__/schema.test.ts` asserts the full column set
// of every table for that reason — the spec itself is not in the repo, so no
// test can ever diff this file against it.
//
// There is no migration runner. cache.db is a disposable projection of the
// archive: a bump here makes `openDb` remove the file and re-sweep.

/** Bumping this makes `openDb` remove cache.db and recreate it. */
export const SCHEMA_VERSION = 1;

export const SCHEMA_DDL = `-- ~/.agent-lens/cache.db
--
-- THIS FILE IS A CACHE. Every byte is a pure function of ~/.agent-lens/archive/**  --
-- the verbatim append-only mirror of the .jsonl transcripts, sibling agent-*.meta.json,
-- and tool-results/*.txt. Deleting it loses NOTHING — that is not a claim about care
-- taken, it is a claim about what is in here.
--
-- The ARCHIVE is a different matter: deleting THAT loses data permanently, because
-- Claude Code expires the originals (measured: nothing older than 41 days survives).
--
-- THERE IS NO MIGRATION RUNNER. A schema change bumps SCHEMA_VERSION; db/open.ts unlinks
-- cache.db (+ -wal/-shm) and re-sweeps (~190 ms for session files today). src/db/migrate.ts
-- (135 LOC) and src/db/migrations/** (178 LOC) are deleted.
--
-- TIER A (sessions rows, index columns) is built by SWEEPING and is persisted forever,
--   invalidated per file on (mtime,size).
-- TIER B (turns, events, events_fts) is PER SESSION, LAZY on first open, and DISPOSABLE.
--   Dropping one session's Tier B is 3 statements. Worst measured rebuild: 45 ms.

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = OFF;    -- projections are dropped wholesale, per session, by hand
PRAGMA user_version = 1;      -- SCHEMA_VERSION; mismatch => unlink + recreate

-- =====================================================================  sessions
-- The file index AND the session-list row AND the projection freshness header,
-- fused into one table. Sub-agent sidecars live here too (parent_session_id NOT NULL),
-- which is what makes "expand a sub-agent" a RECURSION into the same endpoint rather
-- than a second entity, a second projector and a second read path.
CREATE TABLE sessions (
  id                    TEXT PRIMARY KEY,   -- sessionId (filename stem), or agentId for a sidecar

  -- SOURCE: ~/.claude/projects. Claude Code DELETES this (measured: dense 0-16 days, then
  -- 1 file at 25, 5 at 30, 4 at 40, nothing beyond). Present-tense, not hypothetical.
  source_path           TEXT NOT NULL,
  source_mtime_ms       INTEGER,            -- NULL once source_state='expired'
  source_size           INTEGER,
  source_head_sha256    TEXT,               -- first 4 KB; detects an in-place rewrite
  source_state          TEXT NOT NULL DEFAULT 'present',  -- present | expired | diverged

  -- ARCHIVE: ~/.agent-lens/archive. THE SYSTEM OF RECORD. Byte-identical, append-only.
  -- archive_size is ALWAYS derived from statSync at read time, never trusted from here --
  -- there is no counter to desynchronise, so there is no offset-commit-ordering problem.
  -- line_ref offsets in \`events\` are ARCHIVE-relative, never source-relative: source-relative
  -- refs break the moment Claude Code expires the file.
  archive_path          TEXT NOT NULL,
  archive_size          INTEGER NOT NULL DEFAULT 0,   -- last observed; advisory only
  archive_sha256        TEXT,               -- full-content hash, set at seal time
  archive_state         TEXT NOT NULL DEFAULT 'hot',  -- hot (raw) | sealed (.zst)
  archived_at           TEXT,
  sealed_at             TEXT,

  -- The Tier-B invalidation key. Compared against the ARCHIVE, because that is what the
  -- projector reads. Must ALSO fold max(child mtime) + sum(child size) across sidecars:
  -- measured, a parent went 1,814 s without a write while 11 sidecars grew by 3.76 MB, and
  -- parent-only invalidation froze every Agent row for 30 minutes.
  file_mtime_ms         INTEGER NOT NULL,   -- \\
  file_size             INTEGER NOT NULL,   -- / the invalidation key (archive-derived)

  project_path          TEXT NOT NULL,      -- cwd; the list groups and filters on it
  git_branch            TEXT,
  model                 TEXT,               -- most recent message.model
  harness_version       TEXT,               -- \`version\`; transcript-only, groups the drift report
  title                 TEXT,               -- LAST type:'ai-title' line
  preview               TEXT,               -- first human prompt, 200 chars

  started_at            TEXT NOT NULL,
  last_activity_at      TEXT NOT NULL,      -- last TOP-LEVEL timestamp; NOT the last nested one
                                            -- (trailing file-history-snapshot records carry nested
                                            --  timestamps up to 8 days later — measured)

  -- OWN rollups: this file only
  turn_count            INTEGER NOT NULL DEFAULT 0,  -- HUMAN prompts only (101 of 1,934 user lines)
  tool_call_count       INTEGER NOT NULL DEFAULT 0,
  error_count           INTEGER NOT NULL DEFAULT 0,  -- is_error === true, never !is_error
  tokens_in             INTEGER NOT NULL DEFAULT 0,
  tokens_out            INTEGER NOT NULL DEFAULT 0,  -- per-requestId LAST-line fold
  tokens_cache_read     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write    INTEGER NOT NULL DEFAULT 0,
  est_cost              REAL,                        -- NULL = unpriceable model, NEVER 0

  -- SUB-AGENT rollups: SUM over child rows. 65% of all transcript bytes are sidecars, so a
  -- session's cost is 2-6x wrong without these. Filled by the background sweep wave.
  agent_count           INTEGER NOT NULL DEFAULT 0,
  sub_tool_call_count   INTEGER NOT NULL DEFAULT 0,
  sub_error_count       INTEGER NOT NULL DEFAULT 0,
  sub_tokens_in         INTEGER NOT NULL DEFAULT 0,
  sub_tokens_out        INTEGER NOT NULL DEFAULT 0,
  sub_tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  sub_tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  sub_est_cost          REAL,
  rollup_state          TEXT NOT NULL DEFAULT 'own', -- 'own' | 'complete'

  -- sidecar linkage (NULL on a top-level session)
  parent_session_id     TEXT,
  spawned_by_event_id   TEXT,               -- the Agent tool_call event id (meta.json toolUseId)
  agent_type            TEXT,               -- 'approach-critic' | 'Explore' | ...
  agent_description     TEXT,
  spawn_depth           INTEGER,

  -- Tier B freshness. ALL THREE must match to count as a cache hit.
  projected_mtime_ms    INTEGER,            -- NULL => never projected
  projected_size        INTEGER,
  projector_version     INTEGER,
  projected_at          TEXT,
  projection_state      TEXT NOT NULL DEFAULT 'none',  -- none | ready | failed | empty
                                            -- 'empty' is the tombstone: the file
                                            -- projected no header, so it has no turns,
                                            -- events or FTS rows and must not be re-read
  projection_error      TEXT,
  drift_json            TEXT NOT NULL DEFAULT '{}'
);

-- The partial predicate keeps sidecars — 65% of the corpus by bytes — out of every list scan.
-- The \`, id DESC\` tail makes the ORDER BY total and single-pass, fixing the documented
-- "no tiebreaker for same-millisecond sessions" wart in today's db/reads.ts.
CREATE INDEX idx_sessions_recent  ON sessions(last_activity_at DESC, id DESC)
  WHERE parent_session_id IS NULL;
CREATE INDEX idx_sessions_project ON sessions(project_path, last_activity_at DESC, id DESC)
  WHERE parent_session_id IS NULL;
CREATE INDEX idx_sessions_parent  ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;

-- ========================================================================  turns
-- One row per promptId group. The collapsible header on screen 2.
CREATE TABLE turns (
  id                 TEXT PRIMARY KEY,      -- '<session_id>:<seq>'
  session_id         TEXT NOT NULL,
  seq                INTEGER NOT NULL,
  kind               TEXT NOT NULL,         -- human | task_notification | slash_command
                                            -- | compaction | system | unknown
  parent_event_id    TEXT,                  -- BLOCKING FIX #3. When kind='task_notification',
                                            -- the Agent tool_call event that spawned it (join on
                                            -- <tool-use-id>), so machinery FOLDS under its Agent
                                            -- row instead of rendering as a top-level turn.
                                            -- Measured without it: 15 of 19 turns in one session
                                            -- and 17 of 28 in another render as raw XML headers.
  title              TEXT NOT NULL,         -- prompt text, 200 chars
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  duration_ms        INTEGER,
  duration_source    TEXT,                  -- 'turn_duration' (system line) | 'derived'
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  est_cost           REAL,
  tool_call_count    INTEGER NOT NULL DEFAULT 0,
  error_count        INTEGER NOT NULL DEFAULT 0,
  first_seq          INTEGER NOT NULL,      -- the event window this turn owns; also the live cursor
  last_seq           INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_turns_session_seq ON turns(session_id, seq);

-- =======================================================================  events
-- THE table. One row per thing the UI draws, in file order. A tool_use and its
-- tool_result are ONE row, not two — that fold is what deletes both \`spans\` and
-- \`messages\` from the old model. Content is INLINE up to 64 KB (measured p99 = 31.7 KB),
-- so the thread renders with ZERO follow-up requests; above that we store an 8 KB head
-- preview plus a (offset,len,block) REF back into the .jsonl, which honours
-- "never copy the transcript" and drops the measured 13.0 ms of 15.1 ms payload write.
CREATE TABLE events (
  id                 TEXT PRIMARY KEY,      -- 'toolu_...' for a tool_call, else '<uuid>:<blockIndex>'
                                            -- (0 duplicate uuids across 23,109 corpus-wide)
  session_id         TEXT NOT NULL,
  turn_id            TEXT NOT NULL,
  seq                INTEGER NOT NULL,      -- thread order; deterministic from the file bytes
  kind               TEXT NOT NULL,         -- prompt | text | thinking | tool_call
                                            -- | error | compaction | unknown
  ts                 TEXT NOT NULL,
  request_id         TEXT,                  -- groups the N lines of ONE assistant response
                                            -- (1:1 with message.id; 13,629/13,630 lines = 1 block)
  block_index        INTEGER,

  name               TEXT,                  -- tool name, for kind='tool_call'
  status             TEXT,                  -- ok | error | denied | running
  duration_ms        INTEGER,
  duration_source    TEXT,                  -- 'elapsed' | 'sidecar_span' | 'reported'
                                            -- NEVER labelled "execution": a 61 ms Bash reads
                                            -- 8,063 ms elapsed when a human sat on the approval

  input              TEXT,                  -- tool_use.input as JSON text (full, or 8 KB preview)
  input_bytes        INTEGER,               -- TRUE logical size
  input_storage      TEXT,                  -- inline | line_ref | absent
  text               TEXT,                  -- prose / thinking / prompt / tool output
  text_bytes         INTEGER,
  output_storage     TEXT,                  -- inline | line_ref | spill | missing | absent
  spill_path         TEXT,                  -- resolved <session-dir>/tool-results/*.txt
  spill_bytes        INTEGER,

  -- provenance + the line_ref resolver's coordinates. File path is derivable from
  -- sessions.file_path, because a sidecar IS a sessions row.
  src_offset         INTEGER NOT NULL,      -- byte offset of the emitting line
  src_len            INTEGER NOT NULL,
  result_offset      INTEGER,               -- byte offset of the tool_result line
  result_len         INTEGER,
  result_block       INTEGER,

  model              TEXT,                  -- \\  stamped on the FIRST event of each requestId
  tokens_in          INTEGER,               --  } group ONLY. Naive summing is 1.51x HIGH,
  tokens_out         INTEGER,               --  } first-line-only is 2.6x LOW; correct is the
  tokens_cache_read  INTEGER,               --  } LAST line's output_tokens with input/cache
  tokens_cache_write INTEGER,               --  } taken once per requestId.
  est_cost           REAL,                  -- /

  child_session_id   TEXT,                  -- Agent tool_call -> the sidecar's sessions row
  agent_type         TEXT,
  agent_status       TEXT,                  -- completed | failed | killed | running

  raw_type           TEXT NOT NULL,         -- the harness's own \`type\`, VERBATIM
  raw_subtype        TEXT,
  attrs              TEXT NOT NULL DEFAULT '{}'  -- ALLOWLIST ONLY: attributionSkill,
                                            -- attributionAgent, effort, permissionMode,
                                            -- compactMetadata, toolDenialKind, unknown_fields[]
);
CREATE UNIQUE INDEX idx_events_session_seq ON events(session_id, seq);
CREATE INDEX        idx_events_turn        ON events(turn_id, seq);
CREATE INDEX        idx_events_slow        ON events(session_id, kind, duration_ms DESC);
CREATE INDEX        idx_events_child       ON events(child_session_id)
  WHERE child_session_id IS NOT NULL;

-- ===================================================================  full text
-- External-content FTS5 over events(text, input): in-session search on day one and
-- cross-session search over every projected session, from ONE table. This is the
-- concrete replacement for today's payloads_fts, which migration 001 creates and
-- NOTHING populates. Dropping a session's projection MUST run the 'delete' idiom
-- first; db/write.ts:deleteSessionProjection() is the only place that does it, and a
-- test asserts INSERT INTO events_fts(events_fts, rank) VALUES('integrity-check', 1)
-- passes after 3 drop/reproject cycles, and that the inverted order throws
-- 'database disk image is malformed' on the FIRST cycle.
-- CORRECTED 2026-08-19 by measurement: this used to ask for fts row count == events
-- row count, which is vacuous here. count(*) on an external-content table delegates
-- to the content table, so it reads equal in the inverted order too, and bare
-- integrity-check answers ok in every broken state. Only the rank=1 form discriminates.
CREATE VIRTUAL TABLE events_fts USING fts5(
  text,
  input,
  content='events',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- ========================================================================  meta
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- seeded: schema_version, projector_version, projects_root, index_built_at`;
