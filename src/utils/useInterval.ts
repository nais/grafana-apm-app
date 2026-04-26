import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

/** Tiny external store for the countdown value. */
function createCountdownStore(initialDelayMs: number | null) {
  let nextTick = 0;
  let snapshot = initialDelayMs ? Math.ceil(initialDelayMs / 1000) : 0;
  const listeners = new Set<() => void>();

  function notify() {
    for (const l of listeners) {
      l();
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    reset(delayMs: number) {
      nextTick = Date.now() + delayMs;
      snapshot = Math.ceil(delayMs / 1000);
      notify();
    },
    tick() {
      const remaining = Math.max(0, Math.ceil((nextTick - Date.now()) / 1000));
      if (remaining !== snapshot) {
        snapshot = remaining;
        notify();
      }
    },
    destroy() {
      listeners.clear();
    },
  };
}

/**
 * Auto-refresh hook that calls `callback` every `delayMs` milliseconds.
 * Pauses when the browser tab is hidden to avoid wasted fetches.
 * Returns the number of seconds until the next refresh for UI display.
 */
export function useInterval(callback: () => void, delayMs: number | null): { secondsUntilRefresh: number } {
  // Stable store instance per delayMs value
  const store = useMemo(() => createCountdownStore(delayMs), [delayMs]);

  // Subscribe to the external store for countdown display
  const secondsUntilRefresh = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Keep callback ref fresh without triggering effect re-runs
  const callbackRef = useMemo(() => ({ current: callback }), [callback]);

  useEffect(() => {
    if (delayMs === null || delayMs <= 0) {
      return;
    }

    let mainTimer: ReturnType<typeof setInterval>;
    let countdownTimer: ReturnType<typeof setInterval>;
    let paused = false;

    const start = () => {
      store.reset(delayMs);
      mainTimer = setInterval(() => {
        callbackRef.current();
        store.reset(delayMs);
      }, delayMs);

      countdownTimer = setInterval(() => {
        store.tick();
      }, 1000);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        paused = true;
        clearInterval(mainTimer);
        clearInterval(countdownTimer);
      } else if (paused) {
        paused = false;
        callbackRef.current();
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(mainTimer);
      clearInterval(countdownTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      store.destroy();
    };
  }, [delayMs, store, callbackRef]);

  return { secondsUntilRefresh };
}

/** Interval options for the refresh rate selector. */
export const REFRESH_INTERVALS = [
  { label: '30s', value: 30000 },
  { label: '1m', value: 60000 },
  { label: '5m', value: 300000 },
] as const;

/** useAutoRefresh wraps useInterval with a selectable interval and refetch callback. */
export function useAutoRefresh(refetch: () => void, intervalMs: number) {
  const stableRefetch = useCallback(() => {
    refetch();
  }, [refetch]);

  return useInterval(stableRefetch, intervalMs);
}
