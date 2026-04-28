import { useCallback, useSyncExternalStore } from 'react';
import { favoritesStore, serviceKey, FavoritesStore } from './favoritesStorage';

export { serviceKey };

/**
 * React hook for managing favorite services.
 * Uses useSyncExternalStore for same-tab + cross-tab reactivity.
 */
export function useFavorites(store: FavoritesStore = favoritesStore) {
  const favorites = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const toggle = useCallback(
    (key: string) => {
      store.toggle(key);
    },
    [store]
  );

  const isFavorite = useCallback((key: string) => favorites.has(key), [favorites]);

  return { favorites, toggle, isFavorite, count: favorites.size };
}
