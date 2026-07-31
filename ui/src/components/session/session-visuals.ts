/*
 * The session row's colour vocabulary, as one exported manifest (Task 5.2b).
 *
 * ===========================================================================
 * WHY A MANIFEST AND NOT INLINE CLASSES.
 * ===========================================================================
 * A status-to-classes lookup is the natural way to write this, and it is also
 * invisible to the instrument that proves classes compile: `retokenized.test.ts`
 * extracts only what it finds in a `className="…"` position or as a string
 * literal inside a `cn( … )` call. Class strings held in a map are extracted as
 * nothing — Tailwind still emits them, because it scans raw source, but the TEST
 * would prove nothing while looking as though it proved something.
 *
 * So this file stays OUT of that suite's source array (it would extract zero
 * tokens and red the per-file richness bar), and the suite instead iterates this
 * manifest's own values through `hasRule`. Same instrument, honest coverage.
 * `spec-tokens.ts` established the pattern; `span-visuals.ts` follows it next.
 *
 * ===========================================================================
 * EVERY VALUE IS A FULL LITERAL.
 * ===========================================================================
 * Never assemble one from parts. Tailwind's scanner is a regex over raw source,
 * so a name built at runtime emits no rule at all — silently, since an unknown
 * utility is not an error.
 */

import type { CaptureMode, SessionStatus } from '@shared/entities.ts';

export interface StatusVisual {
  /** The badge's own text colour. */
  badge: string;
  /** The leading dot. The live one carries the pulse the theme already ships. */
  dot: string;
  /**
   * The word rendered beside the dot. Never omit it: `design-system.md`'s
   * accessibility baseline says status is never conveyed by colour alone, and
   * "live gets pulse + 'live' text" is the example it gives.
   */
  label: string;
}

export const SESSION_STATUS_VISUALS = {
  live: { badge: 'text-running', dot: 'bg-running animate-live-pulse', label: 'live' },
  complete: { badge: 'text-muted', dot: 'bg-success', label: 'complete' },
  interrupted: { badge: 'text-warning', dot: 'bg-warning', label: 'interrupted' },
} satisfies Record<SessionStatus, StatusVisual>;

export interface CaptureVisual {
  chip: string;
  label: string;
}

/**
 * `full` is the undegraded case and draws nothing — a chip on every row would
 * make the one row that matters harder to find, not easier. `null` says that
 * out loud, so an exhaustive check over `CaptureMode` still covers it.
 */
export const CAPTURE_MODE_VISUALS = {
  full: null,
  transcript_only: {
    chip: 'rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-warning',
    label: 'transcript only',
  },
} satisfies Record<CaptureMode, CaptureVisual | null>;
