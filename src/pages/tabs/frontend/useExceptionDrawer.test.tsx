import React, { useEffect } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useExceptionDrawerState } from './useExceptionDrawer';
import * as client from '../../../api/client';

jest.mock('../../../api/client', () => ({
  ...jest.requireActual('../../../api/client'),
  getIssues: jest.fn(),
}));

const getIssues = client.getIssues as jest.Mock;

function issue(overrides: Partial<client.UnifiedIssue>): client.UnifiedIssue {
  return {
    fingerprint: 'v1:aaaa',
    tier: 2,
    title: 'Boom',
    count: 1,
    sessions: 1,
    memberHashes: [],
    source: 'browser',
    ...overrides,
  };
}

/**
 * Shared by the Frontend and Issues tabs (#69 P10): whichever tab renders
 * <ExceptionDrawer>, both resolve issueId/exceptionHash through this one
 * hook, so a deep link opens the drawer identically on either. The unified
 * issues list is the single resolver (#84): it carries each issue's source and
 * member hashes.
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

function issuesResponse(issues: client.UnifiedIssue[]): client.IssuesResponse {
  return { fingerprintVersion: 'v1', sources: { browser: true, serverLogs: true }, issues };
}

beforeEach(() => {
  getIssues.mockReset().mockResolvedValue(issuesResponse([]));
});

describe('useExceptionDrawerState', () => {
  it('resolves a browser issueId to its member hashes and source', async () => {
    getIssues.mockResolvedValue(issuesResponse([issue({ fingerprint: 'v1:aaaa', memberHashes: ['h1', 'h2'] })]));
    const { result } = renderWithRouter(['/?issueId=v1:aaaa']);

    await waitFor(() => expect(result.current.drawerHashes).toEqual(['h1', 'h2']));
    expect(result.current.source).toBe('browser');
    expect(result.current.selectedGroupTitle).toBe('Boom');
    expect(result.current.selectedIssueId).toBe('v1:aaaa');
  });

  it('resolves a server issueId to source=server with no hashes', async () => {
    getIssues.mockResolvedValue(
      issuesResponse([issue({ fingerprint: 'v1:srv', source: 'server', title: 'PSQLException', memberHashes: [] })])
    );
    const { result } = renderWithRouter(['/?issueId=v1:srv']);

    await waitFor(() => expect(result.current.source).toBe('server'));
    // Server issues open on source alone — empty hashes, never null (which would
    // read as "still resolving") once resolved.
    expect(result.current.drawerHashes).toEqual([]);
    expect(result.current.selectedGroupTitle).toBe('PSQLException');
  });

  it('falls back to exceptionHash (browser) when there is no issueId', () => {
    const { result } = renderWithRouter(['/?exceptionHash=abc123']);

    expect(result.current.drawerHashes).toEqual(['abc123']);
    expect(result.current.source).toBe('browser');
    expect(result.current.selectedIssueId).toBe('');
    expect(result.current.selectedHash).toBe('abc123');
  });

  it('returns null hashes when issueId has no matching issue yet', async () => {
    getIssues.mockResolvedValue(issuesResponse([]));
    const { result } = renderWithRouter(['/?issueId=v1:missing']);

    await waitFor(() => expect(getIssues).toHaveBeenCalled());
    expect(result.current.drawerHashes).toBeNull();
    expect(result.current.source).toBeUndefined();
  });

  it('returns null when neither issueId nor exceptionHash is set', () => {
    const { result } = renderWithRouter(['/']);
    expect(result.current.drawerHashes).toBeNull();
    expect(result.current.source).toBeUndefined();
  });

  it('reports drawerLoading while a fresh issueId resolves, then clears it', async () => {
    let resolve!: (v: unknown) => void;
    getIssues.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const { result } = renderWithRouter(['/?issueId=v1:aaaa']);

    expect(result.current.drawerLoading).toBe(true);
    expect(result.current.drawerHashes).toBeNull();

    await act(async () => {
      resolve(issuesResponse([issue({ fingerprint: 'v1:aaaa', memberHashes: ['h1'] })]));
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
      expect(params.get('environment')).toBe('prod-gcp');
    });
  });
});
