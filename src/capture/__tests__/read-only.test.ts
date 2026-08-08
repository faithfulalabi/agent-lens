// AC4, behavioural half — the corpus is byte-identical after the tailer has run.
//
// The static sibling (`src/fs-write-sites.test.ts`) proves no write-capable
// `node:fs` call exists in the tailer's module. This proves the stronger, dumber
// thing: point the tailer at a transcript tree, run it three times with backfill
// ON — the mode `npm run dev` uses against the developer's own history — and
// every file is still exactly the bytes it was.
//
// Each proof catches what the other misses. A static scan cannot see a write
// that arrives through a helper, a stream, or a dependency; a behavioural
// snapshot cannot see a write to a file the fixture happens not to contain.
//
// `atime` is deliberately NOT in the snapshot: reading legitimately updates it,
// so including it would make this test fail for the one behaviour that is
// allowed.

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Broadcaster } from '../../server/sse.js';
import { tailOnce } from '../tailer.js';
import { freshDb } from './fixtures.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** What a file is, for the purposes of "nothing changed". */
interface FileState {
  size: number;
  mtimeMs: number;
  ino: number;
  sha256: string;
}

/** Every file under `dir`, recursively, keyed by its path relative to `dir`. */
function snapshot(dir: string): Record<string, FileState> {
  const out: Record<string, FileState> = {};
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    out[relative(dir, path)] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  }
  return out;
}

function transcriptLine(session: string, i: number): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${session}-u-${i}`,
    sessionId: session,
    timestamp: new Date(Date.UTC(2026, 6, 26, 0, 0, i)).toISOString(),
    cwd: '/Users/dev/proj',
  });
}

function writeTranscript(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
}

/**
 * A corpus shaped like the real one: several project slugs, several transcripts
 * per slug, plus the `<session>/subagents/` sidecars the depth-one scan skips —
 * because "never touched" has to cover the files the tailer does not even read.
 */
function makeCorpus(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-lens-readonly-'));
  dirs.push(root);
  for (const slug of ['-Users-dev-proj-a', '-Users-dev-proj-b']) {
    for (const session of ['sess-1', 'sess-2']) {
      writeTranscript(
        join(root, slug, `${session}.jsonl`),
        Array.from({ length: 8 }, (_, i) => transcriptLine(`${slug}-${session}`, i)),
      );
      writeTranscript(
        join(root, slug, session, 'subagents', 'agent-1.jsonl'),
        Array.from({ length: 3 }, (_, i) => transcriptLine(`${slug}-${session}-sub`, i)),
      );
    }
  }
  return root;
}

describe('AC4 (behavioural) — tailing never modifies the corpus', () => {
  it('leaves every file byte- and mtime-identical across three backfill passes', () => {
    const root = makeCorpus();
    const before = snapshot(root);
    // A fixture that snapshotted nothing would pass this test trivially.
    expect(Object.keys(before)).toHaveLength(8);

    const db = freshDb();
    const broadcaster = new Broadcaster();
    let ingested = 0;
    for (let pass = 0; pass < 3; pass++) {
      ingested += tailOnce(db, broadcaster, {
        transcriptRoot: root,
        firstSight: 'backfill',
      }).ingested;
    }
    // The tailer really ran: pass 1 backfilled all four top-level transcripts (8
    // lines each), passes 2 and 3 found nothing new. Without this the assertion
    // below would hold just as well for a tailer that did nothing at all.
    expect(ingested).toBe(32);

    expect(snapshot(root)).toEqual(before);
  });
});
