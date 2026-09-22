import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appSource, pagesImportedBy } from '../../__tests__/app-pages';
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
    const source = appSource();
    expect(source).toMatch(/import\s*\{\s*AppShell\s*\}/);

    const opened = source.indexOf('<AppShell');
    const closed = source.indexOf('</AppShell>');
    expect(opened, 'App.tsx does not render <AppShell>').toBeGreaterThan(-1);
    expect(closed, 'App.tsx does not close <AppShell>').toBeGreaterThan(opened);

    /*
     * Generalised by Task 5.2a from the hardcoded pair it used to hold. The
     * claim is unchanged — every page renders inside the shell — but the list
     * of pages now comes from App.tsx's own imports, so a task that adds a page
     * adds one import and edits no test. (Task 5.3 asked for this; 5.2a runs
     * first, so 5.2a makes it.)
     */
    const pages = pagesImportedBy(source);
    expect(pages.length, 'no page import was derived from App.tsx').toBeGreaterThan(0);
    expect(
      pages,
      'the showcase page is the vacuity guard: a regex that matched only its ' +
        'first hit would return one page and green the loop below against it.',
    ).toContain('Showcase');

    const wrapped = source.slice(opened, closed);
    for (const page of pages) {
      expect(
        wrapped,
        `<${page} /> renders outside <AppShell> — every page App.tsx imports ` +
          'must render inside the shell.',
      ).toContain(`<${page}`);
    }
  });

  it('derives the page list from App.tsx page imports and nothing else', () => {
    const pages = pagesImportedBy(appSource());
    // Narrowing to the `./pages/` prefix is the whole mechanism: the shell
    // comes from `./components/shell/` and the router binding from `./lib/`,
    // so neither can be mistaken for a page and demanded inside the shell tags.
    expect(pages).not.toContain('AppShell');
    expect(pages).not.toContain('useRoute');
  });
});
