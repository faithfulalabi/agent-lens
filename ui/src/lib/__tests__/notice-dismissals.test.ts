import { describe, expect, it } from 'vitest';
import { createNoticeDismissals } from '../use-notice-dismissal';

describe('notice dismissal for one app run', () => {
  it('keeps notices hidden when revisited and scopes drift notices per session', () => {
    const notices = createNoticeDismissals();
    notices.dismiss('cost-unknown');
    notices.dismiss('drift:session-a');
    expect(notices.isDismissed('cost-unknown')).toBe(true);
    expect(notices.isDismissed('drift:session-a')).toBe(true);
    expect(notices.isDismissed('drift:session-b')).toBe(false);
    expect(createNoticeDismissals().isDismissed('cost-unknown')).toBe(false);
    expect(createNoticeDismissals().isDismissed('drift:session-a')).toBe(false);
  });

  it('notifies mounted notices once per dismissal and unsubscribes on unmount', () => {
    const notices = createNoticeDismissals();
    let changes = 0;
    const unsubscribe = notices.subscribe(() => {
      changes += 1;
    });
    notices.dismiss('cost-unknown');
    notices.dismiss('cost-unknown');
    expect(changes).toBe(1);
    unsubscribe();
    notices.dismiss('drift:session-a');
    expect(changes).toBe(1);
  });
});
