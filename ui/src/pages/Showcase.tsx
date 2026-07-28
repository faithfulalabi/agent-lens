import type { ReactNode } from 'react';
import { SPEC_TOKENS, type SpecToken } from '../design/spec-tokens';

/*
 * The token showcase — the visual smoke surface for the design system, and the
 * reference every later UI task copies class names from.
 *
 * It renders straight off ../design/spec-tokens.ts, so a token that exists in
 * CSS but appears nowhere on this page is a test failure, not an oversight.
 *
 * Deliberately standalone: no `cn()`, no `@/*` alias, no shadcn component, no
 * AppShell. It is a top-level element, and the dark canvas, base font and focus
 * ring all come from `@layer base` in globals.css rather than any React chrome.
 */

const isLineHeight = (t: SpecToken) => t.cssVar.endsWith('--line-height');

const colours = SPEC_TOKENS.filter((t) => t.cssVar.startsWith('--color-'));
const typeSteps = SPEC_TOKENS.filter((t) => t.cssVar.startsWith('--text-') && !isLineHeight(t));
const lineHeightOf = (cssVar: string) =>
  SPEC_TOKENS.find((t) => t.cssVar === `${cssVar}--line-height`)?.specValue ?? '';
const radii = SPEC_TOKENS.filter((t) => t.cssVar.startsWith('--radius-'));

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="border-b border-border py-8">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-xs text-faint">{note}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Token name + spec value, in mono — the caption under every specimen. */
function Caption({ token }: { token: SpecToken }) {
  return (
    <div className="mt-2">
      <div className="font-mono text-2xs text-muted">{token.cssVar}</div>
      <div className="font-mono text-2xs text-faint">{token.specValue}</div>
      {token.utilityClass !== null && (
        <div className="font-mono text-2xs text-accent">.{token.utilityClass}</div>
      )}
    </div>
  );
}

