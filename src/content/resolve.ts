// Row in, text out. The one module that dereferences an `events` row's
// `line_ref` coordinates and its `spill_path` into the bytes the detail response
// could not afford to carry inline.
//
// EVERY BYTE COMES THROUGH `createArchiveReader`, never a direct `openSync` —
// the rule `src/corpus/env.ts:4-7` states, for the same two reasons: a sealed
// session must resolve byte-identically to a hot one, and this tree then adds no
// row to `fs-write-sites.test.ts`'s open manifest.
//
// IT NEVER SEES A `DatabaseSync`. The row arrives as a parameter, which makes
// "no SQL outside `src/db/`" and "copies no bytes into SQLite" type-level facts
// rather than behavioural claims somebody has to keep guarding.
//
// ## Never throws
//
// The same contract `transcript/spill.ts` documents: an unreachable archive, a
// dangling `spill_path`, a line that will not parse — all LABELLED STATES, not
// exceptions. `missing` is normal, and `read-api`'s route answers 200 for every
// one of them. Nothing here fabricates a path or invents bytes.

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isUnderAnyRoot } from '../archive/paths.js';
import type { ArchiveReader } from '../archive/read.js';
import { toolResultsDirOf } from '../corpus/paths.js';
import type { EventContentRow } from '../db/read.js';
import { contentBlocks, type Block } from '../transcript/blocks.js';
import { DriftCounter } from '../transcript/drift.js';
import { classifyLine } from '../transcript/line.js';

/** Which half of an event row is being asked for. */
export type ContentField = 'text' | 'input';

/**
 * The reads a resolve needs, injected so every test is hermetic and the sealed
 * and hot arms are drivable without a real archive.
 */
export interface ContentEnv {
  reader: ArchiveReader;
  /**
   * True when the path exists IN ANY ARCHIVED FORM. The same contract
   * `ResolveEnv.exists` carries (`spill.ts:76-83`): a sealed spill exists only
   * as `<p>.zst`, so a probe that tested the logical name alone would report
   * every sealed spill missing.
   */
  exists(path: string): boolean;
  /**
   * True when a RECORDED `spill_path` may be dereferenced verbatim — it
   * realpath-resolves inside a root this product owns (finding F1). Optional so
   * hermetic env literals stay valid; `createContentEnv` always binds it.
   * Absent means unchecked. A throwing predicate refuses, fail-closed.
   */
  withinRoots?(path: string): boolean;
}

/**
 * One content field, resolved. Structurally the `ResolvedContent` that
 * `server/api.ts:347-355` assembles the wire body from — declared here rather
 * than imported so `src/content/` never points upward at `src/server/`.
 */
