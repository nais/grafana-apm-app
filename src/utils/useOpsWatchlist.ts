import { useCallback, useEffect, useRef, useState } from 'react';
import { getOpsWatchlist, saveOpsWatchlist, OpsWatchlistEntry } from '../api/client';

export type { OpsWatchlistEntry } from '../api/client';

interface UseOpsWatchlistResult {
  watchlist: OpsWatchlistEntry[];
  loading: boolean;
  /** Add a service to the watchlist. */
  add: (namespace: string, service: string) => void;
  /** Remove a service from the watchlist by namespace/service. */
  remove: (namespace: string, service: string) => void;
  /** Check if a namespace/service is on the watchlist. */
  has: (namespace: string, service: string) => boolean;
  /** Reload the watchlist from the server. */
  refetch: () => void;
}

function entryKey(ns: string, svc: string): string {
  return `${ns}/${svc}`;
}

/**
 * Hook for the shared ops watchlist stored in plugin settings (server-side).
 * Any authenticated user can read and write — the backend uses its service
 * account token to update plugin jsonData.
 */
export function useOpsWatchlist(): UseOpsWatchlistResult {
  const [watchlist, setWatchlist] = useState<OpsWatchlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const doFetch = useCallback(() => {
    getOpsWatchlist()
      .then((data) => {
        if (mountedRef.current) {
          setWatchlist(data ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    doFetch();
    return () => {
      mountedRef.current = false;
    };
  }, [doFetch]);

  const refetch = useCallback(() => {
    setLoading(true);
    doFetch();
  }, [doFetch]);

  const persist = useCallback(
    (entries: OpsWatchlistEntry[]) => {
      setWatchlist(entries);
      saveOpsWatchlist(entries).catch(() => {
        // Revert on error — refetch to get server state
        if (mountedRef.current) {
          doFetch();
        }
      });
    },
    [doFetch]
  );

  const add = useCallback(
    (namespace: string, service: string) => {
      setWatchlist((prev) => {
        if (prev.some((e) => e.namespace === namespace && e.service === service)) {
          return prev;
        }
        const next = [...prev, { namespace, service }];
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const remove = useCallback(
    (namespace: string, service: string) => {
      setWatchlist((prev) => {
        const next = prev.filter((e) => !(e.namespace === namespace && e.service === service));
        if (next.length === prev.length) {
          return prev;
        }
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const has = useCallback(
    (namespace: string, service: string) => {
      return watchlist.some((e) => e.namespace === namespace && e.service === service);
    },
    [watchlist]
  );

  return { watchlist, loading, add, remove, has, refetch };
}

/** Build a lookup set from watchlist entries for efficient filtering. */
export function watchlistToSet(watchlist: OpsWatchlistEntry[]): Set<string> {
  const set = new Set<string>();
  for (const e of watchlist) {
    set.add(entryKey(e.namespace, e.service));
  }
  return set;
}

export { entryKey as watchlistKey };
