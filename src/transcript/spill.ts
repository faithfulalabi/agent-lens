// Resolve the `<persisted-output>` pointer on a tool result to the sidecar file
// the harness spilled it to. Ported from the 3-clause ladder in
// `src/capture/merge.ts` (`truncationSignal`), with the sidecar case fixed.
//
// This module RESOLVES A PATH AND RETURNS A LABEL. It opens no file: `env.exists`
// is a boolean probe, deliberately not a reader, because reading the sidecar
// bytes belongs to Task 3.4. `merge.ts` stays live until Task 4.5, so the
// assertions its tests bank are COPIED here, never moved.
//
// ## Why the obvious implementation fails
//
// Measured over the frozen archive (2026-08-13), 43 structured spill references:
//   - 0 of 43 basenames start with `toolu_`, and 0 of 43 equal `<tool_use_id>.txt`.
//     A resolver deriving `tool-results/<tool_use_id>.txt` succeeds ZERO times.
//     The names are an unrelated `b<8 chars>.txt` sequence.
//   - 25 of 43 references sit in a `subagents/agent-*.jsonl` sidecar whose spill
//     lives in the GRANDPARENT session directory. "Look next to the transcript"
//     resolves 0 of 43; re-anchoring under the session root resolves 43 of 43.
//
// ## Never throws
//
// An absent, elided or malformed pointer is a LABELLED STATE, not an exception.
// `missing` is normal — the UI says "full output no longer on disk", nothing
// retries and nothing logs an error. Above all nothing FABRICATES a path: an
// unresolved state carries `path: undefined`, never a plausible-looking guess.

import { basename, join } from 'node:path';
import { num, obj, str } from './accessors.js';

/** Marker the harness writes at index 0 of a spilled `tool_result` string. */
const PERSISTED_MARKER = '<persisted-output>';

/**
 * The path inside the marker. Deliberately NOT anchored at `^`: the harness
 * writes `Output too large (100KB). Full output saved to: /abs/path.txt`, so the
 * literal sits mid-line. `.` never crosses a newline, so the capture still stops
 * at the end of that line. All 53 measured marker blocks use this one phrasing.
 */
const SAVED_TO = /Full output saved to: (.+)$/m;

/** Where the harness mirrors spills, under a session directory. */
const SPILL_SUBDIR = 'tool-results';

/**
 * Byte size at which the harness truncates tool output. A BYTE test, never
 * `.length`, and never an equality: the cap can cut mid-character, so a
 * multibyte truncation stores 30,001 bytes (10,001 chars) ending in U+FFFD, and
 * an equality comparison against this constant misses it entirely. A test walks
 * this module's syntax tree to prove no such comparison exists — see
 * `__tests__/spill.test.ts`. Exported so that guard has an identifier to resolve.
 */
export const TRUNCATION_BYTES = 30000;

/**
 * Where a spill pointer ended up.
 *
 * `none` and `missing` are different answers to different questions: `none` means
 * this line never claimed a spill, `missing` means it claimed one this resolver
 * could not reach. Collapsing them would make "no spill" and "lost spill"
 * indistinguishable in the UI.
 */
export type SpillState =
  | { kind: 'resolved'; path: string; source: 'pointer' | 'marker'; declaredSize?: number }
  | { kind: 'missing'; reason: 'no-path' | 'not-on-disk'; declaredPath?: string }
  | { kind: 'none' };

/**
 * The filesystem probe and the roots to re-anchor under, injected so this module
 * imports no `node:fs` and every test is hermetic.
 */
export interface ResolveEnv {
  /**
   * True when the path exists IN ANY ARCHIVED FORM. An archived spill can be
   * sealed to `<p>.zst` with a `.zst.sha256` sidecar, so an adapter over the
   * archive MUST answer true for a path present only as `<p>.zst` — otherwise
   * spill resolution reports `missing` for every sealed file. Owning the `.zst`
   * fallback here, rather than in this module, is what keeps `node:fs` out.
   */
  exists(path: string): boolean;
  /** The session directory holding `tool-results/`. For a sidecar transcript
   *  this is the GRANDPARENT of the transcript, not its own directory. */
  sessionRoot?: string;
  archiveRoot?: string;
}

/** The declared path plus where it came from, before any existence check. */
interface Declared {
  path: string;
  source: 'pointer' | 'marker';
  declaredSize?: number;
}

