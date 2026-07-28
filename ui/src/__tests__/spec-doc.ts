import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `internal_docs/agent-lens/spec/design-system.md` is the source of truth for
 * every design token. The parity tests read it directly, so the path is pinned
 * here once and asserted (test: "the spec file is where the parity test thinks
 * it is") rather than being allowed to fail by silently parsing nothing.
 */
export const DESIGN_SYSTEM_PATH = fileURLToPath(
  new URL('../../../internal_docs/agent-lens/spec/design-system.md', import.meta.url),
);

export const designSystemExists = (): boolean => existsSync(DESIGN_SYSTEM_PATH);

/** 1-based line access, so `specLine` in the manifest reads naturally. */
export function designSystemLines(): string[] {
  return readFileSync(DESIGN_SYSTEM_PATH, 'utf8').split('\n');
}

/**
 * The one machine-readable part of the spec: the fenced ```css block holding the
 * 20 colour tokens. Returns them keyed by their Tailwind namespace name, i.e.
 * `--background` in the doc becomes `--color-background` in the build.
 */
export function parseColourFence(lines: string[]): Map<string, string> {
  const open = lines.findIndex((l) => l.trim() === '```css');
  if (open === -1) throw new Error(`no \`\`\`css fence in ${DESIGN_SYSTEM_PATH}`);
  const close = lines.findIndex((l, i) => i > open && l.trim() === '```');
  if (close === -1) throw new Error(`unterminated \`\`\`css fence in ${DESIGN_SYSTEM_PATH}`);

  const tokens = new Map<string, string>();
  for (const raw of lines.slice(open + 1, close)) {
    const line = raw.replace(/\/\*.*?\*\//g, '').trim();
    const match = /^--([\w-]+)\s*:\s*([^;]+);?$/.exec(line);
    if (match?.[1] && match[2]) tokens.set(`--color-${match[1]}`, match[2].trim().toLowerCase());
  }
  if (tokens.size === 0) throw new Error(`parsed zero colour tokens from ${DESIGN_SYSTEM_PATH}`);
  return tokens;
}
