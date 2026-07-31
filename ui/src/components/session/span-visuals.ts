/*
 * The span tree's colour and glyph vocabulary, as one exported manifest
 * (Task 5.3b). The sibling of `session-visuals.ts`, built the same way and for
 * the same reasons.
 *
 * ===========================================================================
 * WHY A MANIFEST AND NOT INLINE CLASSES.
 * ===========================================================================
 * A type-to-classes lookup is the natural way to write this and it is also
 * invisible to the instrument that proves classes compile:
 * `retokenized.test.ts` extracts only what it finds in a `className="…"`
 * position or as a string literal inside a `cn( … )` call, and a map value is
 * neither. Tailwind still EMITS these rules — it scans raw source — so the
 * classes work; it is the PROOF that would go missing, silently.
 *
 * So this file stays OUT of that suite's source array (it would extract zero
 * tokens and red the per-file richness bar) and the suite iterates this
 * manifest's own values through `hasRule` instead. Same instrument, honest
 * coverage.
 *
 * ===========================================================================
 * EVERY CLASS IS A FULL LITERAL. NEVER ASSEMBLE ONE FROM PARTS.
 * ===========================================================================
 * Tailwind's scanner is a regex over raw source, so a name built at runtime
 * emits no rule at all — silently, because an unknown utility is not an error.
 *
 * ===========================================================================
 * NOTHING HERE IS COLOUR ALONE.
 * ===========================================================================
 * `design-system.md`'s accessibility baseline states it outright: status is
 * never conveyed by colour alone, and error rows get an icon AND a row tint.
 * Every status entry below therefore carries a glyph and a word as well as a
 * class, and the word is the half that survives both a token rename and a
 * reader who cannot tell the two reds apart.
 */

import {
  Ban,
  Bot,
  Box,
  Brain,
  CircleCheck,
  CircleX,
  Loader,
  MessageSquare,
  Minus,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { SpanStatus, SpanType } from '@shared/entities.ts';

export interface SpanTypeVisual {
  /** The icon's tint, straight off the spec's span-type palette. */
  readonly tint: string;
  /** The glyph itself. */
  readonly Icon: LucideIcon;
  /** The word this kind of work is called, for the row's accessible name. */
  readonly label: string;
}

export interface SpanStatusVisual {
  /**
   * The whole row's wash. Empty for the statuses that need none — a tint on
   * every row would make the rows that matter harder to find, not easier.
   */
  readonly row: string;
  /** The status glyph's own tint. */
  readonly tint: string;
  readonly Icon: LucideIcon;
  /** Never empty. This is the non-colour half the baseline requires. */
  readonly label: string;
}

export interface SpanVisualManifest {
  readonly type: Record<SpanType, SpanTypeVisual>;
  readonly status: Record<SpanStatus, SpanStatusVisual>;
  /** The turn header's own icon, which is not a `SpanType`. */
  readonly trace: SpanTypeVisual;
  /**
   * The neutral badge a turn with a non-prompt trigger carries. Informational
   * rather than degraded, so it is the metric-chip atom's muted spelling.
   */
  readonly triggerBadge: string;
  /** The warning-toned chip naming a degradation tag on a span. */
  readonly degradedChip: string;
  /**
   * The error count beside a header's chips.
   *
   * A local chip rather than a fourth `MetricChip` slot, decided 2026-07-31:
   * `design-system.md`'s span-tree row is specced as exactly three chips
   * (duration, tokens, cost), the session list already renders its own error
   * count the same way, and widening the shared atom would edit a merged file
   * that the class scans read in full.
   */
  readonly errorChip: string;
}

/**
 * The degradation tags the normalizer writes.
 *
 * Stated as a closed list rather than "any tag": `seeded` is a tag too, and a
 * warning chip on every seeded span would be a warning about nothing.
 */
export const DEGRADED_TAGS: readonly string[] = [
  'degraded',
  'transcript_only',
  'synthetic_open',
  'unattributed',
];

export const SPAN_VISUALS = {
  type: {
    llm_call: { tint: 'text-span-llm', Icon: Sparkles, label: 'model call' },
    tool_call: { tint: 'text-span-tool', Icon: Wrench, label: 'tool call' },
    thinking: { tint: 'text-span-thinking', Icon: Brain, label: 'thinking' },
    subagent: { tint: 'text-span-subagent', Icon: Bot, label: 'sub-agent' },
    generic: { tint: 'text-span-generic', Icon: Box, label: 'activity' },
  },
  status: {
    // The pulse is the spec's own treatment for a live row, and `theme.css`
    // already ships the keyframes it names.
    running: { row: '', tint: 'text-running animate-live-pulse', Icon: Loader, label: 'running' },
    ok: { row: '', tint: 'text-success', Icon: CircleCheck, label: 'ok' },
    // The 8% wash `design-system.md`'s flagship-row paragraph asks for by name.
    // Compiled against this repo's theme it yields
    // `color-mix(in oklab, var(--color-error) 8%, transparent)` — the cleared
    // namespaces do not block the opacity modifier.
    error: { row: 'bg-error/8', tint: 'text-error', Icon: CircleX, label: 'error' },
    denied: { row: 'bg-error/8', tint: 'text-error', Icon: Ban, label: 'denied' },
    // Faint and a dash, so it reads as "nobody knows" rather than as a status
    // that could be mistaken for the live one.
    unknown: { row: '', tint: 'text-faint', Icon: Minus, label: 'unknown' },
  },
  trace: { tint: 'text-span-turn', Icon: MessageSquare, label: 'turn' },
  triggerBadge: 'rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-muted',
  degradedChip: 'rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-warning',
  errorChip: 'font-mono text-2xs text-error',
} as const satisfies SpanVisualManifest;

/**
 * Which degradation tags a span carries, in the manifest's own order.
 *
 * Order taken from {@link DEGRADED_TAGS} rather than from `Span.tags` so two
 * spans degraded the same way never draw their chips in different orders.
 */
export function degradedTagsOf(tags: readonly string[]): string[] {
  return DEGRADED_TAGS.filter((tag) => tags.includes(tag));
}
