import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TraceBreakdowns } from './TraceBreakdowns';
import * as analytics from '../../../api/analytics';

jest.mock('../../../api/analytics', () => ({
  ...jest.requireActual('../../../api/analytics'),
  getTraceBreakdown: jest.fn(),
}));

const getTraceBreakdown = analytics.getTraceBreakdown as jest.Mock;

function renderPanel(onSelectSpan = jest.fn()) {
  render(
    <TraceBreakdowns
      namespace="ns"
      service="svc"
      tracesUid="prod-tempo"
      fromMs={1000}
      toMs={2000}
      onSelectSpan={onSelectSpan}
    />
  );
  return onSelectSpan;
}

const RESPONSE = {
  mode: 'traceql' as const,
  dimension: 'name',
  dimensions: ['name', 'db.system'],
  rows: [
    { value: 'POST /b', rate: 4, errorRate: 0, p95Ms: 200, p99Ms: 250 },
    { value: 'GET /a', rate: 3, errorRate: 33.3, p95Ms: 50, p99Ms: 60 },
  ],
};

describe('TraceBreakdowns', () => {
  beforeEach(() => getTraceBreakdown.mockReset());

  it('renders rows with RED metrics and the mode badge', async () => {
    getTraceBreakdown.mockResolvedValue(RESPONSE);
    renderPanel();

    await waitFor(() => expect(screen.getByText('POST /b')).toBeInTheDocument());
    expect(screen.getByText('GET /a')).toBeInTheDocument();
    expect(screen.getByText('33.3%')).toBeInTheDocument();
    expect(screen.getByText('TraceQL metrics')).toBeInTheDocument();
    // p99 250ms rendered
    expect(screen.getByText('250ms')).toBeInTheDocument();
  });

  it('fetches the default dimension (name) on mount', async () => {
    getTraceBreakdown.mockResolvedValue(RESPONSE);
    renderPanel();

    await waitFor(() => expect(getTraceBreakdown).toHaveBeenCalled());
    expect(getTraceBreakdown).toHaveBeenLastCalledWith('ns', 'svc', 1000, 2000, 'prod-tempo', 'name');
  });

  it('seeds the span search on row click', async () => {
    getTraceBreakdown.mockResolvedValue(RESPONSE);
    const onSelectSpan = renderPanel();

    await waitFor(() => expect(screen.getByText('POST /b')).toBeInTheDocument());
    fireEvent.click(screen.getByText('POST /b'));
    expect(onSelectSpan).toHaveBeenCalledWith('POST /b');
  });

  it('renders the empty state', async () => {
    getTraceBreakdown.mockResolvedValue({ mode: 'traceql', dimension: 'name', dimensions: ['name'], rows: [] });
    renderPanel();

    await waitFor(() => expect(screen.getByText('No data')).toBeInTheDocument());
  });

  it('surfaces unavailability', async () => {
    getTraceBreakdown.mockResolvedValue({
      mode: 'unavailable',
      dimension: 'name',
      dimensions: [],
      rows: [],
      note: 'traces datasource not configured',
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText('traces datasource not configured')).toBeInTheDocument());
  });
});
