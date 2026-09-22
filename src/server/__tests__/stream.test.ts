// AC1 — one stream, exactly four event names, a 15 s heartbeat, the three
// protocol rules, and a clean grep over `src/server/**`.
//
// ★ EVERY TEST HERE ASSERTS ON THE RAW WIRE BYTES, never on the argument handed
// to `writeSSE`. The bytes are the contract: `ui/src/lib/__tests__/`
// sse-parser.test.ts and sse-client.test.ts feed the client the literal string
// `'event: heartbeat\ndata: \n\n'`, and the two halves of the protocol meet only
// if this side puts exactly those bytes out. A `src/` test may not import from
// `ui/` — `npm run typecheck` cannot resolve the `@shared` alias outside the ui
// project — so the literal string IS the seam.
//
// ★ AND EVERY TEST TERMINATES THROUGH `hub.drain()`. Under this design the route
// emits nothing by itself: it attaches and parks. `drain()` closes the stream,
// which ends `responseReadable`, which resolves the collected text. A test that
// reads a body without draining would sit until the root project's 15 s
// `testTimeout` and fail for a reason that is not the assertion.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSEStreamingApi } from 'hono/streaming';
import { fileEnv, openCache } from '../../db/__tests__/fixtures/index.js';
import { TOKEN_HEADER } from '../../shared/index.js';
import { buildApiApp } from '../app.js';
import { createStreamHub, HEARTBEAT_MS, STREAM_EVENTS, type StreamHub } from '../stream.js';
import { stubWarm } from './helpers.js';

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Short enough that a beat test costs milliseconds, long enough to be countable. */
const FAST_BEAT_MS = 20;

/** One attached client plus the text its socket will hold once the hub drains. */
interface Attached {
  stream: SSEStreamingApi;
  parked: Promise<void>;
  bytes: Promise<string>;
}

function attach(hub: StreamHub): Attached {
  const { readable, writable } = new TransformStream();
  const stream = new SSEStreamingApi(writable, readable);
  // NOT awaited: it resolves only when the stream closes, which `drain()` does.
  const bytes = new Response(stream.responseReadable).text();
  return { stream, parked: hub.attach(stream), bytes };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every `event: …\ndata: …` block of a collected body, terminators kept. */
function blocks(text: string): string[] {
  return text
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => `${block}\n\n`);
}

let hubs: StreamHub[] = [];

function makeHub(heartbeatMs = HEARTBEAT_MS): StreamHub {
  const hub = createStreamHub({ heartbeatMs });
  hubs.push(hub);
  return hub;
}

afterEach(async () => {
  // Draining twice is harmless and leaving a hub undrained leaks its interval.
  await Promise.all(hubs.map((hub) => hub.drain()));
  hubs = [];
});

describe('AC1 — the wire vocabulary', () => {
  it('is exactly four event names, and none of them is "error"', () => {
    expect([...STREAM_EVENTS].sort()).toEqual([
      'heartbeat',
      'session_changed',
      'session_indexed',
      'warm_progress',
    ]);
    // Rule 3, at the value level. The type level is stronger: `StreamEventName`
    // is the union of this tuple, so `publish('error', …)` does not compile.
    expect([...STREAM_EVENTS]).not.toContain('error');
  });

  it('beats at the 15 s the client hardcodes to derive its watchdog', () => {
    // `ui/src/lib/sse.ts:47-48` mirrors this number and derives a 37.5 s watchdog
    // from it. A beat that tracked the sweep period instead would starve that
    // watchdog at `sweepIntervalMs: 60_000` and storm it at 5.
    expect(HEARTBEAT_MS).toBe(15_000);
  });
});

