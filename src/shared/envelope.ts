// The envelope: the schema contract shared verbatim by adapter, tailer, and
// server (RFC one-door: bespoke envelope). Every producer builds envelopes the
// same way via `makeEnvelope`, so the event_id is always derived identically.

import { deriveEventId } from './event-id.js';
import type { EventIdInput } from './event-id.js';

/** Where an envelope originated (mirrors RawEvent.source in data-model). */
export type EnvelopeSource = 'hook' | 'transcript' | 'backfill' | 'spool_replay';

/** The wire/spool contract. `ts` is ISO-8601 (sortable, excluded from the id hash). */
export interface Envelope {
  /** deterministic idempotency key from `deriveEventId`. */
  event_id: string;
  session_id: string;
  harness: string;
  source: EnvelopeSource;
  /** present only for hook-sourced events. */
  hook_name?: string;
  /** ISO-8601 timestamp; caller-supplied, never hashed (keeps replay deterministic). */
  ts: string;
  raw_payload: unknown;
}

/** Input to `makeEnvelope`: the id-derivation input plus `ts` and optional `harness`. */
export type MakeEnvelopeInput = EventIdInput & {
  ts: string;
  harness?: string;
};

const DEFAULT_HARNESS = 'claude-code';

/** Build an envelope, deriving its `event_id` so all producers agree on identity. */
export function makeEnvelope(input: MakeEnvelopeInput): Envelope {
  const event_id = deriveEventId(input);
  const envelope: Envelope = {
    event_id,
    session_id: input.session_id,
    harness: input.harness ?? DEFAULT_HARNESS,
    source: input.source,
    ts: input.ts,
    raw_payload: input.raw_payload,
  };
  if (input.source === 'hook') {
    envelope.hook_name = input.hook_name;
  }
  return envelope;
}
