import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { of } from 'rxjs';
import { IssuesTab } from './IssuesTab';
import * as client from '../../api/client';

jest.mock('../../api/client', () => ({
  ...jest.requireActual('../../api/client'),
  getIssues: jest.fn().mockResolvedValue({ fingerprintVersion: 'v1', sources: {}, issues: [] }),
  getTriageStates: jest.fn().mockResolvedValue({}),
  getFrontendVersions: jest.fn().mockResolvedValue({ versions: [] }),
  getFrontendSessions: jest.fn().mockResolvedValue({ sessions: [] }),
  getFrontendMetrics: jest.fn(),
  getExceptionGroups: jest.fn(),
}));

jest.mock('../../utils/userStorage', () => ({
  useUserMutes: () => ({ mutes: new Set<string>(), toggleMute: jest.fn(), loaded: true }),
}));

const mockFetch = jest.fn();
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: (options: unknown) => mockFetch(options) }),
  getAppEvents: () => ({ publish: jest.fn() }),
  locationService: { push: jest.fn() },
}));

const getFrontendMetrics = client.getFrontendMetrics as jest.Mock;
const getFrontendVersions = client.getFrontendVersions as jest.Mock;

function renderTab(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <IssuesTab namespace="ns" service="svc" />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  getFrontendMetrics.mockReset().mockResolvedValue({ available: true, hasLoki: true });
  getFrontendVersions.mockReset().mockResolvedValue({ versions: [] });
});

describe('IssuesTab (#69 P1/P2/P3)', () => {
  it('renders the issues table without tab-local time controls', async () => {
    renderTab();

    await waitFor(() => expect(screen.getByText('No issues')).toBeInTheDocument());
    expect(screen.getByText('Top Exceptions')).toBeInTheDocument();
    // Time controls live in the global page header (HeaderTimeControls) —
    // the tab must not render its own picker or refresh control.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('refresh-control')).not.toBeInTheDocument();
  });

  it('names the actual window in the empty state', async () => {
    renderTab(['/?from=now-3h&to=now']);

    await waitFor(() => expect(screen.getByText('No errors in the last 3 hours.')).toBeInTheDocument());
  });

  it('shows Sessions (and Releases when they have data) for services with browser telemetry', async () => {
    getFrontendVersions.mockResolvedValue({
      versions: [{ version: 'deadbeef01', sessions: 5, adoption: 1, errorFreeRate: 1, exceptions: 0 }],
      latestVersion: 'deadbeef01',
    });
    renderTab();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Releases' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument();
  });

  it('hides Releases and Sessions panels for backend-only services', async () => {
    getFrontendMetrics.mockResolvedValue({ available: false });
    renderTab();

    await waitFor(() => expect(screen.getByText('No issues')).toBeInTheDocument());
    await waitFor(() => expect(getFrontendMetrics).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Releases' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sessions' })).not.toBeInTheDocument();
  });

  it('hides the Releases panel when a browser service has no version data', async () => {
    getFrontendVersions.mockResolvedValue({ versions: [] });
    renderTab();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument());
    await waitFor(() => expect(getFrontendVersions).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Releases' })).not.toBeInTheDocument();
    expect(screen.queryByText('No releases')).not.toBeInTheDocument();
  });

  it('opens the ExceptionDrawer from an issueId deep link (#69 P10)', async () => {
    // The drawer resolves issueId → source + hashes via the unified issues list (#84).
    (client.getIssues as jest.Mock).mockResolvedValue({
      fingerprintVersion: 'v1',
      sources: { browser: true, serverLogs: true },
      issues: [
        {
          fingerprint: 'v1:aaaa',
          title: 'Boom',
          tier: 2,
          count: 1,
          sessions: 1,
          memberHashes: ['h1'],
          source: 'browser',
        },
      ],
    });
    const exceptionLine =
      'timestamp=2026-07-03T10:00:00Z kind=exception type=TypeError value="boom" hash=h1 session_id=sess-1';
    mockFetch.mockReturnValue(
      of({ data: { data: { result: [{ stream: {}, values: [['1751536800000000000', exceptionLine]] }] } } })
    );

    renderTab(['/?issueId=v1:aaaa']);

    expect(await screen.findByText('TypeError')).toBeInTheDocument();
  });
});
