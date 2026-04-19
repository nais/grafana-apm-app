import { useState, useEffect } from 'react';

/**
 * Debounce a value by the given delay (ms).
 * Returns the debounced value that only updates after the delay.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/**
 * Escape regex special characters in a string for safe interpolation
 * into LogQL (|~ "pattern") or TraceQL (name=~"pattern").
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
