import { useSyncExternalStore } from 'react';

/** In-memory only: navigating keeps dismissals; reloading starts a fresh run. */
export function createNoticeDismissals() {
  const dismissed = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    isDismissed: (key: string) => dismissed.has(key),
    dismiss(key: string) {
      if (dismissed.has(key)) return;
      dismissed.add(key);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const notices = createNoticeDismissals();

export function useNoticeDismissal(key: string) {
  const dismissed = useSyncExternalStore(
    notices.subscribe,
    () => notices.isDismissed(key),
    () => false,
  );
  return { dismissed, dismiss: () => notices.dismiss(key) };
}
