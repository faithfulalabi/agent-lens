// Dead-letter reprocess: the reason dead-lettering is safe rather than lossy.
// When a parser bug or a schema gap makes a projection fail, the envelope is
// still archived verbatim; once the bug is fixed, this replays those rows through
// the normalizer and heals the traces they belonged to. Nothing is re-fetched and
// nothing is re-derived — the archive IS the source of truth.
//
// It deliberately does NOT go through `ingestEnvelope`: the raw row already
// exists, so the upsert-by-event_id there would short-circuit on
// `inserted:false` and skip the projection entirely.

import type { DatabaseSync } from 'node:sqlite';
import type { Envelope, EnvelopeSource } from '../shared/index.js';
import {
  listDeadLetters,
  setRawEventStatus,
  type DeadLetterRow,
} from '../db/index.js';
import { normalize } from './normalizer.js';
import { TXN_TOP } from '../server/ingest.js';

/** Outcome of a reprocess pass. `attempted = healed + failed`. */
export interface ReprocessResult {
  attempted: number;
  healed: number;
  failed: number;
}

/**
 * Replay every `dead_letter` archive row through the normalizer, in arrival
 * order, each in its own transaction. A row that projects cleanly is retagged
 * (`processed`, or `degraded` when the hook is still unrecognized) and its spans
 * appear; a row that still fails keeps its dead-letter status with a refreshed
 * error and leaks no partial rows. Idempotent — a second pass finds nothing.
 */
export function reprocessDeadLetters(db: DatabaseSync): ReprocessResult {
  const result: ReprocessResult = { attempted: 0, healed: 0, failed: 0 };

  for (const row of listDeadLetters(db)) {
    result.attempted += 1;
    let envelope: Envelope;
    try {
      envelope = rebuildEnvelope(row);
    } catch (err) {
      // Not even JSON (HTTP-boundary garbage): nothing to project, stays dead.
      setRawEventStatus(db, row.id, 'dead_letter', String(err));
      result.failed += 1;
      continue;
    }

    db.exec(TXN_TOP.begin);
    try {
      const verdict = normalize(db, envelope);
      setRawEventStatus(
        db,
        row.id,
        verdict.degraded ? 'degraded' : 'processed',
        verdict.reason,
      );
      db.exec(TXN_TOP.commit);
      result.healed += 1;
    } catch (err) {
      db.exec(TXN_TOP.rollback);
      setRawEventStatus(db, row.id, 'dead_letter', String(err));
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Rebuild the envelope from an archive row. Current rows hold the whole envelope;
 * rows written before that change hold only `raw_payload`, so fall back to the
 * row's own columns for identity. Throws if `raw` is not JSON at all.
 */
function rebuildEnvelope(row: DeadLetterRow): Envelope {
  const parsed: unknown = JSON.parse(row.raw);
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof (parsed as Record<string, unknown>).event_id === 'string'
  ) {
    return parsed as Envelope;
  }
  return {
    event_id: row.id,
    session_id: row.session_id,
    harness: 'claude-code',
    source: row.source as EnvelopeSource,
    hook_name: row.hook_name ?? undefined,
    ts: row.received_at,
    raw_payload: parsed,
  };
}
