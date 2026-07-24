import { describe, it, expect } from 'vitest';
import { detectInversions } from './ordering-probe.mjs';

describe('detectInversions', () => {
  it('reports zero inversions when arrival order matches logical order', () => {
    const arrivals = [
      { event_id: 'a', seq: 1, logical: 0 },
      { event_id: 'b', seq: 2, logical: 1 },
      { event_id: 'c', seq: 3, logical: 2 },
    ];
    expect(detectInversions(arrivals).inversions).toBe(0);
  });

  it('counts each out-of-logical-order arrival as an inversion', () => {
    const arrivals = [
      { event_id: 'a', seq: 1, logical: 0 },
      { event_id: 'c', seq: 2, logical: 2 },
      { event_id: 'b', seq: 3, logical: 1 }, // arrived after c but is logically earlier
    ];
    const { inversions, pairs } = detectInversions(arrivals);
    expect(inversions).toBe(1);
    expect(pairs[0].event_id).toBe('b');
  });

  it('handles the empty case (no events captured)', () => {
    expect(detectInversions([]).inversions).toBe(0);
  });
});
