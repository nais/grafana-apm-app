import { renderHook, waitFor } from '@testing-library/react';
import {
  initDatasourceConfig,
  usePluginDatasources,
  useConfiguredEnvironments,
  useHasEnvironmentOverrides,
  _resetForTesting,
  _resolveUidForTesting as resolveUid,
} from './datasources';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

beforeEach(() => {
  _resetForTesting();
  mockFetch.mockReset();
});

describe('resolveUid', () => {
  it('returns env-specific UID when available', () => {
    const ds = {
      uid: 'default-tempo',
      byEnvironment: { production: { uid: 'prod-tempo' } },
    };
    expect(resolveUid(ds, 'production', 'fallback')).toBe('prod-tempo');
  });

  it('returns default UID when env has no override', () => {
    const ds = {
      uid: 'default-tempo',
      byEnvironment: { production: { uid: 'prod-tempo' } },
    };
    expect(resolveUid(ds, 'staging', 'fallback')).toBe('default-tempo');
  });

  it('returns fallback when ds has no UID', () => {
    expect(resolveUid({}, undefined, 'fallback')).toBe('fallback');
  });

  it('returns fallback when ds is undefined', () => {
    expect(resolveUid(undefined, undefined, 'tempo')).toBe('tempo');
  });

  it('returns default UID when env is undefined', () => {
    const ds = {
      uid: 'default-tempo',
      byEnvironment: { production: { uid: 'prod-tempo' } },
    };
    expect(resolveUid(ds, undefined, 'fallback')).toBe('default-tempo');
  });

  it('returns default UID when env is empty string', () => {
    const ds = {
      uid: 'default-tempo',
      byEnvironment: { production: { uid: 'prod-tempo' } },
    };
    expect(resolveUid(ds, '', 'fallback')).toBe('default-tempo');
  });

  it('returns fallback when byEnvironment entry has no uid', () => {
    const ds = {
      uid: 'default-tempo',
      byEnvironment: { production: { type: 'tempo' } },
    };
    expect(resolveUid(ds, 'production', 'fallback')).toBe('default-tempo');
  });
});

describe('initDatasourceConfig', () => {
  it('fetches plugin settings and caches result', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonData: {
          metricsDataSource: { uid: 'my-mimir' },
          tracesDataSource: { uid: 'my-tempo' },
          logsDataSource: { uid: 'my-loki' },
        },
      }),
    });

    initDatasourceConfig();

    // Wait for fetch to resolve
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/plugins/'));
  });

  it('deduplicates concurrent init calls', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ jsonData: {} }),
    });

    initDatasourceConfig();
    initDatasourceConfig();
    initDatasourceConfig();

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });

  it('does not re-fetch after cache is populated', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ jsonData: {} }),
    });

    initDatasourceConfig();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Second init should be a no-op since cache is already populated
    initDatasourceConfig();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty object on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    initDatasourceConfig();

    // Should not throw; hook should return defaults
    const { result } = renderHook(() => usePluginDatasources());
    await waitFor(() => {
      // After failed fetch, should use fallback defaults
      expect(result.current.metricsUid).toBe('mimir');
    });
  });

  it('returns empty object on non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    initDatasourceConfig();

    const { result } = renderHook(() => usePluginDatasources());
    await waitFor(() => {
      expect(result.current.metricsUid).toBe('mimir');
    });
  });
});

describe('usePluginDatasources', () => {
  it('returns fallback UIDs before fetch completes', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    initDatasourceConfig();

    const { result } = renderHook(() => usePluginDatasources());
    expect(result.current.metricsUid).toBe('mimir');
    expect(result.current.tracesUid).toBe('tempo');
    expect(result.current.logsUid).toBe('loki');
    expect(result.current.isEnvSpecific).toBe(false);
  });

  it('returns configured UIDs after fetch completes', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonData: {
          metricsDataSource: { uid: 'custom-mimir' },
          tracesDataSource: { uid: 'custom-tempo' },
          logsDataSource: { uid: 'custom-loki' },
        },
      }),
    });

    initDatasourceConfig();

    const { result } = renderHook(() => usePluginDatasources());
    await waitFor(() => {
      expect(result.current.metricsUid).toBe('custom-mimir');
    });
    expect(result.current.tracesUid).toBe('custom-tempo');
    expect(result.current.logsUid).toBe('custom-loki');
    expect(result.current.isEnvSpecific).toBe(false);
  });

  it('resolves env-specific UIDs when env provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonData: {
          metricsDataSource: { uid: 'mimir' },
          tracesDataSource: {
            uid: 'default-tempo',
            byEnvironment: { prod: { uid: 'prod-tempo' } },
          },
          logsDataSource: {
            uid: 'default-loki',
            byEnvironment: { prod: { uid: 'prod-loki' } },
          },
        },
      }),
    });

    initDatasourceConfig();

    const { result } = renderHook(() => usePluginDatasources('prod'));
    await waitFor(() => {
      expect(result.current.tracesUid).toBe('prod-tempo');
    });
    expect(result.current.logsUid).toBe('prod-loki');
    expect(result.current.isEnvSpecific).toBe(true);
  });
});

describe('useConfiguredEnvironments', () => {
  it('returns empty array when no env overrides', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonData: {
          tracesDataSource: { uid: 'tempo' },
          logsDataSource: { uid: 'loki' },
        },
      }),
    });

    initDatasourceConfig();

    const { result } = renderHook(() => useConfiguredEnvironments());
    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it('returns sorted union of traces and logs environments', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonData: {
          tracesDataSource: {
            uid: 'tempo',
            byEnvironment: { production: { uid: 'p-tempo' }, staging: { uid: 's-tempo' } },
          },
          logsDataSource: {
            uid: 'loki',
            byEnvironment: { production: { uid: 'p-loki' }, dev: { uid: 'd-loki' } },
          },
        },
      }),
    });

    initDatasourceConfig();

    const { result } = renderHook(() => useConfiguredEnvironments());
    await waitFor(() => {
      expect(result.current).toEqual(['dev', 'production', 'staging']);
    });
  });
});

describe('useHasEnvironmentOverrides', () => {
  it('returns false when no overrides', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ jsonData: {} }),
    });

    initDatasourceConfig();

    const { result } = renderHook(() => useHasEnvironmentOverrides());
    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it('returns true when overrides exist', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonData: {
          tracesDataSource: {
            uid: 'tempo',
            byEnvironment: { prod: { uid: 'p' } },
          },
        },
      }),
    });

    initDatasourceConfig();

    const { result } = renderHook(() => useHasEnvironmentOverrides());
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });
});
