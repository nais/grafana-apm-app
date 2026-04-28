import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

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
