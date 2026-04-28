import { renderHook, act } from '@testing-library/react';
import {
  FavoritesStorage,
  FavoritesStore,
  LocalStorageFavoritesStorage,
  serviceKey,
  STORAGE_KEY,
} from './favoritesStorage';
import { useFavorites } from './useFavorites';

// --- Unit tests for FavoritesStorage ---

describe('LocalStorageFavoritesStorage', () => {
  let storage: LocalStorageFavoritesStorage;

  beforeEach(() => {
    localStorage.clear();
    storage = new LocalStorageFavoritesStorage();
  });

  it('returns empty array when nothing stored', () => {
    expect(storage.load()).toEqual([]);
  });

  it('saves and loads favorites', () => {
    storage.save(['team-a/api', 'team-b/web']);
    expect(storage.load()).toEqual(['team-a/api', 'team-b/web']);
  });

  it('handles corrupted JSON gracefully', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json');
    expect(storage.load()).toEqual([]);
  });

  it('handles wrong schema version', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99, services: ['a/b'] }));
    expect(storage.load()).toEqual([]);
  });

  it('filters out non-string entries', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, services: ['a/b', 123, null] }));
    expect(storage.load()).toEqual(['a/b']);
  });

  it('filters out entries without slash separator', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, services: ['valid/key', 'noslash'] }));
    expect(storage.load()).toEqual(['valid/key']);
  });

  it('handles missing services array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1 }));
    expect(storage.load()).toEqual([]);
  });
});

// --- Unit tests for FavoritesStore ---

describe('FavoritesStore', () => {
  let mockStorage: FavoritesStorage;
  let store: FavoritesStore;

  beforeEach(() => {
    mockStorage = {
      load: jest.fn().mockReturnValue([]),
      save: jest.fn(),
    };
    store = new FavoritesStore(mockStorage);
  });

  afterEach(() => {
    store.destroy();
  });

  it('initializes from storage', () => {
    (mockStorage.load as jest.Mock).mockReturnValue(['ns/svc']);
    const s = new FavoritesStore(mockStorage);
    expect(s.isFavorite('ns/svc')).toBe(true);
    expect(s.getSnapshot().size).toBe(1);
    s.destroy();
  });

  it('toggle adds a service', () => {
    store.toggle('team/api');
    expect(store.isFavorite('team/api')).toBe(true);
    expect(mockStorage.save).toHaveBeenCalledWith(['team/api']);
  });

  it('toggle removes a service', () => {
    store.toggle('team/api');
    store.toggle('team/api');
    expect(store.isFavorite('team/api')).toBe(false);
    expect(mockStorage.save).toHaveBeenLastCalledWith([]);
  });

  it('notifies subscribers on toggle', () => {
    const listener = jest.fn();
    store.subscribe(listener);
    store.toggle('ns/app');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const listener = jest.fn();
    const unsub = store.subscribe(listener);
    unsub();
    store.toggle('ns/app');
    expect(listener).not.toHaveBeenCalled();
  });

  it('handles cross-tab storage event', () => {
    (mockStorage.load as jest.Mock).mockReturnValue(['cross/tab']);
    const listener = jest.fn();
    store.subscribe(listener);

    const event = new StorageEvent('storage', {
      key: STORAGE_KEY,
      storageArea: localStorage,
    });
    window.dispatchEvent(event);

    expect(listener).toHaveBeenCalled();
    expect(store.isFavorite('cross/tab')).toBe(true);
  });

  it('handles localStorage.clear() event (key=null)', () => {
    store.toggle('ns/svc');
    (mockStorage.load as jest.Mock).mockReturnValue([]);
    const listener = jest.fn();
    store.subscribe(listener);

    const event = new StorageEvent('storage', {
      key: null,
      storageArea: localStorage,
    });
    window.dispatchEvent(event);

    expect(store.isFavorite('ns/svc')).toBe(false);
  });

  it('ignores storage events from other keys', () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const event = new StorageEvent('storage', {
      key: 'other-key',
      storageArea: localStorage,
    });
    window.dispatchEvent(event);

    expect(listener).not.toHaveBeenCalled();
  });
});

// --- Unit tests for useFavorites hook ---

describe('useFavorites', () => {
  let mockStorage: FavoritesStorage;
  let store: FavoritesStore;

  beforeEach(() => {
    mockStorage = { load: jest.fn().mockReturnValue([]), save: jest.fn() };
    store = new FavoritesStore(mockStorage);
  });

  afterEach(() => {
    store.destroy();
  });

  it('starts with empty favorites', () => {
    const { result } = renderHook(() => useFavorites(store));
    expect(result.current.count).toBe(0);
    expect(result.current.isFavorite('ns/app')).toBe(false);
  });

  it('toggle adds and removes favorites', () => {
    const { result } = renderHook(() => useFavorites(store));

    act(() => result.current.toggle('ns/app'));
    expect(result.current.isFavorite('ns/app')).toBe(true);
    expect(result.current.count).toBe(1);

    act(() => result.current.toggle('ns/app'));
    expect(result.current.isFavorite('ns/app')).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('persists to storage on toggle', () => {
    const { result } = renderHook(() => useFavorites(store));
    act(() => result.current.toggle('team/svc'));
    expect(mockStorage.save).toHaveBeenCalledWith(['team/svc']);
  });

  it('initializes from pre-existing storage data', () => {
    (mockStorage.load as jest.Mock).mockReturnValue(['a/one', 'b/two']);
    const preloaded = new FavoritesStore(mockStorage);
    const { result } = renderHook(() => useFavorites(preloaded));
    expect(result.current.count).toBe(2);
    expect(result.current.isFavorite('a/one')).toBe(true);
    preloaded.destroy();
  });

  it('reacts to cross-tab storage events', () => {
    const { result } = renderHook(() => useFavorites(store));
    expect(result.current.count).toBe(0);

    (mockStorage.load as jest.Mock).mockReturnValue(['ext/svc']);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, storageArea: localStorage }));
    });

    expect(result.current.isFavorite('ext/svc')).toBe(true);
  });
});

// --- serviceKey helper ---

describe('serviceKey', () => {
  it('creates namespace/name key', () => {
    expect(serviceKey('my-team', 'my-api')).toBe('my-team/my-api');
  });

  it('handles empty namespace', () => {
    expect(serviceKey('', 'svc')).toBe('/svc');
  });
});
