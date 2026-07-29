import { describe, it, expect } from 'vitest';
import { cn } from '../utils';

/*
 * AC5 — cn() merges conflicting classes correctly.
 *
 * cn() is two lines of glue, but every hand-copied component funnels its
 * className through it, so a regression here is invisible until a caller's
 * override silently loses to the base class. Pinned against the versions this
 * task installs: clsx@2.1.1 + tailwind-merge@3.6.0.
 */

describe('cn', () => {
  it('merges conflicting utilities, later wins', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('bg-surface', 'bg-surface-raised')).toBe('bg-surface-raised');
  });

  it('preserves non-conflicting utilities and tolerates falsy/array input', () => {
    expect(cn('text-muted', 'font-medium')).toBe('text-muted font-medium');
    expect(cn('a', false, undefined, null, ['b'])).toBe('a b');
    expect(cn('bg-surface', false, undefined, ['bg-surface-raised'])).toBe('bg-surface-raised');
  });

  /*
   * A regression pin, not a record of a limitation. `2xs` is a custom step
   * (design-system.md's 11px row) and tailwind-merge has to recognise it as a
   * font size for the conflict to resolve — it does, via its t-shirt-size
   * validator, so no extendTailwindMerge config is needed. If a future
   * tailwind-merge stops recognising it, `text-sm text-2xs` would both survive
   * and the smaller step would lose to source order in the stylesheet.
   */
  it('dedupes the custom 2xs font size against the rest of the scale', () => {
    expect(cn('text-sm', 'text-2xs')).toBe('text-2xs');
    expect(cn('text-2xs', 'text-sm')).toBe('text-sm');
    // Colour and size are different groups — `text-muted` must survive.
    expect(cn('text-muted', 'text-2xs')).toBe('text-muted text-2xs');
  });
});
