// Deterministic event-ID derivation — the idempotency key for every ingest
// path (data-model §Primary Key Strategy). Same source datum always yields the
// same key, so upsert-by-ID makes ingest idempotent across process restarts,
// spool replays, and transcript re-reads.
//
// Precedence (documented contract):
//   hook       -> tool_use_id > prompt_id > stateless content hash
//   transcript -> line uuid  > content hash of (file_identity + line)
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

/** Transcript line: line uuid preferred, else hash of file identity + line. */
export interface TranscriptEventIdInput {
  source: 'transcript';
  session_id: string;
  /** stable fingerprint of the source file (inode/size + head-hash). */
  file_identity: string;
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
      const digest = sha256Hex128(`${input.file_identity}\n${input.line}`);
      return `${input.session_id}:transcript:${digest}`;
    }
    default: {
      const digest = sha256Hex128(canonicalJson(input.raw_payload));
      return `${input.session_id}:${input.source}:${digest}`;
    }
  }
}
