import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { IssuesTable } from './IssuesTable';
import * as client from '../../../../api/client';

jest.mock('../../../../api/client', () => ({
  ...jest.requireActual('../../../../api/client'),
  getIssues: jest.fn(),
  getTriageStates: jest.fn().mockResolvedValue({}),
  getFrontendVersions: jest.fn().mockResolvedValue({ versions: [] }),
  postTriageAction: jest.fn(),
}));

// The user-storage wrapper needs Grafana's PluginContext — stub it with an
// in-memory mute set for component tests.
const toggleMuteMock = jest.fn();
jest.mock('../../../../utils/userStorage', () => ({
  useUserMutes: () => ({ mutes: new Set<string>(), toggleMute: toggleMuteMock, loaded: true }),
}));

function mockIssues(n: number, source: 'browser' | 'server' = 'browser') {
  return {
    fingerprintVersion: 'v1',
    sources: { browser: true, serverLogs: true },
    issues: Array.from({ length: n }, (_, i) => ({
      fingerprint: `v1:${String(i).padStart(16, '0')}`,
      tier: 2,
      title: `Error: issue number ${i}`,
      count: 1000 - i,
      sessions: source === 'server' ? 0 : 100 - (i % 100),
      memberHashes: source === 'server' ? [] : [`${i}`],
      source,
      impact: { pods: 0, versions: [] },
    })),
  };
}

function LocationSpy() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderTable(props?: { compact?: boolean }) {
  return render(
    <MemoryRouter>
      <IssuesTable namespace="ns" service="svc" compact={props?.compact} />
      <LocationSpy />
    </MemoryRouter>
  );
}

describe('IssuesTable pagination', () => {
  const getIssues = client.getIssues as jest.Mock;

  it('renders one page of rows with a pager for long result sets', async () => {
    getIssues.mockResolvedValue(mockIssues(37));
    renderTable();

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());

    // 10 rows on the first page, not 37
    expect(screen.getByText('Error: issue number 9')).toBeInTheDocument();
    expect(screen.queryByText('Error: issue number 10')).not.toBeInTheDocument();
    expect(screen.getByText(/37 issues · showing 1–10/)).toBeInTheDocument();

    // Navigate to page 2 (Grafana Pagination buttons are named by bare number)
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(screen.getByText('Error: issue number 10')).toBeInTheDocument();
    expect(screen.queryByText('Error: issue number 0')).not.toBeInTheDocument();
    expect(screen.getByText(/showing 11–20/)).toBeInTheDocument();
  });

  it('hides the pager when everything fits on one page', async () => {
    getIssues.mockResolvedValue(mockIssues(4));
    renderTable();

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    expect(screen.getByText('4 issues')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('IssuesTable triage', () => {
  const getIssues = client.getIssues as jest.Mock;
  const getTriageStates = client.getTriageStates as jest.Mock;
  const getFrontendVersions = client.getFrontendVersions as jest.Mock;
  const postTriageAction = client.postTriageAction as jest.Mock;

  it('hides resolved issues under the default filter and shows them under Resolved', async () => {
    getIssues.mockResolvedValue(mockIssues(3));
    getTriageStates.mockResolvedValue({
      'v1:0000000000000001': { status: 'resolved', updatedAt: 999999999999999, updatedBy: 'hans' },
    });
    renderTable();

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    expect(screen.queryByText('Error: issue number 1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Resolved' }));
    await waitFor(() => expect(screen.getByText('Error: issue number 1')).toBeInTheDocument());
    expect(screen.queryByText('Error: issue number 0')).not.toBeInTheDocument();
  });

  it('bubbles regressed issues to the top with a badge', async () => {
    getIssues.mockResolvedValue(mockIssues(3));
    // Issue 2 resolved BEFORE the latest deploy but still occurring → regressed.
    getTriageStates.mockResolvedValue({
      'v1:0000000000000002': { status: 'resolved', updatedAt: 1000, updatedBy: 'hans' },
    });
    getFrontendVersions.mockResolvedValue({
      latestVersion: 'sha2',
      versions: [{ version: 'sha2', sessions: 10, adoption: 1, errorFreeRate: 1, exceptions: 0, deployedAtMs: 2000 }],
    });
    renderTable();

    await waitFor(() => expect(screen.getByText('Regressed')).toBeInTheDocument());
    // Issue rows carry role=button (clickable); the regressed one sorts first.
    const rows = screen.getAllByRole('button').filter((el) => /issue number/.test(el.textContent ?? ''));
    expect(rows[0]).toHaveTextContent('Error: issue number 2');
  });

  it('resolve action POSTs and removes the row under the default filter', async () => {
    getIssues.mockResolvedValue(mockIssues(2));
    getTriageStates.mockResolvedValue({});
    postTriageAction.mockResolvedValue({ status: 'resolved', updatedAt: 999999999999999, updatedBy: 'me' });
    renderTable();

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'Resolve' })[0]);

    await waitFor(() =>
      expect(postTriageAction).toHaveBeenCalledWith(
        'ns',
        'svc',
        'v1:0000000000000000',
        expect.objectContaining({ action: 'resolve' })
      )
    );
    await waitFor(() => expect(screen.queryByText('Error: issue number 0')).not.toBeInTheDocument());
  });
});

