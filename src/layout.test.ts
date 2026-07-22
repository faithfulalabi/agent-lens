import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const srcDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(srcDir, '..');

describe('repo layout conforms to the tech plan', () => {
  it('has the five src module directories', () => {
    for (const mod of ['cli', 'server', 'capture', 'db', 'shared']) {
      expect(existsSync(resolve(srcDir, mod, 'index.ts'))).toBe(true);
    }
  });

  it('has all six CLI command stubs', () => {
    for (const cmd of ['start', 'hook', 'install', 'uninstall', 'doctor', 'import']) {
      expect(existsSync(resolve(srcDir, 'cli', 'commands', `${cmd}.ts`))).toBe(true);
    }
  });

  it('has the nested ui/ Vite app', () => {
    expect(existsSync(resolve(root, 'ui', 'package.json'))).toBe(true);
    expect(existsSync(resolve(root, 'ui', 'index.html'))).toBe(true);
    expect(existsSync(resolve(root, 'ui', 'src', 'App.tsx'))).toBe(true);
  });

  it('has the bin entry', () => {
    expect(existsSync(resolve(root, 'bin', 'agent-lens.js'))).toBe(true);
  });
});
