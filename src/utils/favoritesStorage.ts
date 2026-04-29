/**
 * Favorites storage abstraction — localStorage implementation with
 * versioned schema and subscribable store for React integration.
 */

const STORAGE_KEY = 'nais-apm-favorites';

interface StorageSchema {
  version: 1;
  services: string[];
}

// --- Storage Interface ---

export interface FavoritesStorage {
  load(): string[];
  save(keys: string[]): void;
}

// --- localStorage Implementation ---

export class LocalStorageFavoritesStorage implements FavoritesStorage {
  load(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const data: StorageSchema = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.services)) {
        return [];
      }
      return data.services.filter((s) => typeof s === 'string' && s.includes('/'));
    } catch {
      return [];
    }
  }

  save(keys: string[]): void {
    try {
      const schema: StorageSchema = { version: 1, services: keys };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(schema));
    } catch {
      // localStorage may be unavailable (private mode, quota exceeded)
    }
  }
}

// --- Subscribable Store (for useSyncExternalStore) ---

type Listener = () => void;

export class FavoritesStore {
  private storage: FavoritesStorage;
  private snapshot: Set<string>;
  private listeners = new Set<Listener>();

  constructor(storage: FavoritesStorage = new LocalStorageFavoritesStorage()) {
    this.storage = storage;
    this.snapshot = new Set(storage.load());

    // Cross-tab sync via storage event
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorageEvent);
    }
  }

  private handleStorageEvent = (e: StorageEvent) => {
    // e.key is null when localStorage.clear() is called
    if (e.storageArea === localStorage && (e.key === STORAGE_KEY || e.key === null)) {
      this.snapshot = new Set(this.storage.load());
      this.notify();
    }
  };

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Set<string> => {
    return this.snapshot;
  };

  toggle(key: string): void {
    const next = new Set(this.snapshot);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.snapshot = next;
    this.storage.save([...next]);
    this.notify();
  }

  /** Replace all favorites at once (used by sync layer to apply remote state). */
  replaceAll(keys: Set<string>): void {
    this.snapshot = keys;
    this.storage.save([...keys]);
    this.notify();
  }

  isFavorite(key: string): boolean {
    return this.snapshot.has(key);
  }

  destroy() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleStorageEvent);
    }
    this.listeners.clear();
  }
}

// --- Helpers ---

export function serviceKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

// Singleton instance for the app
export const favoritesStore = new FavoritesStore();

export { STORAGE_KEY };
