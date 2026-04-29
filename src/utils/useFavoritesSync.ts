import { useEffect, useMemo, useRef } from 'react';
import { usePluginContext } from '@grafana/data';
import { favoritesStore } from './favoritesStorage';

const REMOTE_KEY = 'favorites';

export interface PluginUserStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * Get the user storage instance directly — avoids the hook that throws
 * when PluginContext is missing (e.g., in tests).
 */
function createUserStorage(pluginId: string): PluginUserStorage | null {
  try {
    const runtime = require('@grafana/runtime') as { UserStorage?: new (id: string) => PluginUserStorage };
    const { UserStorage } = runtime;
    if (UserStorage) {
      return new UserStorage(pluginId);
    }
  } catch {
    // Not available (e.g., test environment)
  }
  return null;
}

/** Parse and validate a remote favorites JSON string into a Set. */
function parseRemoteFavorites(raw: string): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return new Set(parsed.filter((s): s is string => typeof s === 'string' && s.includes('/')));
  } catch {
    return null;
  }
}

/**
 * Syncs the local FavoritesStore with Grafana's per-user backend storage.
 *
 * Model: **remote-authoritative**
 * - localStorage is a fast cache for instant rendering (no loading flash)
 * - On mount: remote state replaces local state (deletions propagate across devices)
 * - If remote is empty and local has data, local is seeded to remote (one-time migration)
 * - On user toggle: optimistic local update + debounced write-through to remote
 *
 * Call this hook once at the app root level.
 */
export function useFavoritesSync(): void {
  const context = usePluginContext();
  const pluginId = context?.meta.id ?? null;

  // Stable storage instance for the lifetime of the plugin
  const storage = useMemo(() => (pluginId ? createUserStorage(pluginId) : null), [pluginId]);

  // Write-through is only enabled after initial hydration completes
  const hydrated = useRef(false);

  // Hydrate: load remote state → replace local
  useEffect(() => {
    if (!storage) {
      return;
    }
    let cancelled = false;

    async function hydrate() {
      try {
        const raw = await storage!.getItem(REMOTE_KEY);
        if (cancelled) {
          return;
        }

        if (raw) {
          // Remote has data — it is authoritative, replace local
          const remote = parseRemoteFavorites(raw);
          if (remote) {
            favoritesStore.replaceAll(remote);
          }
        } else {
          // Remote is empty — seed from local (one-time migration)
          const local = [...favoritesStore.getSnapshot()];
          if (local.length > 0) {
            await storage!.setItem(REMOTE_KEY, JSON.stringify(local));
          }
        }
      } catch {
        // Remote unavailable — localStorage continues working as standalone fallback
      }

      if (!cancelled) {
        hydrated.current = true;
      }
    }

    hydrate();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  // Write-through: debounced sync of local changes to remote
  useEffect(() => {
    if (!storage) {
      return;
    }
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = favoritesStore.subscribe(() => {
      // Suppress write-through until hydration is complete to avoid
      // writing stale local state back to remote
      if (!hydrated.current) {
        return;
      }

      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        const current = [...favoritesStore.getSnapshot()];
        storage!.setItem(REMOTE_KEY, JSON.stringify(current)).catch(() => {
          // Silently ignore — localStorage has the data, next toggle retries
        });
      }, 1000); // 1s debounce to batch rapid toggles
    });

    return () => {
      unsubscribe();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [storage]);
}
