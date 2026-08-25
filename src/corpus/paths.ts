// Pure string math over the archive mirror's layout. Nothing here opens a file,
// stats one, or reads ambient config beyond the two root resolvers it borrows
// from `src/archive/paths.ts`.
//
// ★ THE CLASSIFIER DECIDES BEFORE ANYTHING IS OPENED. That is the whole point:
// the 2026-08-19 ruling excludes `subagents/**/journal.jsonl` from the corpus,
// and a walker that had to parse a file to learn that would re-read it on every
// tick forever. The file carries no timestamp and no `cwd`, so no `sessions` row
// can exist for it, so no tombstone can stop the loop either — the exclusion has
// to be a discovery rule.
//
// Sidecar and `tool-results` directories are DERIVED from a transcript path, not
// discovered by a second walk. `<slug>/<stem>.jsonl` and `<slug>/<stem>/` are the
// same slice `foldArchive` already takes, so the two cannot drift.

import { join } from 'node:path';

const TRANSCRIPT_EXT = '.jsonl';
const SEALED_SUFFIX = '.zst';
const SUBAGENTS_DIR = 'subagents';
const TOOL_RESULTS_DIR = 'tool-results';
const WORKFLOWS_DIR = 'workflows';
const AGENT_PREFIX = 'agent-';
const JOURNAL_NAME = 'journal.jsonl';

/**
 * What the sweep does with one path.
 *
 * `excluded` and `ignored` both mean "no row", and the difference is worth a
 * word: `excluded` is a transcript a naive recursive `.jsonl` walker WOULD index and a
 * ruling says must not be, so it is reported by path; `ignored` is a file that
 * was never a transcript — a meta, a tool result, a checksum — and is counted.
 */
export type CorpusKind = 'session' | 'sidecar' | 'excluded' | 'ignored';

/** Forward slashes, no leading or trailing separator, empty parts dropped. */
function segments(relPath: string): string[] {
  return relPath
    .split('\\')
    .join('/')
    .split('/')
    .filter((part) => part !== '' && part !== '.');
}

/**
 * A project directory's encoded name. TOTAL and exact: Claude Code maps `/` to
 * `-` and nothing else, measured 5/5 over the real corpus.
 */
export function encodeProjectDir(projectPath: string): string {
  return projectPath.split('/').join('-');
}

/**
 * A BEST-EFFORT SEED, never an answer, and callers must treat it as one.
 *
 * `encodeProjectDir` is lossy: `/` becomes `-` with no escaping, so a directory
 * whose own name contains a hyphen is indistinguishable from a path separator
 * and `-Users-me-Desktop-agent-lens` decodes to `/Users/me/Desktop/agent/lens`,
 * which does not exist. The disagreement is a PROPERTY of the encoding, not a
 * ratio worth quoting — the corpus grows hourly and every ratio measured for it
 * has rotted within a week.
 *
 * The round-trip that holds is `slug -> seed -> header -> cwd`: the sweep seeds
 * `sessions.project_path` with this, and `WRITE_HEADER_SQL`'s
 * `COALESCE(:project_path, project_path)` overwrites it with the session's own
 * `cwd` at the first projection. A decoder that claimed to be total is the
 * defect this comment exists to prevent.
 */
export function decodeProjectDir(slug: string): string {
  return slug.split('-').join('/');
}

/** The addressable name of a possibly-sealed file: a trailing `.zst` removed. */
export function logicalPathOf(physicalPath: string): string {
  return physicalPath.endsWith(SEALED_SUFFIX)
    ? physicalPath.slice(0, -SEALED_SUFFIX.length)
    : physicalPath;
}

/**
 * The sibling directory holding a transcript's sidecars and tool results — the
 * same slice `foldArchive` takes. Returns the path unchanged for anything that
 * is not a transcript, which degrades exactly as the fold's own walk does.
 */
export function sessionDirOf(archivePath: string): string {
  return archivePath.endsWith(TRANSCRIPT_EXT)
    ? archivePath.slice(0, -TRANSCRIPT_EXT.length)
    : archivePath;
}

export function subagentsDirOf(archivePath: string): string {
  return join(sessionDirOf(archivePath), SUBAGENTS_DIR);
}

