// `agent-lens warm` — the CLI face of `POST /api/warm`, driven to completion.
//
// IN-PROCESS, NOT AN HTTP CLIENT, and the distinction is not stylistic: this
// runs `server/warm.ts`'s queue, which IS the endpoint's own implementation. A
// client against the socket would be a different path that merely triggers it,
// and it would be useless in the case that makes `warm` worth having — a
// `PROJECTOR_VERSION` bump on a machine where the server is not running.
//
// ★ A WARM IS NOT ONE-SHOT. Wave 1 DEFERS a sidecar whose parent is not indexed
// yet, and projecting a parent is what discovers and inserts its children, so
// the warmable count GROWS on the early passes (measured 43 -> 360 in
// `server/__tests__/warm.test.ts:736-753`). The fixed point is therefore the ID
// SET REPEATING, never the count falling — a repeated set is the permanently
// failing residual.

import { resolveArchiveRoot, resolveDataDir, resolveTranscriptRoot } from '../../archive/index.js';
import { createArchiveReader } from '../../archive/read.js';
import { createProjectionEnv } from '../../corpus/env.js';
import { createCorpusSweep } from '../../corpus/watch.js';
import { DbLockedError, openDb } from '../../db/open.js';
import { readWarmableIds } from '../../db/read.js';
import type { WarmProgressFrame } from '../../shared/api.js';
// Deep imports, never the `server/index.js` barrel: the barrel loads the HTTP
// server, and this command binds no socket.
import type { StreamHub } from '../../server/stream.js';
import { createWarmQueue } from '../../server/warm.js';
import { EXIT_INCOMPLETE, EXIT_OK, parseStringFlag } from './archive.js';

/** Generous: the real corpus converges in 3 (`warm.test.ts:733`). */
const MAX_PASSES = 12;

const POLL_MS = 10;

export interface PrintingHub extends StreamHub {
  /** `warm_progress` frames written so far — how the driver knows a pass ended. */
  readonly published: number;
}

/**
 * `recordingHub`'s shape with a printer where the recorder was. Only
 * `warm_progress` renders; the queue publishes nothing else, and a hub that
 * printed every event would turn a future frame into CLI output by accident.
 */
export function printingHub(write: (line: string) => void = console.log): PrintingHub {
  let published = 0;
  return {
    get published() {
      return published;
    },
    attach: () => Promise.resolve(),
    publish: (event, data) => {
      if (event === 'warm_progress') {
        const frame = data as WarmProgressFrame;
        published += 1;
        write(`  warmed ${frame.done}/${frame.total}`);
      }
      return Promise.resolve();
    },
    beat: () => Promise.resolve(),
    drain: () => Promise.resolve(),
    size: () => 0,
  };
}

/**
 * The drain always publishes exactly one frame per session — a projection that
 * throws is caught and counted (`server/warm.ts:94-100`) — so this terminates
 * whenever the queue does, and hanging here means a projection hung.
 */
async function waitForFrames(hub: PrintingHub, target: number): Promise<void> {
  while (hub.published < target) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * `residual` is NAMED rather than swallowed. The loop stops on an empty set, on
 * a repeated set, or on `MAX_PASSES`, and only the first of the three means the
 * corpus drained — a summary that read the same either way would report success
 * over sessions that never projected.
 */
function summarize(perPass: readonly number[], residual: number): string {
  const total = perPass.reduce((sum, n) => sum + n, 0);
  if (total === 0 && residual === 0) {
    return 'agent-lens warm: nothing to warm — every indexed session is already projected';
  }
  const tail = residual === 0 ? '' : `; ${residual} still unprojected — see \`agent-lens doctor\``;
  // The per-pass list is printed because a GROWING count is the expected shape,
  // and a reader who does not see the passes reads it as a bug.
  return `agent-lens warm: ${total} warmed over ${perPass.length} pass(es) [${perPass.join(', ')}]${tail}`;
}

/** Drives the queue to its fixed point, then tears down in the one safe order. */
async function drainCorpus(dataDir: string, transcriptRoot: string | undefined): Promise<number> {
  const opened = openDb({ dataDir });
  const hub = printingHub();
  const env = createProjectionEnv(createArchiveReader(), {
    archiveRoot: resolveArchiveRoot(dataDir),
    transcriptRoot: resolveTranscriptRoot(transcriptRoot),
  });
  const queue = createWarmQueue({ db: opened.db, env, hub });
  try {
    // WAVE 1 FIRST. `readWarmableIds` reads `sessions` rows and only the boot
    // sweep creates them, so a warm straight after a whole-cache rebuild would
    // otherwise warm zero and report success.
    createCorpusSweep({ db: opened.db, dataDir, transcriptRoot }).wave1();

    const perPass: number[] = [];
    let previousKey = '';
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const remaining = readWarmableIds(opened.db);
      const key = remaining.join(',');
      if (remaining.length === 0 || key === previousKey) break;
      previousKey = key;

      const before = hub.published;
      const started = queue.start();
      perPass.push(started);
      await waitForFrames(hub, before + started);
      // `inFlight` clears in a `.finally` AFTER the last frame publishes, so
      // re-entering in the same turn makes `start()` report a remaining count
      // while starting nothing.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // A residual reports rather than pages, the same ruling `commands/archive.ts:1`
    // makes for a coverage gap: a permanently red cron is a muted one.
    console.log(summarize(perPass, readWarmableIds(opened.db).length));
    return EXIT_OK;
  } finally {
    // ORDER IS LOAD-BEARING (`warm.test.ts:196-212`): the queue stops before the
    // database closes, or a pending `setImmediate` wakes on a closed handle and
    // throws where nothing can catch it.
    queue.close();
    opened.close();
  }
}

/**
 * `main` has no try/catch, so an escaping throw is an unhandled rejection and an
 * ugly stack. Every failure leaves here as one clean line and a 1.
 */
export async function warm(args: string[] = []): Promise<number> {
  try {
    return await drainCorpus(
      resolveDataDir(parseStringFlag(args, 'dataDir')),
      parseStringFlag(args, 'transcriptRoot'),
    );
  } catch (error) {
    if (error instanceof DbLockedError) {
      console.error(
        `${error.message} — warm it through the running server instead: the UI's warm button, or POST /api/warm`,
      );
      return EXIT_INCOMPLETE;
    }
    console.error(`agent-lens warm: ${String((error as Error).message ?? error)}`);
    return EXIT_INCOMPLETE;
  }
}
