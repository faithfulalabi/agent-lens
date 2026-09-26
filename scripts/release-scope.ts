// Task 8.5 — the one definition of "a file whose bytes can change the published
// tarball", and the CI gate that asks it about a diff.
//
// `package.json` `files` ships `bin`, `dist` and `ui/dist`. `dist` is tsc's
// emit of `src/` through `tsconfig.build.json`; `ui/dist` is vite's bundle of
// `ui/index.html` + `ui/src/` (plus `src/shared` through the `@shared` alias,
// already covered by `src/`). npm always adds package.json, README.md and
// LICENSE. Everything else — tests, docs, CI, scripts, fixtures — never reaches
// a user, so a merge touching only those must not cut a release.
// `src/packaging.test.ts` holds this against the compiler, the manifest and the
// vite config, so a drift between "what ships" and "what triggers a release"
// goes red.
//
// Runs under plain `node` (Node 24 strips erasable types): `node:` imports and
// erasable TypeScript only, no tsx, no install.
//
//   node scripts/release-scope.ts --base <ref>     diff <ref>..HEAD
//   node scripts/release-scope.ts --files a b c    ask about explicit paths
//
// Prints one line per file, then the decision, and appends `shipped=true|false`
// to $GITHUB_OUTPUT when set. Exits 0 on either decision and 1 on a usage or
// git error — never 2, which the CLI reserves product-wide.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Single files whose bytes reach the tarball or shape its build. */
export const SHIPPED_FILES = [
  'package.json', // npm always packs these three (scripts/pack-smoke.mjs MANDATORY)
  'README.md',
  'LICENSE',
  'tsconfig.json', // dist emit settings
  'tsconfig.node.json',
  'tsconfig.build.json',
  'ui/index.html', // ui/dist build inputs
  'ui/vite.config.ts',
  'ui/tsconfig.json',
  'ui/package.json', // dependencies bundled into ui/dist
  'ui/package-lock.json',
] as const;

/** `files` + tsconfig `include` + the vite root. */
export const SHIPPED_DIRS = ['bin/', 'src/', 'ui/src/'] as const;

/** `tsconfig.build.json` `exclude` entries under `src/`. */
export const NOT_SHIPPED_DIRS = ['src/dev/', 'src/render-gate/'] as const;

const TEST_SEGMENT = /(^|\/)(__tests__|__snapshots__)\//;
const TEST_FILE = /\.test\.tsx?$/;

export function isShipped(path: string): boolean {
  const file = path.replace(/^\.\//, '');
  if ((SHIPPED_FILES as readonly string[]).includes(file)) return true;
  if (file.endsWith('.md')) return false;
  if (TEST_SEGMENT.test(file) || TEST_FILE.test(file)) return false;
  if (NOT_SHIPPED_DIRS.some((dir) => file.startsWith(dir))) return false;
  return SHIPPED_DIRS.some((dir) => file.startsWith(dir));
}

function fail(message: string): never {
  process.stderr.write(`release-scope: ${message}\n`);
  process.exit(1);
}

function changedFiles(argv: string[]): string[] {
  const [flag, ...rest] = argv;
  if (flag === '--files') return rest;
  if (flag === '--base' && rest.length === 1 && rest[0]) {
    try {
      const out = execFileSync('git', ['diff', '--name-only', `${rest[0]}..HEAD`], {
        encoding: 'utf8',
      });
      return out.split('\n').filter(Boolean);
    } catch {
      return fail(`git diff against ${rest[0]} failed`);
    }
  }
  return fail('usage: release-scope.ts --base <ref> | --files <path>...');
}

function main(argv: string[]): void {
  const files = changedFiles(argv);
  const shipped = files.filter(isShipped);
  for (const file of files) console.log(`${isShipped(file) ? 'SHIPPED' : 'skip'}  ${file}`);
  console.log(`decision: ${shipped.length > 0 ? 'release-eligible' : 'no-release'}`);
  const output = process.env['GITHUB_OUTPUT'];
  if (output) appendFileSync(output, `shipped=${shipped.length > 0}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
