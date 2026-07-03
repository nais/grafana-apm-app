import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VersionsPanel } from './VersionsPanel';
import * as client from '../../../../api/client';

jest.mock('../../../../api/client', () => ({
  ...jest.requireActual('../../../../api/client'),
  getFrontendVersions: jest.fn(),
}));

function renderPanel() {
  return render(
    <MemoryRouter>
      <VersionsPanel namespace="ns" service="svc" />
    </MemoryRouter>
  );
}

describe('VersionsPanel', () => {
  const getFrontendVersions = client.getFrontendVersions as jest.Mock;

  it('renders version rows with deploy time, adoption and error-free rate', async () => {
    getFrontendVersions.mockResolvedValue({
      versions: [
        {
          version: 'a1b2c3d4e5f6a7b8',
          sessions: 100,
          adoption: 0.6667,
          errorFreeRate: 0.95,
          exceptions: 12,
          deployedAtMs: Date.now() - 2 * 3_600_000,
        },
        { version: 'ffff000011112222', sessions: 50, adoption: 0.3333, errorFreeRate: 1, exceptions: 0 },
      ],
      latestVersion: 'a1b2c3d4e5f6a7b8',
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText('a1b2c3d4e5')).toBeInTheDocument());

    // Short SHA (10 chars) with the full version on the title attribute
    const sha = screen.getByText('a1b2c3d4e5');
    expect(sha).toHaveAttribute('title', 'a1b2c3d4e5f6a7b8');
    expect(screen.getByText('latest')).toBeInTheDocument();

    // Deployed: relative time when annotated, em dash otherwise
    expect(screen.getByText('2h ago')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(1);

    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('95.0%')).toBeInTheDocument();
    expect(screen.getByText('100.0%')).toBeInTheDocument();
    expect(screen.getByText(/did this start with today/)).toBeInTheDocument();
  });

  it('shows a dash for error-free rate when a version has no sessions', async () => {
    getFrontendVersions.mockResolvedValue({
      versions: [{ version: 'deadbeef01', sessions: 0, adoption: 0, errorFreeRate: 0, exceptions: 7 }],
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText('deadbeef01')).toBeInTheDocument());
    // Both Deployed (no annotation) and Error-free % (no sessions) degrade to a dash
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('renders the empty state when there is no version data', async () => {
    getFrontendVersions.mockResolvedValue({ versions: [] });
    renderPanel();

    await waitFor(() => expect(screen.getByText('No versions')).toBeInTheDocument());
  });

  it('surfaces Loki unavailability', async () => {
    getFrontendVersions.mockResolvedValue({ versions: [], unavailable: true });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Loki is not available')).toBeInTheDocument());
  });
});
