import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DESIGN_SYSTEM_EXCERPT, FIRST_RUN_EXCERPT, INSPECT_SESSION_EXCERPT } from './spec-excerpt';

/**
 * `spec/design-system.md` is the source of truth for every design token, and
 * `spec/user-flows/` for the empty-state copy. The parity tests read them
 * directly, so resolution is pinned here once rather than being allowed to fail
 * by silently parsing nothing.
 *
 * TWO THINGS ARE RESOLVED HERE, AND BOTH WERE BUGS.
 *
 * 1. THE ROOT IS A PROPERTY OF THE ENVIRONMENT, NOT OF THE REPO. On the founder's
 *    machine `internal_docs` is a symlink to a directory that already absorbs the
 *    `agent-lens/` level, so the spec sits at `internal_docs/spec/`. CI's tar
 *    recreated the deeper `internal_docs/agent-lens/spec/` layout. A single pinned
 *    path could only ever be right in one of the two, so the candidates are an
 *    ordered list and the first whose `design-system.md` exists wins.
 *
 * 2. WHEN NO ROOT EXISTS AT ALL, THE EXCERPT WINS — NOT A SKIP, NOT A THROW.
 *    `internal_docs/` is git-ignored by design, so a fork PR and a fresh clone
 *    have no spec. They used to have no path to green either. `spec-excerpt.ts`
 *    carries the published lines, so the parity tests assert the same copy in
 *    every environment. The real spec still takes precedence whenever it is on
 *    disk, which is what keeps it authoritative and makes the excerpt's own drift
 *    detectable (`spec-excerpt.test.ts`).
 *
 * The candidate list is injectable so a hermetic test can drive a `mkdtempSync`
 * root without touching the founder's symlink.
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

/**
 * The first candidate root holding `design-system.md`, or `null` when none does.
 * `null` is the fork/fresh-clone case and is answered by the excerpt, not an error.
 */
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
 * The user-flow documents, added by Task 5.2b.
 *
 * Until 5.2b nothing in any suite read them, and the empty-state ruling made
 * that a gap rather than an omission: the binding spelling of the never-captured
 * sentence lives in `01-first-run-install.md`, and the `agent-lens doctor` hint
 * beside it lives in `03-inspect-session.md`.
 *
 * Whole-text rather than by line: a flow document is prose in motion, and a line
 * pin on it would break on any edit above the line. The token manifest's
 * `specLine` pins stay line-based because design-system.md's token tables are
 * genuinely positional — which is also why only the design-system excerpt is
 * index-aligned and these two are plain strings.
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
 * Never throws, even with no spec on disk: `session-list.test.tsx` evaluates this
 * EAGERLY to build a failure message, so a throw here would surface as a stack
 * under an unrelated assertion.
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
 * The one machine-readable part of the spec: the fenced ```css block holding the
 * 20 colour tokens. Returns them keyed by their Tailwind namespace name, i.e.
 * `--background` in the doc becomes `--color-background` in the build.
 *
 * `label` names the source in the failure message, because the lines may have
 * come from either the real spec or the excerpt and a wrong path in the message
 * sends the reader to the wrong file.
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
