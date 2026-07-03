import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Batch URL-param updater: applies every change in ONE setSearchParams call.
 *
 * Rule: one user action = one atomic params transaction. Sequential
 * single-param updates race each other under React 18 batching (each update
 * re-runs against a different snapshot) — the root cause of the
 * ExceptionDrawer close/reopen loop fixed across v0.13.2–v0.13.4.
 *
 * Pass a string to set a param; pass null/undefined/'' to delete it.
 */
export function useUrlParams(): (
  changes: Record<string, string | null | undefined>,
  opts?: { replace?: boolean }
) => void {
  const [, setSearchParams] = useSearchParams();
  return useCallback(
    (changes, opts) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === undefined || value === '') {
            params.delete(key);
          } else {
            params.set(key, value);
          }
        }
        return params;
      }, opts);
    },
    [setSearchParams]
  );
}

/**
 * URL-backed string state. Reads/writes a single query parameter.
 * When value equals defaultValue, the param is removed from the URL to keep it clean.
 */
export function useUrlString(key: string, defaultValue = ''): [string, (v: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(key) ?? defaultValue;

  const setValue = useCallback(
    (next: string) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        if (next === defaultValue || next === '') {
          params.delete(key);
        } else {
          params.set(key, next);
        }
        return params;
      });
    },
    [key, defaultValue, setSearchParams]
  );

  return [value, setValue];
}

/**
 * URL-backed comma-separated array state.
 * Empty array removes the param from URL.
 */
export function useUrlCsv(key: string): [string[], (v: string[]) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key) ?? '';
  const value = useMemo(() => (raw ? raw.split(',').filter(Boolean) : []), [raw]);

  const setValue = useCallback(
    (next: string[]) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        if (next.length === 0) {
          params.delete(key);
        } else {
          params.set(key, next.join(','));
        }
        return params;
      });
    },
    [key, setSearchParams]
  );

  return [value, setValue];
}

/**
 * URL-backed boolean state. Stored as 'true'/'false' string.
 * When value is the default, the param is removed.
 */
export function useUrlBoolean(key: string, defaultValue = false): [boolean, (v: boolean) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key);
  const value = raw !== null ? raw === 'true' : defaultValue;

  const setValue = useCallback(
    (next: boolean) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        if (next === defaultValue) {
          params.delete(key);
        } else {
          params.set(key, String(next));
        }
        return params;
      });
    },
    [key, defaultValue, setSearchParams]
  );

  return [value, setValue];
}

/**
 * URL-backed numeric state. Stored as string, parsed as number.
 * When value equals defaultValue, the param is removed.
 */
export function useUrlNumber(key: string, defaultValue: number): [number, (v: number) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key);
  const value = raw !== null ? Number(raw) : defaultValue;

  const setValue = useCallback(
    (next: number) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        if (next === defaultValue) {
          params.delete(key);
        } else {
          params.set(key, String(next));
        }
        return params;
      });
    },
    [key, defaultValue, setSearchParams]
  );

  return [value, setValue];
}
