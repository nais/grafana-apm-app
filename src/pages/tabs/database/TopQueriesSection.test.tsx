import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TopQueriesSection } from './TopQueriesSection';
import * as analytics from '../../../api/analytics';
import { TopQueriesResponse } from '../../../api/analytics';

jest.mock('../../../api/analytics');
const mockGetTopQueries = analytics.getTopQueries as jest.MockedFunction<typeof analytics.getTopQueries>;

const baseResponse: TopQueriesResponse = {
  mode: 'traceql',
  sampled: 120,
  truncated: false,
  windowSeconds: 3600,
  queries: [
    {
      statement: 'select x from t where id in (?)',
      dbSystem: 'oracle',
      table: 't',
      count: 40,
      totalTimeMs: 800,
      avgTimeMs: 20,
      p95Ms: 55,
      traceId: 'abc123',
    },
    {
      statement: 'GET ?',
      dbSystem: 'redis',
      count: 200,
      totalTimeMs: 300,
      avgTimeMs: 1.5,
      p95Ms: 4,
      traceId: 'def456',
    },
  ],
};

const renderSection = () =>
  render(
    <MemoryRouter>
      <TopQueriesSection namespace="myns" service="mysvc" fromMs={1000} toMs={2000} tracesUid="tempo-uid" />
    </MemoryRouter>
  );

describe('TopQueriesSection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders normalized statements with system, counts and a trace link', async () => {
    mockGetTopQueries.mockResolvedValue(baseResponse);
    renderSection();

    await waitFor(() => expect(screen.getByText('select x from t where id in (?)')).toBeInTheDocument());
    expect(screen.getByText('GET ?')).toBeInTheDocument();
    expect(screen.getByText('oracle')).toBeInTheDocument();
    expect(screen.getByText('redis')).toBeInTheDocument();
    // Representative trace links point at the traceId via TraceQL Explore.
    const links = screen.getAllByRole('link', { name: 'View representative trace' });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('abc123'));
  });

  it('sorts by total time descending by default, and re-sorts by count', async () => {
    mockGetTopQueries.mockResolvedValue(baseResponse);
    renderSection();

    await waitFor(() => expect(screen.getByText('select x from t where id in (?)')).toBeInTheDocument());
    let rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('select x from t where id in (?)'); // 800ms total leads

    fireEvent.click(screen.getByRole('button', { name: /Count/ }));
    await waitFor(() => {
      const r = screen.getAllByRole('row').slice(1);
      expect(r[0]).toHaveTextContent('GET ?'); // 200 count leads
    });
  });

  it('expands a statement on click', async () => {
    mockGetTopQueries.mockResolvedValue(baseResponse);
    renderSection();

    await waitFor(() => expect(screen.getByText('GET ?')).toBeInTheDocument());
    const stmt = screen.getByText('select x from t where id in (?)');
    expect(stmt).toHaveAttribute('title', 'Expand full statement');
    fireEvent.click(stmt);
    expect(stmt).toHaveAttribute('title', 'Collapse');
  });

  it('shows a graceful notice when trace search is unavailable', async () => {
    mockGetTopQueries.mockResolvedValue({
      mode: 'unavailable',
      queries: [],
      sampled: 0,
      truncated: false,
      windowSeconds: 3600,
      note: 'trace search unavailable (Tempo may be busy) — try a narrower range',
    });
    renderSection();

    await waitFor(() => expect(screen.getByText(/trace search unavailable/i)).toBeInTheDocument());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an empty state when no statements were found', async () => {
    mockGetTopQueries.mockResolvedValue({
      mode: 'traceql',
      queries: [],
      sampled: 0,
      truncated: false,
      windowSeconds: 3600,
    });
    renderSection();

    await waitFor(() => expect(screen.getByText('No query statements found')).toBeInTheDocument());
  });

  it('reports a bounded sample when truncated', async () => {
    mockGetTopQueries.mockResolvedValue({ ...baseResponse, truncated: true });
    renderSection();

    await waitFor(() => expect(screen.getByText(/scan limit was reached/i)).toBeInTheDocument());
  });
});
