/*
 * The token manifest — the spine of AC1 and AC3.
 *
 * One entry per custom property that `../styles/theme.css` emits, each carrying
 * its citation back to `internal_docs/agent-lens/spec/design-system.md`.
 * `../pages/Showcase.tsx` renders from it; the parity tests assert against it.
 *
 * ===========================================================================
 * `utilityClass` MUST BE A FULL LITERAL STRING.
 * ===========================================================================
 * Write 'bg-span-llm', never `bg-${name}`. Tailwind v4's scanner is a regex over
 * raw source text — a class name assembled at runtime produces no CSS at all,
 * and the failure is silent.
 *
 * ===========================================================================
 * `specValue` CARRIES THE SPEC'S SPELLING. NEVER THE BUILT SPELLING.
 * ===========================================================================
 * `@tailwindcss/vite`'s lightningcss pass respells four of these on the way out
 * (150ms -> .15s, rgb(0 0 0 / 0.5) -> #00000080, cubic-bezier(0.4, ...) ->
 * cubic-bezier(.4, ...), 300ms -> .3s). When the parity test goes red, the
 * tempting fix is to paste the built value in here. Do not.
 *
 * Doing so would go green while severing the parity chain: `prosePin` must be
 * findable in the spec prose AND (for non-colour tokens) be a substring of
 * `specValue`. Break that and the manifest stops transcribing the spec and
 * starts transcribing the compiler, at which point the parity test asserts only
 * that Tailwind agrees with itself — which it always does. If the parity test
 * fails, the bug is in `normalize-css-value.ts` or in `theme.css`.
 *
 * `specLine` is a 1-based line number and therefore shifts whenever a line is
 * inserted above it in design-system.md. The prose-pin test is what catches a
 * stale number: it reds with the line's actual content in the message.
 */

/** The shape of the utility rule Tailwind generates for a token. Verified by
 *  compiling the real `@theme static` block — it is not uniform. */
export type TokenEmitShape =
  /** The rule body contains a bare `var(--token)`. Most tokens. */
  | 'var'
  /** Wrapped in a `--tw-*` fallback: `var(--tw-leading,var(--text-sm--line-height))`. */
  | 'var-fallback'
  /** Tailwind inlines the literal value and never references the variable. */
  | 'inline';

export interface SpecToken {
  /** The emitted custom property, e.g. '--shadow-float'. */
  readonly cssVar: string;
  /** The spec's spelling of the value, verbatim. See the warning above. */
  readonly specValue: string;
  /** 1-based line in design-system.md that states this value. */
  readonly specLine: number;
  /** Exact substring that must still be on `specLine`. */
  readonly prosePin: string;
  /** Expected utility-rule shape. Data, so a wrong guess reds instead of passing. */
  readonly emits: TokenEmitShape;
  /** Full literal utility class, or null where the token has no eponymous utility. */
  readonly utilityClass: string | null;
}

/**
 * Entries whose `prosePin` is deliberately NOT a substring of `specValue`.
 *
 * Only the six type-scale steps qualify: the spec writes the scale as prose
 * ('11 (dense chips/timestamps)') while the token value is '11px'. Keep this
 * list short — growing it decouples pin from value at exactly the point the
 * parity chain is meant to bind them.
 */
export const PROSE_SHAPE_DIFFERS: ReadonlySet<string> = new Set([
  '--text-2xs',
  '--text-xs',
  '--text-sm',
  '--text-base',
  '--text-lg',
  '--text-xl',
]);

/*
 * One line per token, deliberately: this manifest gets read side-by-side with
 * design-system.md, and at printWidth 100 Prettier expands every entry to eight
 * lines, turning 41 scannable rows into 300 lines of noise.
 */
