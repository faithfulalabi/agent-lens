/*
 * Canonicalizes a CSS value so the *spec's* spelling and the *built* spelling
 * of the same value compare equal.
 *
 * Why this exists: `@tailwindcss/vite` runs its own lightningcss `optimize()`
 * pass over the generated CSS. It is not Vite's minifier — it reproduces with
 * `build.minify: false`, so there is no escape hatch. Four of our token values
 * come out respelled:
 *
 *   --shadow-float                        0 8px 24px rgb(0 0 0 / 0.5) -> ... #00000080
 *   --default-transition-duration         150ms                       -> .15s
 *   --default-transition-timing-function  cubic-bezier(0.4, 0, 0.2, 1) -> cubic-bezier(.4, 0, .2, 1)
 *   --animate-row-arrive                  row-arrive 300ms ease-out 1  -> row-arrive .3s ease-out 1
 *
 * All 20 colour tokens round-trip byte-identical, so the colour parity test
 * compares them literally and never calls this.
 *
 * This is the main failure surface of the parity test: too aggressive and it
 * hides real drift, too narrow and a correct build goes red. Every rule below
 * is pinned by both an equal-case and an unequal-case in its unit test.
 *
 * CANONICALIZATION IS FUNCTION-AWARE AND OPERATES IN PLACE. Do not "simplify"
 * this by splitting on whitespace or commas first — that would shred
 * `rgb(0 0 0 / 0.5)` (whitespace-separated) and `cubic-bezier(.4, 0, .2, 1)`
 * (comma-separated) before the rules that target them could match.
 */

/** Rule 2 helper: 0-1 alpha to a 2-digit hex byte, rounding at .5 the way
 *  lightningcss does. `Math.floor` yields #0000007f and reds a correct build. */
function alphaToHex(alpha: number): string {
  return Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
}

function channelToHex(channel: number): string {
  return Math.round(channel).toString(16).padStart(2, '0');
}

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` -> lowercase `#rrggbbaa`. */
function expandHex(hex: string): string {
  const digits = hex.slice(1).toLowerCase();
  const expanded =
    digits.length <= 4
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;
  return `#${expanded.length === 6 ? `${expanded}ff` : expanded}`;
}

export function normalizeCssValue(value: string): string {
  let out = value;

  // Rule 1 — time units. `<n>s` -> `<n x 1000>ms`; `ms` is inherently untouched
  // because the character before the `s` is `m`, not a digit.
  out = out.replace(/(?<![\w.])(\d*\.?\d+)s(?![\w%])/g, (_m, seconds: string) => {
    // 0.15 * 1000 === 150.00000000000003 in IEEE 754 — round through micros.
    const ms = Math.round(parseFloat(seconds) * 1e6) / 1e3;
    return `${ms}ms`;
  });

  // Rule 2 — colour spellings. rgb()/rgba(), space- or comma-separated, with or
  // without alpha, plus 3/4/6/8-digit hex, all become lowercase 8-digit hex.
  out = out.replace(
    /\brgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+))?\s*\)/gi,
    (_m, r: string, g: string, b: string, a: string | undefined) => {
      const alpha = a === undefined ? 1 : parseFloat(a);
      return `#${channelToHex(parseFloat(r))}${channelToHex(parseFloat(g))}${channelToHex(parseFloat(b))}${alphaToHex(alpha)}`;
    },
  );
  out = out.replace(/#([0-9a-f]{3,8})\b/gi, (m) =>
    [3, 4, 6, 8].includes(m.length - 1) ? expandHex(m) : m,
  );

  // Rule 3 — bare decimals: restore a leading zero, strip trailing zeros.
  // Only tokens containing a `.` are touched, which is what keeps integers and
  // the hex produced by rule 2 out of scope.
  out = out.replace(/(?<![\w#.-])(\d*\.\d+)/g, (m) => String(parseFloat(m)));

  // Rule 4 — quote style. The repo's Prettier config sets `singleQuote: true`,
  // which applies to CSS, so theme.css reads `'Inter'`; CSS serializes it back
  // out as `"Inter"`. Only the delimiter is canonicalized, so `"Inter"` vs
  // `"Arial"` is still a difference.
  out = out.replace(/'([^']*)'/g, '"$1"');

  // Rule 5 — whitespace last, once the rules that depend on it have run.
  out = out
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}
