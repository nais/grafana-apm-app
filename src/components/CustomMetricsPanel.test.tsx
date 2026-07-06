import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CustomMetricsPanel } from './CustomMetricsPanel';
import { SceneQueryRunner } from '@grafana/scenes';
import * as client from '../api/client';

jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  getCustomMetrics: jest.fn(),
}));

// The auto-charts render an EmbeddedScene; stub @grafana/scenes so the table
// assertions here stay focused (the per-type query PromQL is covered in
// customMetricQueries.test.ts).
jest.mock('@grafana/scenes', () => ({
  EmbeddedScene: jest.fn().mockImplementation((cfg) => ({ ...cfg, Component: () => null })),
  SceneFlexLayout: jest.fn().mockImplementation((cfg) => cfg),
  SceneFlexItem: jest.fn().mockImplementation((cfg) => cfg),
  SceneQueryRunner: jest.fn().mockImplementation((cfg) => cfg),
  SceneTimeRange: jest.fn().mockImplementation((cfg) => cfg),
  PanelBuilders: {
    timeseries: () => {
      const b: any = {
        setTitle: () => b,
        setDescription: () => b,
        setData: () => b,
        setUnit: () => b,
        build: () => ({}),
      };
      return b;
    },
  },
}));

/** Extract the PromQL expr from an Explore href's JSON-encoded `left` param. */
function exprFromHref(href: string | null): string {
  const left = new URLSearchParams((href ?? '').split('?')[1]).get('left') ?? '{}';
  return JSON.parse(left).queries?.[0]?.expr ?? '';
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <CustomMetricsPanel namespace="team" service="app" />
    </MemoryRouter>
  );
}

const COUNTER = {
  name: 'orders_processed_total',
  type: 'counter',
  help: 'Orders processed',
  unit: '',
  series: 12,
  highCardinality: false,
  chart: 'rate' as const,
};

const HISTOGRAM = {
  name: 'batch_duration_seconds',
  type: 'histogram',
  help: '',
  unit: 'seconds',
  series: 40,
  highCardinality: false,
  chart: 'p95' as const,
};

const CHATTY_GAUGE = {
  name: 'queue_depth',
  type: 'gauge',
  help: '',
  unit: '',
  series: 150,
  highCardinality: true,
  chart: 'gauge' as const,
};

describe('CustomMetricsPanel', () => {
  const getCustomMetrics = client.getCustomMetrics as jest.Mock;

  beforeEach(() => {
    getCustomMetrics.mockReset();
  });

  it('defaults to collapsed — the table stays hidden until the header is clicked', async () => {
    getCustomMetrics.mockResolvedValue({ metrics: [COUNTER, HISTOGRAM], truncated: false });
    renderPanel();

    // The count-bearing header renders eagerly (the fetch backs the count),
    // but the table underneath does not.
    await waitFor(() => expect(screen.getByText('Custom metrics (2)')).toBeInTheDocument());
    expect(screen.queryByText('orders_processed_total')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Custom metrics (2)'));
    await waitFor(() => expect(screen.getByText('orders_processed_total')).toBeInTheDocument());

    // Clicking again collapses it back.
    fireEvent.click(screen.getByText('Custom metrics (2)'));
    expect(screen.queryByText('orders_processed_total')).not.toBeInTheDocument();
  });

  it('renders a row per metric with type badge, series count, and Explore link', async () => {
    getCustomMetrics.mockResolvedValue({ metrics: [COUNTER, HISTOGRAM], truncated: false });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Custom metrics (2)')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Custom metrics (2)'));
    await waitFor(() => expect(screen.getByText('orders_processed_total')).toBeInTheDocument());

    expect(screen.getByText('Custom metrics (2)')).toBeInTheDocument();
    // Help text rides on the title attribute of the metric name.
    expect(screen.getByText('orders_processed_total')).toHaveAttribute('title', 'Orders processed');
    expect(screen.getByText('counter')).toBeInTheDocument();
    expect(screen.getByText('histogram')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('seconds')).toBeInTheDocument();

    // Explore links carry the auto-generated PromQL per chart type.
    const links = screen.getAllByRole('link', { name: /open in explore/i });
    expect(links).toHaveLength(2);
    expect(exprFromHref(links[0].getAttribute('href'))).toBe(
      'sum(rate(orders_processed_total{app="app", namespace="team"}[$__rate_interval]))'
    );
    expect(exprFromHref(links[1].getAttribute('href'))).toBe(
      'histogram_quantile(0.95, sum by (le) (rate(batch_duration_seconds_bucket{app="app", namespace="team"}[$__rate_interval])))'
    );
  });

  it('auto-charts the low-cardinality families with type-aware queries when expanded', async () => {
    const runner = SceneQueryRunner as unknown as jest.Mock;
    runner.mockClear();
    getCustomMetrics.mockResolvedValue({ metrics: [COUNTER, HISTOGRAM, CHATTY_GAUGE], truncated: false });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Custom metrics (3)')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Custom metrics (3)'));
    await waitFor(() => expect(screen.getByText('orders_processed_total')).toBeInTheDocument());

    const exprs = runner.mock.calls.flatMap((c) => (c[0].queries as Array<{ expr: string }>).map((q) => q.expr));
    // Counter → rate, histogram → p95.
    expect(exprs).toContain('sum(rate(orders_processed_total{app="app", namespace="team"}[$__rate_interval]))');
    expect(exprs).toContain(
      'histogram_quantile(0.95, sum by (le) (rate(batch_duration_seconds_bucket{app="app", namespace="team"}[$__rate_interval])))'
    );
    // The high-cardinality gauge is NOT auto-charted (Explore-link only).
    expect(exprs.some((e) => e.includes('queue_depth'))).toBe(false);
  });

  it('renders nothing when no custom metrics are discovered', async () => {
    getCustomMetrics.mockResolvedValue({ metrics: [], truncated: false });
    const { container } = renderPanel();

    await waitFor(() => expect(getCustomMetrics).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows the high-cardinality hint on flagged metrics', async () => {
    getCustomMetrics.mockResolvedValue({ metrics: [CHATTY_GAUGE], truncated: false });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Custom metrics (1)')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Custom metrics (1)'));
    await waitFor(() => expect(screen.getByText('queue_depth')).toBeInTheDocument());
    expect(screen.getByText(/high cardinality — not auto-charted/)).toBeInTheDocument();
    // Gauge chart deep-links to Explore with a pod-aggregated avg query.
    const link = screen.getByRole('link', { name: /open in explore/i });
    expect(exprFromHref(link.getAttribute('href'))).toBe('avg(queue_depth{app="app", namespace="team"})');
  });

  it('notes truncation when the family cap was hit', async () => {
    getCustomMetrics.mockResolvedValue({ metrics: [COUNTER], truncated: true });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Custom metrics (1)')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Custom metrics (1)'));
    await waitFor(() => expect(screen.getByText(/Showing the first 1 metric families/)).toBeInTheDocument());
  });

  it('surfaces fetch errors even while collapsed', async () => {
    getCustomMetrics.mockRejectedValue(new Error('boom'));
    renderPanel();

    // Errors are actionable — they must not be hidden behind the default collapse.
    await waitFor(() => expect(screen.getByText('Failed to load custom metrics')).toBeInTheDocument());
  });
});
