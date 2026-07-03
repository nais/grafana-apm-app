import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { dateMath } from '@grafana/data';

const DEFAULT_FROM = 'now-1h';
const DEFAULT_TO = 'now';

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
  // Bumped by refresh() to re-resolve relative ranges to fresh absolute timestamps.
  const [resolveTick, setResolveTick] = useState(0);

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
    // resolveTick intentionally busts the memo so `now`-relative ranges re-resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, fallbackNow, resolveTick]);

  const refresh = useCallback(() => setResolveTick((t) => t + 1), []);

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