/**
 * The session directory a transcript's `tool-results/` hangs off. For a SIDECAR
 * this is the grandparent, not the sibling: `spill.ts:80-81` states the rule and
 * `discover.ts:11` enforces it, mirroring `tool-results/` only under
 * `<slug>/<stem>/`. Measured 2026-08-25 over 53 structured spill references: 34
 * sit in `subagents/agent-*.jsonl` and 0 of 65 archive `tool-results/` files sit
 * under `subagents/`, so `sessionDirOf` alone re-anchors 19 of 53 and this
 * re-anchors 53 of 53.
 *
 * The cut is on the LAST `/subagents/`, so the `subagents/workflows/wf_<id>/`
 * pocket lands on the same root as a flat sidecar.
 */
export function sessionRootOf(archivePath: string): string {
  const cut = archivePath.lastIndexOf(`/${SUBAGENTS_DIR}/`);
  return cut === -1 ? sessionDirOf(archivePath) : archivePath.slice(0, cut);
}

/** Where a transcript's spilled tool results are mirrored. Anchored at
 *  {@link sessionRootOf}, so a sidecar resolves to its parent's directory. */
export function toolResultsDirOf(archivePath: string): string {
  return join(sessionRootOf(archivePath), TOOL_RESULTS_DIR);
}

/**
 * Classify one archive-root-relative LOGICAL path. Total — there is no
 * `undefined` arm, which is what makes "zero unclassified" a type-level fact
 * rather than a count somebody has to keep checking.
 *
 * Pass the logical name (`logicalPathOf`), so a sealed file classifies
 * identically to its hot twin.
 *
 * Two directories are named `workflows` and only one is in scope. The archive's
 * `<slug>/<stem>/subagents/workflows/wf_<id>/` holds ordinary `agent-*.jsonl`
 * sidecars plus the excluded journal; the source tree's `<slug>/<stem>/workflows/`
 * holds scripts and is never mirrored, so the walk cannot reach it.
 */
export function classifyCorpusPath(relPath: string): CorpusKind {
  const parts = segments(relPath);
  const leaf = parts[parts.length - 1] ?? '';

  // `<slug>/<stem>.jsonl` — a top-level session. Anything else at this depth is
  // a checksum or the harness's own index.
  if (parts.length === 2) return leaf.endsWith(TRANSCRIPT_EXT) ? 'session' : 'ignored';

  // `<slug>/<stem>/subagents/…` to any depth. Sub-agents nest one flat listing
  // deep, plus the `workflows/wf_<id>/` pocket.
  if (parts.length >= 4 && parts[2] === SUBAGENTS_DIR) {
    if (leaf === JOURNAL_NAME) return 'excluded';
    return leaf.startsWith(AGENT_PREFIX) && leaf.endsWith(TRANSCRIPT_EXT) ? 'sidecar' : 'ignored';
  }

  return 'ignored';
}

/**
 * The top-level session a `subagents/workflows/` sidecar belongs to, by string
 * math over `<slug>/<stem>/subagents/workflows/wf_<id>/agent-*.jsonl`.
 *
 * These 12 sidecars carry no `toolUseId`, so the `meta.json` join that links
 * every other sidecar cannot reach them and the sweep indexes them itself. Left
 * unparented they would satisfy `idx_sessions_recent`'s
 * `parent_session_id IS NULL` predicate and appear on the first screen as
 * phantom top-level sessions — a 43% inflation of the list the product opens on.
 */
export function workflowParentOf(relPath: string): string | undefined {
  const parts = segments(relPath);
  if (parts.length < 5) return undefined;
  if (parts[2] !== SUBAGENTS_DIR || parts[3] !== WORKFLOWS_DIR) return undefined;
  return parts[1];
}

/** The encoded project directory a relative archive path sits under. */
export function projectSlugOf(relPath: string): string {
  return segments(relPath)[0] ?? '';
}

/**
 * The `sessions.id` a transcript path becomes: its filename stem, with a
 * sidecar's `agent-` prefix removed so the sweep and `linkSubagents` mint the
 * same id for the same file and cannot produce two rows for it.
 */
export function rowIdOf(relPath: string): string {
  const parts = segments(relPath);
  const leaf = parts[parts.length - 1] ?? '';
  const stem = leaf.endsWith(TRANSCRIPT_EXT) ? leaf.slice(0, -TRANSCRIPT_EXT.length) : leaf;
  return stem.startsWith(AGENT_PREFIX) ? stem.slice(AGENT_PREFIX.length) : stem;
}
