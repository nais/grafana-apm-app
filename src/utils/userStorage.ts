import { useCallback, useEffect, useRef, useState } from 'react';
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

export function usePinnedMetrics(namespace: string, service: string) {
  const storage = usePluginUserStorage();
  const storageRef = useRef(storage);
  const key = `selectedMetrics:${namespace}/${service}`;
  const [state, setState] = useState<{ key: string; metrics: string[]; loaded: boolean; error: string | null }>({
    key,
    metrics: [],
    loaded: false,
    error: null,
  });
  const edited = useRef(false);
  const pendingWrite = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    edited.current = false;
    storageRef.current
      .getItem(key)
      .then((raw) => {
        if (cancelled || edited.current) {
          return;
        }
        if (raw == null) {
          setState({ key, metrics: [], loaded: true, error: null });
          return;
        }
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!Array.isArray(parsed) || parsed.length > 3 || !parsed.every((name) => typeof name === 'string')) {
            throw new Error('Invalid saved metric selections');
          }
          setState({ key, metrics: parsed, loaded: true, error: null });
        } catch (error) {
          setState({
            key,
            metrics: [],
            loaded: true,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && !edited.current) {
          setState({
            key,
            metrics: [],
            loaded: true,
            error: `Could not load saved metrics: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const save = useCallback(
    (metrics: string[]) => {
      edited.current = true;
      setState({ key, metrics, loaded: true, error: null });
      pendingWrite.current = pendingWrite.current
        .then(() => storageRef.current.setItem(key, JSON.stringify(metrics)))
        .then(() => {
          setState((current) => (current.key === key ? { ...current, error: null } : current));
        })
        .catch((error: unknown) => {
          setState((current) =>
            current.key === key
              ? {
                  ...current,
                  error: `Could not save selected metrics: ${error instanceof Error ? error.message : String(error)}`,
                }
              : current
          );
        });
    },
    [key]
  );

  return {
    metrics: state.key === key ? state.metrics : [],
    loaded: state.key === key && state.loaded,
    error: state.key === key ? state.error : null,
    save,
  };
}