describe('AC1 — the three protocol rules, on the raw wire bytes', () => {
  it('a heartbeat frame carries an empty data line and no id (rules 1 and 2)', async () => {
    const hub = makeHub();
    const client = attach(hub);

    await hub.beat();
    await hub.drain();

    const text = await client.bytes;
    // Byte-for-byte the string `sse-parser.test.ts:47` and `sse-client.test.ts:47`
    // already feed the client. That literal is the whole cross-project contract.
    // The data line is empty, so it is not JSON. The swallowed crash rule 1 exists
    // to prevent: a client that branches on "there is a data line" and parses it
    // dies here. Branch on `event:` instead.
    expect(text).toBe('event: heartbeat\ndata: \n\n');
    expect(text.split('\n').some((line) => line.startsWith('id:'))).toBe(false);
  });

  it('a throwing route callback produces no "event: error" frame (rule 3)', async () => {
    // The hub is `ApiDeps`' seam, so this needs no production change: a hub whose
    // `attach` rejects makes the route callback throw. Hono's `run` catches,
    // finds no `onError` because `streamSSE` is called with two arguments, and
    // ends the body in its `finally`.
    const db = openCache();
    try {
      const failing: StreamHub = {
        attach: () => Promise.reject(new Error('boom')),
        publish: () => Promise.resolve(),
        beat: () => Promise.resolve(),
        drain: () => Promise.resolve(),
        size: () => 0,
      };
      const app = buildApiApp({
        db,
        env: fileEnv(),
        token: 'tok',
        uiDir: join(SERVER_DIR, 'no-such-ui'),
        hub: failing,
        warm: stubWarm(),
      });
      const res = await app.request('/api/stream', {
        headers: { Host: 'localhost', [TOKEN_HEADER]: 'tok' },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('event: error');
    } finally {
      db.close();
    }
  });

  it('a published frame is JSON under its own event name', async () => {
    const hub = makeHub();
    const client = attach(hub);

    await hub.publish('session_indexed', { session_id: 'sess-1' });
    await hub.drain();

    expect(await client.bytes).toBe('event: session_indexed\ndata: {"session_id":"sess-1"}\n\n');
  });
});

describe('AC1 — the hub beats on its own timer, independently of the live tick', () => {
  it('keeps beating with no live tick in the test at all', async () => {
    // Founder ruling 3. `startLiveTick` is constructed inside `start.ts`'s
    // `sweepIntervalMs !== 0` gate, and `intervalMs: 0` binds no timer — so a
    // beat derived from the tick stops entirely on a sweepless boot, which
    // `src/dev/server.ts` can reach. Nothing here constructs a tick.
    const hub = makeHub(FAST_BEAT_MS);
    const client = attach(hub);

    await sleep(FAST_BEAT_MS * 4);
    await hub.drain();

    const beats = blocks(await client.bytes);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(new Set(beats)).toEqual(new Set(['event: heartbeat\ndata: \n\n']));
  });

  it('drain() clears the timer, so no interval survives the hub', async () => {
    const hub = makeHub(FAST_BEAT_MS);
    await hub.drain();

    // Attached AFTER the drain: a surviving interval would beat into this one.
    const late = attach(hub);
    await sleep(FAST_BEAT_MS * 4);
    await hub.drain();

    expect(await late.bytes).toBe('');
  });
});

describe('AC1 — one stream for the whole app', () => {
  it('fans out to every attached client, and an aborted one is dropped AND unparked', async () => {
    const hub = makeHub();
    const survivor = attach(hub);
    const leaving = attach(hub);
    expect(hub.size()).toBe(2);

    leaving.stream.abort();

    // ★ THE LOAD-BEARING HALF, asserted BEFORE the drain. Deleting the entry
    // without resolving its promise leaks the suspended `run()` frame — with its
    // stream, transform, writer and reader — for the process lifetime, because
    // `drain()` iterates the map the entry was just removed from. `hub.size()`
    // alone cannot see that. The client's 37.5 s watchdog reconnects, so every
    // trip would leak one more.
    await expect(leaving.parked).resolves.toBeUndefined();

    await hub.publish('session_changed', { session_id: 'sess-1' });
    expect(hub.size()).toBe(1);

    await hub.drain();
    expect(await survivor.bytes).toContain('event: session_changed');
    expect(await leaving.bytes).not.toContain('event: session_changed');
  });

  it('drain() unparks every remaining client', async () => {
    const hub = makeHub();
    const client = attach(hub);

    await hub.drain();

    await expect(client.parked).resolves.toBeUndefined();
    expect(hub.size()).toBe(0);
  });
});

// --- The AC1 grep ----------------------------------------------------------
// ★ THE SCAN MUST EXCLUDE TEST FILES, AND THE PATTERNS MUST NOT BE INLINE
// LITERALS IN A SCANNED FILE. This file lives inside the scanned tree, so a
// scanner that included tests would match its own pattern set and red on
// arrival. The exclusion is copied from `sql-one-door.test.ts:65` verbatim.

/** The deleted concepts, held as data rather than written into the scan. */
const BANNED = ['ring ?buffer', 'stream_id', 'streamId', 'resume verdict', 'resumeVerdict'];

/** Every non-test `.ts` under `src/server/`, relative to it. */
function serverFiles(): string[] {
  return readdirSync(SERVER_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.split('\\').join('/'))
    .filter((name) => !name.endsWith('.test.ts') && !name.includes('__tests__/'))
    .sort();
}

/** `file:line:pattern` for every banned term in `text`, case-insensitively. */
function scan(file: string, text: string, patterns: readonly string[] = BANNED): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const pattern of patterns) {
      if (new RegExp(pattern, 'i').test(line)) hits.push(`${file}:${index + 1}:${pattern}`);
    }
  });
  return hits;
}

function scanAll(): string[] {
  return serverFiles().flatMap((file) => scan(file, readFileSync(join(SERVER_DIR, file), 'utf8')));
}

describe('AC1 — no ring buffer, stream_id or resume verdict in src/server/**', () => {
  it('finds no reintroduced resume machinery', () => {
    expect(
      scanAll(),
      'Task 6.1 deleted ring buffers, `stream_id` epochs and live/backfill/refetch ' +
        'resume verdicts rather than reimplementing them: whole-file reprojection ' +
        'makes a refetch cheap, and every one of those mechanisms existed only to ' +
        'avoid one. A client resumes by taking the next `session_changed` frame ' +
        'and splicing from its `from_seq`.',
    ).toEqual([]);
  });

  it('(a) the scan reaches a real tree', () => {
    const files = serverFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('stream.ts');
    expect(files).toContain('live.ts');
    // The exclusion is doing its job rather than the tree simply having no tests.
    expect(files.some((file) => file.includes('__tests__/'))).toBe(false);
  });

  it('(b) a planted term reds, and the same text without it greens', () => {
    // Without this control the assertion above is trivially green — it already
    // was at `e04e844`, repo-wide — and proves nothing.
    const planted = 'const epoch = frame.stream_id;\n';
    expect(scan('scratch/planted.ts', planted)).toEqual(['scratch/planted.ts:1:stream_id']);
    expect(scan('scratch/planted.ts', 'const epoch = frame.fingerprint;\n')).toEqual([]);
  });

  it('(c) every banned pattern reds on its own', () => {
    const samples: [string, string][] = [
      ['ring ?buffer', 'const buffer = new RingBuffer(256);'],
      ['stream_id', 'if (frame.stream_id !== epoch) refetch();'],
      ['streamId', 'const streamId = crypto.randomUUID();'],
      ['resume verdict', '// the resume verdict is live | backfill | refetch'],
      ['resumeVerdict', 'const resumeVerdict = decideResume(lastSeq);'],
    ];
    for (const [pattern, sample] of samples) {
      expect(scan('scratch/planted.ts', sample, [pattern])).toHaveLength(1);
    }
  });
});
