// `agent-lens warm` — the CLI face of `POST /api/warm`.
//
// ★ A WARM IS NOT ONE-SHOT, and the convergence test below is the one that
// matters. Wave 1 DEFERS a sidecar whose parent it has not indexed yet, and
// projecting a parent is what discovers and inserts its children — so the
// warmable count GROWS on the early passes. A driver that stopped after one
// pass, or that treated a rising count as a failure, would leave every sub-agent
// transcript cold and report success. `server/__tests__/warm.test.ts:736-753`
// recorded this over the real archive (43 rows in the first snapshot, 360 in the
// table by the end); this is the hermetic miniature of it.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { sessionRecords, writeSession, writeSidecar } from '../../corpus/__tests__/fixtures.js';
import { CACHE_LOCK_FILE, openDb } from '../../db/open.js';
import { countUnprojected, readHealthCounts } from '../../db/read.js';
import { EXIT_INCOMPLETE, EXIT_OK } from '../commands/archive.js';
import { printingHub, warm } from '../commands/warm.js';

const START = '2026-08-14T09:00:00.000Z';
const END = '2026-08-14T09:00:30.000Z';

let sandbox: Sandbox | undefined;

function sb(): Sandbox {
  sandbox ??= makeSandbox();
  return sandbox;
}

afterEach(() => {
  if (sandbox) cleanup(sandbox);
  sandbox = undefined;
});

function argsFor(s: Sandbox): string[] {
  return [`--dataDir=${s.dataDir}`, `--transcriptRoot=${s.sourceRoot}`];
}

