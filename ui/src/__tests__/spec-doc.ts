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

/*
 * The user-flow documents, added by Task 5.2b.
 *
 * Until 5.2b nothing in any suite read them, and the empty-state ruling made
 * that a gap rather than an omission: the binding spelling of the never-captured
 * sentence lives in `01-first-run-install.md`, and the `agent-lens doctor` hint
 * beside it lives in `03-inspect-session.md`. Copy pinned against the document
 * that specifies it is the same instrument `spec-tokens.ts` uses for colours —
 * the alternative is a bare literal in the component that drifts silently.
 *
 * Whole-text rather than by line: a flow document is prose in motion, and a line
 * pin on it would break on any edit above the line. The token manifest's
 * `specLine` pins stay line-based because design-system.md's token tables are
 * genuinely positional.
 */
const USER_FLOW_DIR = new URL(
  '../../../internal_docs/agent-lens/spec/user-flows/',
  import.meta.url,
);

/** Flow documents this repo pins copy against. Extend rather than inline a path. */
export const USER_FLOWS = {
  firstRun: '01-first-run-install.md',
  inspectSession: '03-inspect-session.md',
} as const;

export function userFlowPath(name: keyof typeof USER_FLOWS): string {
  return fileURLToPath(new URL(USER_FLOWS[name], USER_FLOW_DIR));
}

export function userFlowText(name: keyof typeof USER_FLOWS): string {
  return readFileSync(userFlowPath(name), 'utf8');
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
