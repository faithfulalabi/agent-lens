import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CaptureMode, SessionStatus } from '@shared/entities.ts';
import type { EventStatus } from '../../lib/turn-tree';
import type { SpanTypeKey } from '../session/span-visuals';
import { builtCss, cleanupBuilds } from '../../__tests__/build-ui';
import { CAPTURE_MODE_VISUALS, SESSION_STATUS_VISUALS } from '../session/session-visuals';
import { SPAN_VISUALS } from '../session/span-visuals';

afterAll(cleanupBuilds);

/*
 * AC2, AC3 and AC4 — the retokenizing pass, checked against source text.
 *
 * Source text rather than rendered markup, deliberately, and it is the strictly
 * stronger instrument:
 *   - Tailwind v4 scans raw source, so these strings are exactly what the
 *     compiler saw;
 *   - context-menu renders almost nothing under SSR (see components.test.tsx);
 *   - variant-prefixed classes (`data-[state=open]:`, `focus:`,
 *     `focus-visible:`) never appear in any static render at all.
 *
 * Task 5.1a clears the --color-*, --text-*, --radius-*, --shadow-* and --font-*
 * namespaces, so a stale `bg-popover` — or a `shadow-lg`, `shadow-md`,
 * `rounded-sm`, or a bare `shadow` — compiles to no CSS rule whatsoever. Silent
 * no-ops, not errors. That is what AC3 catches.
 */

/*
 * Phase 8 adds `dialog.tsx` here when it builds it.
 *
 * Tasks 5.2a and 5.2b brought the session components in. Joining this array is
 * not free and not automatic — a file listed here must ALSO clear the deny-list
 * below (which contains one legitimate agent-lens token, for the reason stated
 * there) and the per-file richness bar further down. Two files 5.2b created are
 * deliberately absent:
 *
 *   - `../session/session-visuals.ts` holds its classes in a lookup map, and
 *     `classTokensOf` extracts exactly nothing from one. Listing it would red
 *     the richness bar while proving nothing; the manifest scan at the bottom
 *     of this file covers it properly instead.
 *   - `../../pages/Sessions.tsx` is a page module that renders the four
 *     components below and writes almost no classes of its own — the same
 *     richness bar, for the same reason.
 *
 * Task 5.3b brought the span tree in, and left two of its own files out for
 * exactly the two reasons above:
 *
 *   - `../session/span-visuals.ts` is a lookup map, like `session-visuals.ts`
 *     beside it. The manifest scan at the bottom of this file covers both.
 *   - `../../pages/SessionView.tsx` is a page module, like `Sessions.tsx`.
 */
const SOURCE_FILES = [
  '../ui/tabs.tsx',
  '../ui/context-menu.tsx',
  '../shell/AppShell.tsx',
  '../session/MetricChip.tsx',
  '../session/SessionListView.tsx',
  '../session/VolumeHistogram.tsx',
  '../session/RangeControl.tsx',
  '../session/EmptyState.tsx',
  '../session/SpanTree.tsx',
  '../session/SpanRow.tsx',
  '../session/EventDetail.tsx',
  '../session/TraceGroup.tsx',
  '../session/TruncationNotice.tsx',
  '../session/SessionHeader.tsx',
  '../session/ThreadView.tsx',
  // Task 7.3's alarm, in because it is the truncation strip's sibling and
  // writes the same kind of colour vocabulary. `FollowPill.tsx` stayed out for
  // the opposite reason: too few distinct classes to clear the bar below.
  '../session/DriftBanner.tsx',
] as const;

