import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IssuesTable } from './IssuesTable';
import * as client from '../../../../api/client';

jest.mock('../../../../api/client', () => ({
  ...jest.requireActual('../../../../api/client'),
  getExceptionGroups: jest.fn(),
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

function mockGroups(n: number) {
  return {
    fingerprintVersion: 'v1',
    groups: Array.from({ length: n }, (_, i) => ({
      fingerprint: `v1:${String(i).padStart(16, '0')}`,
      tier: 2,
      title: `Error: issue number ${i}`,
      count: 1000 - i,
      sessions: 100 - (i % 100),
      memberHashes: [`${i}`],
    })),
  };
}

function renderTable() {
  return render(
    <MemoryRouter>
      <IssuesTable namespace="ns" service="svc" />
    </MemoryRouter>
  );
}

describe('IssuesTable pagination', () => {
  const getExceptionGroups = client.getExceptionGroups as jest.Mock;

  it('renders one page of rows with a pager for long result sets', async () => {
    getExceptionGroups.mockResolvedValue(mockGroups(37));
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
    getExceptionGroups.mockResolvedValue(mockGroups(4));
    renderTable();

    await waitFor(() => expect(screen.getByText('Error: issue number 0')).toBeInTheDocument());
    expect(screen.getByText('4 issues')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('IssuesTable triage', () => {
  const getExceptionGroups = client.getExceptionGroups as jest.Mock;
  const getTriageStates = client.getTriageStates as jest.Mock;
  const getFrontendVersions = client.getFrontendVersions as jest.Mock;
  const postTriageAction = client.postTriageAction as jest.Mock;

  it('hides resolved issues under the default filter and shows them under Resolved', async () => {
    getExceptionGroups.mockResolvedValue(mockGroups(3));
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
    getExceptionGroups.mockResolvedValue(mockGroups(3));
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
    getExceptionGroups.mockResolvedValue(mockGroups(2));
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
