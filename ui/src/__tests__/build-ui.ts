import { build } from 'vite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * A real `vite build` into a temp dir, memoized per module graph.
 *
 * All three acceptance criteria read the same build output. That is the point:
 * it removes the "did you run npm run build first?" branch entirely, so there is
 * no skip path to go silent, ui/dist's gitignored status is irrelevant, and a
 * fresh clone is green. (The repo's standing rule — an acceptance criterion that
 * skips itself is worse than no test at all.)
 *
 * Costs ~1s. Temp-dir handling mirrors src/server/__tests__/helpers.ts.
 */

const uiDir = fileURLToPath(new URL('../..', import.meta.url));

let pending: Promise<string> | null = null;
const created: string[] = [];

export function buildUi(): Promise<string> {
  pending ??= (async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'agent-lens-ui-build-'));
    created.push(outDir);

    // Vite derives `isProduction` from process.env.NODE_ENV and offers no inline
    // config lever for it (vite 5 resolveConfig: `isProduction =
    // process.env.NODE_ENV === "production"`). Its CLI sets that variable;
    // vitest sets NODE_ENV=test, so without this the build keeps React's dev
    // branches and emits ~24 extra reactjs.org warning URLs that never ship.
    // The no-egress scan would then be measuring bytes no user ever receives.
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await build({
        root: uiDir,
        configFile: join(uiDir, 'vite.config.ts'),
        mode: 'production',
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true },
      });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
    return outDir;
  })();
  return pending;
}

/** Call from afterAll. Safe to call when no build ever ran. */
export function cleanupBuilds(): void {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
  pending = null;
}

function readAll(dir: string, ext: string): { name: string; text: string }[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith(ext))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

/** Every emitted stylesheet, concatenated. There is one today; not assumed. */
export async function builtCss(): Promise<string> {
  const dir = await buildUi();
  const files = readAll(dir, '.css');
  if (files.length === 0) throw new Error(`no .css emitted into ${dir} — did the build change?`);
  return files.map((f) => f.text).join('\n');
}

/** Every emitted HTML document, concatenated. */
export async function builtHtml(): Promise<string> {
  const dir = await buildUi();
  const files = readAll(dir, '.html');
  if (files.length === 0) throw new Error(`no .html emitted into ${dir} — did the build change?`);
  return files.map((f) => f.text).join('\n');
}

/**
 * Every emitted text file, concatenated — the surface AC2's URL scan runs over.
 * Binaries are skipped by extension; directories by stat. Read errors are NOT
 * swallowed: silently dropping a file here would silently shrink what the
 * no-egress scan can see.
 */
export async function builtBundleText(): Promise<string> {
  const dir = await buildUi();
  const texts = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => !/\.(woff2?|ttf|otf|png|jpe?g|gif|webp|ico)$/i.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => readFileSync(join(dir, name), 'utf8'));
  if (texts.length === 0) throw new Error(`no text files emitted into ${dir}`);
  return texts.join('\n');
}

/**
 * The `:root, :host { ... }` declaration block Tailwind emits its theme into.
 * Parsed from the built artifact rather than from the source theme.css, which
 * would be a tautology.
 */
export async function builtRootVars(): Promise<Map<string, string>> {
  const css = await builtCss();
  const block = /:root(?:\s*,\s*:host)?\s*\{([^}]*)\}/.exec(css);
  if (!block?.[1]) {
    throw new Error('no `:root` block in the built CSS — @theme static may have been dropped');
  }
  const vars = new Map<string, string>();
  for (const decl of block[1].split(';')) {
    const at = decl.indexOf(':');
    if (at === -1) continue;
    const name = decl.slice(0, at).trim();
    if (name.startsWith('--')) vars.set(name, decl.slice(at + 1).trim());
  }
  return vars;
}

/** The declaration body of the rule for a single utility class, e.g. `.bg-accent`. */
export function ruleBody(css: string, utilityClass: string): string | null {
  const escaped = utilityClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The class may appear in a selector list; match it as a whole selector token.
  const re = new RegExp(`(?:^|[},])([^{}]*\\.${escaped})(?![\\w-])([^{}]*)\\{([^}]*)\\}`, 'm');
  return re.exec(css)?.[3] ?? null;
}
