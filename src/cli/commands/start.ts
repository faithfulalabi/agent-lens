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

/**
 * `agent-lens start [--port <n>]` — boot the collector, print the port, and run
 * in the foreground until interrupted. The returned promise resolves only on
 * SIGINT/SIGTERM so the CLI entry keeps the process (and the listening socket)
 * alive rather than exiting the moment boot completes.
 */
export async function start(args: string[] = []): Promise<void> {
  const port = parsePort(args);
  const handle = await startServer(port === undefined ? {} : { port });
  console.log(`agent-lens listening on http://127.0.0.1:${handle.port}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void handle.close().then(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