export function Showcase() {
  return (
    <main className="mx-auto max-w-5xl px-8 py-12">
      <header>
        <h1 className="text-xl font-semibold text-foreground">agent-lens design tokens</h1>
        <p className="mt-2 text-sm text-muted">
          Every token in <span className="font-mono text-2xs">spec/design-system.md</span>, rendered
          through the utility class that emits it. This page is the reference — copy class names
          from here, and if a colour or size you want is missing, it is missing on purpose.
        </p>
      </header>

      <Section
        title="Color"
        note="Neutrals carry the layout, span-type colors carry meaning, the accent only marks interactivity. Tailwind's default palette is cleared — bg-red-500 does not exist."
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {colours.map((token) => (
            <div key={token.cssVar}>
              <div
                className={`h-16 rounded-md border border-border ${token.utilityClass ?? ''}`}
                aria-hidden="true"
              />
              <Caption token={token} />
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Type scale"
        note="Six steps, 11px to 20px, each with its own line-height. Nothing larger exists — text-3xl does not compile."
      >
        <div className="space-y-5">
          {typeSteps.map((token) => (
            <div key={token.cssVar} className="flex items-baseline gap-6">
              <span className="w-28 shrink-0 font-mono text-2xs text-faint">
                {token.specValue} / {lineHeightOf(token.cssVar)}
              </span>
              <div>
                <p className={token.utilityClass ?? ''}>
                  Inspect everything your agent did in a session.
                </p>
                <div className="font-mono text-2xs text-accent">.{token.utilityClass}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Font families"
        note="Both self-hosted and bundled. Mono is ~40% of rendered text in this product — a first-class citizen, not an accent."
      >
        <div className="space-y-5">
          <div>
            <p className="font-sans text-base text-foreground">
              Inter — the quick brown fox jumps over the lazy dog 0123456789
            </p>
            <div className="font-mono text-2xs text-accent">.font-sans</div>
          </div>
          <div>
            <p className="font-mono text-base text-foreground">
              JetBrains Mono — 1.02s · 185 tok · &lt;$0.001 · sess_01J8XZ
            </p>
            <div className="font-mono text-2xs text-accent">.font-mono</div>
          </div>
        </div>
      </Section>

      <Section title="Radius" note="rounded-md everywhere; rounded-lg for floating surfaces only.">
        <div className="flex gap-8">
          {radii.map((token) => (
            <div key={token.cssVar}>
              <div
                className={`h-20 w-20 bg-surface-raised border border-border ${token.utilityClass ?? ''}`}
                aria-hidden="true"
              />
              <Caption token={token} />
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Shadow"
        note="One level, floating surfaces only. In-flow surfaces separate with borders, never shadows."
      >
        <div className="w-72 rounded-lg bg-surface-raised p-4 shadow-float">
          <p className="text-sm text-foreground">Floating surface</p>
          <p className="mt-1 text-xs text-muted">Modals, popovers, context menus.</p>
        </div>
        <div className="font-mono text-2xs text-accent mt-2">.shadow-float</div>
      </Section>

      <Section
        title="Motion"
        note="150ms default. The running pulse loops; row arrival washes once. Both stop under prefers-reduced-motion."
      >
        <div className="flex flex-wrap items-center gap-8">
          <div>
            <span className="inline-flex items-center gap-2 rounded-md bg-surface-raised px-2 py-1">
              <span
                className="h-2 w-2 rounded-full bg-running animate-live-pulse"
                aria-hidden="true"
              />
              <span className="font-mono text-2xs text-muted">live</span>
            </span>
            <div className="font-mono text-2xs text-accent mt-2">.animate-live-pulse</div>
          </div>

          <div>
            <div className="rounded-md px-3 py-1.5 animate-row-arrive">
              <span className="font-mono text-2xs text-muted">new row arrived</span>
            </div>
            <div className="font-mono text-2xs text-accent mt-2">.animate-row-arrive</div>
          </div>

          <div>
            <button
              type="button"
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-surface-raised"
            >
              Hover me
            </button>
            <div className="font-mono text-2xs text-accent mt-2">.transition-colors</div>
          </div>
        </div>
      </Section>

      <Section
        title="Span-type vocabulary"
        note="How the span palette reads in situ — the atom every tree row and thread card is built from."
      >
        <div className="rounded-md border border-border bg-surface">
          {[
            { label: 'turn', dot: 'bg-span-turn', name: 'user turn' },
            { label: 'llm', dot: 'bg-span-llm', name: 'claude-opus-4 completion' },
            { label: 'tool', dot: 'bg-span-tool', name: 'Read(src/server/app.ts)' },
            { label: 'subagent', dot: 'bg-span-subagent', name: 'Explore subagent' },
            { label: 'thinking', dot: 'bg-span-thinking', name: 'thinking' },
            { label: 'generic', dot: 'bg-span-generic', name: 'foreign span' },
          ].map((row) => (
            <div
              key={row.label}
              className="flex items-center gap-3 border-b border-border px-3 py-1.5 last:border-b-0"
            >
              <span className={`h-2 w-2 rounded-full ${row.dot}`} aria-hidden="true" />
              <span className="text-xs text-foreground">{row.name}</span>
              <span className="ml-auto font-mono text-2xs text-muted">
                1.02s · 185 tok · $0.004
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Status"
        note="Status is never conveyed by color alone — every one of these pairs with an icon or a word in the real UI."
      >
        <div className="flex flex-wrap gap-3">
          {[
            { cls: 'text-success', label: 'complete' },
            { cls: 'text-warning', label: 'degraded' },
            { cls: 'text-error', label: 'failed' },
            { cls: 'text-running', label: 'running' },
          ].map((s) => (
            <span
              key={s.label}
              className={`rounded-md bg-surface-raised px-2 py-1 font-mono text-2xs ${s.cls}`}
            >
              {s.label}
            </span>
          ))}
        </div>
      </Section>
    </main>
  );
}
