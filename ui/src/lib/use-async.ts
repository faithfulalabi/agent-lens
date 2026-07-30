/*
 * The React binding over `async-state.ts` (Task 5.2a).
 *
 * Deliberately branch-free. The `ui` vitest project has no DOM
 * (`ui/vitest.config.ts`: `environment: 'node'`), so an effect never runs under
 * test — anything expressed as a decision in here would be untested by
 * construction. Every decision therefore lives in the reducer, which is a plain
 * function a unit test can drive directly, and what remains is wiring.
 *
 * Three details are load-bearing:
 *
 * 1. **The id is minted from a ref INSIDE the effect**, never derived from the
 *    slot the current render can see. See `async-state.ts`'s header for the
 *    `<StrictMode>` deadlock that the derived form causes. A ref survives
 *    StrictMode's simulated remount, so the two runs of one commit get
 *    consecutive ids and the abandoned one is discarded cleanly.
 *
 * 2. **The dependencies are `[key, refreshToken]`.** `[key]` alone would mean
 *    the same key can never fetch again, which would leave Task 6.2 no seam to
 *    invalidate through. Keyed by a string because this repo has no
 *    `eslint-plugin-react-hooks` to police a dependency array.
 *
 * 3. **`load` is read through a ref**, so passing an arrow written at the call
 *    site does not re-run the request on every render.
 *
 * Nothing is built at module scope. The API client factory's default reads the
 * page bootstrap and throws outside a browser, so building one here would make
 * every suite that imports this file un-runnable.
 */

import { useEffect, useReducer, useRef } from 'react';

import type { ApiFailure } from './api.js';
import { asyncReducer, initialSlot, type AsyncState } from './async-state.js';

export function useAsync<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  refreshToken = 0,
): AsyncState<T> {
  const [slot, dispatch] = useReducer(asyncReducer<T>, initialSlot<T>());
  const idRef = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const requestId = ++idRef.current;
    const controller = new AbortController();
    dispatch({ type: 'start', requestId });
    void loadRef.current(controller.signal).then(
      (value) => dispatch({ type: 'resolve', requestId, value }),
      (error: unknown) => dispatch({ type: 'reject', requestId, error: error as ApiFailure }),
    );
    return () => controller.abort();
  }, [key, refreshToken]);

  return slot.state;
}
