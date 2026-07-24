import { stdin } from 'node:process';
import { runHook } from '../hook.js';

/** Parse `--port <n>` / `--port=<n>` from the subcommand args, else undefined. */
function parsePort(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--port') {
      const value = args[i + 1];
      if (value !== undefined && Number.isInteger(Number(value))) {
        return Number(value);
      }
    }
    if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length);
      if (Number.isInteger(Number(value))) return Number(value);
    }
  }
  return undefined;
}

/**
 * `agent-lens hook` — the adapter Claude Code exec's per hook. Reads the hook
 * payload from stdin and delegates to `runHook`, which owns the never-harm /
 * never-lose contract (always exits 0).
 */
export async function hook(args: string[] = []): Promise<void> {
  await runHook({ stdin, port: parsePort(args) });
}
