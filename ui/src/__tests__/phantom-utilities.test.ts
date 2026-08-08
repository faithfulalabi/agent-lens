import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { builtCss, cleanupBuilds } from './build-ui';

afterAll(cleanupBuilds);

/*
 * Task 0.1 — the phantom-utility guard.
 *
 * Tailwind v4 scans comments and ordinary English prose, not just class
 * attributes: "a fixed seed" compiles a `.fixed` rule, "filter state" compiles
 * a `.filter` rule. Every one of those is CSS shipped to users that no element
 * uses, and it makes "is this class real?" unanswerable by reading the built
 * bundle — the exact question the design-system tests exist to answer.
 *
 * The instrument: build the stylesheet for real, extract the class names in
 * SELECTOR position, and subtract the tokens production source actually
 * declares. What remains is emitted-but-undeclared and has to be on the
 * allowlist below with a written reason. The reverse direction runs too — an
 * entry the build no longer produces reds instead of quietly widening the net —
 * which is `KNOWN_INERT_URLS` in `no-egress.test.ts`, in a second domain.
 *
 * SCOPE, stated up front so it is not mistaken for something stricter. The leak
 * surface this guard defends is COMMENTS AND JSX TEXT. The declared set is
 * deliberately over-broad — every string literal and template-literal text part
 * counts, not only `className` positions — because the strict alternative
 * false-positives on every class held in a lookup map, which
 * `retokenized.test.ts:36-50` documents at length. Two consequences are accepted
 * on purpose: `.collapse` is "declared" by the aria-label template at
 * `session/TraceGroup.tsx:87`, and `.inline` by the string-literal type member
 * at `design/spec-tokens.ts:43`. Both are laundered, both are known.
 *
 * This file depends on Step 0 of its own task: the `@source not` line in
 * `styles/globals.css` that lifts `__tests__` out of Tailwind's scan. Without
 * it, naming a class in the allowlist below is enough to mint the rule the entry
 * exempts, both directions of the diff go vacuous, and the dead rules ship
 * forever. The canary test is the first assertion in this file, because a
 * mistyped `@source` path is a silent no-op — no warning, no error, no diff.
 */

const UI_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const STYLES_DIR = fileURLToPath(new URL('../styles', import.meta.url));

/** This file's own path, relative to `ui/` — see the self-blame note on `formatPhantomFailure`. */
const GUARD_FILE = 'src/__tests__/phantom-utilities.test.ts';

/**
 * A utility-shaped literal that appears nowhere else in `ui/`, used to prove the
 * `@source not` exclusion is live. Theme-independent (`text-decoration-line`),
 * so it cannot go quietly dead when the theme changes, and it is the exact class
 * a broken exclusion was measured to mint.
 */
const CANARY_UTILITY = 'underline';

/**
 * Utilities the build emits that no source token declares, each with the reason
 * it is tolerated rather than fixed. Every entry must still be emitted-and-
 * undeclared: a stale exemption reds, because an exemption nothing needs is an
 * exemption that has stopped being reviewed.
 *
 * The fix for a NEW phantom is almost always to widen the prose, not to add a
 * line here — a suffixed form is not a utility candidate at all.
 */
export const KNOWN_UNREFERENCED_UTILITIES: readonly { utility: string; why: string }[] = [
  {
    utility: 'block',
    why:
      'a local identifier, not prose: `src/lib/sse.ts:136` iterates `for (const block of blocks)`. ' +
      "Renaming a variable for CSS's sake is worse than one dead rule.",
  },
  {
    utility: 'invisible',
    why:
      'ordinary English in component headers (`session/MetricChip.tsx:27`, `session/SpanRow.tsx:28`, ' +
      '`session/span-visuals.ts:10`) describing what a scan cannot see. No synonym reads as clearly.',
  },
  {
    utility: 'lowercase',
    why:
      '`design/normalize-css-value.ts:40`,`:65` documents the casing rule it implements, and the ' +
      'word IS the behaviour being described — paraphrasing it would make the comment worse.',
  },
  {
    utility: 'ring-accent',
    why:
      "`components/ui/tabs.tsx:23` names the design system's 2px focus ring by role in the " +
      'retokenizing table. The class the component actually uses is the variant-prefixed form, ' +
      'which Tailwind extracts as a separate candidate.',
  },
  {
    utility: 'shrink',
    why:
      '`src/lib/tree-nav.ts:111` — "a shrink pulls focusedIndex back into range" — describes list ' +
      'behaviour, not layout. The layout utility the components use is the suffixed form.',
  },
  {
    utility: 'transition',
    why:
      "`components/ui/context-menu.tsx:16` refers to the design system's 150ms default, which is a " +
      'theme setting (`--default-transition-*`) rather than a class anything applies.',
  },
];

