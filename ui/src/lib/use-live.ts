/*
 * The React binding over the stream (Task 6.2), and the only one.
 *
 * Deliberately branch-free, on the rule `use-async.ts:4-8` states: the `ui`
 * project has no DOM, so an effect never runs under test and any decision
 * expressed in here would be untested by construction. Every decision about a
 * frame lives in `live.ts`; what is here is one client, one subscription and
 * one teardown.
 *
 * The cast below is the ONE decode boundary. `sse.ts` hands back `data:
 * unknown` because a wire payload is unknown until something claims it, and the
 * claim is made here, once, by event name — so both pages read a narrowed
 * `LiveFrame` and neither carries a cast of its own.
 *
 * Nothing is built at module scope: `createSseClient`'s default reads the page
 * bootstrap, which throws outside a browser.
 */

import { useEffect, useRef } from 'react';

import type { SessionChangedFrame, SessionIndexedFrame, WarmProgressFrame } from '@shared/api.ts';

import type { EventRow } from './api.js';
import type { LiveBus } from './live.js';
import {
  createSseClient,
  type ConnectionState,
  type SseClient,
  type SseClientOptions,
} from './sse.js';

export interface UseLiveStreamOptions {
  /** What a reconnect badge renders from. Task 6.2 ships no badge. */
  onState?: (state: ConnectionState) => void;
  /** Injected by a test; production takes the real client factory. */
  create?: (options: SseClientOptions) => SseClient;
}

/** Open one stream for the app's lifetime and publish its frames onto `bus`. */
export function useLiveStream(bus: LiveBus, options: UseLiveStreamOptions = {}): void {
  const busRef = useRef(bus);
  busRef.current = bus;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const create = optionsRef.current.create ?? createSseClient;
    const client = create({
      onEvent: ({ event, data }) => {
        if (event === 'session_changed') {
          busRef.current.publish({ event, data: data as SessionChangedFrame<EventRow> });
        } else if (event === 'session_indexed') {
          busRef.current.publish({ event, data: data as SessionIndexedFrame });
        } else if (event === 'warm_progress') {
          busRef.current.publish({ event, data: data as WarmProgressFrame });
        }
      },
      onState: (state) => optionsRef.current.onState?.(state),
    });
    void client.start();
    return () => client.close();
    // One stream, opened once. The bus and the callbacks are read through refs
    // precisely so a caller passing an arrow does not tear the socket down on
    // every render.
  }, []);
}
