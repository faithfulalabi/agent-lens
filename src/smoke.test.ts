import { describe, it, expect } from 'vitest';
import { estimateCost } from './shared/index.js';
import { COMMANDS, printHelp } from './cli/index.js';

describe('scaffold smoke', () => {
  it('imports a shared export (ESM works in tests)', () => {
    expect(typeof estimateCost).toBe('function');
  });

  it('registers the six CLI commands', () => {
    // Seven until task 4.5, then three. `hook`, `install`, `uninstall` and
    // `import` were the hook path and its stubs; RFC 002 closes that path, so
    // they are gone rather than stubbed. `rebuild`, `warm` and `prune` are the
    // ship-phase three, and ORDER IS ASSERTED: `printHelp` lists them in this
    // order, so the destructive one stays last.
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(['start', 'doctor', 'archive', 'rebuild', 'warm', 'prune']);
  });

  it('registers every command as a lazily-loaded runner', () => {
    // Not identity with an imported symbol: `run` is a dynamic-import thunk so
    // that `agent-lens archive` never loads `node:sqlite` via `start`.
    for (const cmd of COMMANDS) {
      expect(typeof cmd.run).toBe('function');
    }
  });

  it('registers every command with an argument spec', () => {
    // The seam task 0.6 added: a seventh command arriving without `flags` would
    // otherwise be silently exempt from unknown-argument rejection, and a typo
    // in `positional` would silently read as "no positionals".
    for (const cmd of COMMANDS) {
      expect(cmd.flags, cmd.name).toBeDefined();
      expect(['none', 'anywhere'], cmd.name).toContain(cmd.positional);
      for (const [flag, kind] of Object.entries(cmd.flags)) {
        expect(flag, `${cmd.name} ${flag}`).toMatch(/^--/);
        expect(['value', 'boolean'], `${cmd.name} ${flag}`).toContain(kind);
      }
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
