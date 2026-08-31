// ★ AC5 — THE ROUTE OWNS THE `ensureProjected` GATE.
//
// `src/db/read.ts` never projects: task 4.2 ruled it a pure module and it opens
// no file. So if `GET /api/sessions/:id` does not call the gate, NOBODY does,
// and the detail view serves a stale or empty projection in silence. This file
// drives that over a REAL temp archive: mutate a transcript on disk, touch no
// row, and require the response to reflect the new bytes.
//
// The mutation control at the bottom is what stops the positive test passing
// vacuously — it neuters the gate through `vi.mock(..., { spy: true })`, the
// idiom `db/__tests__/freshness.test.ts:38` already establishes. NEVER a toggle
// on `buildApiApp`: a production seam added for a test is how the gate would
// silently stop running in the first place.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { cleanup, makeSandbox, type Sandbox } from '../../archive/__tests__/fixtures.js';
import { createStreamHub } from '../stream.js';
import {
  SESSION_ID,
  fileEnv,
  humanLine,
  jsonl,
  openCache,
  seedIndexRow,
  sessionRow,
  toolCallLine,
  toolResultLine,
  writeTranscript,
} from '../../db/__tests__/fixtures/index.js';
import { TOKEN_HEADER } from '../../shared/index.js';
import { buildApiApp } from '../app.js';
import { ensureProjectedFold, fingerprint, foldArchive } from '../../db/freshness.js';

// The real implementation still runs; only the call list and the override are
// new. `{ spy: true }` is what lets the control neuter one function and restore.
vi.mock('../../db/freshness.js', { spy: true });

const TOKEN = 'test-token';

let sandbox: Sandbox;
let db: DatabaseSync;
let app: Hono;
let archive: string;

const FIRST_LINES = [
  humanLine('find the parser bug', '2026-08-14T09:00:00.000Z'),
  toolCallLine('toolu_1', 'Grep', '2026-08-14T09:00:01.000Z'),
  toolResultLine('toolu_1', 'match at line 7', '2026-08-14T09:00:02.000Z'),
];

beforeEach(() => {
  sandbox = makeSandbox();
  db = openCache();
  archive = writeTranscript(join(sandbox.archiveRoot, `${SESSION_ID}.jsonl`), FIRST_LINES);
  seedIndexRow(db, archive);
  app = buildApiApp({
    db,
    env: fileEnv(),
    token: TOKEN,
    uiDir: join(sandbox.root, 'no-such-ui'),
    hub: createStreamHub(),
  });
});

afterEach(() => {
  // `reset`, never `restore`: on a `{ spy: true }` automock, restore unwraps the
  // spy for the REST OF THE FILE, so every later `vi.mocked` call would be
  // reaching for a plain function. Reset puts the real implementation back and
  // keeps the wrapper.
  vi.resetAllMocks();
  db.close();
  cleanup(sandbox);
});

interface Detail {
  session: { projection: { state: string; error?: string } };
  turns: unknown[];
  events: { text: string | null; input: string | null }[];
  fingerprint: string;
}

async function detail(id = SESSION_ID): Promise<{ status: number; body: Detail }> {
  const res = await app.request(`/api/sessions/${id}`, {
    headers: { Host: 'localhost', [TOKEN_HEADER]: TOKEN },
  });
  return { status: res.status, body: (await res.json()) as Detail };
}

/** Every text and input byte the response carries, for a substring probe. */
function contentOf(body: Detail): string {
  return body.events.map((e) => `${e.text ?? ''} ${e.input ?? ''}`).join('\n');
}

describe('★ the gate runs on the detail route (AC5)', () => {
  it('projects a never-projected session on first read', async () => {
    // The corpus sweep wrote the Tier-A row and nothing else. Nobody has
    // projected this session, so the gate is the only thing that can.
    expect(sessionRow(db, SESSION_ID).projection_state).toBe('none');

    const { status, body } = await detail();
    expect(status).toBe(200);
    expect(vi.mocked(ensureProjectedFold)).toHaveBeenCalledTimes(1);
    expect(body.turns.length).toBeGreaterThan(0);
    expect(body.events.length).toBeGreaterThan(0);
    expect(sessionRow(db, SESSION_ID).projection_state).toBe('ready');
  });

  it('★ reflects bytes appended to the transcript with the DB untouched', async () => {
    const first = await detail();
    expect(contentOf(first.body)).toContain('find the parser bug');
    expect(contentOf(first.body)).not.toContain('second question');

    // The mutation: new lines on disk, no row written. Only the gate can notice.
    appendFileSync(
      archive,
      jsonl([
        humanLine('second question', '2026-08-14T09:05:00.000Z'),
        toolCallLine('toolu_2', 'Read', '2026-08-14T09:05:01.000Z'),
        toolResultLine('toolu_2', 'the file body', '2026-08-14T09:05:02.000Z'),
      ]),
    );

    const second = await detail();
    expect(second.body.events.length).toBeGreaterThan(first.body.events.length);
    expect(contentOf(second.body)).toContain('second question');
  });

  it('★ MUTATION CONTROL — with the gate neutered the SAME request serves stale bytes', async () => {
    const first = await detail();
    appendFileSync(archive, jsonl([humanLine('second question', '2026-08-14T09:05:00.000Z')]));

    // A no-op gate: exactly what a route that forgot to call it would produce.
    vi.mocked(ensureProjectedFold).mockReturnValue({ outcome: 'hit' });

    const stale = await detail();
    expect(stale.body.events.length).toBe(first.body.events.length);
    expect(contentOf(stale.body)).not.toContain('second question');

    // And the control is honest: restoring the real gate sees the new bytes.
    vi.mocked(ensureProjectedFold).mockReset();
    expect(contentOf((await detail()).body)).toContain('second question');
  });
});

