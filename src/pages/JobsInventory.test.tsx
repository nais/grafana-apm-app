import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import JobsInventory from './JobsInventory';
import { JobsResponse } from '../api/jobs';

const response: JobsResponse = {
  available: true,
  jobs: [
    {
      name: 'nightly-sync',
      namespace: 'team-a',
      cluster: 'prod',
      kind: 'CronJob',
      schedule: '0 2 * * *',
      lastRun: { outcome: 'succeeded', startMs: 1_700_000_000_000, completionMs: 1_700_000_030_000, durationSec: 30 },
      nextScheduleMs: 1_700_086_400_000,
      failureStreak: 0,
      status: 'ok',
      runCount: 5,
    },
    {
      name: 'broken-report',
      namespace: 'team-b',
      cluster: 'prod',
      kind: 'CronJob',
      schedule: '*/5 * * * *',
      lastRun: { outcome: 'failed', reason: 'BackoffLimitExceeded', startMs: 1_700_000_500_000 },
      nextScheduleMs: 1_700_000_800_000,
      failureStreak: 3,
      status: 'failing',
      runCount: 10,
    },
    {
      name: 'oneshot-migrate',
      namespace: 'team-a',
      cluster: 'dev',
      kind: 'Job',
      lastRun: { outcome: 'succeeded', startMs: 1_700_000_900_000, completionMs: 1_700_000_905_000, durationSec: 5 },
      failureStreak: 0,
      status: 'ok',
      runCount: 1,
    },
  ],
};

const getJobsMock = jest.fn(() => Promise.resolve(response));

jest.mock('../api/jobs', () => ({
  getJobs: (...args: unknown[]) => (getJobsMock as (...a: unknown[]) => Promise<unknown>)(...args),
}));

jest.mock('../utils/datasources', () => ({
  usePluginDatasources: () => ({ logsUid: 'loki', metricsUid: 'mimir', tracesUid: 'tempo' }),
}));

function renderJobs(route = '/jobs') {
  return render(
    <MemoryRouter initialEntries={[route]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <JobsInventory />
    </MemoryRouter>
  );
}

describe('JobsInventory', () => {
  it('renders a row per job with schedule and outcome', async () => {
    renderJobs();
    expect(await screen.findByText('nightly-sync')).toBeInTheDocument();
    expect(screen.getByText('broken-report')).toBeInTheDocument();
    expect(screen.getByText('oneshot-migrate')).toBeInTheDocument();
    // Cron expression is shown for CronJobs.
    expect(screen.getByText('0 2 * * *')).toBeInTheDocument();
    // The failing job surfaces its failure reason.
    expect(screen.getByText('BackoffLimitExceeded')).toBeInTheDocument();
  });

  it('filters to failing jobs via the Failing pill', async () => {
    renderJobs();
    await screen.findByText('nightly-sync');
    fireEvent.click(screen.getByText(/^Failing/));
    await waitFor(() => expect(screen.queryByText('nightly-sync')).not.toBeInTheDocument());
    expect(screen.getByText('broken-report')).toBeInTheDocument();
    expect(screen.queryByText('oneshot-migrate')).not.toBeInTheDocument();
  });

  it('fuzzy search matches a misspelled job name', async () => {
    renderJobs('/jobs?q=nightly');
    expect(await screen.findByText('nightly-sync')).toBeInTheDocument();
    expect(screen.queryByText('broken-report')).not.toBeInTheDocument();
    expect(screen.queryByText('oneshot-migrate')).not.toBeInTheDocument();
  });

  it('shows the fail streak count for failing jobs', async () => {
    renderJobs('/jobs?status=failing');
    const row = (await screen.findByText('broken-report')).closest('tr')!;
    expect(within(row).getByText('3')).toBeInTheDocument();
  });

  it('renders an unavailable notice when KSM job metrics are missing', async () => {
    getJobsMock.mockResolvedValueOnce({ available: false, jobs: [], note: 'kube-state-metrics not exposed' });
    renderJobs();
    expect(await screen.findByText(/Job metrics not available/i)).toBeInTheDocument();
  });
});
