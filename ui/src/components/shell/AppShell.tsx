import { Aperture, Search } from 'lucide-react';
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
      className={cn('flex h-dvh min-h-0 flex-col overflow-hidden bg-background', className)}
    >
      {banner ? (
        <div data-slot="banner" className="w-full">
          {banner}
        </div>
      ) : null}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <a
          href="/"
          className="flex shrink-0 items-center gap-2.5 whitespace-nowrap text-sm font-semibold text-foreground"
        >
          <Aperture size={20} className="text-accent" aria-hidden="true" />
          agent-lens
        </a>
        <span className="hidden border-l border-border pl-3 text-xs text-muted sm:block">
          Session explorer
        </span>
        <a
          href="/search"
          className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface hover:text-foreground"
        >
          <Search size={14} aria-hidden="true" /> Search sessions
        </a>
        <span className="hidden items-center gap-1.5 text-2xs text-muted sm:flex">
          <span className="size-1.5 rounded-md bg-success" />
          Local
        </span>
      </header>
      <div data-slot="content" className="min-h-0 flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
