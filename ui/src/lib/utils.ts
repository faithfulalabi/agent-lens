import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class names, with later Tailwind utilities winning over earlier
 * conflicting ones. Every hand-copied component funnels its `className` through
 * this, so a caller's override beats the component's base class.
 *
 * clsx flattens/filters the inputs; tailwind-merge resolves the conflicts.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
