import { argv, exit } from 'node:process';
import { validateArgs, type ArgSpec } from './args.js';

/**
 * The whole CLI surface in one table. `flags` and `positional` come from
 * `ArgSpec`, so the table a reader consults IS the table `validateArgs` checks —
 * there is no second copy to drift.
 */
interface Command extends ArgSpec {
  summary: string;
  /**
   * A command may return its own process exit code; `void` means 0. Only
   * `archive` has a code to carry today, and `commands/archive.ts:1` is where
   * the whole code namespace is stated. Widened as a union deliberately, so the
   * other commands keep returning `void` unchanged.
   */
  run: (args: string[]) => void | number | Promise<void | number>;
}

/**
 * Every `run` must stay a lazy dynamic import: eager ones pull `start`'s server
 * and DB graph, and with it `node:sqlite`, into every invocation.
 */
export const COMMANDS: Command[] = [
  {
    name: 'start',
    summary: 'Start the local tracing server + UI (default)',
    flags: { '--port': 'value', '--host': 'value' },
    positional: 'none',
    run: (args) => import('./commands/start.js').then((m) => m.start(args)),
  },
  {
    name: 'doctor',
    summary: 'Report archive coverage, integrity and retention',
    flags: {
      '--dataDir': 'value',
      '--transcriptRoot': 'value',
      '--settingsPath': 'value',
      '--verify': 'boolean',
      '--json': 'boolean',
    },
    positional: 'none',
    run: (args) => import('./commands/doctor.js').then((m) => m.doctor(args)),
  },
  {
    name: 'archive',
    summary: 'Mirror Claude Code transcripts into the durable archive',
    flags: {
      '--dataDir': 'value',
      '--transcriptRoot': 'value',
      '--verify': 'boolean',
      '--json': 'boolean',
    },
    positional: 'none',
    run: (args) => import('./commands/archive.js').then((m) => m.archive(args)),
  },
  {
    name: 'rebuild',
    summary: 'Drop the disposable cache, or one session’s projection',
    flags: { '--dataDir': 'value', '--transcriptRoot': 'value' },
    positional: 'anywhere',
    run: (args) => import('./commands/rebuild.js').then((m) => m.rebuild(args)),
  },
  {
    name: 'warm',
    summary: 'Project every indexed session, printing progress to completion',
    flags: { '--dataDir': 'value', '--transcriptRoot': 'value' },
    positional: 'none',
    run: (args) => import('./commands/warm.js').then((m) => m.warm(args)),
  },
  {
    // Before `prune` on purpose: `printHelp` lists in this order and the
    // destructive command stays last. The summary wording is pinned by
    // `smoke.test.ts` — see the help-output ban there before rewording it.
    name: 'schedule',
    summary: 'Manage the recurring archive job (turn on, report, turn off)',
    flags: { '--dataDir': 'value' },
    positional: 'anywhere',
    run: (args) => import('./commands/schedule.js').then((m) => m.schedule(args)),
  },
  {
    name: 'prune',
    summary: 'Permanently delete archived transcripts — asks first, no undo',
    flags: { '--dataDir': 'value', '--transcriptRoot': 'value', '--settingsPath': 'value' },
    positional: 'anywhere',
    run: (args) => import('./commands/prune.js').then((m) => m.prune(args)),
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

  // BEFORE `run`, so a mistyped flag cannot retarget a write-capable command,
  // and so `start --bogus` is refused without binding a socket. The bare `1` is
  // deliberate — see the exit-code note in `args.ts`.
  const checked = validateArgs(match, rest);
  if (!checked.ok) {
    console.error(`agent-lens ${command}: ${checked.message}`);
    return 1;
  }

  try {
    const code = await match.run(rest);
    return code ?? 0;
  } catch (error) {
    // Three of the six commands catch their own throws; the other three let a
    // parser error escape as an unhandled rejection and a stack. One catch here
    // instead of a seventh hand-rolled copy inside a command.
    console.error(`agent-lens ${command}: ${String((error as Error)?.message ?? error)}`);
    return 1;
  }
}

// Auto-run only when executed as the CLI entry (not when imported by tests).
if (import.meta.url === `file://${argv[1]}`) {
  main(argv.slice(2)).then(exit);
}
