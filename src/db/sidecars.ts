// The filesystem half of the sidecar link. `src/project/subagents.ts` decides
// what links to what; this module answers "which sub-agent transcripts exist
// beside this one, and what are their spans" — which needs a directory listing
// and two positional reads, so it sits here, on the same layering `freshness.ts`
// already uses (`db -> archive` is the allowed direction).
//
// ★ THE WALK ENUMERATES `agent-*.meta.json`, NEVER `agent-*.jsonl`. A transcript
// with no sibling meta is skipped silently and never becomes a descriptor. This
// is load-bearing, not tidiness: `createArchiveReader.read` THROWS
// `no archived bytes for …` on a missing file rather than answering undefined,
// so enumerating transcripts and then reading an absent meta would throw inside
// the caller's SAVEPOINT and fail the PARENT session. `journal.jsonl` drops out
// of the same rule for free — it is not an `agent-*.meta.json`, so the
// 2026-08-19 ruling that excludes it needs no code here.
//
// ★ TWO STAGES, AND THE SECOND IS THE EXPENSIVE ONE. Every meta is read: the
// join key lives inside it, and they measure a median of 130 B (4,874 B for the
// corpus's largest tree of 44). Only a meta whose `toolUseId` the caller asked
// for goes on to the stat, the head/tail pread and the envelope fold. Without
// that gate, projecting a 44-sidecar tree pre-reads all 44 transcripts 45 times
// over — once for the parent and once per child — and repeats it on every live
// tick, because `freshness.ts` invalidates the parent whenever any child grows.
// Measured: 3.97 MB / 130 reads / 3.6 ms warm, per repetition.
//
// ★ TWO ENVELOPE READERS OVER ONE GROWTH POLICY. `windows` takes the two preads
// at a given size; `headTail` decodes the two end lines and `readSessionEnvelope`
// folds every whole line in both windows. They differ ONLY in what makes the
// window big enough — end-line wholeness for a sidecar, envelope completeness
// for a top-level session, which opens with a control line carrying neither
// `cwd` nor `timestamp`. The policy is shared so the two cannot drift.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createArchiveReader, type ArchiveReader } from '../archive/read.js';
import type { SidecarDescriptor, SidecarEnvelope } from '../project/subagents.js';
import { parseAgentMeta } from '../transcript/agents.js';
import { DriftCounter } from '../transcript/drift.js';
import { classifyLine, foldSessionEnvelope, type ParsedLine } from '../transcript/line.js';
import { foldArchive } from './freshness.js';

const SUBAGENTS_DIR = 'subagents';
const TRANSCRIPT_EXT = '.jsonl';
const META_EXT = '.meta.json';
const AGENT_PREFIX = 'agent-';
const SEALED_SUFFIX = '.zst';

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * The first window a head/tail read takes, and the size it refuses to grow past.
 *
 * 16 KB rather than a fixed 64 KB because the first line alone measures a median
 * of 4,695 B and a max of 215,461 B, and 7 of 269 sidecars exceed 64 KB — a
 * fixed window misses the line entirely on those. Doubling to 1 MB reads 15.1 MB
 * across the whole corpus where a full read costs 169.0 MB.
 */
const START_WINDOW = 16 * 1024;
const MAX_WINDOW = 1024 * 1024;

/** One end of the file, and where those bytes actually start. */
interface WindowLine {
  text: string;
  byteOffset: number;
}

/**
 * The `subagents/` directory that holds this transcript's children.
 *
 * For a parent `<dir>/<session>.jsonl` it is the sibling `<dir>/<session>/subagents`.
 * For a sidecar already inside one it is that same ancestor — which is what makes
 * depth 3 need no code of its own: every generation of a session's sub-agents
 * shares one flat listing, and the `toolUseId` join is what narrows it.
 */
export function enclosingSubagentsDir(path: string): string | undefined {
  const marker = `${SUBAGENTS_DIR}/`;
  const at = path.split('\\').join('/').lastIndexOf(`/${marker}`);
  if (at !== -1) return path.slice(0, at + marker.length);
  if (!path.endsWith(TRANSCRIPT_EXT)) return undefined;
  return join(path.slice(0, -TRANSCRIPT_EXT.length), SUBAGENTS_DIR);
}

