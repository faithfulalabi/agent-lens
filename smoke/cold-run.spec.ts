// Task 8.2 AC3 — the four screens, driven against the copy INSTALLED FROM THE
// TARBALL. `scripts/pack-smoke.mjs` builds, packs, installs into a resolution
// jail, boots that install and hands the port here as `SMOKE_BASE_URL`.
//
// Two rules, both inherited from the render gate:
//   * NO SLEEPS. Every wait is a selector or a function.
//   * ONE data-slot vocabulary. `SELECTORS` is imported from the gate rather
//     than restated, so a rename reds in one place.

import { expect, test } from '@playwright/test';
import { SELECTORS } from '../src/render-gate/index.js';

const slot = (name: string): string => `[data-slot="${name}"]`;

test('a cold install renders the session list, a session and an event', async ({
  page,
  baseURL,
}) => {
  expect(baseURL, 'SMOKE_BASE_URL is unset — run this through `npm run smoke:pack`').toBeTruthy();

  // The served index.html carries the token through `injectToken`, so the browser
  // is authenticated on first paint. That IS the zero-configuration claim: no
  // settings edit, no consent prompt, nothing typed before the first render.
  await page.goto('/');

  // 1 — session list. The corpus the harness laid down is timestamped inside the
  // list's default range, so no range widening is needed to see it.
  await page.waitForSelector(slot(SELECTORS.sessionRow));
  const count = (await page.locator(slot(SELECTORS.sessionCount)).innerText()).trim();
  expect(count).toMatch(/[1-9]/);

  // 2 — session detail. A bare `<a href>`, so this is a real navigation.
  await page.locator(slot(SELECTORS.sessionRow)).first().click();
  await page.waitForSelector(slot(SELECTORS.traceRow));

  // 3 — turn 1 expanded, because its children land at index 1 and are inside the
  // virtualizer's window by construction. Guarded: on a one-turn session the last
  // turn IS turn 1, which `initialExpanded` already opened, and clicking would
  // collapse it.
  const firstTurn = page.locator(slot(SELECTORS.traceRow)).first();
  if ((await firstTurn.getAttribute('aria-expanded')) === 'false') {
    await page.locator(slot(SELECTORS.traceExpand)).first().click();
  }
  await page.waitForSelector(`[data-index="1"] ${slot(SELECTORS.spanRow)}`);

  // 4 — event detail. Selection first, then the pane: they are separate state,
  // and waiting only on the pane would pass against a stale one.
  const firstSpan = page.locator(`[data-index="1"] ${slot(SELECTORS.spanRow)}`);
  const eventId = await firstSpan.getAttribute('data-event-id');
  expect(eventId).toBeTruthy();

  await firstSpan.click();
  await page.waitForSelector(`[data-index="1"] ${slot(SELECTORS.spanRow)}[aria-selected="true"]`);
  await page.waitForSelector(`${slot(SELECTORS.spanDetail)}[data-event-id="${eventId}"]`);

  expect((await page.locator(slot(SELECTORS.spanDetail)).innerText()).trim()).not.toBe('');
});
