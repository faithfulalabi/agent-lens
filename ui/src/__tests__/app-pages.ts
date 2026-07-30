/*
 * The single source of "which pages does App.tsx render?" (Task 5.2a).
 *
 * TWO suites pin App.tsx's page list, not one — `components/__tests__/
 * components.test.tsx` ("wraps every branch of App.tsx") and `lib/__tests__/
 * route-match.test.ts` ("leaves App.tsx reading the router instead of the
 * address bar"). Both used to spell the page names out by hand, so shipping a
 * new page meant editing two tests that were never about page names in the
 * first place. Both now derive the list from App.tsx's own imports, and adding
 * a page costs exactly one import. Task 5.3 asked for this generalisation; 5.2a
 * runs first, so 5.2a makes it.
 *
 * NOT a test file — the `ui` project collects only `*.test.ts(x)`, the same
 * convention `build-ui.ts` and `spec-doc.ts` beside it already follow. Unlike
 * `build-ui.ts` this reads one file and runs no build, so a second suite
 * importing it costs nothing.
 *
 * Callers MUST pair it with a vacuity guard — the derived list is non-empty and
 * contains a page they know is there. A regex that quietly stopped matching
 * would otherwise green a loop over nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_PATH = fileURLToPath(new URL('../App.tsx', import.meta.url));

export function appSource(): string {
  return readFileSync(APP_PATH, 'utf8');
}

/**
 * Every component name App.tsx imports from `./pages/`.
 *
 * Narrowing to the `./pages/` prefix is what makes this precise rather than a
 * guess: App.tsx imports its shell from `./components/shell/` and its router
 * binding from `./lib/`, so neither can be mistaken for a page. An aliased
 * import (`X as Y`) yields the local name, which is what the JSX will spell.
 */
export function pagesImportedBy(source: string): string[] {
  // Built per call rather than hoisted: a `g` regex carries a `lastIndex`, and
  // module-scope mutable state shared across two suites is not worth the byte.
  const pageImport = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/pages\/[^'"]*['"]/g;
  const names: string[] = [];
  for (const statement of source.matchAll(pageImport)) {
    for (const clause of (statement[1] ?? '').split(',')) {
      // `X as Y` binds Y locally, and Y is the name the JSX will spell.
      const local = clause.replace(/^[\s\S]*\s+as\s+/, '').trim();
      if (local !== '') names.push(local);
    }
  }
  return names;
}
