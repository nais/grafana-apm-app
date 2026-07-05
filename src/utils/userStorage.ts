import { useCallback, useEffect, useState } from 'react';
import { usePluginUserStorage } from '@grafana/runtime';

/**
 * Per-user issue mutes (#57 Phase 0), persisted via Grafana's plugin user
 * storage: survives across browsers for signed-in users (Grafana DB backed,
 * localStorage fallback when the API is unavailable). The upstream hook is
 * @alpha — every usage in the plugin goes through this wrapper so an API
 * change lands in one file.
 */
export function useUserMutes(
  namespace: string,
  service: string
): {
  mutes: Set<string>;
  toggleMute: (fingerprint: string) => void;
  loaded: boolean;
} {
  const storage = usePluginUserStorage();
  const key = `mutedIssues:${namespace}/${service}`;
  const [mutes, setMutes] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    storage
      .getItem(key)
      .then((raw) => {
        if (cancelled) {
          return;
        }
        if (raw) {
          try {
            setMutes(new Set(JSON.parse(raw) as string[]));
          } catch {
            setMutes(new Set());
          }
        } else {
          setMutes(new Set());
        }
        setLoaded(true);
      })
      .catch(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
    // storage is a fresh object per render in the current @alpha API —
    // keying on it would refetch in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toggleMute = useCallback(
    (fingerprint: string) => {
      setMutes((prev) => {
        const next = new Set(prev);
        if (next.has(fingerprint)) {
          next.delete(fingerprint);
        } else {
          next.add(fingerprint);
        }
        storage.setItem(key, JSON.stringify(Array.from(next))).catch(() => {});
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  return { mutes, toggleMute, loaded };
}
