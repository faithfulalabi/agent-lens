// The transcript tailer: the fidelity half of capture. Hooks tell us WHEN things
// happened; the transcript carries WHAT was said — full content, thinking, token
// counts. The format is officially unstable and the file is append-mostly, so the
// whole game is offsets, fingerprints, and defensive parsing.
//
// Shape, deliberately mirroring `inactivity.ts`: `tailOnce` is ONE synchronous
// pass with no timers of its own. The caller (`startServer`) owns the interval,
// so tests drive it directly and never mock a clock.
//
// **Every line — first read or re-read — is funnelled through `ingestBatch`.**
// This is the hard constraint Task 2.6a found: `closeActiveTrace` resolves its
// target by lookup, so re-projecting an already-projected event corrupts trace
// closure. `ingestBatch`'s archive dedupe returns before `normalize` ever runs,
// which is what makes a fingerprint-mismatch re-read converge instead of corrupt.
// `reprocess.ts` calls `normalize` directly and is valid ONLY for dead letters
// that never projected — this module must never copy that shape, and never
// imports `normalize`.

import { createHash } from 'node:crypto';
import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  commitTailerOffset,
  readTailerOffset,
  transcriptPathsFromSessions,
} from '../db/index.js';
import type { TailerOffset } from '../shared/index.js';
import { BATCH_SIZE, ingestBatch, type IngestBatchItem } from '../server/ingest.js';
import type { DeltaPublisher } from '../server/deltas.js';
import type { Broadcaster } from '../server/sse.js';
import {
  parseTranscriptLine,
  transcriptDeadLetter,
  type TranscriptLineContext,
} from './transcript-line.js';

/** How often `startServer` runs a tail pass. "Seconds behind" is the RFC bar. */
export const DEFAULT_TAIL_INTERVAL_MS = 1000;

/**
 * Ceiling on bytes read from one file in one pass. Measured against the real
 * corpus: largest single line 2.73 MB, largest file 10.05 MB — so 8 MiB admits
 * every real line in one go while a cold 10 MB catch-up costs two passes rather
 * than one 10 MB allocation.
 */
export const MAX_BYTES_PER_FILE_PER_PASS = 8 * 1024 * 1024;

/** A line bigger than this is dead-lettered with a marker rather than buffered. */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Bytes of the file head covered by the change-detection hash. */
const HEAD_WINDOW_BYTES = 1024;

const NEWLINE = 0x0a;

/** Why a file was re-read from zero (or `none` for a plain resume). */
export type TailReset =
  | 'none'
  | 'rotation'
  | 'truncation'
  | 'rewrite'
  | 'first-sight';

/**
 * What one pass did to one file. **The counters are the observable**: archive
 * dedupe makes row counts identical whether the tailer resumed correctly or
 * re-read the whole file every tick, so only `reset` and `bytesRead` can tell
 * those two apart.
 */
export interface TailFileResult {
  path: string;
  bytesRead: number;
  linesRead: number;
  ingested: number;
  deadLettered: number;
  reset: TailReset;
  /** Set when the file could not be read this pass; the pass continues regardless. */
  error?: string;
}

/** Aggregate outcome of one tail pass. */
export interface TailResult {
  files: TailFileResult[];
  ingested: number;
  deadLettered: number;
}

