import { startServer } from '../../server/index.js';

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
 * WAL live, the tail timer running, and `config.json` naming a port nothing is
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
