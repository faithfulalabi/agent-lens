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
  setRawEventStatus,
  type SpanLite,
} from '../db/index.js';
import { normalize } from '../capture/normalizer.js';
import type { Broadcaster } from './sse.js';

// --- TASK 2.4 SEAM ---------------------------------------------------------
// The ONLY place transaction verbs are named. Task 2.4's batch endpoint adds a
// nested frame (`SAVEPOINT item` / `RELEASE item` / `ROLLBACK TO item`) and
// passes it per call from inside `ingestBatch`; standalone callers keep
// `TXN_TOP`. Nothing else in the ingest path may `db.exec('BEGIN')` directly.

/** The three transaction verbs a nested-transaction caller can substitute. */
export interface TxnFrame {
  begin: string;
  commit: string;
  rollback: string;
}

/** Top-level transaction verbs — the default for every standalone ingest. */
export const TXN_TOP: TxnFrame = {
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
};

/**
 * Outcome of an ingest: whether a new row was written and its assigned seq.
 * `deadLettered` is present only when it is `true`, so the happy-path JSON body
 * stays exactly `{inserted, seq}`.
 */
export interface IngestResult {
  inserted: boolean;
  seq: number;
  /** Set only when the projection failed and the envelope was archived for triage. */
  deadLettered?: true;
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
 * Admit an envelope in a single per-envelope transaction: archive it
 * (upsert-by-event_id), and only on a genuinely new row derive a span-lite row,
 * assign a seq, and run the normalizer projection (Task 2.2). Duplicate
 * `event_id` → no new row, no projection, no broadcast → `{ inserted: false }`.
 * A `dead_letter` status archives the raw row for later triage but is otherwise
 * treated identically (still materialized so the event is visible).
 *
 * The whole body runs inside one transaction frame so a projection failure never
 * leaves a half-written trace. Broadcast is I/O and happens AFTER commit, so
 * subscribers only ever see durably-persisted events. The Phase-1 `nextSeq` +
 * `insertSpanLite` compat writes are retained alongside `normalize` until the
 * `/api/events` read-path cuts over (Task 2.5-adjacent follow-up).
 *
 * **Ingest never throws** (Task 2.3). A projection failure rolls back, then
 * re-archives the same envelope as a `dead_letter` (the event is real, only its
 * projection broke) so `reprocessDeadLetters` can heal it after a parser fix.
 * A drift verdict from the normalizer marks the archive row `degraded` inside
 * the same transaction, so the counter and the projection commit together.
 */
export function ingestEnvelope(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  envelope: Envelope,
  status: 'processed' | 'dead_letter' = 'processed',
  txn: TxnFrame = TXN_TOP,
): IngestResult {
  db.exec(txn.begin);
  let span: SpanLite;
  try {
    const inserted = insertRawEvent(db, envelope, status);
    if (!inserted) {
      db.exec(txn.commit);
      return { inserted: false, seq: -1 };
    }

    const seq = nextSeq(db);
    insertSpanLite(db, seq, envelope);
    if (status === 'processed') {
      const verdict = normalize(db, envelope);
      if (verdict.degraded) {
        setRawEventStatus(db, envelope.event_id, 'degraded', verdict.reason);
      }
    }
    span = spanLiteOf(seq, envelope);
    db.exec(txn.commit);
  } catch (err) {
    db.exec(txn.rollback);
    return archiveDeadLetter(db, broadcaster, envelope, err, txn);
  }

  // Broadcast only after the transaction is durable (I/O outside the txn).
  broadcaster.publish(span);
  return { inserted: true, seq: span.seq };
}

/** Derive the live-list row for an admitted envelope. */
function spanLiteOf(seq: number, envelope: Envelope): SpanLite {
  return {
    seq,
    event_id: envelope.event_id,
    session_id: envelope.session_id,
    source: envelope.source,
    hook_name: envelope.hook_name ?? null,
    ts: envelope.ts,
  };
}

/**
 * Recovery leg for a failed projection: rollback has already discarded the
 * partial write, so re-archive the envelope as a dead letter (with the error) and
 * still materialize the live-list row + broadcast — the event genuinely arrived.
 * If even this fails the DB is unusable; still no throw, ingest just reports it.
 */
function archiveDeadLetter(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  envelope: Envelope,
  err: unknown,
  txn: TxnFrame,
): IngestResult {
  let span: SpanLite;
  db.exec(txn.begin);
  try {
    insertRawEvent(db, envelope, 'dead_letter', String(err));
    const seq = nextSeq(db);
    insertSpanLite(db, seq, envelope);
    span = spanLiteOf(seq, envelope);
    db.exec(txn.commit);
  } catch {
    db.exec(txn.rollback);
    return { inserted: false, seq: -1, deadLettered: true };
  }
  broadcaster.publish(span);
  return { inserted: true, seq: span.seq, deadLettered: true };
}