/**
 * Every `agent-*.meta.json` under `dir`, as paths relative to it. Sealed copies
 * are reported under their LOGICAL name, so a hot/sealed pair enumerates once
 * and the reader's own ENOENT dispatch decides which bytes serve it.
 */
function metaEntries(dir: string): string[] {
  let names: readonly string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }

  const logical = new Set<string>();
  for (const raw of names) {
    const name = raw.split('\\').join('/');
    const stripped = name.endsWith(SEALED_SUFFIX) ? name.slice(0, -SEALED_SUFFIX.length) : name;
    const leaf = stripped.slice(stripped.lastIndexOf('/') + 1);
    if (leaf.startsWith(AGENT_PREFIX) && leaf.endsWith(META_EXT)) logical.add(stripped);
  }
  return [...logical].sort();
}

/** The bytes before the first newline, or the whole buffer when it IS the file. */
function firstLine(buf: Buffer, whole: boolean): WindowLine | undefined {
  const at = buf.indexOf(NEWLINE);
  if (at !== -1) return { text: buf.subarray(0, at).toString('utf8'), byteOffset: 0 };
  return whole ? { text: buf.toString('utf8'), byteOffset: 0 } : undefined;
}

/** The bytes after the last newline of the newline-stripped window. */
function lastLine(buf: Buffer, base: number, whole: boolean): WindowLine | undefined {
  let end = buf.length;
  while (end > 0 && (buf[end - 1] === NEWLINE || buf[end - 1] === CARRIAGE_RETURN)) end -= 1;

  const at = buf.subarray(0, end).lastIndexOf(NEWLINE);
  if (at !== -1) {
    return { text: buf.subarray(at + 1, end).toString('utf8'), byteOffset: base + at + 1 };
  }
  return whole ? { text: buf.subarray(0, end).toString('utf8'), byteOffset: base } : undefined;
}

/** Both ends of a file at one window size. The tail always ends at EOF. */
interface Windows {
  head: Buffer;
  tail: Buffer;
  /** Byte offset the tail window starts at. */
  base: number;
  /** The window covers the whole file, so both buffers are the file. */
  whole: boolean;
}

/** One growth step: the two positional reads, undecoded. */
function windows(reader: ArchiveReader, path: string, size: number, window: number): Windows {
  const span = window >= size ? size : window;
  const base = size - span;
  return {
    head: reader.read(path, 0, span),
    tail: reader.read(path, base, span),
    base,
    whole: span === size,
  };
}

/**
 * The transcript's first and last lines, by two positional reads that grow until
 * both are whole.
 *
 * Undefined when the cap is reached with either end still unterminated: a
 * truncated head is a guessed span, and a guessed span is exactly what
 * `duration_source` exists to make impossible.
 *
 * ★ KEYED ON END-LINE WHOLENESS, which is right for a SIDECAR and wrong for a
 * top-level session — see `readSessionEnvelope`. Unchanged behaviour, now built
 * on `windows` so the growth policy exists once.
 */
function headTail(
  reader: ArchiveReader,
  path: string,
  size: number,
): [WindowLine, WindowLine] | undefined {
  if (size === 0) return undefined;

  for (let window = START_WINDOW; ; window *= 2) {
    const at = windows(reader, path, size, window);
    const head = firstLine(at.head, at.whole);
    const tail = lastLine(at.tail, at.base, at.whole);
    if (head !== undefined && tail !== undefined) return [head, tail];
    if (at.whole || window >= MAX_WINDOW) return undefined;
  }
}

/**
 * Every newline-terminated line in a window, with archive-relative byte offsets.
 *
 * A leading partial is dropped unless the window starts at byte 0, and a
 * trailing partial unless the window ends the file — which the tail window
 * always does.
 */
function wholeLines(buf: Buffer, base: number, atEof: boolean): WindowLine[] {
  const lines: WindowLine[] = [];
  const push = (from: number, to: number): void => {
    let end = to;
    while (end > from && (buf[end - 1] === NEWLINE || buf[end - 1] === CARRIAGE_RETURN)) end -= 1;
    if (end > from) {
      lines.push({ text: buf.subarray(from, end).toString('utf8'), byteOffset: base + from });
    }
  };

  let start = 0;
  if (base > 0) {
    const at = buf.indexOf(NEWLINE);
    if (at === -1) return lines;
    start = at + 1;
  }
  for (;;) {
    const at = buf.indexOf(NEWLINE, start);
    if (at === -1) break;
    push(start, at);
    start = at + 1;
  }
  if (atEof) push(start, buf.length);
  return lines;
}

