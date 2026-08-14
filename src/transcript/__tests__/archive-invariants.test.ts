// AC1 under real data, without the decay. Opt-in via `AGENT_LENS_REAL_CORPUS=1`,
// same gate as `src/archive/__tests__/real-corpus.test.ts`.
//
// Reads `~/.agent-lens/archive` and NEVER `~/.claude/projects`. The archive is
// append-only and the live source is not: the corpus grew 40,064 -> 40,444 lines
// during one hour of measurement, and `api_error` went 9 -> 0 through pure
// transcript expiry. So every assertion here is an INVARIANT or a LOWER BOUND —
// never an absolute count, which would red on a Tuesday for no reason.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyLine, type ParsedKind } from '../line.js';
import { DriftCounter } from '../drift.js';
import { archiveJsonlFiles, offsetLines } from './fixtures.js';

const ENABLED = process.env.AGENT_LENS_REAL_CORPUS === '1';
const runIt = ENABLED ? it : it.skip;

const ARCHIVE_ROOT = join(homedir(), '.agent-lens', 'archive');

/** Lower bounds, well under what was measured on 2026-08-13 (254 files, 40,701 lines). */
const MIN_FILES = 100;
const MIN_LINES = 20000;

const DECLARED_KINDS: ReadonlySet<string> = new Set<ParsedKind>([
  'assistant',
  'user',
  'system',
  'attachment',
  'mode',
  'last-prompt',
  'permission-mode',
  'ai-title',
  'file-history-snapshot',
  'file-history-delta',
  'queue-operation',
  'pr-link',
  'started',
  'result',
  'unknown',
]);

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
            // A partially written tail line is a real thing in an append-only
            // archive. It is still a line, so it still gets a row.
            parsed = undefined;
          }
          return classifyLine(parsed, { byteOffset: entry.byteOffset, drift });
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

        // The counter must survive real data too — it is a report about a bad
        // transcript, so failing on one would defeat its purpose.
        expect(() => JSON.parse(drift.serialize()), file).not.toThrow();
        linesSeen += entries.length;
      }

      expect(linesSeen).toBeGreaterThanOrEqual(MIN_LINES);

      // A lower bound on coverage, not an equality: `started`/`result` live in a
      // single sidecar that a future archive may not contain, and asserting all
      // 14 would red on a corpus that is merely smaller.
      for (const kind of ['assistant', 'user', 'system', 'attachment', 'ai-title']) {
        expect(kindsSeen.has(kind), `no ${kind} line in the archive`).toBe(true);
      }
    },
    600000,
  );
});
