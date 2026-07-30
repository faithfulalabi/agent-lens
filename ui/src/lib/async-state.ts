/*
 * The async-resource reducer (Task 5.2a — the handoff Task 5.1c deferred so it
 * would be designed against a real consumer rather than in the abstract).
 *
 * ONE rule governs everything: `start` adopts `action.requestId`, and a
 * `resolve`/`reject` whose id is not the current one is discarded. Out-of-order
 * responses, an abort that lands after a restart, and a late failure arriving
 * after a success all fall out of that single line. An abort needs no case of
 * its own — an abort only ever happens because a newer request began, and
 * beginning it already advanced the id.
 *
 * ===========================================================================
 * `start` MUST CARRY ITS OWN id. DO NOT DERIVE IT FROM THE SLOT.
 * ===========================================================================
 * With an id-less `start` the token would live in reducer state alone, and
 * `useReducer` state is not readable until the NEXT render — so the caller
 * could not learn the id the reducer just minted. Computing it as
 * `slot.requestId + 1` from the current render deadlocks under the
 * `<StrictMode>` in `main.tsx`: React runs the same commit's effect twice, both
 * runs read the same slot and compute 1, the reducer lands on 2, the response
 * tagged 1 is discarded, and dev is stuck showing the pending state forever.
 * A counter held in a ref gives the two runs 1 and 2 instead, and the response
 * tagged 2 wins.
 *
 * Discarded actions return the SAME slot object. That is hygiene — no needless
 * state churn — and not a promise: React documents `useReducer`'s equal-state
 * bailout as best effort. Assert the object identity; never a render count.
 */

import type { ApiFailure } from './api.js';

/** What a caller sees: three states, no nulls, no booleans to combine. */
export type AsyncState<T> =
  { kind: 'loading' } | { kind: 'ok'; value: T } | { kind: 'error'; error: ApiFailure };

/** The state plus the generation token that decides which answers still count. */
export interface AsyncSlot<T> {
  requestId: number;
  state: AsyncState<T>;
}

export type AsyncAction<T> =
  | { type: 'start'; requestId: number }
  | { type: 'resolve'; requestId: number; value: T }
  | { type: 'reject'; requestId: number; error: ApiFailure };

/** Shared so a fresh slot is cheap and the pending state has a stable identity. */
const PENDING: AsyncState<never> = { kind: 'loading' };

/** A slot no request has been made against yet. */
export function initialSlot<T>(): AsyncSlot<T> {
  return { requestId: 0, state: PENDING };
}

export function asyncReducer<T>(slot: AsyncSlot<T>, action: AsyncAction<T>): AsyncSlot<T> {
  if (action.type === 'start') return { requestId: action.requestId, state: PENDING };
  if (action.requestId !== slot.requestId) return slot;
  return {
    requestId: slot.requestId,
    state:
      action.type === 'resolve'
        ? { kind: 'ok', value: action.value }
        : { kind: 'error', error: action.error },
  };
}
