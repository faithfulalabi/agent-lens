import { describe, it, expect } from 'vitest';
import { estimateCost } from './shared/index.js';
import { COMMANDS, printHelp } from './cli/index.js';

describe('scaffold smoke', () => {
  it('imports a shared export (ESM works in tests)', () => {
    expect(typeof estimateCost).toBe('function');
  });

  it('registers the three CLI commands', () => {
    // Seven until task 4.5. `hook`, `install`, `uninstall` and `import` were the
    // hook path and its stubs; RFC 002 closes that path, so they are gone rather
    // than stubbed.
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(['start', 'doctor', 'archive']);
  });

  it('registers every command as a lazily-loaded runner', () => {
    // Not identity with an imported symbol: `run` is a dynamic-import thunk so
    // that `agent-lens archive` never loads `node:sqlite` via `start`.
    for (const cmd of COMMANDS) {
      expect(typeof cmd.run).toBe('function');
    }
  });

  it('prints help listing every registered command', () => {
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
    for (const cmd of COMMANDS) {
      expect(output).toContain(cmd.name);
    }
    // The deleted commands must not linger in the help text either.
    for (const gone of ['hook', 'install', 'uninstall', 'import']) {
      expect(output).not.toContain(gone);
    }
  });
});
