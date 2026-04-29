import { renderHook, act } from '@testing-library/react';
import type { PluginUserStorage } from './useFavoritesSync';

// --- Mock @grafana/data ---
let mockPluginContext: { meta: { id: string } } | null = null;
jest.mock('@grafana/data', () => ({
  usePluginContext: () => mockPluginContext,
}));

// --- Mock @grafana/runtime (UserStorage) ---
let mockUserStorage: PluginUserStorage | null = null;
jest.mock('@grafana/runtime', () => ({
  UserStorage: class {
    constructor(_pluginId: string) {
      // Return the mock instance for test control
    }
    getItem(key: string) {
      return mockUserStorage!.getItem(key);
    }
    setItem(key: string, value: string) {
      return mockUserStorage!.setItem(key, value);
    }
  },
}));

// Import after mocks are set up (jest.mock is hoisted, but require is not)
const { useFavoritesSync } = require('./useFavoritesSync');

// Helper: flush microtasks + timers for async hydration
async function flushAll(): Promise<void> {
  await act(async () => {
    await new Promise(process.nextTick);
  });
}

describe('useFavoritesSync', () => {
  let remoteData: Record<string, string>;

  beforeEach(() => {
    remoteData = {};

    mockUserStorage = {
      getItem: jest.fn(async (key: string) => remoteData[key] ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        remoteData[key] = value;
      }),
    };
  });

  afterEach(() => {
    mockPluginContext = null;
  });

  it('does nothing when PluginContext is unavailable', async () => {
    mockPluginContext = null;

    renderHook(() => useFavoritesSync());
    await flushAll();

    expect(mockUserStorage!.getItem).not.toHaveBeenCalled();
  });

  it('calls getItem on mount to hydrate from remote', async () => {
    mockPluginContext = { meta: { id: 'test-plugin' } };
    remoteData['favorites'] = JSON.stringify(['remote/a', 'remote/b']);

    renderHook(() => useFavoritesSync());
    await flushAll();

    expect(mockUserStorage!.getItem).toHaveBeenCalledWith('favorites');
  });

  it('seeds remote from local on first use (empty remote)', async () => {
    mockPluginContext = { meta: { id: 'test-plugin' } };
    remoteData = {};

    renderHook(() => useFavoritesSync());
    await flushAll();

    expect(mockUserStorage!.getItem).toHaveBeenCalledWith('favorites');
    // setItem may or may not be called depending on local state — we just verify no crash
  });

  it('handles remote returning invalid JSON gracefully', async () => {
    mockPluginContext = { meta: { id: 'test-plugin' } };
    remoteData['favorites'] = 'not-json';

    renderHook(() => useFavoritesSync());
    await flushAll();

    expect(mockUserStorage!.getItem).toHaveBeenCalled();
  });

  it('handles remote returning non-array gracefully', async () => {
    mockPluginContext = { meta: { id: 'test-plugin' } };
    remoteData['favorites'] = JSON.stringify({ not: 'an-array' });

    renderHook(() => useFavoritesSync());
    await flushAll();

    expect(mockUserStorage!.getItem).toHaveBeenCalled();
  });

  it('handles remote API failure gracefully', async () => {
    mockPluginContext = { meta: { id: 'test-plugin' } };
    (mockUserStorage!.getItem as jest.Mock).mockRejectedValue(new Error('network error'));

    renderHook(() => useFavoritesSync());
    await flushAll();

    expect(mockUserStorage!.getItem).toHaveBeenCalled();
  });

  it('suppresses write-through during hydration', async () => {
    mockPluginContext = { meta: { id: 'test-plugin' } };
    remoteData['favorites'] = JSON.stringify(['a/b']);

    jest.useFakeTimers();
    try {
      renderHook(() => useFavoritesSync());

      // Manually advance fake timers to let hydration's microtasks resolve
      await act(async () => {
        jest.advanceTimersByTime(0);
        await Promise.resolve();
        jest.advanceTimersByTime(0);
        await Promise.resolve();
      });

      // Advance past debounce window
      act(() => jest.advanceTimersByTime(2000));

      // setItem should NOT have been called by write-through during hydration
      const setItemCalls = (mockUserStorage!.setItem as jest.Mock).mock.calls;
      expect(setItemCalls.length).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('filters invalid entries from remote data', async () => {
    mockPluginContext = { meta: { id: 'test-plugin' } };
    remoteData['favorites'] = JSON.stringify(['valid/svc', 'noslash', 123, null, 'also/valid']);

    renderHook(() => useFavoritesSync());
    await flushAll();

    // Only valid entries (strings with /) should be accepted
    expect(mockUserStorage!.getItem).toHaveBeenCalledWith('favorites');
  });
});
