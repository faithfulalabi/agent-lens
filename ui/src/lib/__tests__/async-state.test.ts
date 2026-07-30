import { describe, it, expect } from 'vitest';

import { asyncReducer, initialSlot, type AsyncSlot } from '../async-state';
import { HttpError, NetworkError } from '../api';

/*
 * AC1 (reducer half) — Test 1 of the task plan.
 *
 * The generation token is the whole design, so every assertion here is about
 * which answer counts and which one is thrown away. Two mutations red this
 * suite, and both were checked by hand before it was written:
 *   - delete the `action.requestId !== slot.requestId` guard;
 *   - drop `requestId` from `start` and have the caller derive
 *     `slot.requestId + 1` instead.
 */

const boom = new HttpError(500, 'boom');
const offline = new NetworkError(new Error('offline'));

function started(id: number): AsyncSlot<string> {
  return asyncReducer<string>(initialSlot<string>(), { type: 'start', requestId: id });
}

describe('asyncReducer keeps only the answer to the newest request', () => {
  it('starts pending and adopts the id the caller minted', () => {
    const slot = started(7);
    expect(slot).toEqual({ requestId: 7, state: { kind: 'loading' } });
  });

  it('accepts a value tagged with the current id', () => {
    const slot = asyncReducer(started(1), { type: 'resolve', requestId: 1, value: 'v' });
    expect(slot.state).toEqual({ kind: 'ok', value: 'v' });
  });

  it('accepts a failure tagged with the current id', () => {
    const slot = asyncReducer(started(1), { type: 'reject', requestId: 1, error: boom });
    expect(slot.state).toEqual({ kind: 'error', error: boom });
  });

  it('discards a value that answers a superseded request', () => {
    const current = started(2);
    const after = asyncReducer(current, { type: 'resolve', requestId: 1, value: 'stale' });
    expect(after.state).toEqual({ kind: 'loading' });
    expect(after, 'a discarded action must not churn the slot').toBe(current);
  });

  it('discards a failure that answers a superseded request', () => {
    const current = asyncReducer(started(1), { type: 'resolve', requestId: 1, value: 'good' });
    const restarted = asyncReducer(current, { type: 'start', requestId: 2 });
    const after = asyncReducer(restarted, { type: 'reject', requestId: 1, error: offline });
    expect(after.state).toEqual({ kind: 'loading' });
    expect(after).toBe(restarted);
  });

  it('lets a value at the current id overwrite an earlier failure at that id', () => {
    // Same generation, two answers: the reducer has no opinion beyond the id,
    // so a retry that reuses the id still wins. The hook never does this — the
    // assertion exists so a future caller learns the rule from a test.
    const failed = asyncReducer(started(3), { type: 'reject', requestId: 3, error: boom });
    const recovered = asyncReducer(failed, { type: 'resolve', requestId: 3, value: 'v' });
    expect(recovered.state).toEqual({ kind: 'ok', value: 'v' });
  });

  it('survives the StrictMode double-invoke of one commit', () => {
    /*
     * `main.tsx` renders under `<StrictMode>`, so React runs the effect of a
     * single commit twice. The two runs mint 1 and 2 from a ref counter; the
     * cleanup between them aborts the first request, whose rejection arrives
     * tagged 1 and must be dropped. Were the id derived from the slot instead,
     * both runs would compute 1, the reducer would sit at 2, and BOTH answers
     * would be discarded — the pending state would never end in dev.
     */
    let slot = initialSlot<string>();
    slot = asyncReducer(slot, { type: 'start', requestId: 1 });
    slot = asyncReducer(slot, { type: 'start', requestId: 2 });
    slot = asyncReducer(slot, { type: 'reject', requestId: 1, error: offline });
    expect(slot.state, 'the aborted first attempt must not surface').toEqual({ kind: 'loading' });

    slot = asyncReducer(slot, { type: 'resolve', requestId: 2, value: 'second' });
    expect(slot.state, 'the surviving attempt must resolve the slot').toEqual({
      kind: 'ok',
      value: 'second',
    });
  });

  it('leaves the answer to an abandoned attempt unreachable in either order', () => {
    // The same commit, with the discarded answer arriving LAST rather than
    // first — the ordering that a max()-based guard would get wrong.
    let slot = initialSlot<string>();
    slot = asyncReducer(slot, { type: 'start', requestId: 1 });
    slot = asyncReducer(slot, { type: 'start', requestId: 2 });
    slot = asyncReducer(slot, { type: 'resolve', requestId: 2, value: 'second' });
    const settled = slot;
    slot = asyncReducer(slot, { type: 'resolve', requestId: 1, value: 'first' });
    expect(slot).toBe(settled);
  });
});