describe('★ all four gate outcomes (AC5)', () => {
  it("'hit' — a second identical read reprojects nothing", async () => {
    await detail();
    const projected_at = sessionRow(db, SESSION_ID).projected_at;

    const again = await detail();
    expect(again.status).toBe(200);
    // `projected_at` unmoved is the proof no rewrite happened.
    expect(sessionRow(db, SESSION_ID).projected_at).toBe(projected_at);
    expect(again.body.session.projection.state).toBe('ready');
  });

  it("'unindexed' — a session the sweep has never seen is a 404 at the gate", async () => {
    const res = await app.request('/api/sessions/no-such-session', {
      headers: { Host: 'localhost', [TOKEN_HEADER]: TOKEN },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    // Decided at the gate, before any read: nothing is fabricated from a stat.
    expect(
      db.prepare('SELECT count(*) AS n FROM sessions WHERE id = ?').get('no-such-session'),
    ).toEqual({ n: 0 });
  });

  it("★ 'failed' (a) — a vanished archive serves the SURVIVING projection, labelled", async () => {
    const before = await detail();
    expect(before.body.session.projection.state).toBe('ready');
    expect(before.body.events.length).toBeGreaterThan(0);

    // `foldArchive` now answers undefined, which returns BEFORE any write — so
    // the column still reads 'ready' for a session whose bytes are gone.
    rmSync(archive);
    expect(sessionRow(db, SESSION_ID).projection_state).toBe('ready');

    const after = await detail();
    expect(after.status).toBe(200);
    // ★ THE OVERRIDE. Without it the response claims a verified projection.
    expect(after.body.session.projection.state).toBe('failed');
    expect(after.body.session.projection.error).toBeTypeOf('string');

    // ★ AND THE CONTENT SURVIVES. Blanking it would discard turns the user can
    // still read; spec:340 makes "present but unverifiable" a labelled state.
    expect(after.body.turns).toEqual(before.body.turns);
    expect(after.body.events.length).toBe(before.body.events.length);

    // No fold means no epoch. Empty never equals a real one, so a client
    // refetches instead of trusting a stale fingerprint.
    expect(after.body.fingerprint).toBe('');
  });

  it("★ 'failed' (b) — an unparseable line labels the row and keeps what survived", async () => {
    const before = await detail();
    expect(before.body.events.length).toBeGreaterThan(0);

    // Rewrite with a torn line. Size moves, so the gate tries and `readLines`
    // throws; `projectSession` rolls its savepoint back before recording.
    writeFileSync(archive, `${jsonl(FIRST_LINES)}{"type":"user",,,\n`);

    const after = await detail();
    expect(after.status).toBe(200);
    expect(after.body.session.projection.state).toBe('failed');
    expect(after.body.session.projection.error).not.toBe('');
    expect(sessionRow(db, SESSION_ID).projection_state).toBe('failed');
    // The rollback restored the prior projection before the failure was stamped.
    expect(after.body.events.length).toBe(before.body.events.length);
  });
});

describe('★ fingerprint is the live-tail epoch (AC5, gap 2)', () => {
  it('equals the gate’s own fold and moves when the transcript grows', async () => {
    const first = await detail();
    expect(first.body.fingerprint).toBe(fingerprint(foldArchive(archive)!));

    appendFileSync(archive, jsonl([humanLine('second question', '2026-08-14T09:05:00.000Z')]));

    const second = await detail();
    expect(second.body.fingerprint).not.toBe(first.body.fingerprint);
    expect(second.body.fingerprint).toBe(fingerprint(foldArchive(archive)!));
  });

  it('moves when only a SIDECAR grows, never a parent-only stat', async () => {
    const first = await detail();
    // A parent can go quiet for 2,240 s while its sidecars grow by megabytes.
    // The fold covers the whole session directory, so the epoch still moves.
    const sidecar = join(sandbox.archiveRoot, SESSION_ID, 'subagents', 'agent-0.jsonl');
    writeTranscript(sidecar, [humanLine('sub-agent work', '2026-08-14T09:06:00.000Z')]);

    expect((await detail()).body.fingerprint).not.toBe(first.body.fingerprint);
  });
});
