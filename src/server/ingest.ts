// The single ingest funnel. Every path that admits an envelope — the
// `POST /api/ingest` handler and Task 1.4's spool replay / future backfill —
// calls `ingestEnvelope`, guaranteeing the identical upsert + span-lite + seq +
// broadcast pipeline in-process. Deliberately NOT inlined in the HTTP handler.

import type { DatabaseSync } from 'node:sqlite';
import type { Envelope } from '../shared/index.js';
import {
  insertRawEvent,
  insertSpanLite,
  nextSeq,
  type SpanLite,
} from '../db/index.js';
import type { Broadcaster } from './sse.js';

/** Outcome of an ingest: whether a new row was written and its assigned seq. */
export interface IngestResult {
  inserted: boolean;
  seq: number;
}

/** Required envelope fields — presence (shape) only, not payload contents. */
const REQUIRED_FIELDS = ['event_id', 'session_id', 'source', 'ts'] as const;

/** Shape guard: reject anything missing a required envelope field. */
export function isValidEnvelopeShape(value: unknown): value is Envelope {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (typeof obj[field] !== 'string' || obj[field] === '') {
      return false;
    }
  }
  return 'raw_payload' in obj;
}

/**
 * Admit an envelope: archive it (upsert-by-event_id), and only on a genuinely
 * new row derive a span-lite row, assign a seq, and broadcast. Duplicate
 * `event_id` → no new row, no broadcast → `{ inserted: false }`. A
 * `dead_letter` status archives the raw row for later triage but is otherwise
 * treated identically (still materialized so the event is visible).
 */
export function ingestEnvelope(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  envelope: Envelope,
  status: 'processed' | 'dead_letter' = 'processed',
): IngestResult {
  const inserted = insertRawEvent(db, envelope, status);
  if (!inserted) {
    return { inserted: false, seq: -1 };
  }

  const seq = nextSeq(db);
  insertSpanLite(db, seq, envelope);
  const span: SpanLite = {
    seq,
    event_id: envelope.event_id,
    session_id: envelope.session_id,
    source: envelope.source,
    hook_name: envelope.hook_name ?? null,
    ts: envelope.ts,
  };
  broadcaster.publish(span);
  return { inserted: true, seq };
}
