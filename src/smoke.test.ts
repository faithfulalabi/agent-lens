import { describe, it, expect } from 'vitest';
import { deriveEventId } from './shared/index.js';
import { COMMANDS, printHelp } from './cli/index.js';

describe('scaffold smoke', () => {
  it('imports a shared export (ESM works in tests)', () => {
    expect(typeof deriveEventId).toBe('function');
  });

  it('registers the seven CLI commands', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(['start', 'hook', 'install', 'uninstall', 'doctor', 'import', 'archive']);
  });

  it('registers every command as a lazily-loaded runner', () => {
    // Not identity with an imported symbol: `run` is now a dynamic-import thunk
    // so that `agent-lens archive` never loads `node:sqlite` via `start`.
    for (const cmd of COMMANDS) {
      expect(typeof cmd.run).toBe('function');
    }
  });

  it('prints help listing all five tracer-bullet commands', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg?: unknown) => {
      lines.push(String(msg));
    };
    try {
      printHelp();
    } finally {
      console.log = original;
    }
    const output = lines.join('\n');
    for (const cmd of ['start', 'hook', 'install', 'uninstall', 'doctor']) {
      expect(output).toContain(cmd);
    }
  });
});
