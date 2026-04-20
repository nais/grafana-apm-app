import { useEffect, useRef, useState } from 'react';

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Generic data-fetching hook with automatic cancellation on dependency change
 * or unmount. Prevents stale data from overwriting fresh results.
 *
 * @param fetcher  Async function that returns data. Called whenever deps change.
 * @param deps     Dependency array (like useEffect). Fetcher re-runs when deps change.
 * @param options  Optional config: `skip` to disable fetching, `initialData` for default.
 */
export function useFetch<T>(
  fetcher: () => Promise<T>,
  deps: React.DependencyList,
  options?: { skip?: boolean; initialData?: T | null }
): FetchState<T> & { refetch: () => void } {
  const skip = options?.skip ?? false;
  const initialData = options?.initialData ?? null;

  const [state, setState] = useState<FetchState<T>>({
    data: initialData,
    loading: !skip,
    error: null,
  });

  // Keep fetcher in a ref so it's always current without being a dependency
  const fetcherRef = useRef(fetcher);
  const skipRef = useRef(skip);

  useEffect(() => {
    fetcherRef.current = fetcher;
    skipRef.current = skip;
  });

  // Refetch trigger — increment to force a new fetch
  const [fetchTrigger, setFetchTrigger] = useState(0);

  useEffect(() => {
    if (skipRef.current) {
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    fetcherRef
      .current()
      .then((result) => {
        if (!cancelled) {
          setState({ data: result, loading: false, error: null });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setState({ data: null, loading: false, error: e instanceof Error ? e.message : String(e) });
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, fetchTrigger]);

  const refetch = () => setFetchTrigger((t) => t + 1);

  return { ...state, refetch };
}
