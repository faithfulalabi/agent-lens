import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { builtCss, cleanupBuilds } from './build-ui';

afterAll(cleanupBuilds);

/*
 * Guards the built stylesheet against utility rules no source token declares.
 * Tailwind v4 compiles candidates out of comments and JSX text, not just class
 * attributes, so prose leaks dead CSS into the bundle.
 *
 * Depends on the `@source not` line in `styles/globals.css` lifting `__tests__`
 * out of Tailwind's scan: without it, naming a class in the allowlist below
 * mints the rule that entry exempts and both directions of the diff go vacuous.
 */

const UI_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const STYLES_DIR = fileURLToPath(new URL('../styles', import.meta.url));

/** This file's own path, relative to `ui/` — see the self-blame note on `formatPhantomFailure`. */
const GUARD_FILE = 'src/__tests__/phantom-utilities.test.ts';

/** Utility-shaped, written nowhere else in `ui/`: the rule can only appear if the exclusion broke. */
const CANARY_UTILITY = 'underline';

/**
 * Utilities the build emits that no source token declares, with the reason each
 * is tolerated. A stale entry reds too — an exemption nothing needs has stopped
 * being reviewed.
 */
export const KNOWN_UNREFERENCED_UTILITIES: readonly { utility: string; why: string }[] = [
  {
    utility: 'invisible',
    why: 'plain English in component headers (`session/MetricChip.tsx:27` and two others).',
  },
  {
    utility: 'lowercase',
    why: '`design/normalize-css-value.ts:40` documents the casing rule it implements.',
  },
  {
    utility: 'ring-accent',
    why: '`components/ui/tabs.tsx:23` names the focus ring by role; the component uses the variant-prefixed form.',
  },
  {
    utility: 'shrink',
    why: '`src/lib/tree-nav.ts:111` describes list behaviour; the layout utility used is the suffixed form.',
  },
  {
    utility: 'transition',
    why: '`components/ui/context-menu.tsx:16` refers to the theme default, not a class.',
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ASCII_IDENT = /[A-Za-z0-9_-]/;

/** Non-ASCII code points count as ident characters — matches what Tailwind's escaper leaves bare. */
function isIdentChar(ch: string): boolean {
  return ASCII_IDENT.test(ch) || (ch.codePointAt(0) ?? 0) >= 0x80;
}

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
        name += selector[end + 1] ?? '';
        end += 2;
        continue;
      }
      if (!isIdentChar(ch)) break;
      name += ch;
      end += 1;
    }
    if (name !== '') into.add(name);
    // Resume at the stop index: restarting at `i + 1` would mint a bogus `5`
    // out of the escaped dot in `.p-0\.5`.
    i = end;
  }
}

/**
 * Every class name the built stylesheet declares a rule for: a character walk,
 * quote- and comment-aware in the same pass, going selector -> class.
 * `@`-preludes are skipped whole.
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

/**
 * Whitespace-separated tokens from one source's string literals and template
 * text parts. Comments and `JsxText` contribute nothing, deliberately: they are
 * what Tailwind is wrongly reading, so counting them would make this a tautology.
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

export function declaredTokens(): Set<string> {
  const tokens = new Set<string>();

  for (const path of productionSourceFiles()) {
    for (const token of declaredTokensOfSource(path, readFileSync(path, 'utf8'))) tokens.add(token);
  }

  /*
   * Plus raw tokens from the stylesheets themselves — the hook an `@apply` would
   * need. There is none in `ui/` today, so this only launders `.static` and
   * `.ring`, each spelled in stylesheet prose.
   */
  for (const name of readdirSync(STYLES_DIR)) {
    if (!name.endsWith('.css')) continue;
    for (const token of readFileSync(join(STYLES_DIR, name), 'utf8').split(/\s+/)) {
      if (token !== '') tokens.add(token);
    }
  }

  return tokens;
}

/** Both directions of the allowlist, over plain sets so the rule is provable without a build. */
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

const BLAME_SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const BINARY_EXTENSION = /\.(woff2?|ttf|otf|png|jpe?g|gif|webp|ico)$/i;

/**
 * Every file Tailwind could have read: all of `ui/` minus vendored code, build
 * output and binaries. `__tests__` is deliberately included even though the
 * declared scan skips it — Tailwind's scan base is `ui/`, not `ui/src`, so a
 * phantom can be born in a file the declared scan never opens.
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
 * Tailwind. A total grep — the guard file is not filtered here, so this
 * function's own unit tests stay honest. The `:` in the lookbehind keeps
 * variant-prefixed uses out of a bare word's blame.
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
 * The failure message the phantom assertion reports, and what `expect` is
 * actually given. Each allowlist entry above is itself a line the blame regex
 * matches, so for an allowlisted utility the guard-file hits are noise and are
 * dropped here — not by narrowing the regex, which would also stop blame
 * reaching `__tests__` for a utility that is not allowlisted.
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

describe('the built stylesheet ships no utility that source never declares', () => {
  it('the __tests__ exclusion in globals.css is live', async () => {
    // A mistyped `@source not` path is a silent no-op — exit 0, no warning, no
    // class diff — so this canary is the only thing that catches it.
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

    expect(
      unexpected,
      formatPhantomFailure(unexpected.map((utility) => ({ utility, hits: blamePhantom(utility) }))),
    ).toEqual([]);

    expect(
      stale,
      'allowlist entries the build no longer emits (or that source now declares) — delete them',
    ).toEqual([]);
  });

  it('the emitted-set walker survives the escape shapes that break a naive parser', async () => {
    // Honest controls only because the scan exclusion keeps these literals out.
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

/* Written only in this file: proof that blame reaches into `__tests__`. */
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

    // Guard-file hits dropped first: this file names both forms.
    const shrink = blamePhantom('shrink').filter((hit) => !hit.startsWith(`${GUARD_FILE}:`));
    expect(shrink.some((hit) => hit.startsWith('src/lib/tree-nav.ts:111  '))).toBe(true);
    for (const hit of shrink) {
      expect(hit, 'a suffixed layout line was blamed for the bare rule').not.toMatch(
        /(?<![\w-])shrink-0/,
      );
    }
  });

  it('the failure message is what the assertion actually reports', () => {
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
    // Floors: without them an extractor that regressed to returning almost nothing would go green.
    expect(emittedUtilityClasses(await builtCss()).size, 'emitted set').toBeGreaterThan(120);
    expect(declaredTokens().size, 'declared set').toBeGreaterThan(600);
    expect(productionSourceFiles().length, 'production sources walked').toBeGreaterThan(25);
    expect(blameCorpus().length, 'blame corpus').toBeGreaterThan(50);
  });
});