export interface ResolvedContent {
  storage: string;
  /** What is servable. A stored head preview when the archive was unreachable. */
  content: string;
  /** The TRUE byte size of the whole field, which `content` may be a prefix of. */
  byte_size: number;
  spill_path?: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * A tool result's own text, from the blocks hanging off it.
 *
 * Mirrors `pipeline.ts:264-266` and MUST stay byte-identical to it: joined on
 * `'\n'` and NEVER trimmed, because `text_bytes` was sized off that exact
 * string and both spill-marker predicates test index 0.
 */
function resultText(children: readonly Block[]): string {
  return children.flatMap((child) => (child.kind === 'text' ? [child.text] : [])).join('\n');
}

/**
 * Pread one line out of the archive and index one block of it.
 *
 * The ONLY call into the line parser in this module, which is what makes
 * "exactly one call into `transcript/line.ts`" a property of the code shape
 * rather than a discipline. `undefined` for every failure — an unreadable line
 * degrades to the stored preview, it does not abort the request.
 */
function blockAt(
  env: ContentEnv,
  archivePath: string,
  byteOffset: number,
  len: number,
  blockIndex: number,
): Block | undefined {
  let bytes: Buffer;
  try {
    bytes = env.reader.read(archivePath, byteOffset, len);
  } catch {
    // `no archived bytes for …` (`archive/read.ts:114`) when the session has been
    // pruned out from under a row the freshness key never invalidated.
    return undefined;
  }
  if (bytes.length === 0) return undefined;
  try {
    const line = classifyLine(JSON.parse(bytes.toString('utf8')), {
      byteOffset,
      byteLength: len,
      drift: new DriftCounter(),
    });
    return contentBlocks(line)[blockIndex];
  } catch {
    return undefined;
  }
}

/** The column half, used verbatim and as the degraded answer for every arm. */
function stored(row: EventContentRow, field: ContentField): { text: string; bytes: number | null } {
  const text = (field === 'text' ? row.text : row.input) ?? '';
  return { text, bytes: field === 'text' ? row.text_bytes : row.input_bytes };
}

function fromColumn(row: EventContentRow, field: ContentField, storage: string): ResolvedContent {
  const { text, bytes } = stored(row, field);
  return { storage, content: text, byte_size: bytes ?? byteLength(text) };
}

/** `''` / `0`, for the two states that describe an absence rather than a payload. */
function empty(storage: string): ResolvedContent {
  return { storage, content: '', byte_size: 0 };
}

/**
 * A resolved `line_ref`, or the stored preview labelled `line_ref` when the
 * archive could not answer. `byte_size` stays the row's TRUE size either way, so
 * the route's `truncated` flag is right in both cases.
 */
function fromLineRef(
  row: EventContentRow,
  field: ContentField,
  text: string | undefined,
): ResolvedContent {
  if (text === undefined) return fromColumn(row, field, 'line_ref');
  const { bytes } = stored(row, field);
  return { storage: 'line_ref', content: text, byte_size: bytes ?? byteLength(text) };
}

function probe(env: ContentEnv, path: string): boolean {
  try {
    return env.exists(path) === true;
  } catch {
    // An injected probe that throws must not take the request with it.
    return false;
  }
}

/** The F1 gate on the verbatim fallback arm. Fail-closed on a throwing predicate. */
function within(env: ContentEnv, path: string): boolean {
  if (env.withinRoots === undefined) return true;
  try {
    return env.withinRoots(path) === true;
  } catch {
    return false;
  }
}

/**
 * Where a spill's bytes are readable NOW.
 *
 * ★ ARCHIVE FIRST — the deliberate inversion of `spill.ts:206`'s declared-path-
 * first order, and the load-bearing decision in this module. `spill_path` holds
 * the path that resolved at PROJECTION time, which today is a `~/.claude/`
 * source path on every measured row; Claude Code expires those at ~41 days and
 * the Tier-B invalidation key is archive-derived (`corpus/scan.ts:1-7`), so the
 * row is never reprojected and the column dangles forever. The archive is the
 * system of record (`schema.ts:20-23`) and the only copy that can be sealed.
 */
function spillSource(
  row: EventContentRow,
  archivePath: string | undefined,
  env: ContentEnv,
): string | undefined {
  if (row.spill_path === null) return undefined;
  const name = basename(row.spill_path);
  // An empty basename would re-anchor onto the `tool-results` DIRECTORY, and a
  // probe answering true for it would serve a directory as the spill body.
  if (archivePath !== undefined && name !== '') {
    const mirrored = join(toolResultsDirOf(archivePath), name);
    if (probe(env, mirrored)) return mirrored;
  }
  // The verbatim fallback: a recorded path is only read from inside the roots,
  // so a row projected before the F1 fix (or by another writer) cannot serve
  // out-of-root bytes either. The mirror arm above builds its own path.
  return within(env, row.spill_path) && probe(env, row.spill_path) ? row.spill_path : undefined;
}

/**
 * ponytail: CEILING — the whole spill is read into memory and the route slices
 * the result, so a ranged request still pays for the entire file. Bounded by the
 * reader's `DEFAULT_MAX_BYTES` (64 MB, `archive/read.ts:25`) and harmless at the
 * measured sizes, which sit far below it. Upgrade path: pass the clamped range
 * down and pread it, once a sealed spill can be sliced without decompressing the
 * whole frame — today `loadSealed` materialises it regardless.
 */
function fromSpill(
  row: EventContentRow,
  archivePath: string | undefined,
  env: ContentEnv,
): ResolvedContent {
  const path = spillSource(row, archivePath, env);
  if (path === undefined) return empty('missing');
  try {
    // Two `openLogical` calls, not one pread: `size` then `read`. For a sealed
    // spill the second decompress is served from the reader's LRU, so the real
    // cost is one decompress and two opens.
    const size = env.reader.size(path);
    return {
      storage: 'spill',
      content: env.reader.read(path, 0, size).toString('utf8'),
      byte_size: size,
      spill_path: path,
    };
  } catch {
    // The probe and the read race, or the file is unreadable. Degrading here is
    // what keeps a vanished spill a 200 rather than a 500.
    return empty('missing');
  }
}

/**
 * One event field, resolved to text.
 *
 * `archivePath` is the LOGICAL archive path of the row's session — never a
 * `.zst` — from `readEventArchivePath`. Absent means the session row is gone, in
 * which case every archive-backed arm degrades to its stored preview.
 */
export function resolveContent(
  row: EventContentRow,
  field: ContentField,
  archivePath: string | undefined,
  env: ContentEnv,
): ResolvedContent {
  return field === 'input'
    ? resolveInput(row, archivePath, env)
    : resolveText(row, archivePath, env);
}

/**
 * `input_storage` has FOUR states including NULL: `tools.ts:82-86` returns
 * `NO_INPUT` for every row that is not a tool call, which leaves the column
 * NULL rather than `'absent'`.
 */
function resolveInput(
  row: EventContentRow,
  archivePath: string | undefined,
  env: ContentEnv,
): ResolvedContent {
  switch (row.input_storage) {
    case 'inline':
      return fromColumn(row, 'input', 'inline');
    case 'line_ref': {
      // The EMITTING line's pair plus the row's own `block_index`
      // (`pipeline.ts:536-538`) — a tool call's input is the CALL half.
      const block =
        archivePath === undefined || row.block_index === null
          ? undefined
          : blockAt(env, archivePath, row.src_offset, row.src_len, row.block_index);
      const input = block?.kind === 'tool_use' ? block.input : undefined;
      // `JSON.stringify` over the object `obj()` handed back BY REFERENCE
      // (`accessors.ts:65-72`), so key order matches `toolInput` (`tools.ts:121`).
      return fromLineRef(row, 'input', input === undefined ? undefined : JSON.stringify(input));
    }
    case 'absent':
    case null:
      return empty('absent');
    default:
      return fromColumn(row, 'input', row.input_storage);
  }
}

/**
 * `output_storage` has SIX states. Beyond the five `schema.ts:204` names, NULL
 * is a sixth and the commonest: `pipeline.ts:490` sets the column only on
 * `tool_call` rows, so every other row carries NULL storage, NULL `text_bytes`
 * and its full uncapped text inline.
 */
function resolveText(
  row: EventContentRow,
  archivePath: string | undefined,
  env: ContentEnv,
): ResolvedContent {
  switch (row.output_storage) {
    case null: {
      // `text_bytes` is NULL on every row this arm serves, so it is not merely
      // unset — it is untrustworthy. Size the column instead of reading it.
      const text = row.text ?? '';
      return { storage: 'inline', content: text, byte_size: byteLength(text) };
    }
    case 'inline':
      return fromColumn(row, 'text', 'inline');
    case 'line_ref': {
      // ★ The RESULT line's coordinates, NEVER `src_offset`/`block_index`. The
      // stored text is `resultText` off the result line (`tools.ts:253` ←
      // `pipeline.ts:401`); the emitting line's pair would index a `tool_use`.
      const { result_offset, result_len, result_block } = row;
      const reachable =
        archivePath !== undefined &&
        result_offset !== null &&
        result_len !== null &&
        result_block !== null;
      const block = reachable
        ? blockAt(env, archivePath, result_offset, result_len, result_block)
        : undefined;
      return fromLineRef(
        row,
        'text',
        block?.kind === 'tool_result' ? resultText(block.children) : undefined,
      );
    }
    case 'spill':
      return fromSpill(row, archivePath, env);
    case 'missing':
      // No preview exists to serve: `tools.ts:160-162` clears `event.text` on the
      // spill branch and `write.ts:392-396` forbids filling it. `text_bytes`
      // sizes the harness's own marker boilerplate, which `tools.ts:17-20` bars
      // from being published as output, so it is not a size of anything servable.
      return empty('missing');
    case 'absent':
      return empty('absent');
    default:
      return fromColumn(row, 'text', row.output_storage);
  }
}

/**
 * The production env. The probe is `corpus/env.ts`'s, verbatim: the `.zst`
 * limb is required, not defensive, because a sealed spill exists only under that
 * name. `existsSync` reads no bytes, so the "every byte through the reader" rule
 * still holds and this tree adds no row to the open manifest.
 *
 * `roots` is REQUIRED — the roots a recorded `spill_path` may be read from
 * (finding F1). Production security is by construction, not caller discipline.
 */
export function createContentEnv(reader: ArchiveReader, roots: readonly string[]): ContentEnv {
  return {
    reader,
    exists: (path) => existsSync(path) || existsSync(`${path}.zst`),
    withinRoots: (path) => isUnderAnyRoot(path, roots),
  };
}

/**
 * Bind a resolver onto `ApiDeps.resolveContent` (`server/api.ts:57`). The
 * archive-path lookup is passed in as a function, so this module still never
 * touches a `DatabaseSync`. `env` is required so every production construction
 * carries the F1 containment roots.
 */
export function createContentResolver(
  archivePathOf: (session_id: string) => string | undefined,
  env: ContentEnv,
): (row: EventContentRow, field: ContentField) => ResolvedContent {
  return (row, field) => resolveContent(row, field, archivePathOf(row.session_id), env);
}
