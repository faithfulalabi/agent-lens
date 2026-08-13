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

  // `src/transcript/` is the one module with NO index.ts, deliberately: four
  // Phase 2 tasks each proposed a different owner for the barrel, which is a
  // guaranteed merge conflict on every branch. Deep imports with `.js`
  // extensions instead. The absence is asserted so nobody helpfully adds one.
  it('has the transcript module, and no barrel in it', () => {
    for (const file of ['raw-types.ts', 'accessors.ts', 'line.ts', 'drift.ts']) {
      expect(existsSync(resolve(srcDir, 'transcript', file)), file).toBe(true);
    }
    expect(existsSync(resolve(srcDir, 'transcript', 'index.ts'))).toBe(false);
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

  // `preview.local.ts` was untracked, so nothing but this stops it being
  // resurrected — its port-4470 squat reds `port.test.ts`.
  it('has the dev server, and no leftover preview script', () => {
    expect(existsSync(resolve(srcDir, 'dev', 'server.ts'))).toBe(true);
    expect(existsSync(resolve(root, 'preview.local.ts'))).toBe(false);
  });
});
