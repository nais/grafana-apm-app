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

function renderTab(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <IssuesTab namespace="ns" service="svc" />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('IssuesTab (#69 P1/P2/P3)', () => {
  it('renders the issues table, versions panel, and sessions panel', async () => {
    renderTab();

    await waitFor(() => expect(screen.getByText('No issues')).toBeInTheDocument());
    expect(screen.getByText('Top Exceptions')).toBeInTheDocument();
    expect(screen.getByText('Versions')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
  });

  it('opens the ExceptionDrawer from an issueId deep link (#69 P10)', async () => {
    (client.getExceptionGroups as jest.Mock).mockResolvedValue({
      fingerprintVersion: 'v1',
      groups: [{ fingerprint: 'v1:aaaa', title: 'Boom', tier: 2, count: 1, sessions: 1, memberHashes: ['h1'] }],
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
