import {
  discover,
  resolveArchiveRoot,
  resolveTranscriptRoot,
  type DiscoveredEntry,
} from '../../archive/index.js';
import { startServer } from '../../server/index.js';

/**
 * The next step a first boot needs, or `undefined` when the archive already has
 * bytes. The corpus sweep walks `<dataDir>/archive` and NOTHING else
 * (`corpus/watch.ts:179`; `scanCorpus`'s own doc says `sourceRoot` "is used for
 * path math alone"), so `agent-lens start` on a machine that never ran
 * `agent-lens archive` renders an empty session list with no explanation.
 *
 * It PRINTS and does not mirror: a first boot must not silently start copying
 * hundreds of megabytes. The wording follows `dev/server.ts:88-95`, which was
 * written for this same confusion — two directories, named separately, because
 * one sentence naming only the measured tree reads as though the sweep indexed
 * it.
 */
export function emptyArchiveNotice(dataDir?: string, transcriptRoot?: string): string | undefined {
  const archiveRoot = resolveArchiveRoot(dataDir);
  const root = resolveTranscriptRoot(transcriptRoot);
  const entries: DiscoveredEntry[] = discover(root, archiveRoot);
  if (entries.some((entry) => entry.presence !== 'source-only')) return undefined;
  return (
    `agent-lens: ${archiveRoot} is empty, so the session list will be too — ` +
    `${entries.length} file(s) of transcripts under ${root} ` +
    'are what `agent-lens archive` mirrors into it. Nothing is indexed until it runs.'
  );
}

/** Parse `--port <n>` / `--port=<n>` from the subcommand args. */
export function parsePort(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--port') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('--port requires a value');
      }
      return parsePortValue(value);
    }
    if (arg.startsWith('--port=')) {
      return parsePortValue(arg.slice('--port='.length));
    }
  }
  return undefined;
}

function parsePortValue(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port value: ${value}`);
  }
  return port;
}

/** Parse `--host <h>` / `--host=<h>` from the subcommand args. */
export function parseHost(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--host') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('--host requires a value');
      }
      return parseHostValue(value);
    }
    if (arg.startsWith('--host=')) {
      return parseHostValue(arg.slice('--host='.length));
    }
  }
  return undefined;
}

function parseHostValue(value: string): string {
  if (value === '') {
    throw new Error('--host requires a value');
  }
  return value;
}

/**
 * `agent-lens start [--port <n>] [--host <h>]` — boot the collector, print the port, and run
 * in the foreground until interrupted. The returned promise resolves only on
 * SIGINT, SIGTERM or SIGHUP so the CLI entry keeps the process (and the
 * listening socket) alive rather than exiting the moment boot completes.
 *
 * SIGHUP is the one a closed terminal sends, and its Node default action
 * terminates the process without running any exit handler — leaving the SQLite
 * WAL live, the sweep timer running, and `config.json` naming a port nothing is
 * listening on.
 *
 * **Ordering invariant: the handlers are registered before the readiness line
 * reaches stdout.** A supervisor that matches that line and signals immediately
 * would otherwise land in a window where the default action still applies,
 * stranding the same wreckage an unhandled SIGHUP does.
 */
export async function start(args: string[] = []): Promise<void> {
  const port = parsePort(args);
  const host = parseHost(args);
  const options: { port?: number; host?: string } = {};
  if (port !== undefined) options.port = port;
  if (host !== undefined) options.host = host;

  // BEFORE `startServer`, for `dev/server.ts:82-84`'s reason: the sweep's first
  // tick runs before the socket binds, so a line printed afterwards leaves the
  // user watching a silent hang.
  const notice = emptyArchiveNotice();
  if (notice !== undefined) console.log(notice);

  const handle = await startServer(options);

  await new Promise<void>((resolve) => {
    // One implementation for all three signals, guarded: a second signal
    // arriving mid-shutdown would otherwise start a second teardown, and the
    // second `db.close()` throws ERR_INVALID_STATE where nothing can catch it.
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      void handle.close().then(resolve);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, shutdown);
    }
    // Announced only now — see the ordering invariant above. The executor runs
    // synchronously, so this still prints in the same tick as the boot.
    console.log(`agent-lens listening on http://${host ?? '127.0.0.1'}:${handle.port}`);
  });
}
