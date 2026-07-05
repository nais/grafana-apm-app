import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';
import { dateMath } from '@grafana/data';

const DEFAULT_FROM = 'now-1h';
const DEFAULT_TO = 'now';

// Module-shared resolve tick: one refresh() re-resolves EVERY mounted
// useTimeRange instance, not just the caller's. Components fetch
// independently with their own useTimeRange (IssuesTable, VersionsPanel, …),
// so a page-level RefreshControl must reach them through shared state — a
// per-hook tick would only refresh the page's own fetches.
let resolveTick = 0;
const tickListeners = new Set<() => void>();

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  return () => tickListeners.delete(listener);
}

function readTick(): number {
  return resolveTick;
}

/** Re-resolve all relative time ranges app-wide (see useTimeRange.refresh). */
export function refreshTimeRange(): void {
  resolveTick++;
  tickListeners.forEach((l) => l());
}

interface TimeRangeState {
  /** Grafana relative or absolute time range */
  from: string;
  to: string;
  /** Resolved absolute timestamps in milliseconds */
  fromMs: number;
  toMs: number;
  /** Update the time range (persists to URL) */
  setTimeRange: (from: string, to: string) => void;
  /**
   * Re-resolve a relative range (e.g. now-1h) to fresh absolute timestamps.
   * Auto-refresh must call this before refetching, otherwise every refresh
   * re-queries the window that was resolved when the page first rendered.
   * Consumers with fromMs/toMs in their fetch deps refetch automatically.
   */
  refresh: () => void;
}

/**
 * Shared time range hook that persists from/to in URL search params.
 * All pages and backend API calls should use this for consistent time windows.
 */
export function useTimeRange(): TimeRangeState {
  const [searchParams, setSearchParams] = useSearchParams();

  const from = searchParams.get('from') || DEFAULT_FROM;
  const to = searchParams.get('to') || DEFAULT_TO;

  // Stable fallback for when parsing fails (lazy init runs once, avoids impure Date.now in render)
  const [fallbackNow] = useState(() => Date.now());
  // Bumped by refresh() (any instance's) to re-resolve relative ranges to
  // fresh absolute timestamps.
  const tick = useSyncExternalStore(subscribeTick, readTick);

  const { fromMs, toMs } = useMemo(() => {
    const parsedFrom = dateMath.toDateTime(from, {});
    const parsedTo = dateMath.toDateTime(to, { roundUp: true });
    if (parsedFrom && parsedTo) {
      return {
        fromMs: parsedFrom.valueOf(),
        toMs: parsedTo.valueOf(),
      };
    }
    return { fromMs: fallbackNow - 3600000, toMs: fallbackNow };
    // tick intentionally busts the memo so `now`-relative ranges re-resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, fallbackNow, tick]);

  const refresh = useCallback(() => refreshTimeRange(), []);

  const setTimeRange = useCallback(
    (newFrom: string, newTo: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('from', newFrom);
          next.set('to', newTo);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  return { from, to, fromMs, toMs, setTimeRange, refresh };
}
