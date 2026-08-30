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

import type { EventKind, EventStatus } from '@/lib/turn-tree';

/**
 * The manifest's own five visual keys — the vocabulary of the SPAN-TYPE PALETTE,
 * not of `events.kind`.
 *
 * `design-system.md:78-83` ships six span-type tokens; one is the turn header's,
 * so five remain, and the palette is what this union names. `events.kind` has
 * SEVEN values and is a different vocabulary — {@link VISUAL_OF_KIND} is the map
 * between them. Merging the two would orphan `subagent` (no event kind is a
 * sub-agent; a sub-agent is a folded TURN) and crush four kinds onto `generic`.
 */
export type SpanTypeKey = 'llm_call' | 'tool_call' | 'thinking' | 'subagent' | 'generic';

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
  readonly type: Record<SpanTypeKey, SpanTypeVisual>;
  readonly status: Record<EventStatus, SpanStatusVisual>;
  /** The turn header's own icon, which is not a `SpanTypeKey`. */
  readonly trace: SpanTypeVisual;
  /**
   * The neutral badge a turn whose kind is not `human` carries. Informational
   * rather than degraded, so it is the metric-chip atom's muted spelling.
   */
  readonly triggerBadge: string;
  /**
   * The same neutral atom, for the input and output previews an event row
   * carries on its second line. `design-system.md:143` spells it once and both
   * consumers use that spelling; nothing new is invented here.
   */
  readonly payloadChip: string;
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
  payloadChip: 'rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-muted',
  errorChip: 'font-mono text-2xs text-error',
} as const satisfies SpanVisualManifest;

/**
 * The visual an `events.kind` draws with — seven kinds onto five palette keys.
 *
 * A map rather than a rekeying of {@link SPAN_VISUALS}, and the reason is the
 * palette: `subagent` belongs to a folded TURN and no event kind is one, while
 * four of the seven kinds are honestly generic. Rekeying would orphan one token
 * and crowd another, and this map is the shape the plan-001 adapter already had
 * — only its home changed.
 */
export const VISUAL_OF_KIND: Record<EventKind, SpanTypeVisual> = {
  tool_call: SPAN_VISUALS.type.tool_call,
  thinking: SPAN_VISUALS.type.thinking,
  text: SPAN_VISUALS.type.llm_call,
  prompt: SPAN_VISUALS.type.generic,
  error: SPAN_VISUALS.type.generic,
  compaction: SPAN_VISUALS.type.generic,
  unknown: SPAN_VISUALS.type.generic,
};
