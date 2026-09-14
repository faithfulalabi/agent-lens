import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUi, builtCss, builtHtml, builtBundleText, cleanupBuilds } from './build-ui';
import { SPEC_TOKENS } from '../design/spec-tokens';

afterAll(cleanupBuilds);

/*
 * AC2 — no external network requests in the built bundle.
 *
 * "Zero egress" is a product guarantee, not a preference: `npx agent-lens` must
 * serve collector + UI from one process with nothing reaching the network.
 *
 * A blanket "no http(s):// in dist" grep fails on day one — React's production
 * error decoder, five W3C namespace URIs and Tailwind's own legal banner are all
 * in there and none of them can cause a request. Hence the two-tier scan below:
 * anything *fetchable* is forbidden outright, and every remaining literal has to
 * be on a justified allowlist.
 */

const FONTS_DIR = fileURLToPath(new URL('../assets/fonts', import.meta.url));

/**
 * String literals that look like URLs but cannot produce a request. Every entry
 * needs a reason, and every entry must actually be found in the bundle — a stale
 * exemption reds rather than quietly widening the net.
 */
const KNOWN_INERT_URLS: readonly { url: string; why: string }[] = [
  {
    url: 'https://github.com/remarkjs/react-markdown/blob/main/changelog.md',
    why: 'react-markdown uses this only in thrown configuration-error messages; never fetched',
  },
  {
    url: 'https://github.com/syntax-tree/hast-util-to-jsx-runtime',
    why: 'hast-util-to-jsx-runtime attaches this documentation URL to conversion errors; never fetched',
  },
  { url: 'http://www.w3.org/1999/xhtml', why: 'XML namespace identifier; never dereferenced' },
  { url: 'http://www.w3.org/2000/svg', why: 'SVG namespace identifier; never dereferenced' },
  { url: 'http://www.w3.org/1999/xlink', why: 'XLink namespace identifier; never dereferenced' },
  {
    url: 'http://www.w3.org/XML/1998/namespace',
    why: 'reserved xml: namespace identifier; never dereferenced',
  },
  {
    url: 'http://www.w3.org/1998/Math/MathML',
    why: 'MathML namespace identifier; never dereferenced',
  },
  {
    url: 'https://reactjs.org/docs/error-decoder.html?invariant=',
    why: "React 18 production error decoder — a string in a thrown Error's message; the app never fetches it",
  },
  {
    url: 'https://tailwindcss.com',
    why: "Tailwind's /*! legal banner, preserved by esbuild; a CSS comment cannot request anything",
  },
];

