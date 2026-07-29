import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';

/*
 * Hand-copied from shadcn/ui `new-york` (ui.shadcn.com/r/styles/new-york/tabs.json)
 * and then rewritten onto agent-lens tokens. There is no update path back to
 * upstream — edit this file directly. Task 5.1d, two approved deviations:
 *
 *   A. every shadcn semantic class becomes an agent-lens token (the alternative,
 *      shadcn-compat alias tokens, would put non-spec variables into :root);
 *   B. the `tw-animate-css` entrance utilities are stripped — that package is
 *      deliberately not installed, so they would emit no CSS at all.
 *
 * `"use client"` is dropped: there is no RSC here.
 *
 * The rewrites, named by role rather than by upstream class literal — see the
 * "Tailwind scans comments" note at the bottom for why:
 *
 *   upstream's muted surface        -> bg-surface-raised   (the tabs-list track)
 *   upstream's muted foreground     -> text-muted
 *   upstream's focus-ring colour    -> ring-accent         (design-system.md's
 *                                                           2px accent ring)
 *   the active trigger's background -> bg-surface          (upstream means a
 *                                                           *panel* background
 *                                                           here, not the app
 *                                                           canvas)
 *
 * DROPPED, not remapped: upstream's bare `shadow` on the active trigger.
 * theme.css sets --shadow-*: initial and defines only --shadow-float, so the
 * class emits nothing — and design-system.md's Shadow rule is floating surfaces
 * only ("None on in-flow surfaces"). A tabs trigger is in flow, so the honest
 * fix is removal, not --shadow-float.
 *
 * TAILWIND SCANS COMMENTS. Any class-shaped text in this header is a candidate
 * like any other: it would emit a real (dead) CSS rule, and it would trip
 * retokenized.test.ts's deny-list scan, which reads raw source on purpose. That
 * is why the colour rewrites above are described rather than quoted. The full
 * map lives in the task file.
 */

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-9 items-center justify-center rounded-lg bg-surface-raised p-1 text-muted',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-surface data-[state=active]:text-foreground',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
