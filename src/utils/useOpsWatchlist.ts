import { useCallback, useEffect, useRef, useState } from 'react';
import { getOpsWatchlist, saveOpsWatchlist, OpsWatchlistEntry } from '../api/client';

export type { OpsWatchlistEntry } from '../api/client';

interface UseOpsWatchlistResult {
  watchlist: OpsWatchlistEntry[];
  loading: boolean;
  error: string | null;
  /** Add a service (in one environment) to the watchlist. */
  add: (namespace: string, service: string, environment?: string) => void;
  /** Remove a service (in one environment) from the watchlist. */
  remove: (namespace: string, service: string, environment?: string) => void;
  /** Check if a service (in one environment) is on the watchlist. */
  has: (namespace: string, service: string, environment?: string) => boolean;
  /** Reload the watchlist from the server. */
  refetch: () => void;
}

function entryKey(ns: string, svc: string, env?: string): string {
  return `${ns}/${svc}/${env ?? ''}`;
}

/**
 * Hook for the shared ops watchlist stored in plugin settings (server-side).
 * Any authenticated user can read and write — the backend uses its service
 * account token to update plugin jsonData.
 */
export function useOpsWatchlist(): UseOpsWatchlistResult {
  const [watchlist, setWatchlist] = useState<OpsWatchlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const doFetch = useCallback(() => {
    getOpsWatchlist()
      .then((data) => {
        if (mountedRef.current) {
          setWatchlist(Array.isArray(data) ? data : []);
          setLoading(false);
          setError(null);
        }
      })
      .catch((err) => {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
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

  // Use a ref to track the latest watchlist for computing optimistic updates
  // without needing to re-create callbacks on every state change.
  const watchlistRef = useRef<OpsWatchlistEntry[]>(watchlist);
  useEffect(() => {
    watchlistRef.current = watchlist;
  }, [watchlist]);

  const persist = useCallback(
    (entries: OpsWatchlistEntry[]) => {
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
    (namespace: string, service: string, environment?: string) => {
      const prev = watchlistRef.current;
      if (
        prev.some((e) => entryKey(e.namespace, e.service, e.environment) === entryKey(namespace, service, environment))
      ) {
        return;
      }
      const next = [...prev, { namespace, service, environment }];
      setWatchlist(next);
      persist(next);
    },
    [persist]
  );

  const remove = useCallback(
    (namespace: string, service: string, environment?: string) => {
      const prev = watchlistRef.current;
      const target = entryKey(namespace, service, environment);
      const next = prev.filter((e) => entryKey(e.namespace, e.service, e.environment) !== target);
      if (next.length === prev.length) {
        return;
      }
      setWatchlist(next);
      persist(next);
    },
    [persist]
  );

  const has = useCallback(
    (namespace: string, service: string, environment?: string) => {
      const target = entryKey(namespace, service, environment);
      return watchlist.some((e) => entryKey(e.namespace, e.service, e.environment) === target);
    },
    [watchlist]
  );

  return { watchlist, loading, error, add, remove, has, refetch };
}

/** Build a lookup set from watchlist entries for efficient filtering. */
export function watchlistToSet(watchlist: OpsWatchlistEntry[]): Set<string> {
  const set = new Set<string>();
  for (const e of watchlist) {
    set.add(entryKey(e.namespace, e.service, e.environment));
  }
  return set;
}

export { entryKey as watchlistKey };
