// Acceptance tests for the Task 1.7 golden fixture sets. The sets themselves
// are produced by a HITL runbook (four live Claude Code sessions), so this file
// ships BEFORE the data does. It is deliberately written not to pass vacuously:
//
//   - the ledger test goes RED on any partial set (1-3 of 4 present), which is
//     the realistic failure — a session that was captured but not committed;
//   - every deep assertion below runs against whatever IS present, so a set
//     that exists but is malformed fails on content even while the ledger fails
//     on count;
//   - the pre-capture state (0 of 4) passes, but prints PENDING CAPTURE.
//
// Secret-residue scanning is the other half of the gate and lives in
// experiments/tracer-bullet/verify.test.mjs (it needs verify.mjs's detectRules).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidEnvelopeShape } from '../../server/ingest.js';
import {
  bootTestServer,
  openTestDb,
  cleanupDir,
  TOKEN_HEADER,
  type TestServer,
} from '../../server/__tests__/helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRUBBED_ROOT = join(repoRoot, 'fixtures', 'scrubbed');

/** The four sets Task 1.7 AC3 requires, one dedicated Claude Code session each. */
const FIXTURE_SETS = ['multi-turn', 'large-output', 'subagent', 'compaction'] as const;

/** A set counts as captured once it has the file every consumer replays. */
const present = FIXTURE_SETS.filter((set) =>
  existsSync(join(SCRUBBED_ROOT, set, 'envelopes.jsonl')),
);

if (present.length === 0) {
  console.warn(
    '[golden-fixtures] PENDING CAPTURE — fixtures/scrubbed/ holds none of the four sets.\n' +
      '  The replay/completeness assertions below have no data to run against yet.\n' +
      '  Run the HITL runbook in internal_docs/agent-lens/tasks/task-1.7-fixture-finalization.md\n' +
      '  (source experiments/tracer-bullet/run-experiment.sh <exp>), then re-run npm test.',
  );
}

/** Read a fixture file's non-empty lines. */
function readLines(set: string, ...parts: string[]): string[] {
  return readFileSync(join(SCRUBBED_ROOT, set, ...parts), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('golden fixture set ledger (AC3)', () => {
  it('holds either all four sets or none — a partial set is a capture bug', () => {
    // Fails loudly at 1, 2 or 3: the human captured some sessions and stopped,
    // or a set was committed without its envelopes.jsonl. `present` is derived
    // by filtering FIXTURE_SETS, so a count of 4 also pins the names.
    expect([0, FIXTURE_SETS.length]).toContain(present.length);
  });
});

if (present.length > 0) {
  describe.each(present)('fixture set %s', (set) => {
    const setDir = join(SCRUBBED_ROOT, set);

    describe('layout (AC3)', () => {
      it('has a non-empty envelopes.jsonl', () => {
        expect(readLines(set, 'envelopes.jsonl').length).toBeGreaterThan(0);
      });

      it('has a non-empty parent transcript', () => {
        expect(readLines(set, 'transcripts', 'parent.jsonl').length).toBeGreaterThan(0);
      });

      it('has a manifest naming this set and mapping the parent transcript', () => {
        const manifest = JSON.parse(readFileSync(join(setDir, 'manifest.json'), 'utf8')) as {
          exp: string;
          session_id: string;
          path_map: Record<string, string>;
        };
        expect(manifest.exp).toBe(set);
        expect(manifest.session_id).toBeTruthy();
        // Phase 3's tailer resolves transcript_path through this map; without
        // the parent entry it cannot find a transcript that no longer exists.
        expect(Object.values(manifest.path_map)).toContain(join('transcripts', 'parent.jsonl'));
      });
    });

    it.runIf(set === 'large-output')('carries the tool-results sidecars', () => {
      // Founder decision #1 reversed 2026-07-26: full tool output IS
      // recoverable from <session-dir>/tool-results/<id>.txt. Without these the
      // restored Phase-3 backfill work has no golden test.
      const dir = join(setDir, 'tool-results');
      expect(existsSync(dir)).toBe(true);
      const sidecars = readdirSync(dir);
      expect(sidecars.length).toBeGreaterThan(0);
      for (const name of sidecars) {
        expect(statSync(join(dir, name)).size).toBeGreaterThan(0);
      }
    });

    it.runIf(set === 'subagent')('carries >=2 sub-agent transcripts, each with .meta.json', () => {
      const dir = join(setDir, 'transcripts', 'subagents');
      expect(existsSync(dir)).toBe(true);
      const names = readdirSync(dir);
      const transcripts = names.filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'));
      expect(transcripts.length).toBeGreaterThanOrEqual(2);
      // The .meta.json holds the toolUseId join Tasks 4.2/4.3 parent on;
      // SubagentStop is unreliable (findings :339-344), so a missing sidecar
      // silently costs 4.3 its correlation.
      for (const transcript of transcripts) {
        expect(names).toContain(transcript.replace(/\.jsonl$/, '.meta.json'));
      }
    });

    describe('replayability through /api/ingest (AC4)', () => {
      let server: TestServer;
      let lines: string[];

      beforeAll(async () => {
        lines = readLines(set, 'envelopes.jsonl');
        server = await bootTestServer();
      });

      afterAll(async () => {
        await server.close();
        cleanupDir(server.dataDir);
      });

      it('every line parses and passes isValidEnvelopeShape', () => {
        for (const line of lines) {
          expect(isValidEnvelopeShape(JSON.parse(line))).toBe(true);
        }
      });

      it('every line POSTs 200 and archives one row per distinct envelope', async () => {
        // /api/* is token-guarded (src/server/app.ts:46), so this must go
        // through bootTestServer's token — a bare buildApp() POST 401s.
        for (const line of lines) {
          const res = await fetch(server.url('/api/ingest'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
            body: line,
          });
          expect(res.status).toBe(200);
        }

        const distinct = new Set(
          lines.map((line) => (JSON.parse(line) as { event_id: string }).event_id),
        );
        const db = openTestDb(server.dataDir);
        try {
          const row = db.prepare('SELECT COUNT(*) AS n FROM raw_events').get() as { n: number };
          // Distinct rather than lines.length: ingest is idempotent on
          // event_id, so a set containing a genuine duplicate must still pass.
          expect(row.n).toBe(distinct.size);
        } finally {
          db.close();
        }
      });
    });
  });
}
