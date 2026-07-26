// The single ingest funnel. Every path that admits an envelope — the
// `POST /api/ingest` handler and Task 1.4's spool replay / future backfill —
// calls `ingestEnvelope` or `ingestBatch`, guaranteeing the identical upsert +
// span-lite + seq + rollup + broadcast pipeline in-process. Deliberately NOT
// inlined in the HTTP handler.

import type { DatabaseSync } from 'node:sqlite';
import type { Envelope } from '../shared/index.js';
import {
  insertRawEvent,
  insertSpanLite,
  nextSeq,
  recomputeRollups,
  setRawEventStatus,
  type SpanLite,
} from '../db/index.js';
import { normalize } from '../capture/normalizer.js';
import type { Broadcaster } from './sse.js';

// --- Transaction frames ----------------------------------------------------
// The ONLY place transaction verbs are named. A standalone ingest opens a real
// transaction (`TXN_TOP`); an item inside `ingestBatch` opens a SAVEPOINT
// instead (`TXN_NESTED`) so one poison envelope rolls back to its own boundary
// without destroying the items already applied in the surrounding transaction.
// Nothing else in the ingest path may `db.exec('BEGIN')` directly.

/** The three verbs that open, commit, and abort one unit of work. */
export interface TxnVerbs {
  begin: string;
  commit: string;
  rollback: string;
}

/**
 * A transaction frame: the main verbs, plus the ones the dead-letter recovery
 * leg needs. Recovery runs AFTER `rollback`, so under a savepoint frame it
 * cannot reuse the item's own savepoint name (`ROLLBACK TO item` leaves `item`
 * on the stack) — it gets its own, and `close` then pops the item frame.
 */
export interface TxnFrame extends TxnVerbs {
  /** Verbs for the re-archive that runs after `rollback`. */
  recover: TxnVerbs;
  /** Issued once recovery finishes, to pop the frame. `null` at top level. */
  close: string | null;
}

const TOP_VERBS: TxnVerbs = {
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
};

/** Top-level transaction verbs — the default for every standalone ingest. */
export const TXN_TOP: TxnFrame = {
  ...TOP_VERBS,
  recover: TOP_VERBS,
  close: null,
};

/**
 * Savepoint verbs for one item inside `ingestBatch`. A fixed name pair is
 * enough: SQLite pops the name on `RELEASE`, and releasing `item` also releases
 * a `recover` left open by a failed recovery leg (probe-verified), so no
 * per-index suffixes are needed.
 *
 * **Never hand this to a standalone caller.** Outside a transaction `SAVEPOINT`
 * opens an implicit one, and the recovery leg would leave it open forever —
 * which is why `reprocessDeadLetters` and the inactivity sweep keep `TXN_TOP`.
 */
export const TXN_NESTED: TxnFrame = {
  begin: 'SAVEPOINT item',
  commit: 'RELEASE item',
  rollback: 'ROLLBACK TO item',
  recover: {
    begin: 'SAVEPOINT recover',
    commit: 'RELEASE recover',
    rollback: 'ROLLBACK TO recover',
  },
  close: 'RELEASE item',
};

/**
 * Savepoint verbs for the dirty-set rollup flush. It sits OUTSIDE every per-item
 * savepoint, so it needs a third name of its own.
 */
