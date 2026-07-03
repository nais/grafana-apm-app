import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IssuesTable } from './IssuesTable';
import * as client from '../../../../api/client';

jest.mock('../../../../api/client', () => ({
  ...jest.requireActual('../../../../api/client'),
  getExceptionGroups: jest.fn(),
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