/** The `tool_result` block's text, however the harness nested it. */
function toolResultText(line: unknown): string | undefined {
  const content = obj(obj(line, undefined)?.message, undefined)?.content;
  const blocks = Array.isArray(content) ? (content as readonly unknown[]) : undefined;
  if (blocks === undefined) return undefined;

  for (const block of blocks) {
    const fields = obj(block, undefined);
    if (str(fields?.type, undefined) !== 'tool_result') continue;

    const inner = fields?.content;
    const direct = str(inner, undefined);
    if (direct !== undefined) return direct;

    // The array form: `[{ type: 'text', text: '<persisted-output>…' }]`.
    if (!Array.isArray(inner)) continue;
    for (const part of inner as readonly unknown[]) {
      const text = str(obj(part, undefined)?.text, undefined);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

/**
 * The path this line CLAIMS, by the same clause order `merge.ts` documents as
 * load-bearing: the structured field first, the text marker only as the fallback
 * for harness builds that emit no structured pointer.
 */
function declaredPathOf(line: unknown): Declared | undefined {
  const tur = obj(line, undefined)?.toolUseResult;
  // `toolUseResult` is a bare STRING on some tool calls, so every read below has
  // to go through the object narrowing rather than a property access.
  const pointer = str(obj(tur, undefined)?.['persistedOutputPath'], undefined);
  if (pointer !== undefined) {
    const size = num(obj(tur, undefined)?.['persistedOutputSize'], undefined);
    return {
      path: pointer,
      source: 'pointer',
      declaredSize: size !== undefined && Number.isInteger(size) ? size : undefined,
    };
  }

  const text = toolResultText(line);
  // `startsWith`, NEVER `includes`: the same literal appears mid-string in
  // assistant prose describing truncation, and a substring test would resolve a
  // spill for the model merely talking about one. Measured at index 0, always.
  if (text === undefined || !text.startsWith(PERSISTED_MARKER)) return undefined;

  const marked = SAVED_TO.exec(text)?.[1];
  // The elided-path form of the marker lands here: a real marker with no path in
  // it. Answering `undefined` sends it to `missing: 'no-path'` below, which is
  // the whole point — no throw, and no fabricated path.
  return marked === undefined ? undefined : { path: marked, source: 'marker' };
}

/**
 * Re-anchor a spill basename under the roots we were given. This is what
 * recovers the sidecar cases: the declared path names the machine that wrote it
 * (`/home/USER/.claude/projects/…`), which is not where the file is readable now.
 */
function reanchor(name: string, env: ResolveEnv): string | undefined {
  // An empty basename would re-anchor to the `tool-results` DIRECTORY, and a
  // probe answering true for it would report a directory as the spill file.
  if (name === '') return undefined;
  for (const root of [env.sessionRoot, env.archiveRoot]) {
    if (root === undefined) continue;
    const candidate = join(root, SPILL_SUBDIR, name);
    if (env.exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve one line's spill pointer to a labelled state. Total: every input,
 * however malformed, produces a `SpillState` rather than an exception.
 */
export function resolvePersistedOutput(line: unknown, env: ResolveEnv): SpillState {
  let declared: Declared | undefined;
  try {
    declared = declaredPathOf(line);
  } catch {
    // The accessors already absorb a REVOKED Proxy. What they cannot absorb is a
    // live Proxy whose `get` trap throws: `obj` hands back the object, and the
    // property read after it is what raises. A spill pointer is never worth
    // aborting a projection for.
    return { kind: 'none' };
  }

  if (declared === undefined) {
    // A marker with no readable path is a claim this resolver could not satisfy;
    // no marker at all is no claim. `path` is absent in both, never invented.
    return hasMarker(line) ? { kind: 'missing', reason: 'no-path' } : { kind: 'none' };
  }

  const probe = (path: string): boolean => {
    try {
      return env.exists(path) === true;
    } catch {
      // An injected probe that throws must not take the projection with it.
      return false;
    }
  };

  // The size is omitted rather than set to `undefined`: an explicit undefined
  // key is a key, and downstream JSON would carry it.
  const resolvedAt = (path: string): SpillState => ({
    kind: 'resolved',
    path,
    source: declared.source,
    ...(declared.declaredSize !== undefined && { declaredSize: declared.declaredSize }),
  });

  if (probe(declared.path)) return resolvedAt(declared.path);

  let rescued: string | undefined;
  try {
    rescued = reanchor(basename(declared.path), env);
  } catch {
    rescued = undefined;
  }
  if (rescued !== undefined) return resolvedAt(rescued);

  // The path is kept even though the file is not: it is the only record of what
  // was spilled, and discarding it would leave the UI unable to name the loss.
  return { kind: 'missing', reason: 'not-on-disk', declaredPath: declared.path };
}

/** True when the line carries a spill marker at index 0 of its tool result. */
function hasMarker(line: unknown): boolean {
  try {
    return toolResultText(line)?.startsWith(PERSISTED_MARKER) === true;
  } catch {
    return false;
  }
}

/**
 * True when the harness truncated this output — on BYTES at or above the cap, or
 * on the marker alone. Two independent signals: a 2 KB marker block is far under
 * the cap, and a multibyte cut lands ABOVE it at 30,001 bytes, so either signal
 * alone misses cases the other catches.
 */
export function isHarnessTruncated(text: unknown): boolean {
  const value = str(text, undefined);
  if (value === undefined) return false;
  if (value.startsWith(PERSISTED_MARKER)) return true;
  return Buffer.byteLength(value, 'utf8') >= TRUNCATION_BYTES;
}
