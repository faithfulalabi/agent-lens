import { argv, exit } from 'node:process';

interface Command {
  name: string;
  summary: string;
  run: (args: string[]) => void | Promise<void>;
}

/**
 * Every `run` must stay a lazy dynamic import: eager ones pull `start`'s server
 * and DB graph, and with it `node:sqlite`, into every invocation.
 */
export const COMMANDS: Command[] = [
  {
    name: 'start',
    summary: 'Start the local tracing server + UI (default)',
    run: (args) => import('./commands/start.js').then((m) => m.start(args)),
  },
  {
    name: 'hook',
    summary: 'Hook adapter invoked by the agent harness',
    run: (args) => import('./commands/hook.js').then((m) => m.hook(args)),
  },
  {
    name: 'install',
    summary: 'Install the harness integration (e.g. claude-code)',
    run: () => import('./commands/install.js').then((m) => m.install()),
  },
  {
    name: 'uninstall',
    summary: 'Remove the harness integration',
    run: () => import('./commands/uninstall.js').then((m) => m.uninstall()),
  },
  {
    name: 'doctor',
    summary: 'Diagnose the local setup',
    run: () => import('./commands/doctor.js').then((m) => m.doctor()),
  },
  {
    name: 'import',
    summary: 'Backfill sessions from existing transcripts (P2)',
    run: () => import('./commands/import.js').then((m) => m.importCmd()),
  },
  {
    name: 'archive',
    summary: 'Mirror Claude Code transcripts into the durable archive',
    run: (args) => import('./commands/archive.js').then((m) => m.archive(args)),
  },
];

export function printHelp(): void {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  console.log('agent-lens — local-first agentic tracing platform\n');
  console.log('Usage: agent-lens <command> [options]\n');
  console.log('Commands:');
  for (const cmd of COMMANDS) {
    console.log(`  ${cmd.name.padEnd(width)}  ${cmd.summary}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return 0;
  }

  const match = COMMANDS.find((c) => c.name === command);
  if (!match) {
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    return 1;
  }

  await match.run(rest);
  return 0;
}

// Auto-run only when executed as the CLI entry (not when imported by tests).
if (import.meta.url === `file://${argv[1]}`) {
  main(argv.slice(2)).then(exit);
}
