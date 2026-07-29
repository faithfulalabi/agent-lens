import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/*
 * The dark-only application chrome: global banner slot, top bar, content pane.
 *
 * Deliberately dumb. The banner is a slot prop, not state — design-system.md
 * specifies "one global slot, top of viewport, full-width", and Task 5.5 owns
 * what goes in it and when. Rendering it above the top bar is what "top of
 * viewport" means; an omitted banner renders no wrapper at all, so it costs no
 * layout space and draws no border.
 *
 * The top bar separates with a border and no shadow, per design-system.md's
 * Shadow rule: shadows are for floating surfaces, borders separate in-flow
 * panels.
 *
 * The `cn` import here is not decoration — it is the only thing that puts
 * `@/lib/utils` into the production entry graph (index.html -> main.tsx ->
 * App.tsx -> AppShell), which is how the alias gets a real build-level
 * assertion without shipping a test-only fixture module.
 */

export interface AppShellProps {
  children: ReactNode;
  /** Global banner slot — degradation/system messages. Task 5.5 fills it. */
  banner?: ReactNode;
  className?: string;
}

export function AppShell({ banner, children, className }: AppShellProps) {
  return (
    <div
      data-slot="app-shell"
      className={cn('flex min-h-screen flex-col bg-background', className)}
    >
      {banner ? (
        <div data-slot="banner" className="w-full">
          {banner}
        </div>
      ) : null}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-semibold text-foreground">agent-lens</span>
      </header>
      <div data-slot="content" className="flex-1">
        {children}
      </div>
    </div>
  );
}