const TXN_ROLLUP: TxnVerbs = {
  begin: 'SAVEPOINT rollup',
  commit: 'RELEASE rollup',
  rollback: 'ROLLBACK TO rollup',
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

/** One envelope queued for `ingestBatch`, with its archive status. */
export interface IngestBatchItem {
  envelope: Envelope;
  status?: 'processed' | 'dead_letter';
}

/** The publish-only slice of `Broadcaster` that ingest needs. */
type EventSink = Pick<Broadcaster, 'publish'>;

/** Parents whose rollups a batch must recompute before it commits. */
interface DirtySet {
  traces: Set<string>;
  sessions: Set<string>;
}

/** Required envelope fields — presence (shape) only, not payload contents. */
const REQUIRED_FIELDS = ['event_id', 'session_id', 'source', 'ts'] as const;

/** How many envelopes share one transaction. Bounds both commit count and lock hold. */
export const BATCH_SIZE = 64;

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
 * Admit one envelope. Thin wrapper over {@link ingestBatch} so there is exactly
 * one code path: the single-item batch degrades to the same BEGIN/COMMIT frame
 * a standalone ingest always had.
 */
export function ingestEnvelope(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  envelope: Envelope,
  status: 'processed' | 'dead_letter' = 'processed',
): IngestResult {
  return ingestBatch(db, broadcaster, [{ envelope, status }])[0]!;
}

/**
 * Admit a slice of envelopes in ONE transaction, each item isolated by its own
 * savepoint, with a single rollup flush for the whole slice before commit.
 *
 * Why a batch at all: a 64-item burst on one trace costs one recompute instead
 * of 64, and a 10k-line spool replay costs ~150 commits instead of 10k. Results
 * come back in input order, one per item.
 *
 * **Poison-item isolation is `SAVEPOINT`, not rollback-and-retry.** Per-item
 * recovery does not throw (Task 2.3: ingest never throws), so an outer catch
 * would never fire; and a bare `ROLLBACK` inside the loop would discard every
 * item already applied, silently autocommit the rest outside any transaction,
 * and make the closing `COMMIT` fail with "no transaction is active".
 *
 * **Broadcast is deferred past `COMMIT`** — items publish into a buffer, which
 * is drained only once the whole slice is durable, so a subscriber never sees an
 * event that a later rollback erased.
 */
export function ingestBatch(
  db: DatabaseSync,
  broadcaster: Broadcaster,
  items: readonly IngestBatchItem[],
): IngestResult[] {
  if (items.length === 0) return [];

  const pending: SpanLite[] = [];
  const buffer: EventSink = {
    publish: (event) => {
      pending.push(event);
    },
  };
  const dirty: DirtySet = { traces: new Set(), sessions: new Set() };
  const results: IngestResult[] = [];

  db.exec(TXN_TOP.begin);
  try {
    for (const item of items) {
      results.push(
        ingestOne(db, buffer, item.envelope, item.status ?? 'processed', dirty),
      );
    }
    flushRollups(db, dirty);
    db.exec(TXN_TOP.commit);
  } catch {
    // Only BEGIN/COMMIT itself can land here — per-item and rollup failures are
    // both contained. Nothing was persisted, so report every item as unwritten
    // and needing triage rather than throwing: ingest never throws (Task 2.3
    // AC1), and calling these "replayed" would make the counters lie.
    try {
      db.exec(TXN_TOP.rollback);
    } catch {
      /* no transaction to roll back — already the state we want */
    }
    const failed: IngestResult = { inserted: false, seq: -1, deadLettered: true };
    return items.map(() => ({ ...failed }));
  }

  // Durable now: fan out the buffered events (I/O outside the transaction).
  for (const span of pending) broadcaster.publish(span);
  return results;
}

/**
 * Recompute the batch's touched parents inside its own savepoint. Rollups are
 * derived data that self-heals on the next envelope (recompute-from-children is
 * idempotent), so a failure here must not take the real rows down with it — nor
 * throw, which would regress "ingest never throws".
 */
function flushRollups(db: DatabaseSync, dirty: DirtySet): void {
  if (dirty.traces.size === 0 && dirty.sessions.size === 0) return;
  db.exec(TXN_ROLLUP.begin);
  try {
    recomputeRollups(db, dirty.traces, dirty.sessions);
  } catch {
    db.exec(TXN_ROLLUP.rollback);
  }
  db.exec(TXN_ROLLUP.commit);
}

/**
 * One item of a batch: archive it (upsert-by-`event_id`), and only on a
 * genuinely new row derive a span-lite row, assign a seq, and run the normalizer
 * projection. Duplicate `event_id` → no new row, no projection, no broadcast →
 * `{ inserted: false }`. A `dead_letter` status archives the raw row for later
 * triage but is otherwise treated identically (still materialized so the event
 * is visible), and is deliberately NOT projected.
 *
 * Runs entirely inside `TXN_NESTED`, so a projection failure rolls back to this
 * item's savepoint and the surrounding batch transaction continues. The failure
 * leg re-archives the same envelope as a `dead_letter` (the event is real, only
 * its projection broke) so `reprocessDeadLetters` can heal it after a fix. A
 * drift verdict marks the archive row `degraded` in the same frame, so the
 * counter and the projection commit together.
 *
 * `nextSeq` stays per item and inside the transaction: `spans_lite.seq` is a
 * rowid alias, so `MAX(seq)` is O(1) and sees this transaction's prior inserts.
 * That keeps issuance gapless and monotonic without an in-memory counter that
 * could drift when an item is skipped as a duplicate.
 */
function ingestOne(
  db: DatabaseSync,
  sink: EventSink,
  envelope: Envelope,
  status: 'processed' | 'dead_letter',
  dirty: DirtySet,
): IngestResult {
  const txn = TXN_NESTED;
  let span: SpanLite;
  db.exec(txn.begin);
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
      // Task 2.3's finalization pass (unclosed spans -> `unknown`) has already
      // run inside `normalize`, so recomputing these AFTER the loop sees the
      // terminated spans, not the ones it was about to close.
      for (const traceId of verdict.traceIds ?? []) dirty.traces.add(traceId);
      dirty.sessions.add(envelope.session_id);
    }
    span = spanLiteOf(seq, envelope);
    db.exec(txn.commit);
  } catch (err) {
    db.exec(txn.rollback);
    return archiveDeadLetter(db, sink, envelope, err, txn);
  }

  sink.publish(span);
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
 * Recovery leg for a failed projection: the rollback has already discarded the
 * partial write, so re-archive the envelope as a dead letter (with the error) and
 * still materialize the live-list row + publish — the event genuinely arrived.
 * If even this fails the DB is unusable; still no throw, ingest just reports it.
 *
 * Uses `txn.recover` rather than the item's own verbs, then `txn.close` to pop
 * the item frame. Under `TXN_TOP` both collapse to the plain BEGIN/COMMIT pair
 * and `close` is a no-op, so standalone behaviour is byte-identical to Task 2.3.
 */
function archiveDeadLetter(
  db: DatabaseSync,
  sink: EventSink,
  envelope: Envelope,
  err: unknown,
  txn: TxnFrame,
): IngestResult {
  let span: SpanLite;
  db.exec(txn.recover.begin);
  try {
    insertRawEvent(db, envelope, 'dead_letter', String(err));
    const seq = nextSeq(db);
    insertSpanLite(db, seq, envelope);
    span = spanLiteOf(seq, envelope);
    db.exec(txn.recover.commit);
  } catch {
    db.exec(txn.recover.rollback);
    closeFrame(db, txn);
    return { inserted: false, seq: -1, deadLettered: true };
  }
  closeFrame(db, txn);
  sink.publish(span);
  return { inserted: true, seq: span.seq, deadLettered: true };
}

/** Pop a savepoint frame after its recovery leg. No-op at top level. */
function closeFrame(db: DatabaseSync, txn: TxnFrame): void {
  if (txn.close !== null) db.exec(txn.close);
}