/** Same-origin means: no scheme, and no protocol-relative `//` prefix. */
function isSameOriginRef(ref: string): boolean {
  const value = ref.trim().replace(/^['"]|['"]$/g, '');
  if (value === '') return false;
  if (value.startsWith('data:')) return true; // handled separately by the font test
  if (value.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

describe('the built bundle makes no external network requests', () => {
  it('no fetchable off-origin reference in any emitted HTML', async () => {
    const html = await builtHtml();

    for (const tag of html.matchAll(/<(link|script|img|source)\b([^>]*)>/gi)) {
      const attrs = tag[2] ?? '';
      const ref = /\b(?:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs)?.[1];
      if (ref === undefined) continue;
      expect(isSameOriginRef(ref), `off-origin <${tag[1]}> reference: ${ref}`).toBe(true);
    }

    // Preconnect/dns-prefetch to a third party is egress even with no asset behind it.
    for (const link of html.matchAll(/<link\b([^>]*)>/gi)) {
      const attrs = link[1] ?? '';
      if (!/rel\s*=\s*["']?(preconnect|dns-prefetch|stylesheet|preload)/i.test(attrs)) continue;
      const ref = /\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs)?.[1] ?? '';
      expect(isSameOriginRef(ref), `off-origin <link rel=...>: ${attrs}`).toBe(true);
    }

    expect(html, 'a meta refresh can navigate off-origin').not.toMatch(
      /<meta[^>]+http-equiv\s*=\s*["']?refresh/i,
    );
  });

  it('no @import url( and no off-origin url() in any emitted CSS', async () => {
    const css = await builtCss();

    // A Google Fonts stylesheet would arrive exactly this way.
    expect((css.match(/@import\s+url\(/g) ?? []).length).toBe(0);

    for (const url of css.matchAll(/url\(([^)]*)\)/g)) {
      const ref = url[1] ?? '';
      // Vite emits root-absolute asset URLs by default (/assets/x-hash.woff2),
      // so the rule is same-origin, not "must be relative".
      expect(isSameOriginRef(ref), `off-origin url() in built CSS: ${ref}`).toBe(true);
    }
  });

  it('every http(s):// literal in the bundle is on the justified allowlist', async () => {
    const bundle = await builtBundleText();
    const found = new Set(
      [...bundle.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)].map((m) => m[0].replace(/[.,;]+$/, '')),
    );
    const allowed = new Set(KNOWN_INERT_URLS.map((e) => e.url));

    const unexpected = [...found].filter((u) => !allowed.has(u)).sort();
    expect(
      unexpected,
      'new URL literal(s) in the bundle. If genuinely inert, add to KNOWN_INERT_URLS with a reason.',
    ).toEqual([]);

    // The reverse direction: an exemption nothing needs is an exemption that has
    // stopped being reviewed.
    const stale = [...allowed].filter((u) => !found.has(u)).sort();
    expect(stale, 'allowlist entries no longer present in the bundle — delete them').toEqual([]);
  });

  it('fonts are bundled as real .woff2 files, not inlined and not fallen back', async () => {
    const dir = await buildUi();
    const emitted = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((n) =>
      n.endsWith('.woff2'),
    );

    expect(emitted.length, 'expected both families bundled').toBeGreaterThanOrEqual(2);
    for (const name of emitted) {
      expect(statSync(join(dir, name)).size, `${name} is suspiciously small`).toBeGreaterThan(1024);
    }

    const css = await builtCss();
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    expect(faces.length, 'no @font-face rules survived the build').toBeGreaterThan(0);

    const basenames = new Set(emitted.map((n) => n.split('/').pop() ?? n));
    const referenced = new Set<string>();
    for (const face of faces) {
      const src = /src\s*:\s*([^;]+)/.exec(face)?.[1] ?? '';
      // Base64 inlining would defeat the file check above and quietly bloat the CSS.
      expect(src, 'a @font-face src is base64-inlined').not.toMatch(/url\(\s*["']?data:/);

      const refs = [...src.matchAll(/url\(([^)]*)\)/g)].map((m) =>
        (m[1] ?? '').trim().replace(/^['"]|['"]$/g, ''),
      );
      expect(refs.length, `@font-face with no src url(): ${face}`).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(isSameOriginRef(ref), `off-origin @font-face src: ${ref}`).toBe(true);
        const base = ref.split('/').pop() ?? '';
        expect(basenames, `@font-face points at ${ref}, which the build did not emit`).toContain(
          base,
        );
        referenced.add(base);
      }
    }

    // An orphan means a subset was vendored and then never wired up.
    expect([...basenames].filter((b) => !referenced.has(b)).sort()).toEqual([]);
  });

  it('@font-face families equal the first family of --font-sans / --font-mono', async () => {
    // The ONLY automated defence against a silent fallback. Vendored fonts can be
    // bundled, referenced and still never used if the declared family name does
    // not match what --font-sans asks for — which is exactly the trap
    // `@fontsource-variable/inter` sets by declaring itself as 'Inter Variable'.
    const css = await builtCss();
    const declared = new Set(
      [...css.matchAll(/@font-face\s*\{[^}]*?font-family\s*:\s*([^;}]+)/g)].map((m) =>
        (m[1] ?? '').trim().replace(/^['"]|['"]$/g, ''),
      ),
    );

    const firstFamily = (cssVar: string): string => {
      const token = SPEC_TOKENS.find((t) => t.cssVar === cssVar);
      if (!token) throw new Error(`${cssVar} missing from the token manifest`);
      return (token.specValue.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '');
    };

    expect(declared, 'no @font-face declares the family --font-sans asks for').toContain(
      firstFamily('--font-sans'),
    );
    expect(declared, 'no @font-face declares the family --font-mono asks for').toContain(
      firstFamily('--font-mono'),
    );
    expect([...declared].sort()).toEqual(['Inter', 'JetBrains Mono']);
  });

  it('the OFL licence files ship beside the fonts', () => {
    // Redistribution requirement — both families are SIL OFL 1.1.
    for (const name of ['LICENSE-Inter.txt', 'LICENSE-JetBrainsMono.txt']) {
      const path = join(FONTS_DIR, name);
      expect(statSync(path).size, `${name} is empty`).toBeGreaterThan(0);
      expect(readFileSync(path, 'utf8')).toContain('SIL OPEN FONT LICENSE');
    }
  });
});
