import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { dateMath } from '@grafana/data';

const DEFAULT_FROM = 'now-1h';
const DEFAULT_TO = 'now';

export interface TimeRangeState {
  /** Grafana relative or absolute time range */
  from: string;
  to: string;
  /** Resolved absolute timestamps in milliseconds */
  fromMs: number;
  toMs: number;
  /** Update the time range (persists to URL) */
  setTimeRange: (from: string, to: string) => void;
}

/**
 * Shared time range hook that persists from/to in URL search params.
 * All pages and backend API calls should use this for consistent time windows.
 */
export function useTimeRange(): TimeRangeState {
  const [searchParams, setSearchParams] = useSearchParams();

  const from = searchParams.get('from') || DEFAULT_FROM;
  const to = searchParams.get('to') || DEFAULT_TO;

  const { fromMs, toMs } = useMemo(() => {
    const parsedFrom = dateMath.parse(from);
    const parsedTo = dateMath.parse(to, true);
    if (parsedFrom && parsedTo) {
      return {
        fromMs: parsedFrom.valueOf(),
        toMs: parsedTo.valueOf(),
      };
    }
    const now = Date.now();
    return { fromMs: now - 3600000, toMs: now };
  }, [from, to]);

  const setTimeRange = useCallback(
    (newFrom: string, newTo: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('from', newFrom);
        next.set('to', newTo);
        return next;
      }, { replace: true });
    },
    [setSearchParams]
  );

  return { from, to, fromMs, toMs, setTimeRange };
}
