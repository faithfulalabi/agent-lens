import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { AppShell } from '../shell/AppShell';

const APP_PATH = fileURLToPath(new URL('../../App.tsx', import.meta.url));

/*
 * AC1 — a smoke check, and only that. Read the next paragraph before adding an
 * assertion here.
 *
 * Radix Portals render `null` under renderToStaticMarkup: Portal gates on a
 * `mounted` flag set from useLayoutEffect, which never runs during a static
 * render, and `environment: 'node'` has no document.body either. Forcing
 * `open` / `defaultOpen` does not change that — ContextMenu emits ~80
 * characters (the trigger, nothing else) no matter what. So a "markup is
 * non-empty" or "markup contains class X" assertion would be true-but-vacuous
 * for context-menu and would quietly become the thing people trust.
 *
 * What this genuinely proves: the module still parses after the retokenizing
 * edit, its Radix peer is installed, `@/lib/utils` resolves, and the composed
 * tree constructs. Every class-level claim lives in retokenized.test.ts, which
 * reads source text and never goes through the renderer.
 */

const composed: [string, ReactElement][] = [
  [
    'tabs',
    <Tabs defaultValue="io">
      <TabsList>
        <TabsTrigger value="io">I/O</TabsTrigger>
        <TabsTrigger value="raw">Raw</TabsTrigger>
      </TabsList>
      <TabsContent value="io">io</TabsContent>
      <TabsContent value="raw">raw</TabsContent>
    </Tabs>,
  ],
  [
    'context-menu',
    <ContextMenu>
      <ContextMenuTrigger>right-click me</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel inset>Span</ContextMenuLabel>
        <ContextMenuGroup>
          <ContextMenuItem>
            Copy span ID
            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuCheckboxItem checked>Show timings</ContextMenuCheckboxItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuRadioGroup value="pretty">
          <ContextMenuRadioItem value="pretty">Pretty</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
        <ContextMenuSub>
          <ContextMenuSubTrigger inset>Copy payload</ContextMenuSubTrigger>
          <ContextMenuPortal>
            <ContextMenuSubContent>
              <ContextMenuItem>As JSON</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuPortal>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>,
  ],
];

describe('the retokenized shadcn subset', () => {
  it.each(composed)(
    '%s constructs and renders without throwing (smoke only — see the note above)',
    (_name, tree) => {
      expect(() => renderToStaticMarkup(tree)).not.toThrow();
    },
  );
});

/*
 * AC7 — AppShell. Unlike the Radix pair, AppShell has no Portal, so this is a
 * real positive render assertion rather than a smoke check.
 */
describe('AppShell', () => {
  it('renders its banner slot and its children', () => {
    const markup = renderToStaticMarkup(<AppShell banner={<b>BANNER</b>}>child-content</AppShell>);
    expect(markup).toContain('<b>BANNER</b>');
    expect(markup).toContain('child-content');
  });

  it('renders children and no banner chrome when banner is omitted', () => {
    const markup = renderToStaticMarkup(<AppShell>child-content</AppShell>);
    expect(markup).toContain('child-content');
    expect(
      markup,
      'the banner slot is optional — an empty banner wrapper would still take ' +
        'layout space and draw its border.',
    ).not.toContain('data-slot="banner"');
  });

  /*
   * Source-level rather than rendered: App.tsx reads window.location.pathname
   * and there is no `window` under environment: 'node'.
   */
  it('wraps every branch of App.tsx', () => {
    const source = readFileSync(APP_PATH, 'utf8');
    expect(source).toMatch(/import\s*\{\s*AppShell\s*\}/);

    const opened = source.indexOf('<AppShell');
    const closed = source.indexOf('</AppShell>');
    expect(opened, 'App.tsx does not render <AppShell>').toBeGreaterThan(-1);
    expect(closed, 'App.tsx does not close <AppShell>').toBeGreaterThan(opened);

    const wrapped = source.slice(opened, closed);
    for (const page of ['<Showcase', '<Home']) {
      expect(
        wrapped,
        `${page} /> renders outside <AppShell> — both branches of the temporary ` +
          '/showcase switch must render inside the shell.',
      ).toContain(page);
    }
  });
});
