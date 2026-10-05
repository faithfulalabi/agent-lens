// The classifier under real data. Opt-in via `AGENT_LENS_REAL_CORPUS=1`, and it reads the
// append-only archive, never the live source. Every assertion here is an INVARIANT or a LOWER
// BOUND — an absolute count would red on a Tuesday for no reason.

import { describe, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyLine, type ParsedKind } from '../line.js';
import { DriftCounter } from '../drift.js';
import { ARCHIVE_ROOT, archiveJsonlFiles, offsetLines } from './fixtures.js';
import { runIt } from './run-it.js';

/** Lower bounds, deliberately well under what any real archive holds. */
const MIN_FILES = 100;
const MIN_LINES = 20000;

/** `Record<ParsedKind, true>`, not a `Set`: a set accepts a SUBSET, so `tsc` would miss a gap. */
const ALL_KINDS: Record<ParsedKind, true> = {
  assistant: true,
  user: true,
  system: true,
  attachment: true,
  mode: true,
  'last-prompt': true,
  'permission-mode': true,
  'ai-title': true,
  'file-history-snapshot': true,
  'file-history-delta': true,
  'queue-operation': true,
  'pr-link': true,
  started: true,
  result: true,
  'atis-latch': true,
  'cost-state': true,
  'fork-context-ref': true,
  unknown: true,
};

const DECLARED_KINDS: ReadonlySet<string> = new Set(Object.keys(ALL_KINDS));

describe('the frozen archive classifies without throwing (opt-in via AGENT_LENS_REAL_CORPUS=1)', () => {
  runIt(
    'classifies every line of every archived transcript, dropping none',
    () => {
      const files = archiveJsonlFiles(ARCHIVE_ROOT);
      // Non-vacuity: without this, an empty archive passes every assertion below.
      expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);

      let linesSeen = 0;
      const kindsSeen = new Set<string>();

      for (const file of files) {
        const drift = new DriftCounter();
        const entries = offsetLines(readFileSync(file).toString('utf8'));
        const rows = entries.map((entry) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(entry.text);
          } catch {
            // A partially written tail line is real in an append-only archive. It is still
            // a line, so it still gets a row.
            parsed = undefined;
          }
          return classifyLine(parsed, {
            byteOffset: entry.byteOffset,
            byteLength: entry.byteLength,
            drift,
          });
        });

        // Per FILE, not in aggregate: a compensating pair of errors would hide
        // in a total.
        expect(rows, file).toHaveLength(entries.length);

        for (const row of rows) {
          expect(DECLARED_KINDS.has(row.kind), `${file}: ${row.kind}`).toBe(true);
          if (row.kind === 'unknown') {
            expect(row.raw_type, file).not.toBe('');
          }
          kindsSeen.add(row.kind);
        }

        // The counter is a report about a bad transcript, so failing on one defeats it.
        expect(() => JSON.parse(drift.serialize()), file).not.toThrow();
        linesSeen += entries.length;
      }

      expect(linesSeen).toBeGreaterThanOrEqual(MIN_LINES);

      // A lower bound on coverage, not an equality: `started`/`result` live in a single
      // sidecar a given archive may not contain, so demanding every kind reds on a smaller one.
      for (const kind of ['assistant', 'user', 'system', 'attachment', 'ai-title']) {
        expect(kindsSeen.has(kind), `no ${kind} line in the archive`).toBe(true);
      }
    },
    600000,
  );
});
