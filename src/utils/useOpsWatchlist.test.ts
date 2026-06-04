import { act, renderHook, waitFor } from '@testing-library/react';
import { getOpsWatchlist, saveOpsWatchlist } from '../api/client';
import { useOpsWatchlist } from './useOpsWatchlist';

jest.mock('../api/client', () => ({
  getOpsWatchlist: jest.fn(),
  saveOpsWatchlist: jest.fn(),
}));

const mockGetOpsWatchlist = getOpsWatchlist as jest.Mock;
const mockSaveOpsWatchlist = saveOpsWatchlist as jest.Mock;

describe('useOpsWatchlist', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('loads the watchlist and clears errors', async () => {
    mockGetOpsWatchlist.mockResolvedValue([{ namespace: 'demo', service: 'api' }]);

    const { result } = renderHook(() => useOpsWatchlist());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.watchlist).toEqual([{ namespace: 'demo', service: 'api' }]);
  });

  it('surfaces load errors', async () => {
    mockGetOpsWatchlist.mockRejectedValue(new Error('failed to fetch plugin settings (500): boom'));

    const { result } = renderHook(() => useOpsWatchlist());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('failed to fetch plugin settings (500): boom');
    expect(result.current.watchlist).toEqual([]);
  });

  it('adds entries optimistically and persists them', async () => {
    mockGetOpsWatchlist.mockResolvedValue([]);
    mockSaveOpsWatchlist.mockResolvedValue([]);

    const { result } = renderHook(() => useOpsWatchlist());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.add('demo', 'api');
    });

    expect(result.current.has('demo', 'api')).toBe(true);
    expect(mockSaveOpsWatchlist).toHaveBeenCalledWith([{ namespace: 'demo', service: 'api' }]);
  });
});
