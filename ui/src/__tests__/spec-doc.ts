import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DESIGN_SYSTEM_EXCERPT, FIRST_RUN_EXCERPT, INSPECT_SESSION_EXCERPT } from './spec-excerpt';

/**
 * Resolves the spec documents the parity tests read. Two roots, because the spec
 * directory may or may not absorb an `agent-lens/` level; first one holding
 * `design-system.md` wins. With neither on disk the tracked `spec-excerpt.ts`
 * answers instead of skipping or throwing. The candidate list is injectable so a
 * hermetic test can drive a temp root.
 */
const SPEC_ROOT_URLS = [
  '../../../internal_docs/spec/',
  '../../../internal_docs/agent-lens/spec/',
] as const;

/** Every root tried, in order. Exported so a failure message can name them all. */
export const SPEC_ROOT_CANDIDATES: readonly string[] = SPEC_ROOT_URLS.map((relative) =>
  fileURLToPath(new URL(relative, import.meta.url)),
);

const DESIGN_SYSTEM_FILE = 'design-system.md';
const USER_FLOW_SUBDIR = 'user-flows/';

/** Where the excerpt says it came from, when it is the one answering. */
export const EXCERPT_LABEL = 'ui/src/__tests__/spec-excerpt.ts (published excerpt)';

/** First candidate root holding `design-system.md`; `null` means use the excerpt. */
export function resolveSpecRoot(
  candidates: readonly string[] = SPEC_ROOT_CANDIDATES,
): string | null {
  return candidates.find((root) => existsSync(root + DESIGN_SYSTEM_FILE)) ?? null;
}

/** True when the REAL spec is on disk. The drift test gates on this. */
export const designSystemExists = (candidates: readonly string[] = SPEC_ROOT_CANDIDATES): boolean =>
  resolveSpecRoot(candidates) !== null;

/** Which of the two sources answered. Asserted, so neither branch can go dark. */
export type SpecOrigin = 'spec' | 'excerpt';

export interface SpecSource {
  readonly origin: SpecOrigin;
  /** A path when `origin` is 'spec', the module id when 'excerpt'. For messages. */
  readonly label: string;
  /** 1-based line access, so `specLine` in the manifest reads naturally. */
  readonly lines: readonly string[];
}

export function designSystemSource(
  candidates: readonly string[] = SPEC_ROOT_CANDIDATES,
): SpecSource {
  const root = resolveSpecRoot(candidates);
  if (root === null) {
    return { origin: 'excerpt', label: EXCERPT_LABEL, lines: DESIGN_SYSTEM_EXCERPT };
  }
  const path = root + DESIGN_SYSTEM_FILE;
  return { origin: 'spec', label: path, lines: readFileSync(path, 'utf8').split('\n') };
}

/** 1-based line access, so `specLine` in the manifest reads naturally. */
export function designSystemLines(candidates?: readonly string[]): readonly string[] {
  return designSystemSource(candidates).lines;
}

/*
 * The user-flow documents. Pinned by whole text, not by line: a flow document is
 * prose in motion, so a line pin would break on any edit above it. Only the
 * design-system excerpt is index-aligned, because its token tables are positional.
 */

/** Flow documents this repo pins copy against. Extend rather than inline a path. */
export const USER_FLOWS = {
  firstRun: '01-first-run-install.md',
  inspectSession: '03-inspect-session.md',
} as const;

export type UserFlow = keyof typeof USER_FLOWS;

const FLOW_EXCERPTS: Readonly<Record<UserFlow, string>> = {
  firstRun: FIRST_RUN_EXCERPT,
  inspectSession: INSPECT_SESSION_EXCERPT,
};

/**
 * Must never throw: callers evaluate it eagerly to build a failure message, so a
 * throw here surfaces as a stack under an unrelated assertion.
 */
export function userFlowPath(
  name: UserFlow,
  candidates: readonly string[] = SPEC_ROOT_CANDIDATES,
): string {
  const root = resolveSpecRoot(candidates) ?? candidates[candidates.length - 1] ?? '';
  return root + USER_FLOW_SUBDIR + USER_FLOWS[name];
}

export function userFlowSource(
  name: UserFlow,
  candidates: readonly string[] = SPEC_ROOT_CANDIDATES,
): SpecSource {
  const root = resolveSpecRoot(candidates);
  const path = root === null ? null : root + USER_FLOW_SUBDIR + USER_FLOWS[name];
  if (path === null || !existsSync(path)) {
    return {
      origin: 'excerpt',
      label: EXCERPT_LABEL,
      lines: FLOW_EXCERPTS[name].split('\n'),
    };
  }
  return { origin: 'spec', label: path, lines: readFileSync(path, 'utf8').split('\n') };
}

export function userFlowText(name: UserFlow, candidates?: readonly string[]): string {
  return userFlowSource(name, candidates).lines.join('\n');
}

/**
 * Parses the fenced ```css block of colour tokens, keyed by Tailwind namespace:
 * `--background` in the doc becomes `--color-background` in the build. `label`
 * names the source in failures, since the lines may come from either source.
 */
export function parseColourFence(
  lines: readonly string[],
  label = 'the design-system source',
): Map<string, string> {
  const open = lines.findIndex((l) => l.trim() === '```css');
  if (open === -1) throw new Error(`no \`\`\`css fence in ${label}`);
  const close = lines.findIndex((l, i) => i > open && l.trim() === '```');
  if (close === -1) throw new Error(`unterminated \`\`\`css fence in ${label}`);

  const tokens = new Map<string, string>();
  for (const raw of lines.slice(open + 1, close)) {
    const line = raw.replace(/\/\*.*?\*\//g, '').trim();
    const match = /^--([\w-]+)\s*:\s*([^;]+);?$/.exec(line);
    if (match?.[1] && match[2]) tokens.set(`--color-${match[1]}`, match[2].trim().toLowerCase());
  }
  if (tokens.size === 0) throw new Error(`parsed zero colour tokens from ${label}`);
  return tokens;
}
