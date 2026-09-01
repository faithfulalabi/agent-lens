import { useMemo } from 'react';

import { AppShell } from './components/shell/AppShell.js';
import type { ApiClient } from './lib/api.js';
import { createLiveBus } from './lib/live.js';
import type { Router } from './lib/router.js';
import { useLiveStream } from './lib/use-live.js';
import { useRoute } from './lib/use-route.js';
import { SessionView } from './pages/SessionView.js';
import { Sessions } from './pages/Sessions.js';
import { Showcase } from './pages/Showcase.js';

/*
 * ===========================================================================
 * BOTH PORTS ARE OPTIONAL PROPS, AND THAT IS WHAT MAKES `<App />` RENDERABLE.
 * ===========================================================================
 * Added by Task 5.3b, which needed to render this component at `/session/x` and
 * found that it could not. Two independent reasons, both of which had to go:
 *
 *   - `useRoute()` with no argument falls back to the shared router, which is
 *     built by `createRouter()` over the browser history port — and
 *     `createRouter` asks that port for the current path EAGERLY, at
 *     construction. Under `environment: 'node'` there is no address bar to ask.
 *   - the pages then build their own API client, whose factory reads the page
 *     bootstrap and throws outside a browser.
 *
 * Both props are omitted in production, where `main.tsx` renders `<App />` bare
 * and every default is the real thing. The two source pins over this file read
 * its `import` statements rather than its signature, so widening it costs no
 * test edit.
 *
 * ===========================================================================
 * ONE STREAM FOR THE WHOLE APP, FANNED OUT THROUGH A THIRD PORT.
 * ===========================================================================
 * Task 6.1 ships one `/api/stream` and no subscriber concept, and the two pages
 * below are siblings — so the client is built HERE, once, and the bus it feeds
 * goes down as a prop beside `api` and `router`. A page opening its own client
 * would mean two sockets for one app. The bus is a plain port, so both pages
 * stay renderable against a hand-built double.
 */

export interface AppProps {
  router?: Router;
  api?: ApiClient;
}

export function App({ router, api }: AppProps = {}) {
  const route = useRoute(router);

  const bus = useMemo(() => createLiveBus(), []);
  useLiveStream(bus);

  /*
   * Scope note, updated by Task 5.3b: `session` and `trace` now reach the real
   * session view. A `trace` deep link resolves to the session and its turn
   * sequence is not yet used to anchor the view — Task 5.5 owns "any deep link
   * cold-loads to the exact view state", and 5.4 owns the detail pane the
   * selection drives.
   *
   * The switch stays INLINE inside `<AppShell>`. Extracting it into a helper
   * would move the page elements outside the slice that `components.test.tsx`
   * reads, and break a pin for no reason.
   */
  return (
    <AppShell>
      {route.name === 'showcase' ? (
        <Showcase />
      ) : route.name === 'session' || route.name === 'trace' ? (
        <SessionView
          sessionId={route.sessionId}
          bus={bus}
          {...(api === undefined ? {} : { api })}
        />
      ) : (
        <Sessions
          bus={bus}
          {...(router === undefined ? {} : { router })}
          {...(api === undefined ? {} : { api })}
        />
      )}
    </AppShell>
  );
}
