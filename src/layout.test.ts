import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const srcDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(srcDir, '..');

describe('repo layout conforms to the tech plan', () => {
  it('has the barrelled src module directories', () => {
    for (const mod of ['cli', 'server', 'shared']) {
      expect(existsSync(resolve(srcDir, mod, 'index.ts'))).toBe(true);
    }
  });

  // `src/capture/` went with the hook pipeline in task 4.5, and `src/db/`'s
  // barrel went with it — `db/` is now deep-imported like `transcript/`, so the
  // absence is asserted rather than left for someone to helpfully restore.
  it('has no capture module and no db barrel', () => {
    expect(existsSync(resolve(srcDir, 'capture'))).toBe(false);
    expect(existsSync(resolve(srcDir, 'db', 'index.ts'))).toBe(false);
    for (const file of ['open.ts', 'read.ts', 'write.ts', 'schema.ts', 'freshness.ts']) {
      expect(existsSync(resolve(srcDir, 'db', file)), file).toBe(true);
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

  it('has the three CLI commands, and none of the deleted four', () => {
    for (const cmd of ['start', 'doctor', 'archive']) {
      expect(existsSync(resolve(srcDir, 'cli', 'commands', `${cmd}.ts`)), cmd).toBe(true);
    }
    for (const cmd of ['hook', 'install', 'uninstall', 'import']) {
      expect(existsSync(resolve(srcDir, 'cli', 'commands', `${cmd}.ts`)), cmd).toBe(false);
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
