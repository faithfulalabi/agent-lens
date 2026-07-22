import { start } from './commands/start.js';
import { hook } from './commands/hook.js';
import { install } from './commands/install.js';
import { uninstall } from './commands/uninstall.js';
import { doctor } from './commands/doctor.js';
import { importCmd } from './commands/import.js';

import { argv, exit } from 'node:process';

interface Command {
  name: string;
  summary: string;
  run: () => void;
}

export const COMMANDS: Command[] = [
  { name: 'start', summary: 'Start the local tracing server + UI (default)', run: start },
  { name: 'hook', summary: 'Hook adapter invoked by the agent harness', run: hook },
  { name: 'install', summary: 'Install the harness integration (e.g. claude-code)', run: install },
  { name: 'uninstall', summary: 'Remove the harness integration', run: uninstall },
  { name: 'doctor', summary: 'Diagnose the local setup', run: doctor },
  { name: 'import', summary: 'Backfill sessions from existing transcripts (P2)', run: importCmd },
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

export function main(argv: string[]): number {
  const [command] = argv;

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

  match.run();
  return 0;
}

// Auto-run only when executed as the CLI entry (not when imported by tests).
if (import.meta.url === `file://${argv[1]}`) {
  exit(main(argv.slice(2)));
}