/* ------------------------------------------------------------ the emitted set --- */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ASCII_IDENT = /[A-Za-z0-9_-]/;

/**
 * Code points >= U+0080 count as ident characters. This is defence-in-depth and
 * a pragmatic match to what Tailwind's escaper emits, NOT a consequence of the
 * grammar: CSS Syntax L3 narrowed "non-ASCII ident code point" to enumerated
 * ranges and U+2026 is not among them, yet Tailwind leaves it unescaped anyway.
 */
function isIdentChar(ch: string): boolean {
  return ASCII_IDENT.test(ch) || (ch.codePointAt(0) ?? 0) >= 0x80;
}

/** Class names in a single selector prelude. */
function harvestSelectorClasses(selector: string, into: Set<string>): void {
  let i = 0;
  while (i < selector.length) {
    if (selector[i] !== '.') {
      i += 1;
      continue;
    }
    let end = i + 1;
    let name = '';
    while (end < selector.length) {
      const ch = selector[end] ?? '';
      if (ch === '\\') {
        // An escape pair contributes its second character verbatim.
        name += selector[end + 1] ?? '';
        end += 2;
        continue;
      }
      if (!isIdentChar(ch)) break;
      name += ch;
      end += 1;
    }
    if (name !== '') into.add(name);
    /*
     * Resume at the stop index, never at `i + 1`. Load-bearing: `.p-0\.5` has to
     * yield `p-0.5`, and restarting at every `.` would also mint a bogus `5`
     * from the escaped dot it just consumed.
     */
    i = end;
  }
}

/**
 * Every class name the built stylesheet declares a rule for.
 *
 * A single character walk rather than a regex, quote- and comment-aware in the
 * same pass so that a `content: "…/*…"` declaration cannot desynchronise it.
 * `@`-preludes are skipped whole, which drops `@layer`, `@media`, `@supports`,
 * `@property` and `@keyframes` without enumerating them.
 *
 * Direction matters: this goes selector -> class. `retokenized.test.ts`'s
 * `hasRule` goes class -> selector and cannot be reused, and `build-ui.ts`'s
 * `ruleBody` never CSS-escapes, so it returns null for most of the vocabulary.
 */