function sources(): { name: string; text: string }[] {
  return SOURCE_FILES.map((rel) => {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    return { name: rel.replace(/^.*\//, ''), text: readFileSync(path, 'utf8') };
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ AC2 --- */

/*
 * Every left-hand entry of the task's retokenizing map that is NOT also a valid
 * agent-lens class. Stated as an explicit list rather than a regex guess, so the
 * next component copied in adds a line instead of silently passing.
 *
 * The deferred/dropped rows (`bg-primary`, `text-primary-foreground`,
 * `bg-black/80`) are kept on purpose: they cost nothing today and catch a
 * Phase 8 `dialog` paste on arrival.
 *
 * THREE upstream classes are deliberately absent, because a flat list cannot
 * tell shadcn's meaning from ours:
 *   - `bg-border` and `text-foreground` survive the rewrite unchanged;
 *   - `bg-background` is a real spec token (design/spec-tokens.ts) that
 *     AppShell legitimately uses for the app canvas — even though shadcn's
 *     `bg-background` inside tabs.tsx had to become `bg-surface`.
 * `bg-background` and `bg-accent` are therefore covered by NEITHER this test nor
 * AC3 (both emit real rules). The retokenizing map in the task file owns them.
 *
 * The scan below reads RAW SOURCE, comments included, and that is deliberate in
 * both directions: Tailwind v4 scans raw source too, so a class name written in
 * a comment is a real utility candidate that emits a real (dead) rule. The
 * component headers therefore describe the colour rewrites by role instead of
 * quoting the upstream class names.
 */
export const SHADCN_CLASS_DENYLIST = [
  'bg-popover',
  'text-popover-foreground',
  'bg-muted',
  'text-muted-foreground',
  'bg-primary',
  'text-primary-foreground',
  'bg-accent-foreground',
  'text-accent-foreground',
  'ring-ring',
  'bg-black/80',
] as const;

describe('no upstream shadcn semantic class survives the retokenizing pass', () => {
  it('the deny-list is not vacuous', () => {
    expect(SHADCN_CLASS_DENYLIST.length).toBeGreaterThan(0);
    for (const entry of SHADCN_CLASS_DENYLIST) {
      expect(entry, `"${entry}" is not shaped like a utility class`).toMatch(
        /^[a-z][a-z0-9]*(-[a-z0-9]+)+(\/\d+)?$/,
      );
    }
  });

  it('no upstream shadcn semantic class appears in any component source', () => {
    for (const { name, text } of sources()) {
      for (const entry of SHADCN_CLASS_DENYLIST) {
        // Whole-token match: `bg-accent` must not be reported for
        // `bg-accent-muted`, and `.border` must not be reported for
        // `.border-border`.
        const re = new RegExp(`(?<![\\w-])${escapeRegExp(entry)}(?![\\w-])`);
        expect(re.test(text), `${name} still carries the shadcn class "${entry}"`).toBe(false);
      }
    }
  });
});

/* ------------------------------------------------------------------ AC3 --- */

/*
 * The escape hatch for non-token structural utilities, as a closed constant. An
 * exemption is then a reviewable one-line diff rather than a regex loosened in
 * place — this list must never become the place a missed retokenizing target
 * gets parked, which is what the two assertions below enforce.
 *
 * It is EMPTY, and that is a measured result rather than an oversight: every
 * class written into the three sources — including `ring-offset-background`,
 * `outline-none`, `min-w-[8rem]`, `h-3.5` and `tracking-widest` — compiles to a
 * real rule against the shipped theme.css. The task's approach expected this
 * list to need entries and asked for a non-empty assertion; nothing needs
 * exempting, so asserting non-emptiness would mean parking a class here that
 * does not need it, which is exactly the failure the constant exists to
 * prevent. The vacuity guard AC3 actually needs is below: the allowlist may not
 * hold dead entries, and the scan must have checked a real number of classes.
 */
export const STRUCTURAL_CLASS_ALLOWLIST: readonly string[] = [];

const COLOUR_RADIUS_SHADOW_OR_TYPE = /^(bg|text|border|ring|fill|stroke|rounded|shadow|font)-/;

/**
 * A class name as it appears in a CSS selector.
 *
 * 5.1a's ruleBody() cannot be reused: it regex-escapes its argument but never
 * CSS-escapes it, so it returns null for every variant-prefixed,
 * arbitrary-value or opacity-modified class — most of shadcn's vocabulary.
 * `_` is deliberately not escaped (Tailwind does not escape it either), and
 * neither in-scope component ships `[&_svg]:`-style arbitrary variants.
 *
 * `(` and `)` are in the set because the map's Tailwind v3 -> v4 rows put
 * parentheses into the class text — `origin-(--radix-…)`,
 * `max-h-(--radix-…)` — and those conversions are exactly what this test has
 * to be able to see.
 */
export function cssEscapeClass(className: string): string {
  return className.replace(/[:/[\]().%=]/g, '\\$&');
}

/**
 * Does the built CSS carry a rule for this class?
 *
 * The trailing (?![\w-]) is load-bearing, not defensive: every class name is a
 * prefix of longer ones, so a plain substring check false-greens on exactly the
 * map's danger rows — `.shadow` is a substring of `.shadow-float` (a bare
 * `shadow` left un-dropped would pass while emitting nothing) and `.border` of
 * `.border-border`.
 */
export function hasRule(css: string, className: string): boolean {
  const selector = escapeRegExp(cssEscapeClass(className));
  // `{` joins ruleBody()'s `}` and `,` in the leading alternation: a rule that
  // is the first one inside an at-rule block (`@media (hover:hover){.hover\:…`)
  // is preceded by `{`, not by `}`. No in-scope class lands there today; it
  // costs nothing and stops that from becoming a silent green later.
  return new RegExp(`(?:^|[{},])[^{}]*\\.${selector}(?![\\w-])[^{}]*\\{`, 'm').test(css);
}

/** The body of a `cn(` / `(` call starting at `openParen`, string-literals skipped. */
function callBody(source: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  throw new Error('unbalanced cn( … ) call — the class-literal extractor needs fixing');
}

/** Every whitespace-separated class token written into a `className` position. */
export function classTokensOf(source: string): Set<string> {
  const tokens = new Set<string>();
  const push = (literal: string): void => {
    for (const token of literal.split(/\s+/)) if (token) tokens.add(token);
  };

  for (const match of source.matchAll(/className\s*=\s*"([^"]*)"/g)) push(match[1] ?? '');

  for (const match of source.matchAll(/className\s*=\s*\{\s*cn\(/g)) {
    const body = callBody(source, match.index + match[0].length - 1);
    for (const literal of body.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      push(literal[1] ?? literal[2] ?? '');
    }
  }
  return tokens;
}

/** Every class token across every source. */
function allClassTokens(): Set<string> {
  return new Set(sources().flatMap(({ text }) => [...classTokensOf(text)]));
}

describe('every class string in the sources resolves to a real rule', () => {
  it('the structural-utility allowlist is closed', () => {
    const all = allClassTokens();
    for (const entry of STRUCTURAL_CLASS_ALLOWLIST) {
      expect(
        entry,
        `"${entry}" is colour-, radius-, shadow- or type-shaped — exempting it ` +
          'would park a missed retokenizing target in the escape hatch.',
      ).not.toMatch(COLOUR_RADIUS_SHADOW_OR_TYPE);
      expect(
        all,
        `"${entry}" is exempted but appears in no source — a dead exemption is ` +
          'how this list grows into a place things get parked.',
      ).toContain(entry);
    }
  });

  it('the class-literal extractor sees the classes that matter', () => {
    const perFile = sources().map(({ name, text }) => ({ name, tokens: classTokensOf(text) }));
    for (const { name, tokens } of perFile) {
      expect(tokens.size, `no class literals extracted from ${name}`).toBeGreaterThan(4);
    }
    // The vacuity guard the allowlist's own emptiness cannot provide: if the
    // extractor regressed to returning almost nothing, the rule scan below would
    // go green while checking nothing. 76 distinct tokens today; half that is
    // still unambiguously "the extractor works".
    expect(new Set(perFile.flatMap(({ tokens }) => [...tokens])).size).toBeGreaterThan(40);
  });

  it('the extractor sees the two class shapes the map most depends on', () => {
    const all = allClassTokens();
    /*
     * A v4 parenthesis-form CSS variable and a variant-prefixed class: the two
     * shapes a naive extractor drops, and the two the retokenizing map most
     * depends on being visible.
     *
     * The max-h pin does double duty, and it is the only thing that does: it is
     * the sole assertion that catches a regression to Tailwind v3's
     * square-bracket syntax. The rule scan above cannot — v4 compiles the
     * bracket form to `max-height:--radix-…` with no var(), invalid CSS the
     * browser drops, but a rule exists, so the scan goes green on broken
     * output. Losing this clamp means a context menu opened near the viewport
     * bottom overflows instead of scrolling. Mutation-verified.
     */
    expect(all).toContain('max-h-(--radix-context-menu-content-available-height)');
    expect(all).toContain('data-[state=active]:bg-surface');
  });

  it('every class literal in the sources has a rule in the built CSS', async () => {
    const css = await builtCss();
    const missing: string[] = [];
    for (const { name, text } of sources()) {
      for (const token of classTokensOf(text)) {
        if (STRUCTURAL_CLASS_ALLOWLIST.includes(token)) continue;
        if (!hasRule(css, token)) missing.push(`${name}: ${token}`);
      }
    }
    expect(
      missing,
      'these classes compile to no CSS at all. Tailwind v4 emits nothing for a ' +
        'class outside the cleared namespaces — it is not an error, it is silence.',
    ).toEqual([]);
  });
});

/* ------------------------------------------- Task 5.2b — the manifest ----- */

/*
 * `session-visuals.ts` holds its class strings in a lookup map, which is the
 * one shape `classTokensOf` is blind to: it reads `className="…"` positions and
 * string literals inside `cn( … )`, and a map value is neither. Tailwind still
 * EMITS those rules — it scans raw source — so the classes work; it is the
 * proof that would go missing, silently, which is the failure mode this whole
 * file exists to catch.
 *
 * So the manifest is scanned as data instead. It lives here rather than in a
 * suite of its own because this assertion needs `builtCss()`, and `build-ui.ts`
 * memoizes that Vite run in module scope: under vitest's per-file isolation a
 * second file asking for it pays for a second full build. Importing `hasRule`
 * from here into a new file is worse still — it re-registers this entire suite
 * there.
 */
const STATUS_KEYS: readonly SessionStatus[] = ['live', 'complete', 'interrupted'];
const CAPTURE_KEYS: readonly CaptureMode[] = ['full', 'transcript_only'];

/** Every class string the manifest can put on screen, flattened. */
function manifestTokens(): string[] {
  const visuals = [
    ...Object.values(SESSION_STATUS_VISUALS).flatMap((v) => [v.badge, v.dot]),
    ...Object.values(CAPTURE_MODE_VISUALS).map((v) => v?.chip ?? ''),
  ];
  return visuals.flatMap((value) => value.split(/\s+/)).filter((token) => token !== '');
}

describe('the session-visuals manifest is exhaustive and every class in it compiles', () => {
  it('covers every status and every capture mode the wire can carry', () => {
    /*
     * `satisfies` catches a MISSING key at compile time; this catches the other
     * direction — a status added to `lib/turn-tree.ts` that nobody taught
     * this manifest about would otherwise render an unstyled badge, and adding
     * it to the union is exactly the change that would not touch this file.
     */
    expect(Object.keys(SESSION_STATUS_VISUALS).sort()).toEqual([...STATUS_KEYS].sort());
    expect(Object.keys(CAPTURE_MODE_VISUALS).sort()).toEqual([...CAPTURE_KEYS].sort());
  });

  it('gives every status a word, so status is never colour alone', () => {
    for (const status of STATUS_KEYS) {
      expect(SESSION_STATUS_VISUALS[status].label, `${status} has no label`).not.toBe('');
    }
  });

  it('the token list is not vacuous', () => {
    const tokens = manifestTokens();
    expect(tokens.length).toBeGreaterThan(6);
    expect(tokens, 'the live pulse is the one class a token rename would break').toContain(
      'animate-live-pulse',
    );
  });

  it('every class in the manifest has a rule in the built CSS', async () => {
    const css = await builtCss();
    const missing = manifestTokens().filter((token) => !hasRule(css, token));
    expect(
      missing,
      'these compile to no CSS at all — an out-of-vocabulary class is silence, ' +
        'not an error, so a badge would simply render unstyled.',
    ).toEqual([]);
  });
});

/* ------------------------------------------- Task 5.3b — the span tree ---- */

/*
 * The same instrument again, over the span tree's own manifest (Test 12b).
 *
 * `span-visuals.ts` is a lookup map for the same reason `session-visuals.ts`
 * is, and `classTokensOf` is blind to both by construction — it reads a
 * `className="…"` position and the string literals inside a `cn( … )` call, and
 * a map value is neither. The exhaustiveness test beside this one checks only
 * the manifest's KEYS, so without this scan a tint that compiles to nothing
 * would ship green with a passing key check above it.
 *
 * It also subsumes the pin on the 8% error wash, which is both the class most
 * likely to be typed wrong and the one whose failure is hardest to notice: an
 * out-of-vocabulary utility is silence rather than an error, so a mistyped wash
 * renders an error row that looks exactly like an ordinary one.
 */
const SPAN_TYPE_KEYS: readonly SpanTypeKey[] = [
  'llm_call',
  'tool_call',
  'thinking',
  'subagent',
  'generic',
];
const SPAN_STATUS_KEYS: readonly EventStatus[] = ['running', 'ok', 'error', 'denied', 'unknown'];

/** Every class string the span-tree manifest can put on screen, flattened. */
function spanManifestTokens(): string[] {
  const values = [
    ...Object.values(SPAN_VISUALS.type).map((v) => v.tint),
    ...Object.values(SPAN_VISUALS.status).flatMap((v) => [v.row, v.tint]),
    SPAN_VISUALS.trace.tint,
    SPAN_VISUALS.triggerBadge,
    SPAN_VISUALS.payloadChip,
    SPAN_VISUALS.errorChip,
  ];
  return values.flatMap((value) => value.split(/\s+/)).filter((token) => token !== '');
}

describe('the span-visuals manifest is exhaustive and every class in it compiles', () => {
  it('covers every span type and every span status the wire can carry', () => {
    expect(Object.keys(SPAN_VISUALS.type).sort()).toEqual([...SPAN_TYPE_KEYS].sort());
    expect(Object.keys(SPAN_VISUALS.status).sort()).toEqual([...SPAN_STATUS_KEYS].sort());
  });

  it('the token list is not vacuous', () => {
    const tokens = spanManifestTokens();
    expect(tokens.length).toBeGreaterThan(12);
    expect(
      tokens,
      'the 8% error wash is the class this scan most exists for: mistyped, it ' +
        'compiles to nothing and an error row renders as an ordinary one.',
    ).toContain('bg-error/8');
  });

  it('every class in the manifest has a rule in the built CSS', async () => {
    const css = await builtCss();
    const missing = spanManifestTokens().filter((token) => !hasRule(css, token));
    expect(
      missing,
      'these compile to no CSS at all. The opacity modifier on a spec colour ' +
        'is the one worth watching — the cleared namespaces do not block it, ' +
        'but a token rename would.',
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ AC4 --- */

/*
 * The animate-in / fade-* / zoom-* / slide-* utilities are NOT Tailwind core —
 * tailwindcss ships only --animate-{spin,ping,pulse,bounce}. They come from
 * `tw-animate-css`, which this task deliberately does not install, so they would
 * emit nothing and fail silently. Floating surfaces use the design system's own
 * 150ms default transition instead (theme.css --default-transition-*).
 *
 * Scanning raw source, not extracted class tokens: strictly stronger, and the
 * component headers are worded to avoid these literals so the scan stays honest.
 */
const ANIMATION_UTILITIES = /(?<![\w-])(?:animate-in|animate-out|fade-|zoom-|slide-)/;

const UI_PACKAGE_JSON = fileURLToPath(new URL('../../../package.json', import.meta.url));

describe('the stripped animation utilities stay stripped', () => {
  it('no animate-in / animate-out / fade-* / zoom-* / slide-* class remains', () => {
    for (const { name, text } of sources()) {
      const hit = ANIMATION_UTILITIES.exec(text);
      expect(hit?.[0], `${name} still carries "${hit?.[0]}", which emits no CSS`).toBeUndefined();
    }
  });

  it('tw-animate-css is not a dependency', () => {
    const pkg = JSON.parse(readFileSync(UI_PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(
      Object.keys(declared),
      'installing tw-animate-css is not a fix for the test above — restoring the ' +
        'classes is a reversal of an approved deviation and needs to be explicit.',
    ).not.toContain('tw-animate-css');
  });
});
