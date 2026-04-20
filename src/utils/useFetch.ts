import { useEffect, useRef, useState } from 'react';

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** True when we have stale data and a refetch is in progress */
  stale: boolean;
}

/**
 * Generic data-fetching hook with stale-while-revalidate semantics.
 *
 * When deps change, if we already have data, keeps showing the previous
 * result (with `stale: true`) while the new fetch runs in the background.
 * This prevents the UI from flashing a loading spinner on every refetch.
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
    stale: false,
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

    // Stale-while-revalidate: keep existing data visible, mark as stale
    setState((s) => ({
      ...s,
      loading: s.data === null,
      stale: s.data !== null,
      error: null,
    }));

    fetcherRef
      .current()
      .then((result) => {
        if (!cancelled) {
          setState({ data: result, loading: false, error: null, stale: false });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          // On error, keep stale data if available
          setState((s) => ({
            data: s.data,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
            stale: false,
          }));
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
