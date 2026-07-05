import React, { useEffect } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useExceptionDrawerState } from './useExceptionDrawer';
import * as client from '../../../api/client';

jest.mock('../../../api/client', () => ({
  ...jest.requireActual('../../../api/client'),
  getExceptionGroups: jest.fn(),
}));

const getExceptionGroups = client.getExceptionGroups as jest.Mock;

/**
 * Shared by the Frontend and Issues tabs (#69 P10): whichever tab renders
 * <ExceptionDrawer>, both resolve issueId/exceptionHash through this one
 * hook, so a deep link opens the drawer identically on either.
 */
function renderWithRouter(initialEntries: string[]) {
  let lastSearch = '';
  const { result } = renderHook(() => useExceptionDrawerState('ns', 'svc'), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={initialEntries}>
        <LocationCapture onChange={(s) => (lastSearch = s)} />
        {children}
      </MemoryRouter>
    ),
  });
  return { result, getSearch: () => lastSearch };
}

function LocationCapture({ onChange }: { onChange: (search: string) => void }) {
  const location = useLocation();
  useEffect(() => {
    onChange(location.search);
  }, [location.search, onChange]);
  return null;
}

beforeEach(() => {
  getExceptionGroups.mockReset().mockResolvedValue({ fingerprintVersion: 'v1', groups: [] });
});

describe('useExceptionDrawerState', () => {
  it('resolves issueId to the matching group member hashes', async () => {
    getExceptionGroups.mockResolvedValue({
      fingerprintVersion: 'v1',
      groups: [{ fingerprint: 'v1:aaaa', title: 'Boom', tier: 2, count: 1, sessions: 1, memberHashes: ['h1', 'h2'] }],
    });
    const { result } = renderWithRouter(['/?issueId=v1:aaaa']);

    await waitFor(() => expect(result.current.drawerHashes).toEqual(['h1', 'h2']));
    expect(result.current.selectedGroupTitle).toBe('Boom');
    expect(result.current.selectedIssueId).toBe('v1:aaaa');
  });

  it('falls back to exceptionHash when there is no issueId', () => {
    const { result } = renderWithRouter(['/?exceptionHash=abc123']);

    expect(result.current.drawerHashes).toEqual(['abc123']);
    expect(result.current.selectedIssueId).toBe('');
    expect(result.current.selectedHash).toBe('abc123');
  });

  it('returns null hashes when issueId has no matching group yet', async () => {
    getExceptionGroups.mockResolvedValue({ fingerprintVersion: 'v1', groups: [] });
    const { result } = renderWithRouter(['/?issueId=v1:missing']);

    await waitFor(() => expect(getExceptionGroups).toHaveBeenCalled());
    expect(result.current.drawerHashes).toBeNull();
  });

  it('returns null when neither issueId nor exceptionHash is set', () => {
    const { result } = renderWithRouter(['/']);
    expect(result.current.drawerHashes).toBeNull();
  });

  it('reports drawerLoading while a fresh issueId resolves, then clears it', async () => {
    // Hold the groups fetch open so the "resolving" window is observable.
    let resolve!: (v: unknown) => void;
    getExceptionGroups.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const { result } = renderWithRouter(['/?issueId=v1:aaaa']);

    // Deep link set, hashes not resolved yet → loading drawer, no hashes.
    expect(result.current.drawerLoading).toBe(true);
    expect(result.current.drawerHashes).toBeNull();

    await act(async () => {
      resolve({
        fingerprintVersion: 'v1',
        groups: [{ fingerprint: 'v1:aaaa', title: 'Boom', tier: 2, count: 1, sessions: 1, memberHashes: ['h1'] }],
      });
    });

    await waitFor(() => expect(result.current.drawerHashes).toEqual(['h1']));
    expect(result.current.drawerLoading).toBe(false);
  });

  it('never sets drawerLoading for a bare exceptionHash (resolves synchronously)', () => {
    const { result } = renderWithRouter(['/?exceptionHash=abc123']);
    expect(result.current.drawerLoading).toBe(false);
    expect(result.current.drawerHashes).toEqual(['abc123']);
  });

  it('closeDrawer clears issueId, exceptionHash, and exceptionSessionId in one transaction', async () => {
    const { result, getSearch } = renderWithRouter([
      '/?issueId=v1:aaaa&exceptionHash=abc123&exceptionSessionId=sess-1&environment=prod-gcp',
    ]);

    act(() => result.current.closeDrawer());

    await waitFor(() => {
      const params = new URLSearchParams(getSearch());
      expect(params.get('issueId')).toBeNull();
      expect(params.get('exceptionHash')).toBeNull();
      expect(params.get('exceptionSessionId')).toBeNull();
      // Unrelated params survive the transaction.
      expect(params.get('environment')).toBe('prod-gcp');
    });
  });
});
