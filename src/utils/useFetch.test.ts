import { renderHook, waitFor, act } from '@testing-library/react';
import { useFetch } from './useFetch';

describe('useFetch', () => {
  it('fetches data successfully', async () => {
    const fetcher = jest.fn().mockResolvedValue({ value: 42 });
    const { result } = renderHook(() => useFetch(fetcher, []));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('handles fetch errors', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useFetch(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe('Network error');
  });

  it('discards stale results when deps change', async () => {
    let resolvers: Array<(v: string) => void> = [];
    const fetcher = jest.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const { result, rerender } = renderHook(({ dep }) => useFetch(() => fetcher(dep), [dep]), {
      initialProps: { dep: 'a' },
    });

    // First fetch is in flight
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Change deps before first fetch resolves
    rerender({ dep: 'b' });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Resolve the SECOND fetch first
    resolvers[1]!('result-b');
    await waitFor(() => expect(result.current.data).toBe('result-b'));

    // Now resolve the stale FIRST fetch — it should be ignored
    resolvers[0]!('result-a');

    // Give React a tick to process
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.data).toBe('result-b');
  });

  it('skips fetching when skip is true', async () => {
    const fetcher = jest.fn().mockResolvedValue('data');
    const { result } = renderHook(() => useFetch(fetcher, [], { skip: true }));

    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses initialData when provided', async () => {
    const fetcher = jest.fn().mockResolvedValue('fresh');
    const { result } = renderHook(() => useFetch(fetcher, [], { initialData: 'cached' }));

    // Initially shows cached data
    expect(result.current.data).toBe('cached');

    // After fetch completes, shows fresh data
    await waitFor(() => expect(result.current.data).toBe('fresh'));
  });

  it('starts fetching when skip transitions from true to false', async () => {
    const fetcher = jest.fn().mockResolvedValue('lazy-data');
    const { result, rerender } = renderHook(({ skip }) => useFetch(fetcher, [], { skip }), {
      initialProps: { skip: true },
    });

    // Initially skipped — no fetch
    await new Promise((r) => setTimeout(r, 50));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();

    // Now enable fetching
    rerender({ skip: false });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('lazy-data');
  });

  it('preserves stale data on refetch error', async () => {
    let callCount = 0;
    const fetcher = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve('good-data');
      }
      return Promise.reject(new Error('refetch failed'));
    });

    const { result, rerender } = renderHook(({ dep }) => useFetch(() => fetcher(dep), [dep]), {
      initialProps: { dep: 'a' },
    });

    // First fetch succeeds
    await waitFor(() => expect(result.current.data).toBe('good-data'));

    // Change deps to trigger refetch that fails
    rerender({ dep: 'b' });

    await waitFor(() => expect(result.current.error).toBe('refetch failed'));

    // Stale data should still be available
    expect(result.current.data).toBe('good-data');
    expect(result.current.stale).toBe(false);
  });

  it('calls refetch when invoked', async () => {
    let callCount = 0;
    const fetcher = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(`data-${callCount}`);
    });

    const { result } = renderHook(() => useFetch(fetcher, []));

    await waitFor(() => expect(result.current.data).toBe('data-1'));

    // Trigger manual refetch
    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.data).toBe('data-2'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