describe('IssuesTable unified sources', () => {
  const getIssues = client.getIssues as jest.Mock;

  function mixedIssues() {
    const browser = mockIssues(2, 'browser').issues;
    const server = mockIssues(1, 'server').issues.map((i) => ({
      ...i,
      fingerprint: 'v1:00000000000000ff',
      title: 'PSQLException: connection refused to db-host:5432 while executing query',
      impact: { pods: 3, versions: ['1.42.0'] },
    }));
    return {
      fingerprintVersion: 'v1',
      sources: { browser: true, serverLogs: true },
      issues: [...browser, ...server],
    };
  }

  it('renders a source badge per row', async () => {
    getIssues.mockResolvedValue(mixedIssues());
    renderTable();

    await waitFor(() => expect(screen.getByText(/PSQLException/)).toBeInTheDocument());
    expect(screen.getAllByText('browser')).toHaveLength(2);
    expect(screen.getAllByText('server')).toHaveLength(1);
  });

  it('renders a dash in the Sessions cell for server issues', async () => {
    getIssues.mockResolvedValue(mixedIssues());
    renderTable();

    await waitFor(() => expect(screen.getByText(/PSQLException/)).toBeInTheDocument());
    const serverRow = screen.getByText(/PSQLException/).closest('tr')!;
    expect(serverRow).toHaveTextContent('—');
  });

  it('source filter hides browser rows', async () => {
    getIssues.mockResolvedValue(mixedIssues());
    renderTable();

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('radio', { name: 'Server' }));

    await waitFor(() => expect(screen.queryByText('Error: issue number 0')).not.toBeInTheDocument());
    expect(screen.queryByText('Error: issue number 1')).not.toBeInTheDocument();
    expect(screen.getByText(/PSQLException/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Browser' }));
    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    expect(screen.queryByText(/PSQLException/)).not.toBeInTheDocument();
  });

  it('server row click deep-links to the Logs tab instead of opening the drawer', async () => {
    getIssues.mockResolvedValue(mixedIssues());
    renderTable();

    await waitFor(() => expect(screen.getByText(/PSQLException/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/PSQLException/));

    const search = screen.getByTestId('location-search').textContent ?? '';
    const params = new URLSearchParams(search);
    expect(params.get('tab')).toBe('logs');
    // logSearch carries the first 60 chars of the title
    expect(params.get('logSearch')).toBe('PSQLException: connection refused to db-host:5432 while exec');
    expect(params.get('issueId')).toBeNull();
  });

  it('browser row click opens the drawer via issueId', async () => {
    getIssues.mockResolvedValue(mixedIssues());
    renderTable();

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Error: issue number 0'));

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
    expect(params.get('issueId')).toBe('v1:0000000000000000');
    expect(params.get('tab')).toBeNull();
  });
});

describe('IssuesTable compact mode (#69 P6)', () => {
  const getIssues = client.getIssues as jest.Mock;

  it('caps rows at 5 with no pager and hides the source filter', async () => {
    getIssues.mockResolvedValue(mockIssues(12));
    renderTable({ compact: true });

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    expect(screen.getByText('Error: issue number 4')).toBeInTheDocument();
    expect(screen.queryByText('Error: issue number 5')).not.toBeInTheDocument();

    // The status filter (Unresolved/All/…) stays, only the source filter is locked/hidden.
    expect(screen.queryByRole('radio', { name: 'All sources' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Browser' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Server' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Unresolved' })).toBeInTheDocument();

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All issues →' })).toBeInTheDocument();
  });

  it('locks the source filter to browser, hiding server issues', async () => {
    const browser = mockIssues(2, 'browser').issues;
    const server = mockIssues(1, 'server').issues.map((i) => ({
      ...i,
      fingerprint: 'v1:00000000000000ff',
      title: 'PSQLException: connection refused',
    }));
    getIssues.mockResolvedValue({
      fingerprintVersion: 'v1',
      sources: { browser: true, serverLogs: true },
      issues: [...browser, ...server],
    });
    renderTable({ compact: true });

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    // Server-sourced row must not render — compact mode locks source=browser.
    expect(screen.queryByText(/PSQLException/)).not.toBeInTheDocument();
  });

  it('"All issues →" switches the tab to issues while preserving other params', async () => {
    getIssues.mockResolvedValue(mockIssues(1));
    render(
      <MemoryRouter initialEntries={['/?issueId=v1:aaaa&environment=prod-gcp']}>
        <IssuesTable namespace="ns" service="svc" compact />
        <LocationSpy />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'All issues →' }));

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
    expect(params.get('tab')).toBe('issues');
    expect(params.get('issueId')).toBe('v1:aaaa');
    expect(params.get('environment')).toBe('prod-gcp');
  });
});