/** Knobs for one tail pass. */
export interface TailOptions {
  /**
   * Directory holding `<slug>/<session>.jsonl`. When SET, sessions-derived
   * paths are also filtered to this subtree — a hermetic root is otherwise not
   * hermetic, because the primary discovery source is a DB column that can name
   * any path on the machine. Production leaves it unset and accepts all of them.
   */
  transcriptRoot?: string;
  /** Override for {@link MAX_BYTES_PER_FILE_PER_PASS} (tests). */
  maxBytesPerFilePerPass?: number;
  /** Override for {@link MAX_LINE_BYTES} (tests). */
  maxLineBytes?: number;
  /**
   * `'eof'` (the default) records EOF for a file no session named and ingests
   * nothing — otherwise booting parses every transcript on the machine.
   */
  firstSight?: 'eof' | 'backfill';
  /**
   * Restrict discovery to these `<slug>` directory names. Applied to BOTH
   * sources: the sessions source is a DB column that can name any path, so
   * filtering only the scan silently does not filter.
   */
  projects?: readonly string[];
  /**
   * Live-tail publisher, forwarded verbatim to `ingestBatch` (Task 6.1a).
   *
   * Without it the staging block in `ingestBatch` is never reached on the
   * transcript path, so **every** transcript-sourced fact — tokens, cost,
   * thinking blocks, and the completion of every tool call in a hookless session
   * — is written to the DB and never put on the wire. Absent means "publish
   * nothing", which is what the boot catch-up wants and nothing else does.
   *
   * The import is TYPE-ONLY and erased at run time (`verbatimModuleSyntax`): the
   * value is forwarded and never called here, so this adds no runtime module edge.
   */
  deltas?: DeltaPublisher;
}

/**
 * Change-detection fingerprint, stored in the `tailer_offsets.file_identity`
 * COLUMN. Not to be confused with the event-id `file_identity`, which is the
 * canonical path: rotation changes the inode by definition, so keying event ids
 * on it would make a rotated file's uuid-less lines duplicate instead of dedupe.
 */
interface Fingerprint {
  dev: number;
  ino: number;
  /**
   * Size at the last commit. Not consulted by the resume decision (which
   * compares the live size against the committed offset), but it is part of the
   * serialized identity, so growth alone marks the stored row as stale.
   */
  size: number;
  /** Bytes covered by `headHash` — `min(size, 1024)` AT THE TIME OF STORING. */
  headLen: number;
  headHash: string;
}

/** A transcript file to consider this pass, with the session that owns it. */
interface DiscoveredFile {
  path: string;
  sessionId: string;
  /** True when a `sessions` row names this path — i.e. we have seen the session. */
  known: boolean;
}

/** Resolve the transcript root: explicit arg -> env -> ~/.claude/projects. */
export function resolveTranscriptRoot(root?: string): string {
  return (
    root ??
    process.env.AGENT_LENS_TRANSCRIPT_ROOT ??
    join(homedir(), '.claude', 'projects')
  );
}

/**
 * The ONE spelling of a transcript path, applied to BOTH discovery sources.
 *
 * On macOS `resolve()` and `realpathSync` genuinely differ for anything under
 * `os.tmpdir()` (`/var/folders/...` vs `/private/var/folders/...`), and the two
 * sources arrive spelled differently by default — the directory scan builds paths
 * from the root, while `sessions.transcript_path` holds whatever string the hook
 * stored. Canonicalizing only one side splits one file into two identities: two
 * offset rows, two `file_identity` values, and every uuid-less line ingested
 * twice. Since the path IS the event-id identity, that is permanent duplicate
 * data rather than a cosmetic wart.
 *
 * Falls back to a lexical `resolve()` when the file cannot be resolved (deleted,
 * unreadable): a path recorded for a file that no longer exists must still key
 * its historical events, and must never throw and kill the pass.
 */
export function canonicalizeTranscriptPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * One synchronous pass over every discovered transcript. Never throws: a file
 * that vanishes or turns unreadable mid-pass is skipped or recorded with an
 * error, and the remaining files are still tailed.
 */
export function tailOnce(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  options: TailOptions = {},
): TailResult {
  const root = canonicalizeTranscriptPath(resolveTranscriptRoot(options.transcriptRoot));
  const bounded = options.transcriptRoot !== undefined;
  const projects = options.projects === undefined ? undefined : new Set(options.projects);
  const result: TailResult = { files: [], ingested: 0, deadLettered: 0 };

  for (const file of discoverTranscripts(db, root, bounded, projects)) {
    let outcome: TailFileResult | undefined;
    try {
      outcome = tailFile(db, broadcaster, file, options);
    } catch (err) {
      outcome = {
        path: file.path,
        bytesRead: 0,
        linesRead: 0,
        ingested: 0,
        deadLettered: 0,
        reset: 'none',
        error: String(err),
      };
    }
    if (outcome === undefined) continue;
    result.files.push(outcome);
    result.ingested += outcome.ingested;
    result.deadLettered += outcome.deadLettered;
  }

  return result;
}