export function emittedUtilityClasses(css: string): Set<string> {
  const classes = new Set<string>();
  let prelude = '';
  let quote: string | null = null;
  let i = 0;

  while (i < css.length) {
    const ch = css[i] ?? '';

    if (quote !== null) {
      if (ch === '\\') {
        prelude += ch + (css[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      prelude += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      prelude += ch;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      prelude += ch + (css[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '{') {
      const trimmed = prelude.trim();
      if (!trimmed.startsWith('@')) harvestSelectorClasses(trimmed, classes);
      prelude = '';
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ';') {
      prelude = '';
      i += 1;
      continue;
    }

    prelude += ch;
    i += 1;
  }

  return classes;
}

/* ----------------------------------------------------------- the declared set --- */

/**
 * Whitespace-separated tokens from one TS/TSX source's string literals and
 * template-literal text parts, via the TypeScript scanner.
 *
 * Comment trivia and `JsxText` contribute NOTHING, deliberately: they are
 * precisely what Tailwind is wrongly reading, so counting them as a declaration
 * would make the whole guard a tautology.
 */
export function declaredTokensOfSource(fileName: string, text: string): Set<string> {
  const tokens = new Set<string>();
  const push = (value: string): void => {
    for (const token of value.split(/\s+/)) if (token !== '') tokens.add(token);
  };

  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      // StringLiteral and NoSubstitutionTemplateLiteral.
      push(node.text);
    } else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      push((node as ts.TemplateLiteralLikeNode).text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return tokens;
}

/** Production TS/TSX under `ui/src`, i.e. every `.ts`/`.tsx` outside a `__tests__` directory. */
export function productionSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(full);
    }
  };
  walk(SRC_DIR);
  return found.sort();
}

/** Every token any production source could plausibly be declaring as a class. */
export function declaredTokens(): Set<string> {
  const tokens = new Set<string>();

  for (const path of productionSourceFiles()) {
    for (const token of declaredTokensOfSource(path, readFileSync(path, 'utf8'))) tokens.add(token);
  }

  /*
   * Plus raw whitespace-split tokens from the stylesheets themselves — the hook
   * an `@apply` would need. There is no `@apply` in `ui/` today, so this scan
   * currently declares nothing real, and it launders exactly two dead rules:
   *
   *   - `.static`, "declared" only by the word `static` in `@theme static {`
   *     (`styles/theme.css:50`);
   *   - `.ring`,   "declared" only by "2px accent ring" in the base-layer comment
   *     in `styles/globals.css`.
   *
   * Named here so a later reader finds them deliberately rather than by
   * accident. Narrowing this to `@apply` arguments only is a follow-up, and it
   * belongs to whichever task first introduces an `@apply`.
   */
  for (const name of readdirSync(STYLES_DIR)) {
    if (!name.endsWith('.css')) continue;
    for (const token of readFileSync(join(STYLES_DIR, name), 'utf8').split(/\s+/)) {
      if (token !== '') tokens.add(token);
    }
  }

  return tokens;
}

/* ------------------------------------------------------------------ the diff --- */

/**
 * Both directions of the allowlist, over plain sets so the rule is provable
 * without mutating a real build (`no-egress.test.ts:99-116` in a second domain).
 */
export function diffUtilities(
  emitted: Iterable<string>,
  declared: ReadonlySet<string>,
  allowed: Iterable<string>,
): { unexpected: string[]; stale: string[] } {
  const phantoms = [...emitted].filter((utility) => !declared.has(utility)).sort();
  const phantomSet = new Set(phantoms);
  const exempt = new Set(allowed);
  return {
    unexpected: phantoms.filter((utility) => !exempt.has(utility)),
    stale: [...exempt].filter((utility) => !phantomSet.has(utility)).sort(),
  };
}

/* --------------------------------------------------------- blame and the message --- */

const BLAME_SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const BINARY_EXTENSION = /\.(woff2?|ttf|otf|png|jpe?g|gif|webp|ico)$/i;

/**
 * Every file Tailwind could have read: all of `ui/` minus vendored code, build
 * output and binaries.
 *
 * `__tests__` is deliberately INCLUDED even though the declared scan skips it
 * and Tailwind now skips it too. Tailwind's scan base is `ui/` while the
 * declared scan is `ui/src`, so `ui/index.html`, `ui/vite.config.ts`,
 * `ui/tsconfig.json` and `ui/package-lock.json` are all inside what the compiler
 * reads and outside what this guard calls declared. A phantom can still be born
 * in a file the declared scan never opens, and a blame grep restricted to
 * production sources would answer "unknown source" for it.
 */
export function blameCorpus(): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (BLAME_SKIP_DIRS.has(entry.name)) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.isFile() && !BINARY_EXTENSION.test(entry.name)) found.push(relative);
    }
  };
  walk(UI_DIR, '');
  return found.sort();
}

let corpusCache: { path: string; lines: string[] }[] | null = null;

function corpus(): { path: string; lines: string[] }[] {
  corpusCache ??= blameCorpus().map((path) => ({
    path,
    lines: readFileSync(join(UI_DIR, path), 'utf8').split('\n'),
  }));
  return corpusCache;
}