async function runWarm(args: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (msg?: unknown) => void lines.push(String(msg));
  console.error = (msg?: unknown) => void lines.push(String(msg));
  try {
    return { code: await warm(args), lines };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/** `{done, total}` for every rendered progress line, in order. */
function frames(lines: readonly string[]): { done: number; total: number }[] {
  return lines
    .map((line) => /^ {2}warmed (\d+)\/(\d+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ done: Number(match[1]), total: Number(match[2]) }));
}

/** One top-level session with `count` sub-agent transcripts hanging off it. */
function seedTree(s: Sandbox, id: string, count: number): void {
  const callIds = Array.from({ length: count }, (_, i) => `call-${id}-${i}`);
  writeSession(s, id, [...callIds.flatMap((callId) => sessionRecords(callId, START, END))]);
  for (const [i, callId] of callIds.entries()) {
    writeSidecar(s, id, `${id}-kid${i}`, sessionRecords(`nested-${callId}`, START, END), {
      toolUseId: callId,
    });
  }
}

describe('printingHub — renders warm_progress and nothing else', () => {
  it('counts and writes one line per frame', async () => {
    const written: string[] = [];
    const hub = printingHub((line) => written.push(line));

    await hub.publish('warm_progress', { done: 1, total: 2 });
    await hub.publish('warm_progress', { done: 2, total: 2 });
    // A frame the queue never sends today must not become CLI output tomorrow.
    await hub.publish('session_changed', { id: 'x' });

    expect(written).toEqual(['  warmed 1/2', '  warmed 2/2']);
    expect(hub.published).toBe(2);
    expect(hub.size()).toBe(0);
  });
});

describe('10 + 12 — frames run to done == total, and a warm corpus says so (AC3)', () => {
  it('renders 1..N against a constant total and ends at { N, N }', async () => {
    const s = sb();
    const ids = ['aaaaaaaa-1111-4111-8111-wm0000000001', 'aaaaaaaa-1111-4111-8111-wm0000000002'];
    for (const id of ids) writeSession(s, id, sessionRecords(`call-${id}`, START, END));

    const { code, lines } = await runWarm(argsFor(s));

    expect(code).toBe(EXIT_OK);
    const rendered = frames(lines);
    expect(rendered.map((f) => f.done)).toEqual([1, 2]);
    expect(rendered.every((f) => f.total === 2)).toBe(true);
    expect(rendered.at(-1)).toEqual({ done: 2, total: 2 });
    expect(lines.at(-1)).toContain('2 warmed over 1 pass(es) [2]');

    const opened = openDb({ dataDir: s.dataDir });
    try {
      expect(countUnprojected(opened.db)).toBe(0);
      expect(readHealthCounts(opened.db).sessions_projected).toBe(2);
    } finally {
      opened.close();
    }
  });

  it('a second warm over the same corpus warms nothing and still exits 0', async () => {
    const s = sb();
    writeSession(s, 'aaaaaaaa-1111-4111-8111-wm0000000003', sessionRecords('c1', START, END));

    expect((await runWarm(argsFor(s))).code).toBe(EXIT_OK);
    const second = await runWarm(argsFor(s));

    expect(second.code).toBe(EXIT_OK);
    expect(frames(second.lines)).toEqual([]);
    expect(second.lines.at(-1)).toContain('nothing to warm');
  });

  it('warms a corpus the boot sweep has never seen — wave 1 runs first', async () => {
    // Without wave 1 `readWarmableIds` reads an empty `sessions` table, so a
    // warm straight after a whole-cache rebuild would report success over zero.
    const s = sb();
    writeSession(s, 'aaaaaaaa-1111-4111-8111-wm0000000004', sessionRecords('c1', START, END));
    expect(existsSync(join(s.dataDir, 'cache.db'))).toBe(false);

    const { code, lines } = await runWarm(argsFor(s));

    expect(code).toBe(EXIT_OK);
    expect(frames(lines).length).toBeGreaterThan(0);
  });
});

describe('11 — convergence, not one shot (AC3)', () => {
  it('keeps going while projecting parents discovers children, and stops on the repeated set', async () => {
    const s = sb();
    seedTree(s, 'aaaaaaaa-1111-4111-8111-wm0000000005', 2);
    seedTree(s, 'aaaaaaaa-1111-4111-8111-wm0000000006', 2);

    const { code, lines } = await runWarm(argsFor(s));

    expect(code).toBe(EXIT_OK);
    const summary = lines.at(-1)!;
    const perPass = /\[([\d, ]+)\]/.exec(summary)?.[1]?.split(', ').map(Number) ?? [];

    // MORE THAN ONE PASS, and the second pass is larger than the first: the
    // children did not exist as rows when the first pass snapshotted its ids.
    expect(perPass.length).toBeGreaterThan(1);
    expect(perPass[1]).toBeGreaterThan(perPass[0]!);
    // A growing count is the expected shape, so it is printed rather than hidden.
    expect(summary).toMatch(/warmed over \d+ pass\(es\)/);

    const opened = openDb({ dataDir: s.dataDir });
    try {
      // The fixed point really is a drained corpus, not an early break.
      expect(countUnprojected(opened.db)).toBe(0);
      // Non-vacuity: the children are rows now, and there are more of them than
      // the parents the first pass could see.
      expect(readHealthCounts(opened.db).sessions_indexed).toBe(6);
    } finally {
      opened.close();
    }
  });
});

describe('13 — teardown, and the lock a running server holds (AC3)', () => {
  it('closes the queue before the database and leaves nothing pending', async () => {
    const s = sb();
    for (let i = 0; i < 4; i += 1) {
      writeSession(
        s,
        `aaaaaaaa-1111-4111-8111-wm000000001${i}`,
        sessionRecords(`c${i}`, START, END),
      );
    }

    expect((await runWarm(argsFor(s))).code).toBe(EXIT_OK);

    // A queue closed AFTER the database would leave a `setImmediate` that wakes
    // on a closed handle and throws where no test can catch it — which surfaces
    // as an unhandled error and reds this file. Give it turns to do so.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));

    // The lock came back, so `opened.close()` really ran.
    expect(existsSync(join(s.dataDir, CACHE_LOCK_FILE))).toBe(false);
    const reopened = openDb({ dataDir: s.dataDir });
    reopened.close();
  });

  it('a held lock exits 1 and names the in-server path instead', async () => {
    const s = sb();
    writeSession(s, 'aaaaaaaa-1111-4111-8111-wm0000000020', sessionRecords('c1', START, END));
    openDb({ dataDir: s.dataDir }).close();
    writeFileSync(
      join(s.dataDir, CACHE_LOCK_FILE),
      JSON.stringify({ pid: 1, started_at: Date.now(), hostname: hostname() }),
      { mode: 0o600 },
    );

    const { code, lines } = await runWarm(argsFor(s));

    expect(code).toBe(EXIT_INCOMPLETE);
    expect(lines.join('\n')).toContain('POST /api/warm');
  });
});
