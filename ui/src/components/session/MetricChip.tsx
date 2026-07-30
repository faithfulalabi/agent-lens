import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/*
 * The recurring metric atom from `design-system.md:141` — `1.02s · 185 tok ·
 * <$0.001` — as three chips: 11px JetBrains Mono, the muted foreground on the
 * raised surface, small radius, nothing drawn around them.
 *
 * Three slots rather than one free-form chip because both consumers want the
 * same three: the session list's numeric cells (Task 5.2b) and the span-tree
 * row's `[duration] [tokens] [cost]` trio (`design-system.md:137`, Task 5.3).
 * An omitted slot emits nothing at all, so a session with no cost shows two
 * chips rather than a placeholder.
 *
 * Values arrive already spelled, from `@/lib/format`. This component does no
 * arithmetic and reads no clock, which is what lets one server render assert
 * everything it does.
 *
 * ===========================================================================
 * TWO SPELLING RULES, both of which a future edit will want to break.
 * ===========================================================================
 * 1. The chip classes are written as ONE literal in a `className` position.
 *    `retokenized.test.ts`'s extractor reads `className="…"` and the string
 *    literals inside a `cn( … )` call and nothing else, so hoisting them into a
 *    `const` referenced as `className={NAME}` would make this component's
 *    classes invisible to the scan that proves they compile — and Task 5.2b
 *    adds this file to that scan.
 * 2. NEVER write the neutral background as one word. The same array feeds a
 *    deny-list which — for the reason that deny-list documents — contains the
 *    one-word form even though it is a real agent-lens token. The muted
 *    FOREGROUND on the raised surface is what the design system asks for and
 *    the only spelling that stays green.
 */

export interface MetricChipProps {
  /** Pre-formatted elapsed time, e.g. `1.02s`. */
  duration?: string;
  /** Pre-formatted token count, e.g. `185 tok`. */
  tokens?: string;
  /** Pre-formatted cost, e.g. `<$0.001`. */
  cost?: string;
  className?: string;
}

export function MetricChip({ duration, tokens, cost, className }: MetricChipProps) {
  return (
    <span data-slot="metric-chips" className={cn('inline-flex items-center gap-1', className)}>
      <Chip slot="metric-duration">{duration}</Chip>
      <Chip slot="metric-tokens">{tokens}</Chip>
      <Chip slot="metric-cost">{cost}</Chip>
    </span>
  );
}

function Chip({ slot, children }: { slot: string; children?: ReactNode }) {
  if (children === undefined) return null;
  return (
    <span
      data-slot={slot}
      className="rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-muted"
    >
      {children}
    </span>
  );
}