/**
 * Every `path:line  <trimmed line>` in `ui/` that could have handed this word to
 * Tailwind as a candidate. A dumb, total grep — the guard file is not filtered
 * here, so this function's own unit tests stay honest.
 *
 * The leading `:` in the lookbehind is the one deviation from
 * `retokenized.test.ts:134`'s boundary, and it is a measured improvement:
 * without it `ring-accent` also blames the two legitimate variant-prefixed uses
 * in `tabs.tsx`, which are a different emitted class. `font-display: block`
 * (space after the colon) stays visible.
 */
export function blamePhantom(word: string): string[] {
  const pattern = new RegExp(`(?<![\\w:-])${escapeRegExp(word)}(?![\\w-])`);
  const hits: string[] = [];
  for (const { path, lines } of corpus()) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${path}:${index + 1}  ${line.trim()}`);
    });
  }
  return hits;
}

const SUFFIXED_FORMS_NOTE =
  'Note: a suffixed form is not a utility candidate — `filters`, `collapsed`, `truncated` and ' +
  '`grows` all compile to nothing. Widening the prose is the fix; deleting the word is not.';

/**
 * The failure message the phantom assertion reports. A pure function so it can
 * be tested directly, and it MUST be what `expect` is given — a correct
 * `blamePhantom` that nothing calls ships the "unknown source" trap this guard
 * exists to prevent.
 *
 * Self-blame: once this file exists, every `{ utility: 'x', … }` entry is itself
 * a line matching the blame regex (the lookbehind admits the preceding quote,
 * the lookahead the following one). Since Step 0 put this file outside
 * Tailwind's scan, no line in it can be the CAUSE of an emitted rule, so for an
 * ALLOWLISTED utility every hit here is noise and is dropped. For a utility that
 * is not allowlisted the hits stay: that is exactly the case AC4 is about —
 * blame has to be able to reach into `__tests__` and say so.
 */
export function formatPhantomFailure(
  phantoms: readonly { utility: string; hits: readonly string[] }[],
): string {
  const exempt = new Set(KNOWN_UNREFERENCED_UTILITIES.map((entry) => entry.utility));
  const out = [
    'utilities in the built CSS that no source token declares. Tailwind compiled these from ' +
      'prose, not from a class attribute:',
  ];
  for (const { utility, hits } of phantoms) {
    const shown = exempt.has(utility)
      ? hits.filter((hit) => !hit.startsWith(`${GUARD_FILE}:`))
      : hits;
    out.push(`  .${utility}`);
    if (shown.length === 0) {
      out.push('    (no source found in ui/ — check index.html, *.config.ts, package-lock.json)');
    }
    for (const hit of shown) out.push(`    ${hit}`);
  }
  out.push(SUFFIXED_FORMS_NOTE);
  return out.join('\n');
}

/* ------------------------------------------------------------------- suites --- */

describe('the built stylesheet ships no utility that source never declares', () => {
  it('the __tests__ exclusion in globals.css is live', async () => {
    /*
     * Item 0, and the assertion that makes every other one honest. A mistyped
     * `@source not` path is a SILENT no-op — exit 0, no warning, zero-class diff
     * — so a wrong path is indistinguishable from a working one by build output
     * alone. This file names the canary and nothing else in `ui/` does, so the
     * rule can only appear if Tailwind is still reading `__tests__`.
     */
    const emitted = emittedUtilityClasses(await builtCss());
    expect(
      [...emitted],
      `.${CANARY_UTILITY} is in the built CSS, and this file is its only source in ui/. ` +
        'The `@source not "../**/__tests__/**"` line in src/styles/globals.css is not taking ' +
        'effect — check the `../` prefix, and that the rule is at top level.',
    ).not.toContain(CANARY_UTILITY);
  });

  it('every emitted utility is declared in source, or justified on the allowlist', async () => {
    const emitted = emittedUtilityClasses(await builtCss());
    const { unexpected, stale } = diffUtilities(
      emitted,
      declaredTokens(),
      KNOWN_UNREFERENCED_UTILITIES.map((entry) => entry.utility),
    );

    // The message is `formatPhantomFailure`, not a literal — see item 7 below.
    expect(
      unexpected,
      formatPhantomFailure(unexpected.map((utility) => ({ utility, hits: blamePhantom(utility) }))),
    ).toEqual([]);

    // The reverse direction, live only because Step 0 stopped this file feeding
    // the compiler: an exemption nothing needs has stopped being reviewed.
    expect(
      stale,
      'allowlist entries the build no longer emits (or that source now declares) — delete them',
    ).toEqual([]);
  });

  it('the emitted-set walker survives the escape shapes that break a naive parser', async () => {
    /*
     * Real controls only because of Step 0: before it, a control literal in this
     * file minted its own rule and the assertion could never go red.
     */
    const emitted = emittedUtilityClasses(await builtCss());
    for (const shape of [
      'bg-surface',
      'data-[state=active]:bg-surface',
      'bg-error/8',
      'max-h-(--radix-context-menu-content-available-height)',
      '-mx-1',
      'p-0.5',
    ]) {
      expect([...emitted], `the walker lost the class shape "${shape}"`).toContain(shape);
    }
    // The bogus token a "restart at every `.`" walker mints out of `.p-0\.5`.
    expect([...emitted], 'the walker split an escaped dot into a bogus token').not.toContain('5');
  });
});

/* Fixtures for the declared-set rules. `zz-not-a-utility` resolves to nothing. */
const NON_UTILITY = 'zz-not-a-utility';

const PROSE_ONLY_SOURCE = `
// ${NON_UTILITY} written in a line comment
/* ${NON_UTILITY} written in a block comment */
export function Widget() {
  return <div className="p-2">${NON_UTILITY} written as JSX text</div>;
}
`;

const DECLARED_SOURCE = `
const LOOKUP = { live: '${NON_UTILITY}-map' } as const;
export function Widget({ on }: { on: boolean }) {
  return (
    <div className="${NON_UTILITY}-attr">
      <span className={cn('${NON_UTILITY}-cn', on && 'x')} />
      <b className={\`${NON_UTILITY}-head \${on ? 'a' : 'b'}\`} />
      <i>{LOOKUP.live}</i>
    </div>
  );
}
`;

describe('only string literals declare a class — comments and JSX text never do', () => {
  it('a token that appears only in a comment or as JSX text is not declared', () => {
    const tokens = declaredTokensOfSource('fixture.tsx', PROSE_ONLY_SOURCE);
    expect(
      [...tokens],
      'a comment or JSX text was counted as a declaration — that makes the guard a tautology, ' +
        'because comments and JSX text are exactly what Tailwind is wrongly reading',
    ).not.toContain(NON_UTILITY);
    // Not vacuous: the extractor did run and did see the real class attribute.
    expect([...tokens]).toContain('p-2');
  });

  it('JSX text specifically is not a declaration', () => {
    const tokens = declaredTokensOfSource('fixture.tsx', `<div>${NON_UTILITY}</div>;\n`);
    expect([...tokens]).not.toContain(NON_UTILITY);
  });

  it('class attributes, cn() arguments, lookup maps and template heads are declarations', () => {
    const tokens = declaredTokensOfSource('fixture.tsx', DECLARED_SOURCE);
    for (const suffix of ['attr', 'cn', 'map', 'head']) {
      expect([...tokens], `the ${suffix} position was not read as a declaration`).toContain(
        `${NON_UTILITY}-${suffix}`,
      );
    }
  });
});

describe('the allowlist is closed in both directions', () => {
  it('a stale entry reds', () => {
    const { stale, unexpected } = diffUtilities(['kept', 'phantom'], new Set(['kept']), [
      'phantom',
      'gone',
    ]);
    expect(unexpected).toEqual([]);
    expect(stale).toEqual(['gone']);
  });

  it('an unexempted phantom reds', () => {
    const { unexpected } = diffUtilities(['kept', 'phantom'], new Set(['kept']), []);
    expect(unexpected).toEqual(['phantom']);
  });

  it('every entry is shaped like a utility, is unique, and carries a reason', () => {
    expect(KNOWN_UNREFERENCED_UTILITIES.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const { utility, why } of KNOWN_UNREFERENCED_UTILITIES) {
      expect(utility, `"${utility}" is not shaped like a utility class`).toMatch(
        /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
      );
      expect(why.trim(), `"${utility}" carries no reason`).not.toBe('');
      expect(seen.has(utility), `"${utility}" is listed twice`).toBe(false);
      seen.add(utility);
    }
  });
});

/*
 * A token written ONLY in this file, and nowhere else in `ui/`. It is the proof
 * that blame reaches into `__tests__`: a phantom's prose source frequently lives
 * in a test file or a docstring, and a blame grep restricted to production
 * sources would report "unknown source" for the leak it just caught.
 */
const BLAME_FIXTURE_TOKEN = 'zz-blame-reaches-tests';

describe('blame finds the prose that produced a utility', () => {
  it('reaches into __tests__', () => {
    const hits = blamePhantom(BLAME_FIXTURE_TOKEN);
    expect(
      hits.length,
      'blame found nothing for a token written in this very file',
    ).toBeGreaterThan(0);
    const paths = hits.map((hit) => hit.slice(0, hit.indexOf('  ')));
    expect(paths.some((path) => path.includes('__tests__'))).toBe(true);
    expect(paths.every((path) => path.startsWith(`${GUARD_FILE}:`))).toBe(true);
  });

  it('matches whole tokens only, and not through a variant prefix', () => {
    const external = blamePhantom('ring-accent').filter((hit) => !hit.startsWith(`${GUARD_FILE}:`));
    expect(
      external,
      'blame for ring-accent should be the retokenizing table line and nothing else — the two ' +
        'variant-prefixed uses in tabs.tsx are a different emitted class',
    ).toHaveLength(1);
    expect(external[0] ?? '').toMatch(/^src\/components\/ui\/tabs\.tsx:23 {2}/);

    // Guard-file hits are dropped first, for the same reason as above: this
    // file's own assertions name both the bare rule and its suffixed form.
    const shrink = blamePhantom('shrink').filter((hit) => !hit.startsWith(`${GUARD_FILE}:`));
    expect(shrink.some((hit) => hit.startsWith('src/lib/tree-nav.ts:111  '))).toBe(true);
    for (const hit of shrink) {
      expect(hit, 'a suffixed layout line was blamed for the bare rule').not.toMatch(
        /(?<![\w-])shrink-0/,
      );
    }
  });

  it('the failure message is what the assertion actually reports', () => {
    /*
     * AC4's other half. Items above exercise `blamePhantom` in isolation and
     * cannot see whether anything calls it; this one pins the message builder,
     * and the phantom assertion above passes exactly this string to `expect`
     * (mirroring `no-egress.test.ts:107-110`).
     */
    const synthetic = formatPhantomFailure([
      { utility: BLAME_FIXTURE_TOKEN, hits: blamePhantom(BLAME_FIXTURE_TOKEN) },
    ]);
    expect(synthetic, 'the message dropped the only source there was').toContain(
      'phantom-utilities.test.ts:',
    );
    expect(synthetic).toContain(SUFFIXED_FORMS_NOTE);

    // A real phantom: its own allowlist entry self-blames, and that is filtered.
    const real = formatPhantomFailure([
      { utility: 'ring-accent', hits: blamePhantom('ring-accent') },
    ]);
    expect(real).toContain('src/components/ui/tabs.tsx:23');
    expect(real, 'the allowlist entry blamed itself').not.toContain(GUARD_FILE);
  });
});

describe('the scans are not vacuous', () => {
  it('every scan saw a real number of things', async () => {
    /*
     * The standing rule (`retokenized.test.ts:263-269`): without these, an
     * extractor that regressed to returning almost nothing would go green while
     * checking nothing at all. Measured today: 186 emitted, 1401 declared, 36
     * production sources, 82 files in the blame corpus.
     */
    expect(emittedUtilityClasses(await builtCss()).size, 'emitted set').toBeGreaterThan(120);
    expect(declaredTokens().size, 'declared set').toBeGreaterThan(600);
    expect(productionSourceFiles().length, 'production sources walked').toBeGreaterThan(25);
    expect(blameCorpus().length, 'blame corpus').toBeGreaterThan(50);
  });
});
