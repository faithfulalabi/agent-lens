// Deterministic event-ID derivation — the idempotency key for every ingest
// path (data-model §Primary Key Strategy). Same source datum always yields the
// same key, so upsert-by-ID makes ingest idempotent across process restarts,
// spool replays, and transcript re-reads.
//
// Precedence (documented contract):
//   hook       -> tool_use_id > prompt_id > stateless content hash
//   transcript -> line uuid  > content hash of (file_identity + line_offset + line)
//   any        -> canonical content hash of raw_payload (universal fallback)
//
// The function is fully STATELESS and PURE: it takes no caller-supplied counter.
// The `agent-lens hook` CLI is exec'd as a fresh process per hook and holds no
// per-session sequence state, so the hook fallback is a content hash rather than
// a sequence number (ratified 2026-07-22). Nothing time-, PID-, or
// randomness-derived is ever hashed, guaranteeing cross-process determinism.

import { createHash } from 'node:crypto';

/** Hook event: correlators optional, content hash is the last resort. */
export interface HookEventIdInput {
  source: 'hook';
  session_id: string;
  hook_name: string;
  tool_use_id?: string;
  prompt_id?: string;
  raw_payload: unknown;
}

/** Transcript line: line uuid preferred, else hash of file identity + offset + line. */
export interface TranscriptEventIdInput {
  source: 'transcript';
  session_id: string;
  /**
   * The CANONICALIZED absolute transcript path — invariant across growth,
   * truncation, in-place rewrite AND rotation, which is exactly what an identity
   * must be. It is deliberately NOT the detection fingerprint: rotation changes
   * the inode by definition, so a `${dev}:${ino}` identity would re-key every
   * uuid-less line of a rotated file and turn a re-read into duplicate rows
   * instead of convergence. `{dev,ino,size,headLen,headHash}` lives in the
   * `tailer_offsets.file_identity` COLUMN and is used for change detection only.
   * Both concepts share a name in `spec/data-model.md:237`; they are distinct.
   */
  file_identity: string;
  /**
   * Start byte offset of the line within the file. REQUIRED, and part of the
   * uuid-less hash: 16.6% of real transcript lines are byte-identical uuid-less
   * duplicates of an earlier line in the same file (measured over a 4197-line
   * corpus), so without the offset they collide and the later copy is dropped
   * permanently — including `last-prompt` lines, which carry user prompt text.
   *
   * Required rather than optional on purpose: an optional identity-affecting
   * field is a footgun, since a producer that forgets it silently collides.
   *
   * Stability: append leaves prior offsets untouched; truncation removes a
   * suffix, so surviving lines keep their offsets; an in-place rewrite is
   * re-read from 0 with the same offsets for unchanged bytes; rotation with
   * identical content keeps both path and offsets. NOT stable across a
   * prefix-trim rewrite (leading lines removed, remainder shifted), which
   * re-keys every uuid-less line — transcripts are append-only in practice.
   */
  line_offset: number;
  /** verbatim JSONL line text. */
  line: string;
  uuid?: string;
  raw_payload: unknown;
}

/** Backfill / spool-replay: no natural identity, always content-hashed. */
export interface GenericEventIdInput {
  source: 'backfill' | 'spool_replay';
  session_id: string;
  raw_payload: unknown;
}

export type EventIdInput =
  | HookEventIdInput
  | TranscriptEventIdInput
  | GenericEventIdInput;

/** 128-bit hex digest (32 chars) — collision-safe for the PK, half the width. */
function sha256Hex128(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Canonical JSON: recursively key-sorted, whitespace-free. Determinism of the
 * content hash depends entirely on this — object key insertion order must not
 * change the output.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Derive the deterministic envelope `event_id` for an ingest datum. */
export function deriveEventId(input: EventIdInput): string {
  switch (input.source) {
    case 'hook': {
      const correlator =
        input.tool_use_id ??
        input.prompt_id ??
        sha256Hex128(canonicalJson(input.raw_payload));
      return `${input.session_id}:hook:${input.hook_name}:${correlator}`;
    }
    case 'transcript': {
      if (input.uuid !== undefined) {
        return `${input.session_id}:transcript:${input.uuid}`;
      }
      const digest = sha256Hex128(
        `${input.file_identity}\n${input.line_offset}\n${input.line}`,
      );
      return `${input.session_id}:transcript:${digest}`;
    }
    default: {
      const digest = sha256Hex128(canonicalJson(input.raw_payload));
      return `${input.session_id}:${input.source}:${digest}`;
    }
  }
}