/**
 * The three NOT NULL session columns, folded from every WHOLE line in both
 * windows rather than from the two end lines.
 *
 * ★ THE GROWTH LOOP KEYS ON ENVELOPE COMPLETENESS, not end-line wholeness, and
 * that is the whole difference from `headTail`. All 26 hot top-level transcripts
 * open with a `type:"mode"` control line carrying neither `cwd` nor `timestamp`,
 * so the two-end fold gets `started_at` right 0 times out of 26 and `cwd` 7. The
 * windowed fold gets `project_path` and `last_activity_at` exact 26/26. A
 * wholeness-keyed loop would return the moment both ends parse and never grow
 * for a missing `cwd`, so a transcript whose first cwd-bearing line moved past
 * 16 KB would fold to `project_path === undefined` and be dropped silently.
 * Today's maximum such offset is 660 B, a 24.8x margin — thin enough to defend.
 *
 * `projectPathSeed` is consulted ONLY at the cap, and only when both timestamps
 * folded. It is the encoded directory name decoded back, which is lossy by
 * construction — a seed, not an answer, and `WRITE_HEADER_SQL`'s COALESCE
 * replaces it with the header's own `cwd` at the first projection. Consulting it
 * earlier would stop the loop growing and defeat the completeness key. Omit it
 * and the reader is all-three-or-nothing.
 *
 * Undefined at the cap with no seed, or with either timestamp missing — the two
 * timestamps have no fallback anywhere. That is a REPORTED outcome for the
 * caller, never a silent skip: `SweepReport.envelope_incomplete` records the path.
 */
