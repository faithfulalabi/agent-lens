import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { openDb, getAllEventsOrdered } from '../../db/index.js';
import { Broadcaster } from '../../server/sse.js';
import { runHook } from '../../cli/hook.js';
import { replaySpool } from '../replay.js';
import { spoolFile } from '../spool.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agent-lens-replay-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function fixtureStream(name: string): Readable {
  const raw = readFileSync(
    join(__dirname, '..', '..', 'cli', '__tests__', 'fixtures', 'hooks', name),
    'utf8',
  );
  return Readable.from([raw]);
}

const FIXTURES = [
  'session-start.json',
  'user-prompt-submit.json',
  'pre-tool-use.json',
  'post-tool-use.json',
  'stop.json',
];

/** Snapshot the full raw_events + spans_lite state as a comparable string. */
function dbSnapshot(dataDirLocal: string): string {
  const db = openDb(dataDirLocal);
  try {
    const raw = db
      .prepare('SELECT id, session_id, source, hook_name, status FROM raw_events ORDER BY id')
      .all();
    const spans = getAllEventsOrdered(db);
    return JSON.stringify({ raw, spans });
  } finally {
    db.close();
  }
}

describe('replaySpool — collector down -> spool -> replay -> idempotent', () => {
  it('replays spooled events as spool_replay rows, deletes files, is idempotent twice', async () => {
    // 1. Collector down: every hook spools (port 1 refuses).
    for (const name of FIXTURES) {
      await runHook({ stdin: fixtureStream(name), dataDir, port: 1 });
    }
    expect(existsSync(spoolFile('sess-fixture', dataDir))).toBe(true);

    // 2. First replay: five rows, re-stamped spool_replay, file deleted.
    const db = openDb(dataDir);
    const broadcaster = new Broadcaster();
    const first = replaySpool(db, broadcaster, dataDir);
    expect(first.replayed).toBe(5);
    expect(first.deadLettered).toBe(0);
    const rows = getAllEventsOrdered(db);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.source === 'spool_replay')).toBe(true);
    db.close();
    expect(existsSync(spoolFile('sess-fixture', dataDir))).toBe(false);

    // 3. Snapshot, then replay again over the same (now-empty) spool: identical.
    const snapshotAfterFirst = dbSnapshot(dataDir);

    // Re-spool the same fixtures and replay a second time -> upsert no-ops.
    for (const name of FIXTURES) {
      await runHook({ stdin: fixtureStream(name), dataDir, port: 1 });
    }
    const db2 = openDb(dataDir);
    const second = replaySpool(db2, new Broadcaster(), dataDir);
    db2.close();
    expect(second.replayed).toBe(5); // attempted, but upsert dedupes below.

    const snapshotAfterSecond = dbSnapshot(dataDir);
    expect(snapshotAfterSecond).toBe(snapshotAfterFirst);
  });

  it('dead-letters an unparseable spool line without wedging the rest', async () => {
    // Malformed stdin -> dead-letter envelope spooled under best-effort id.
    await runHook({
      stdin: fixtureStream('not-json.txt' as string),
      dataDir,
      port: 1,
    });
    const db = openDb(dataDir);
    const result = replaySpool(db, new Broadcaster(), dataDir);
    expect(result.deadLettered).toBe(1);
    const row = db
      .prepare("SELECT status FROM raw_events WHERE status = 'dead_letter'")
      .get() as { status: string } | undefined;
    expect(row?.status).toBe('dead_letter');
    db.close();
  });

  it('counts a line that parses but fails projection as dead-lettered', async () => {
    await runHook({ stdin: fixtureStream('pre-tool-use.json'), dataDir, port: 1 });
    const db = openDb(dataDir);
    // A genuine, dependency-free projection failure: the line is perfectly valid
    // JSON, so only ingest's own verdict can reveal that it did not replay.
    db.exec('DROP TABLE spans');

    const result = replaySpool(db, new Broadcaster(), dataDir);

    expect(result).toEqual({ files: 1, replayed: 0, deadLettered: 1 });
    const row = db
      .prepare("SELECT status FROM raw_events WHERE status = 'dead_letter'")
      .get() as { status: string } | undefined;
    expect(row?.status).toBe('dead_letter');
    db.close();
  });

  it('returns empty result when there is no spool dir', () => {
    const db = openDb(dataDir);
    const result = replaySpool(db, new Broadcaster(), dataDir);
    db.close();
    expect(result).toEqual({ files: 0, replayed: 0, deadLettered: 0 });
  });
});

describe('event_id determinism through the adapter', () => {
  it('produces an identical event_id for the same fixture twice', async () => {
    await runHook({ stdin: fixtureStream('pre-tool-use.json'), dataDir, port: 1 });
    const firstLine = readFileSync(spoolFile('sess-fixture', dataDir), 'utf8')
      .trim()
      .split('\n')[0]!;
    const firstId = (JSON.parse(firstLine) as { event_id: string }).event_id;

    // Fresh dir, same fixture -> same deterministic id.
    const dir2 = mkdtempSync(join(tmpdir(), 'agent-lens-replay2-'));
    await runHook({ stdin: fixtureStream('pre-tool-use.json'), dataDir: dir2, port: 1 });
    const secondLine = readFileSync(spoolFile('sess-fixture', dir2), 'utf8')
      .trim()
      .split('\n')[0]!;
    const secondId = (JSON.parse(secondLine) as { event_id: string }).event_id;
    rmSync(dir2, { recursive: true, force: true });

    expect(secondId).toBe(firstId);
  });
});
