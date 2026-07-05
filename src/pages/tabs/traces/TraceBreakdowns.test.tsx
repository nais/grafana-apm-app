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

/** Open the collapsed breakdown panel via its header toggle. */
function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Breakdowns by/ }));
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

/** 8 rows so top-N (6) capping and the "show all" affordance are exercised. */
const MANY_ROWS_RESPONSE = {
  mode: 'traceql' as const,
  dimension: 'name',
  dimensions: ['name'],
  rows: Array.from({ length: 8 }, (_, i) => ({
    value: `route-${i}`,
    rate: 8 - i,
    errorRate: 0,
    p95Ms: 10,
    p99Ms: 20,
  })),
};

describe('TraceBreakdowns', () => {
  beforeEach(() => getTraceBreakdown.mockReset());

  it('is collapsed by default, showing the group-by dimension in the header', async () => {
    getTraceBreakdown.mockResolvedValue(RESPONSE);
    renderPanel();

    // The signal survives collapse: header text is present immediately...
    await waitFor(() => expect(screen.getByText('Breakdowns by name (2)')).toBeInTheDocument());
    // ...but the table body (the secondary content) is not rendered until expanded.
    expect(screen.queryByRole('table', { name: 'Span breakdown' })).not.toBeInTheDocument();
    expect(screen.queryByText('POST /b')).not.toBeInTheDocument();
  });

  it('expands to reveal the table on click', async () => {
    getTraceBreakdown.mockResolvedValue(RESPONSE);
    renderPanel();
    await waitFor(() => expect(screen.getByText('Breakdowns by name (2)')).toBeInTheDocument());

    openPanel();

    expect(screen.getByRole('table', { name: 'Span breakdown' })).toBeInTheDocument();
    expect(screen.getByText('POST /b')).toBeInTheDocument();
  });

  it('renders rows with RED metrics and the mode badge', async () => {
    getTraceBreakdown.mockResolvedValue(RESPONSE);
    renderPanel();
    await waitFor(() => expect(screen.getByText('Breakdowns by name (2)')).toBeInTheDocument());
    openPanel();

    expect(screen.getByText('POST /b')).toBeInTheDocument();
    expect(screen.getByText('GET /a')).toBeInTheDocument();
    expect(screen.getByText('33.3%')).toBeInTheDocument();
    expect(screen.getByText('TraceQL metrics')).toBeInTheDocument();
    // p99 250ms rendered
    expect(screen.getByText('250ms')).toBeInTheDocument();
  });

  it('fetches the default dimension (name) on mount, regardless of collapsed state', async () => {
    getTraceBreakdown.mockResolvedValue(RESPONSE);
    renderPanel();

    await waitFor(() => expect(getTraceBreakdown).toHaveBeenCalled());
    expect(getTraceBreakdown).toHaveBeenLastCalledWith('ns', 'svc', 1000, 2000, 'prod-tempo', 'name');
  });

  it('seeds the span search on row click', async () => {
    getTraceBreakdown.mockResolvedValue(RESPONSE);
    const onSelectSpan = renderPanel();
    await waitFor(() => expect(screen.getByText('Breakdowns by name (2)')).toBeInTheDocument());
    openPanel();

    fireEvent.click(screen.getByText('POST /b'));
    expect(onSelectSpan).toHaveBeenCalledWith('POST /b');
  });

  it('renders the empty state', async () => {
    getTraceBreakdown.mockResolvedValue({ mode: 'traceql', dimension: 'name', dimensions: ['name'], rows: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Breakdowns by name')).toBeInTheDocument());
    openPanel();

    await waitFor(() => expect(screen.getByText('No data')).toBeInTheDocument());
  });

  it('names the table and associates the group-by selector with its label', async () => {
    getTraceBreakdown.mockResolvedValue(RESPONSE);
    renderPanel();
    await waitFor(() => expect(screen.getByText('Breakdowns by name (2)')).toBeInTheDocument());
    openPanel();

    expect(screen.getByRole('table', { name: 'Span breakdown' })).toBeInTheDocument();
    // The dimension picker is programmatically labelled by the visible "Group by:" label.
    expect(screen.getByRole('combobox', { name: /Group by/ })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText('Breakdowns by name')).toBeInTheDocument());
    openPanel();

    await waitFor(() => expect(screen.getByText('traces datasource not configured')).toBeInTheDocument());
  });

  it('caps rows to the top 6 with a "show all" affordance that reveals the rest', async () => {
    getTraceBreakdown.mockResolvedValue(MANY_ROWS_RESPONSE);
    renderPanel();
    await waitFor(() => expect(screen.getByText('Breakdowns by name (8)')).toBeInTheDocument());
    openPanel();

    await waitFor(() => expect(screen.getByText('route-0')).toBeInTheDocument());
    for (let i = 0; i < 6; i++) {
      expect(screen.getByText(`route-${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByText('route-6')).not.toBeInTheDocument();
    expect(screen.queryByText('route-7')).not.toBeInTheDocument();

    const showAllButton = screen.getByRole('button', { name: 'Show all 8' });
    fireEvent.click(showAllButton);

    expect(screen.getByText('route-6')).toBeInTheDocument();
    expect(screen.getByText('route-7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show top 6' })).toBeInTheDocument();
  });
});