// --- Discovery -------------------------------------------------------------

/**
 * Union the two discovery sources, deduped by canonical path.
 *
 * *Primary:* `sessions.transcript_path` — the session told us where it lives.
 * *Backstop:* a depth-one scan of `<root>/<slug>/*.jsonl`, for sessions whose
 * `SessionStart` hook we missed entirely.
 *
 * A poll scan, not `fs.watch`: recursive watching is platform-divergent and
 * event-lossy, while a pass is deterministic and testable without fake timers.
 */
function discoverTranscripts(
  db: DatabaseSync,
  root: string,
  bounded: boolean,
  projects: ReadonlySet<string> | undefined,
): DiscoveredFile[] {
  const byPath = new Map<string, DiscoveredFile>();

  for (const row of transcriptPathsFromSessions(db)) {
    const path = canonicalizeTranscriptPath(row.transcript_path);
    if (bounded && !isUnder(path, root)) continue;
    // The filter implies "under the root" too: this column can name any path on
    // the machine, and a same-named directory elsewhere must not slip through.
    if (projects !== undefined && !(isUnder(path, root) && projects.has(slugOf(path)))) {
      continue;
    }
    byPath.set(path, { path, sessionId: row.session_id, known: true });
  }

  for (const path of scanTranscriptRoot(root, projects)) {
    // A sessions-derived entry wins: it carries the real session id and marks
    // the file as one we have a reason to read from the start.
    if (byPath.has(path)) continue;
    byPath.set(path, { path, sessionId: sessionIdFromPath(path), known: false });
  }

  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Every `<root>/<slug>/*.jsonl`, depth EXACTLY one.
 *
 * `<slug>/` also holds `<session-id>/` directories carrying
 * `subagents/agent-*.jsonl` and `tool-results/*.txt`, plus `sessions-index.json`
 * and loose `*.md`. Sidechain lines already appear in both the parent transcript
 * and the sub-agent file, so recursing would double-ingest real events rather
 * than dedupe them (sub-agent merge is Task 4.2's problem, with its own policy).
 */
function scanTranscriptRoot(
  root: string,
  projects: ReadonlySet<string> | undefined,
): string[] {
  const found: string[] = [];
  for (const slug of readDirSafe(root, true)) {
    if (projects !== undefined && !projects.has(slug)) continue;
    for (const name of readDirSafe(join(root, slug), false)) {
      if (!name.endsWith('.jsonl')) continue;
      found.push(canonicalizeTranscriptPath(join(root, slug, name)));
    }
  }
  return found;
}

/** Directory entries of one kind, or `[]` when the directory is unreadable. */
function readDirSafe(dir: string, wantDirs: boolean): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (wantDirs ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** True when `path` is `root` or lives beneath it. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The transcript filename stem, which IS the session UUID in the observed layout. */
function sessionIdFromPath(path: string): string {
  return basename(path, '.jsonl');
}

/** The project slug owning a transcript — its parent directory name. */
function slugOf(path: string): string {
  return basename(dirname(path));
}

// --- One file, one pass ----------------------------------------------------

/**
 * Tail one file: fingerprint it, decide where to resume, read complete lines,
 * and drive them through `ingestBatch` with the new offset committed inside the
 * same transaction. Returns `undefined` when the file is gone or is not a file.
 */
function tailFile(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  file: DiscoveredFile,
  options: TailOptions,
): TailFileResult | undefined {
  const stat = statSafe(file.path);
  if (stat === undefined || !stat.isFile()) return undefined;

  const stored = readTailerOffset(db, file.path);
  const fd = openSync(file.path, 'r');
  try {
    const identity = JSON.stringify(fingerprintOf(fd, stat));

    // First sight of a file no session ever named: record EOF and ingest
    // nothing. Boot cost for an unknown transcript is one stat, not a parse —
    // otherwise starting the collector ingests every unrelated project's history
    // synchronously before the socket binds. Growth from here forward IS
    // captured, which is the backstop role the directory scan plays.
    // `firstSight: 'backfill'` opts out and falls through to `decideStart`.
    if (stored === undefined && !file.known && (options.firstSight ?? 'eof') === 'eof') {
      // `deltas` is inert on an empty slice — `ingestBatch` short-circuits above
      // its staging block — but a field threaded at one of two call sites is a
      // trap for the next author.
      ingestBatch(db, broadcaster, [], {
        beforeCommit: offsetWriter(file, stat.size, identity),
        deltas: options.deltas,
      });
      return {
        path: file.path,
        bytesRead: 0,
        linesRead: 0,
        ingested: 0,
        deadLettered: 0,
        reset: 'first-sight',
      };
    }

    const { start, reset } = decideStart(stored, fd, stat);
    const plan: ReadPlan = { fd, stat, stored, start, reset, identity };
    return readAndIngest(db, broadcaster, file, plan, options);
  } finally {
    closeSync(fd);
  }
}

/** Everything `readAndIngest` needs about the file it is draining. */
interface ReadPlan {
  fd: number;
  stat: Stats;
  stored: TailerOffset | undefined;
  start: number;
  reset: TailReset;
  identity: string;
}

/**
 * Where to resume, and why. Reset to zero on rotation (inode changed),
 * truncation (the file shrank), or rewrite (the head changed under a fixed
 * window); otherwise continue from the committed offset. Every reset re-reads
 * already-ingested lines on purpose — `event_id` dedupe absorbs them.
 */
function decideStart(
  stored: TailerOffset | undefined,
  fd: number,
  stat: Stats,
): { start: number; reset: TailReset } {
  // No offset row yet: read from the beginning. A known session, or any unknown
  // file under `firstSight: 'backfill'`. `reset: 'none'` — nothing was re-read.
  if (stored === undefined) return { start: 0, reset: 'none' };

  const fp = parseFingerprint(stored.file_identity);
  // No usable fingerprint (pre-3.1 row, or corrupt): treat as a rewrite and
  // re-read, which dedupe makes free.
  if (fp === undefined) return { start: 0, reset: 'rewrite' };

  if (fp.dev !== stat.dev || fp.ino !== stat.ino) {
    return { start: 0, reset: 'rotation' };
  }
  // `size < headLen` is a shrink the offset comparison can miss when the stored
  // offset stopped short of the head window (a partial trailing line).
  if (stat.size < stored.committed_offset || stat.size < fp.headLen) {
    return { start: 0, reset: 'truncation' };
  }
  // **Fixed window.** Hashing `min(size, 1024)` instead would rehash a
  // DIFFERENT region on every append below 1 KB, so the hash would differ, the
  // rewrite branch would fire, and the file would be re-read on every tick for
  // its entire early life. Dedupe hides that in row counts — which is why the
  // regression test asserts `TailResult`, not rows.
  if (hashRange(fd, fp.headLen) !== fp.headHash) {
    return { start: 0, reset: 'rewrite' };
  }
  // Blind spot, accepted by the data model: a rewrite preserving dev, ino, size
  // AND the first `headLen` bytes is undetectable.
  return { start: stored.committed_offset, reset: 'none' };
}

/** Read complete lines from `start` and funnel them, committing the new offset. */
function readAndIngest(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  file: DiscoveredFile,
  plan: ReadPlan,
  options: TailOptions,
): TailFileResult {
  const { fd, stat, stored, start, reset, identity } = plan;
  const maxPerPass = options.maxBytesPerFilePerPass ?? MAX_BYTES_PER_FILE_PER_PASS;
  const maxLine = options.maxLineBytes ?? MAX_LINE_BYTES;
  const fallbackTs = new Date(stat.mtimeMs).toISOString();

  let offset = start;
  let linesRead = 0;
  let ingested = 0;
  let deadLettered = 0;
  let batch: IngestBatchItem[] = [];

  /**
   * Drive the buffered items and commit `nextOffset` in the same transaction.
   *
   * **There is no `if (batch.length === 0) return` guard here, and there must
   * never be one.** `replay.ts:84` has exactly that guard; inheriting it would
   * mean a region consumed entirely by blank lines never reaches `ingestBatch`,
   * never commits its offset, and is re-read every tick forever.
   */
  const flush = (nextOffset: number): void => {
    const items = batch;
    batch = [];
    const outcomes = ingestBatch(db, broadcaster, items, {
      beforeCommit: offsetWriter(file, nextOffset, identity),
      deltas: options.deltas,
    });
    outcomes.forEach((outcome, i) => {
      // Count what ingest actually did, not what the parser predicted.
      if (items[i]!.status === 'dead_letter' || outcome.deadLettered) {
        deadLettered += 1;
      } else {
        ingested += 1;
      }
    });
  };

  /** Queue one complete line (its bytes, without the terminating newline). */
  const push = (lineBuf: Buffer, lineOffset: number): void => {
    const ctx: TranscriptLineContext = {
      filePath: file.path,
      lineOffset,
      fallbackSessionId: file.sessionId,
      fallbackTs,
    };

    // The size check comes FIRST so an oversize line is never materialized as a
    // string just to be rejected. It is dead-lettered from a marker instead, so
    // one pathological line can neither exhaust memory nor wedge the tail.
    if (lineBuf.length > maxLine) {
      linesRead += 1;
      batch.push({
        envelope: transcriptDeadLetter(oversizeMarker(lineBuf.length), ctx),
        status: 'dead_letter',
      });
    } else {
      const text = lineBuf.toString('utf8');
      // Consumed but never ingested, per the spool-replay rule. This is
      // precisely how a chunk can be empty while bytes advanced.
      if (text.trim() === '') return;
      linesRead += 1;
      const parsed = parseTranscriptLine(text, ctx);
      batch.push({
        envelope: parsed.envelope,
        status: parsed.kind === 'dead_letter' ? 'dead_letter' : 'processed',
      });
    }

    // Malformed lines join the SAME buffer rather than ingesting out of band:
    // an out-of-band ingest hands a torn line a lower seq than good lines
    // already queued ahead of it, silently reordering the live list.
    if (batch.length >= BATCH_SIZE) flush(lineOffset + lineBuf.length + 1);
  };

  if (offset < stat.size) {
    const want = Math.min(stat.size - offset, maxPerPass);
    const window = readRange(fd, offset, want);
    const lastNewline = window.lastIndexOf(NEWLINE);
    if (lastNewline >= 0) {
      // Byte arithmetic throughout — the transcript is UTF-8 and a multibyte
      // character counted as one `string.length` unit desyncs the offset
      // permanently. The trailing fragment after the last newline is discarded
      // and re-read next pass, when its newline has arrived.
      emitLines(window.subarray(0, lastNewline + 1), offset, push);
      offset += lastNewline + 1;
    } else if (offset + want < stat.size) {
      offset = drainLongLine(fd, offset, stat.size, maxPerPass, maxLine, push);
    }
    // else: a trailing fragment with no newline at all — leave the offset put.
  }

  // Flush when anything moved. Keyed on CONSUMED BYTES (and on first-row
  // creation), never on batch emptiness — see the note on `flush`.
  const changed =
    batch.length > 0 ||
    offset !== start ||
    stored === undefined ||
    stored.file_identity !== identity;
  if (changed) flush(offset);

  return {
    path: file.path,
    bytesRead: offset - start,
    linesRead,
    ingested,
    deadLettered,
    reset,
  };
}

/** Split a newline-terminated region into lines, reporting absolute offsets. */
function emitLines(
  chunk: Buffer,
  chunkStart: number,
  push: (line: Buffer, offset: number) => void,
): void {
  let pos = 0;
  while (pos < chunk.length) {
    const nl = chunk.indexOf(NEWLINE, pos);
    if (nl === -1) return;
    push(chunk.subarray(pos, nl), chunkStart + pos);
    pos = nl + 1;
  }
}

/**
 * Handle a line longer than one pass's read window: SCAN (never buffer) forward
 * for its terminating newline. A line still within `maxLine` is then read and
 * parsed normally; a larger one is dead-lettered from a marker so a single
 * pathological line can neither exhaust memory nor wedge the tail. Returns the
 * new offset — unchanged when the line has no newline yet.
 */
function drainLongLine(
  fd: number,
  offset: number,
  size: number,
  window: number,
  maxLine: number,
  push: (line: Buffer, offset: number) => void,
): number {
  const nlPos = scanForNewline(fd, offset + window, size, window);
  if (nlPos === undefined) return offset;
  const lineLength = nlPos - offset;
  if (lineLength <= maxLine) {
    push(readRange(fd, offset, lineLength), offset);
  } else {
    push(Buffer.from(oversizeMarker(lineLength), 'utf8'), offset);
  }
  return nlPos + 1;
}

/** Absolute position of the next `\n` at or after `from`, or `undefined`. */
function scanForNewline(
  fd: number,
  from: number,
  size: number,
  window: number,
): number | undefined {
  let pos = from;
  while (pos < size) {
    const chunk = readRange(fd, pos, Math.min(window, size - pos));
    if (chunk.length === 0) return undefined;
    const idx = chunk.indexOf(NEWLINE);
    if (idx !== -1) return pos + idx;
    pos += chunk.length;
  }
  return undefined;
}

/**
 * Stand-in text for a line too large to hold. It is what gets hashed into the
 * event id and archived, so the dead letter still dedupes on re-read and still
 * says exactly what was skipped.
 */
function oversizeMarker(byteLength: number): string {
  return `<agent-lens: transcript line omitted, ${byteLength} bytes exceeds the line limit>`;
}

/**
 * The `beforeCommit` hook that advances one file's resume point. The ONLY place
 * an offset is written, so the offset can only ever move inside an `ingestBatch`
 * transaction — never in one of its own.
 */
function offsetWriter(
  file: DiscoveredFile,
  offset: number,
  identity: string,
): (db: DatabaseSync) => void {
  return (db) =>
    commitTailerOffset(db, {
      transcript_path: file.path,
      session_id: file.sessionId,
      committed_offset: offset,
      file_identity: identity,
    });
}

// --- Fingerprinting --------------------------------------------------------

/** The file's current change-detection fingerprint. */
function fingerprintOf(fd: number, stat: Stats): Fingerprint {
  const headLen = Math.min(stat.size, HEAD_WINDOW_BYTES);
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    headLen,
    headHash: hashRange(fd, headLen),
  };
}

function parseFingerprint(serialized: string | undefined): Fingerprint | undefined {
  if (serialized === undefined) return undefined;
  try {
    const parsed = JSON.parse(serialized) as Partial<Fingerprint>;
    if (
      typeof parsed.dev !== 'number' ||
      typeof parsed.ino !== 'number' ||
      typeof parsed.headLen !== 'number' ||
      typeof parsed.headHash !== 'string'
    ) {
      return undefined;
    }
    return parsed as Fingerprint;
  } catch {
    return undefined;
  }
}

/** SHA-256 of the file's first `length` bytes. */
function hashRange(fd: number, length: number): string {
  return createHash('sha256').update(readRange(fd, 0, length)).digest('hex');
}

// --- Raw I/O ---------------------------------------------------------------

/** Read exactly `length` bytes at `position` (short at EOF). */
function readRange(fd: number, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/** `statSync` that reports a vanished/unreadable file as `undefined`. */
function statSafe(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
