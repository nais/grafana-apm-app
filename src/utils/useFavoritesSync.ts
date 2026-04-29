import { useEffect, useMemo, useRef } from 'react';
import { usePluginContext } from '@grafana/data';
import { favoritesStore } from './favoritesStorage';

const REMOTE_KEY = 'favorites';

interface PluginUserStorage {
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
    // Not available
  }
  return null;
}

/**
 * Syncs the local FavoritesStore with Grafana's per-user backend storage.
 *
 * Strategy:
 * - On mount: load remote favorites and merge with local (union of both sets)
 * - On local change: debounce-write to remote
 * - localStorage remains the fast/synchronous source for rendering
 * - Grafana user storage provides cross-device persistence
 *
 * Call this hook once at the app root level.
 */
export function useFavoritesSync(): void {
  const context = usePluginContext();
  const pluginId = context?.meta.id ?? null;

  // Create storage instance once — stable across renders for the same pluginId
  const storage = useMemo(() => (pluginId ? createUserStorage(pluginId) : null), [pluginId]);

  const isSyncing = useRef(false);

  // On mount: hydrate from remote
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
        if (!raw) {
          // Remote is empty — push local state to remote as initial seed
          const local = [...favoritesStore.getSnapshot()];
          if (local.length > 0) {
            await storage!.setItem(REMOTE_KEY, JSON.stringify(local));
          }
          return;
        }

        const remote: string[] = JSON.parse(raw);
        if (!Array.isArray(remote)) {
          return;
        }

        // Merge: union of local + remote (both sources may have unique entries)
        const local = favoritesStore.getSnapshot();
        const merged = new Set([...local, ...remote.filter((s) => typeof s === 'string' && s.includes('/'))]);

        // Only update if there are new entries from remote
        if (merged.size > local.size) {
          isSyncing.current = true;
          for (const key of merged) {
            if (!local.has(key)) {
              favoritesStore.toggle(key);
            }
          }
          isSyncing.current = false;
        }
      } catch {
        // Silently ignore — localStorage continues working as fallback
      }
    }

    hydrate();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  // Subscribe to local changes and write-through to remote (debounced)
  useEffect(() => {
    if (!storage) {
      return;
    }
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = favoritesStore.subscribe(() => {
      if (isSyncing.current) {
        return;
      }

      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        const current = [...favoritesStore.getSnapshot()];
        storage!.setItem(REMOTE_KEY, JSON.stringify(current)).catch(() => {
          // Silently ignore write failures — localStorage is the fallback
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
