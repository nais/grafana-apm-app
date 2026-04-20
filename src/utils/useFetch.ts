import { useEffect, useRef, useState, useCallback } from 'react';

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

  const [data, setData] = useState<T | null>(initialData);
  const [loading, setLoading] = useState(!skip);
  const [error, setError] = useState<string | null>(null);

  // Track the latest fetch generation to discard stale results
  const generationRef = useRef(0);

  const doFetch = useCallback(() => {
    if (skip) {
      setLoading(false);
      return;
    }

    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);

    fetcher()
      .then((result) => {
        // Only apply if this is still the latest fetch
        if (generation === generationRef.current) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (generation === generationRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    doFetch();
    // Increment generation on cleanup so in-flight fetches become stale
    return () => {
      generationRef.current++;
    };
  }, [doFetch]);

  return { data, loading, error, refetch: doFetch };
}
