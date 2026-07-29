import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUi, cleanupBuilds } from './build-ui';

afterAll(cleanupBuilds);

/*
 * AC6 (Vite half) — the `@/*` alias resolves in a real production build.
 *
 * The other half is `npm run typecheck`: tsc reads ui/tsconfig.json `paths`,
 * Vite reads ui/vite.config.ts `resolve.alias`, and configuring only one fails
 * invisibly until the other tool runs. A `paths` mistake is a compile error, so
 * it has no test file here by design.
 *
 * No fixture module, deliberately: buildUi() builds the real
 * index.html -> main.tsx entry, so anything "reachable from the entry" would be
 * test-only code shipped in the production bundle. AppShell is already imported
 * by App.tsx and already needs cn(), which puts `@/lib/utils` in the real graph
 * for free.
 *
 * Note the asymmetry this leaves: ui/src/components/ui/*.tsx are NOT in that
 * graph until something imports them, so until Task 5.4 their `@/lib/utils`
 * imports are covered by tsc alone, not by this build.
 */

const APP_SHELL_PATH = fileURLToPath(new URL('../components/shell/AppShell.tsx', import.meta.url));

/** Every emitted script, concatenated. Minified, so only literals survive. */
async function builtJs(): Promise<string> {
  const dir = await buildUi();
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

describe('the @/* alias', () => {
  it('is exercised by the real entry graph, not by a fixture', () => {
    const source = readFileSync(APP_SHELL_PATH, 'utf8');
    expect(
      source,
      'AppShell must import cn through the alias — that import is the only thing ' +
        'putting `@/lib/utils` into the production entry graph.',
    ).toContain("from '@/lib/utils'");
  });

  it('resolves @/lib/utils in a real Vite build', async () => {
    // A missing resolve.alias entry makes this build throw, which is the assertion.
    const js = await builtJs();
    expect(
      js,
      'AppShell did not reach the bundle, so the build proved nothing about the alias.',
    ).toContain('app-shell');
  });
});