export function readSessionEnvelope(
  reader: ArchiveReader,
  path: string,
  projectPathSeed?: string,
): SidecarEnvelope | undefined {
  // The whole read is inside the catch, for the reason `readEnvelope` states.
  try {
    const size = reader.size(path);
    if (size === 0) return undefined;

    for (let window = START_WINDOW; ; window *= 2) {
      const at = windows(reader, path, size, window);
      const lines = at.whole
        ? wholeLines(at.head, 0, true)
        : [...wholeLines(at.head, 0, false), ...wholeLines(at.tail, at.base, true)];

      const { project_path, started_at, last_activity_at } = foldSessionEnvelope(
        parseWindow(lines),
      );
      const atCap = at.whole || window >= MAX_WINDOW;

      if (started_at !== undefined && last_activity_at !== undefined) {
        if (project_path !== undefined) return { project_path, started_at, last_activity_at };
        if (atCap && projectPathSeed !== undefined) {
          return { project_path: projectPathSeed, started_at, last_activity_at };
        }
      }
      if (atCap) return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Classify a window's lines through one throwaway counter. A line that is not
 * JSON is skipped rather than fatal: over a window, one malformed line must not
 * cost the other 200 their envelope.
 */
function parseWindow(lines: readonly WindowLine[]): ParsedLine[] {
  const drift = new DriftCounter();
  const parsed: ParsedLine[] = [];
  for (const line of lines) {
    try {
      parsed.push(
        classifyLine(JSON.parse(line.text), {
          byteOffset: line.byteOffset,
          byteLength: Buffer.byteLength(line.text, 'utf8'),
          drift,
        }),
      );
    } catch {
      continue;
    }
  }
  return parsed;
}

/**
 * The session-wide values a sidecar row needs, folded from its two end lines.
 *
 * The fold is `foldSessionEnvelope`, unchanged and shared with the full-file
 * path: its timestamp limbs are a strict MIN/MAX, so "the two ends agree with
 * the whole file" is structural rather than a coincidence (measured 269/269).
 *
 * ★ Undefined when any of the three NOT NULL columns folds to nothing. A NULL
 * bind would throw inside the caller's SAVEPOINT and mark the PARENT session
 * failed — one malformed sub-agent taking out the whole session.
 */
function readEnvelope(reader: ArchiveReader, path: string): SidecarEnvelope | undefined {
  // ★ THE WHOLE READ IS INSIDE THE CATCH, not just the parse. `size` and `read`
  // both OPEN the file, and `createArchiveReader` throws `no archived bytes for
  // …` rather than answering undefined — so a sidecar that vanishes between the
  // listing and the pread would otherwise throw inside the caller's SAVEPOINT
  // and mark the PARENT failed. Dropping the descriptor is the same rule the
  // NOT NULL gate below applies, for the same reason.
  try {
    const ends = headTail(reader, path, reader.size(path));
    if (ends === undefined) return undefined;

    // A throwaway counter: whatever these two lines drifted belongs to the
    // sidecar's OWN projection, which reads the whole file with a counter of
    // its own. Folding it into the parent's would double-count it.
    const drift = new DriftCounter();
    const envelope = foldSessionEnvelope(
      ends.map((end) =>
        classifyLine(JSON.parse(end.text), {
          byteOffset: end.byteOffset,
          byteLength: Buffer.byteLength(end.text, 'utf8'),
          drift,
        }),
      ),
    );

    const { project_path, started_at, last_activity_at } = envelope;
    if (project_path === undefined) return undefined;
    if (started_at === undefined || last_activity_at === undefined) return undefined;
    return { project_path, started_at, last_activity_at };
  } catch {
    return undefined;
  }
}

/**
 * Resolve the sub-agent transcripts this session spawned.
 *
 * `toolUseIds` are the parent's own `Agent` `tool_use` ids; a meta naming none of
 * them is dropped before its transcript is ever opened. `sourcePath` is the
 * parent's, and each child's is derived from it by string math alone — the
 * archive mirror is path-identical below the roots, and the row already holds
 * the anchor, so nothing here reads ambient config.
 *
 * `reader` is defaulted rather than injected at every call site so a test can
 * count what was opened without production growing a parameter it never varies.
 */
export function readSidecars(
  archivePath: string,
  sourcePath: string,
  toolUseIds: ReadonlySet<string>,
  reader: ArchiveReader = createArchiveReader(),
): SidecarDescriptor[] {
  // FIRST, BEFORE THE READDIR. A leaf sub-agent spawns nothing, and task 4.1
  // projects every sidecar in its own right, so this is the common case rather
  // than the rare one.
  if (toolUseIds.size === 0) return [];

  const archiveDir = enclosingSubagentsDir(archivePath);
  const sourceDir = enclosingSubagentsDir(sourcePath);
  if (archiveDir === undefined || sourceDir === undefined) return [];

  const descriptors: SidecarDescriptor[] = [];
  for (const rel of metaEntries(archiveDir)) {
    const metaPath = join(archiveDir, rel);

    // ponytail: CEILING — every meta in the enclosing tree is read, so this stays
    // O(tree) at ~130 B each even after the gate below narrows the expensive
    // half. Upgrade path: none until a tree is large enough for 130 B per child
    // to matter; the join key lives inside the file, so it cannot be skipped.
    let meta;
    try {
      meta = parseAgentMeta(JSON.parse(reader.read(metaPath, 0, reader.size(metaPath)).toString()));
    } catch {
      // Vanished between the listing and the read, or not JSON at all. Either
      // way it is not a descriptor, and it is not the parent's failure.
      continue;
    }
    if (meta?.toolUseId === undefined || !toolUseIds.has(meta.toolUseId)) continue;

    const stem = rel.slice(0, -META_EXT.length);
    const transcript = `${stem}${TRANSCRIPT_EXT}`;
    const childArchivePath = join(archiveDir, transcript);

    // The freshness key the sidecar's own row is stamped with, and the same one
    // `ensureProjected` will compare later. Undefined means it vanished between
    // the listing and the stat: drop the descriptor, never bind a zero.
    const fold = foldArchive(childArchivePath);
    if (fold === undefined) continue;

    // The read takes `reader.size`, NOT `fold.size`: the fold answers "how big
    // is this session's tree", the pread needs "how many bytes can I address in
    // this one file".
    const envelope = readEnvelope(reader, childArchivePath);
    if (envelope === undefined) continue;

    descriptors.push({
      agent_id: stem.slice(stem.lastIndexOf('/') + 1 + AGENT_PREFIX.length),
      archive_path: childArchivePath,
      source_path: join(sourceDir, transcript),
      mtime_ms: fold.mtime_ms,
      size: fold.size,
      meta,
      envelope,
    });
  }
  return descriptors;
}
