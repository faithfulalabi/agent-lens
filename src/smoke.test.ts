import { describe, it, expect } from 'vitest';
import { deriveEventId } from './shared/index.js';
import { COMMANDS, printHelp } from './cli/index.js';

describe('scaffold smoke', () => {
  it('imports a shared export (ESM works in tests)', () => {
    expect(typeof deriveEventId).toBe('function');
  });

  it('registers the six CLI commands', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(['start', 'hook', 'install', 'uninstall', 'doctor', 'import']);
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
