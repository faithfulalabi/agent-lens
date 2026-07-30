// Defensive transcript-line parsing: one JSONL line in, one envelope out. Pure —
// no I/O, no DB, no clock — so the tailer's decisions stay testable in isolation.
//
// The transcript format is officially unstable, so this module trusts NOTHING
// about a line's shape beyond "it might be JSON". There is no field allowlist:
// whatever parses becomes `raw_payload` verbatim, and only the three fields we
// need for identity (`sessionId`, `uuid`, `timestamp`) are read out of it, each
// with a fallback. Anything that is not a JSON object is dead-lettered rather
// than guessed at — a dead letter is still archived, still deduped, and still
// healable by `reprocessDeadLetters`, so nothing is lost by being cautious.

import type { Envelope } from '../shared/index.js';
import { makeEnvelope } from '../shared/index.js';

/** Everything a line needs from its file to become an identified envelope. */
export interface TranscriptLineContext {
  /**
   * The CANONICALIZED absolute transcript path. Becomes the event-id
   * `file_identity` — an identity, not the change-detection fingerprint.
   */
  filePath: string;
  /** Start byte offset of this line in the file; part of the uuid-less id. */
  lineOffset: number;
  /**
   * Session id for lines that carry none. 5.2% of real lines
   * (`file-history-snapshot` / `file-history-delta`) have no `sessionId`; the
   * transcript filename stem IS the session UUID in the observed layout.
   */
  fallbackSessionId: string;
  /** ISO timestamp for lines with no parseable `timestamp` (the file mtime). */
  fallbackTs: string;
}

/**
 * A parsed line. Both arms carry a real envelope — a dead letter is archived
 * exactly like a good line, just flagged, so the bytes survive triage.
 */
export type ParsedTranscriptLine =
  | { kind: 'envelope'; envelope: Envelope }
  | { kind: 'dead_letter'; envelope: Envelope };

/** Parse one verbatim JSONL line into an envelope, or dead-letter it. */
export function parseTranscriptLine(
  line: string,
  ctx: TranscriptLineContext,
): ParsedTranscriptLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'dead_letter', envelope: transcriptDeadLetter(line, ctx) };
  }
  // Arrays and scalars are valid JSON but carry no readable identity; treating
  // one as a payload would fabricate structure the harness never sent.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'dead_letter', envelope: transcriptDeadLetter(line, ctx) };
  }

  const obj = parsed as Record<string, unknown>;
  return {
    kind: 'envelope',
    envelope: makeEnvelope({
      source: 'transcript',
      session_id: nonEmpty(obj.sessionId) ?? ctx.fallbackSessionId,
      file_identity: ctx.filePath,
      line_offset: ctx.lineOffset,
      line,
      uuid: nonEmpty(obj.uuid),
      raw_payload: parsed,
      ts: isoTs(obj.timestamp) ?? ctx.fallbackTs,
    }),
  };
}

/**
 * Wrap unusable bytes as a dead-letter envelope. `raw_payload` is the raw text,
 * so the original is recoverable; the id is derived the same way a good uuid-less
 * line's is, so re-reading the same garbage after a fingerprint reset dedupes
 * instead of piling up rows.
 *
 * Exported because the tailer builds one more of these itself: a line too large
 * to buffer is dead-lettered from a marker rather than from its bytes.
 */
export function transcriptDeadLetter(
  text: string,
  ctx: TranscriptLineContext,
): Envelope {
  return makeEnvelope({
    source: 'transcript',
    session_id: ctx.fallbackSessionId,
    file_identity: ctx.filePath,
    line_offset: ctx.lineOffset,
    line: text,
    raw_payload: text,
    ts: ctx.fallbackTs,
  });
}

/** A non-empty string field, or `undefined`. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A parseable ISO timestamp normalized to UTC, or `undefined`. */
function isoTs(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}