// prettier-ignore
export const SPEC_TOKENS: readonly SpecToken[] = [
  // --- Colour: neutrals (design-system.md css fence) ---
  { cssVar: '--color-background', specValue: '#0b0b0e', specLine: 64, prosePin: '#0b0b0e', emits: 'var', utilityClass: 'bg-background' },
  { cssVar: '--color-surface', specValue: '#131318', specLine: 65, prosePin: '#131318', emits: 'var', utilityClass: 'bg-surface' },
  { cssVar: '--color-surface-raised', specValue: '#1b1b22', specLine: 66, prosePin: '#1b1b22', emits: 'var', utilityClass: 'bg-surface-raised' },
  { cssVar: '--color-border', specValue: '#26262e', specLine: 67, prosePin: '#26262e', emits: 'var', utilityClass: 'bg-border' },
  { cssVar: '--color-foreground', specValue: '#ededf0', specLine: 68, prosePin: '#ededf0', emits: 'var', utilityClass: 'bg-foreground' },
  { cssVar: '--color-muted', specValue: '#9b9ba6', specLine: 69, prosePin: '#9b9ba6', emits: 'var', utilityClass: 'bg-muted' },
  { cssVar: '--color-faint', specValue: '#5c5c66', specLine: 70, prosePin: '#5c5c66', emits: 'var', utilityClass: 'bg-faint' },

  // --- Colour: brand accent ---
  { cssVar: '--color-accent', specValue: '#7c8cf8', specLine: 73, prosePin: '#7c8cf8', emits: 'var', utilityClass: 'bg-accent' },
  { cssVar: '--color-accent-hover', specValue: '#97a3fa', specLine: 74, prosePin: '#97a3fa', emits: 'var', utilityClass: 'bg-accent-hover' },
  // The hex literal is authoritative; the deleted mirror's `rgb(124 140 248 / 0.15)`
  // spelling is not accepted. (0x26 is 14.9%, not the 15% the spec comment says —
  // the hex wins over the comment.)
  { cssVar: '--color-accent-muted', specValue: '#7c8cf826', specLine: 75, prosePin: '#7c8cf826', emits: 'var', utilityClass: 'bg-accent-muted' },

  // --- Colour: span-type palette ---
  { cssVar: '--color-span-turn', specValue: '#2dd4bf', specLine: 78, prosePin: '#2dd4bf', emits: 'var', utilityClass: 'bg-span-turn' },
  { cssVar: '--color-span-llm', specValue: '#c084fc', specLine: 79, prosePin: '#c084fc', emits: 'var', utilityClass: 'bg-span-llm' },
  { cssVar: '--color-span-tool', specValue: '#60a5fa', specLine: 80, prosePin: '#60a5fa', emits: 'var', utilityClass: 'bg-span-tool' },
  { cssVar: '--color-span-subagent', specValue: '#818cf8', specLine: 81, prosePin: '#818cf8', emits: 'var', utilityClass: 'bg-span-subagent' },
  { cssVar: '--color-span-thinking', specValue: '#9b9ba6', specLine: 82, prosePin: '#9b9ba6', emits: 'var', utilityClass: 'bg-span-thinking' },
  { cssVar: '--color-span-generic', specValue: '#a3e635', specLine: 83, prosePin: '#a3e635', emits: 'var', utilityClass: 'bg-span-generic' },

  // --- Colour: semantic status ---
  { cssVar: '--color-success', specValue: '#4ade80', specLine: 86, prosePin: '#4ade80', emits: 'var', utilityClass: 'bg-success' },
  { cssVar: '--color-warning', specValue: '#fbbf24', specLine: 87, prosePin: '#fbbf24', emits: 'var', utilityClass: 'bg-warning' },
  { cssVar: '--color-error', specValue: '#f87171', specLine: 88, prosePin: '#f87171', emits: 'var', utilityClass: 'bg-error' },
  // Byte-identical to --color-accent on purpose. Do not de-duplicate by value.
  { cssVar: '--color-running', specValue: '#7c8cf8', specLine: 89, prosePin: '#7c8cf8', emits: 'var', utilityClass: 'bg-running' },

  // --- Type scale: font sizes (all six pinned to the prose line at :101) ---
  { cssVar: '--text-2xs', specValue: '11px', specLine: 101, prosePin: '11 (dense chips/timestamps)', emits: 'var', utilityClass: 'text-2xs' },
  { cssVar: '--text-xs', specValue: '12px', specLine: 101, prosePin: '12 (tree metadata, table cells)', emits: 'var', utilityClass: 'text-xs' },
  { cssVar: '--text-sm', specValue: '13px', specLine: 101, prosePin: '13 (UI base)', emits: 'var', utilityClass: 'text-sm' },
  { cssVar: '--text-base', specValue: '14px', specLine: 101, prosePin: '14 (reading)', emits: 'var', utilityClass: 'text-base' },
  { cssVar: '--text-lg', specValue: '16px', specLine: 101, prosePin: '16 (pane titles)', emits: 'var', utilityClass: 'text-lg' },
  { cssVar: '--text-xl', specValue: '20px', specLine: 101, prosePin: '20 (page titles)', emits: 'var', utilityClass: 'text-xl' },

  // --- Type scale: per-step line heights (the six-row table at :107-112).
  //     They share the font-size utility class; Tailwind emits them wrapped in a
  //     --tw-leading fallback rather than bare.
  { cssVar: '--text-2xs--line-height', specValue: '1.3', specLine: 107, prosePin: '1.3', emits: 'var-fallback', utilityClass: 'text-2xs' },
  { cssVar: '--text-xs--line-height', specValue: '1.3', specLine: 108, prosePin: '1.3', emits: 'var-fallback', utilityClass: 'text-xs' },
  { cssVar: '--text-sm--line-height', specValue: '1.3', specLine: 109, prosePin: '1.3', emits: 'var-fallback', utilityClass: 'text-sm' },
  { cssVar: '--text-base--line-height', specValue: '1.45', specLine: 110, prosePin: '1.45', emits: 'var-fallback', utilityClass: 'text-base' },
  { cssVar: '--text-lg--line-height', specValue: '1.45', specLine: 111, prosePin: '1.45', emits: 'var-fallback', utilityClass: 'text-lg' },
  { cssVar: '--text-xl--line-height', specValue: '1.3', specLine: 112, prosePin: '1.3', emits: 'var-fallback', utilityClass: 'text-xl' },

  // --- Radius (:120). Pins are the bare sizes, not the longer `rounded-md` (6px)
  //     form: the pin must also be a substring of specValue, and '6px' does not
  //     contain '`rounded-md` (6px)'. Both are still unique on the line.
  { cssVar: '--radius-md', specValue: '6px', specLine: 120, prosePin: '6px', emits: 'var', utilityClass: 'rounded-md' },
  { cssVar: '--radius-lg', specValue: '8px', specLine: 120, prosePin: '8px', emits: 'var', utilityClass: 'rounded-lg' },

  // --- Shadow (:124). The only 'inline' token: Tailwind writes the literal into
  //     --tw-shadow and never references var(--shadow-float).
  { cssVar: '--shadow-float', specValue: '0 8px 24px rgb(0 0 0 / 0.5)', specLine: 124, prosePin: '0 8px 24px rgb(0 0 0 / 0.5)', emits: 'inline', utilityClass: 'shadow-float' },

  // --- Fonts (:96, :97). The spec names the family; the fallback stack is ours.
  //     The family name is the load-bearing part — it is what fonts.css must
  //     declare, and a mismatch is the silent-fallback bug.
  { cssVar: '--font-sans', specValue: "'Inter', ui-sans-serif, system-ui, sans-serif", specLine: 96, prosePin: 'Inter', emits: 'var', utilityClass: 'font-sans' },
  { cssVar: '--font-mono', specValue: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace", specLine: 97, prosePin: 'JetBrains Mono', emits: 'var', utilityClass: 'font-mono' },

  // --- Motion defaults (:128). Neither has an eponymous utility; both surface
  //     inside transition-* wrapped in a --tw-* fallback.
  { cssVar: '--default-transition-duration', specValue: '150ms', specLine: 128, prosePin: '150ms', emits: 'var-fallback', utilityClass: 'transition-colors' },
  { cssVar: '--default-transition-timing-function', specValue: 'cubic-bezier(0.4, 0, 0.2, 1)', specLine: 128, prosePin: 'cubic-bezier(0.4, 0, 0.2, 1)', emits: 'var-fallback', utilityClass: 'transition-colors' },

  // --- Animations (:129). Seconds is the spec's own spelling for the pulse.
  { cssVar: '--animate-live-pulse', specValue: 'live-pulse 1.5s ease-in-out infinite', specLine: 129, prosePin: '1.5s ease-in-out', emits: 'var', utilityClass: 'animate-live-pulse' },
  { cssVar: '--animate-row-arrive', specValue: 'row-arrive 300ms ease-out 1', specLine: 129, prosePin: '300ms', emits: 'var', utilityClass: 'animate-row-arrive' },
];

/** Tokens whose value the spec writes in milliseconds. The parity guard's
 *  "no seconds spelling" rule applies to these two and nothing else —
 *  --animate-live-pulse's spec value legitimately contains '1.5s'. */
export const SPEC_WRITES_MILLISECONDS: readonly string[] = [
  '--default-transition-duration',
  '--animate-row-arrive',
];

export const isColourToken = (t: SpecToken): boolean => t.cssVar.startsWith('--color-');
