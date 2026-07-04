import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DatabaseTab } from './DatabaseTab';
import { getEndpoints, getRuntimeMetrics, EndpointGroups, RuntimeResponse } from '../../api/client';

jest.mock('../../api/client', () => ({
  getEndpoints: jest.fn(),
  getRuntimeMetrics: jest.fn(),
  getCapabilities: jest.fn().mockResolvedValue({
    spanMetrics: {
      detected: true,
      namespace: 'traces_spanmetrics',
      callsMetric: 'traces_spanmetrics_calls_total',
      durationMetric: 'traces_spanmetrics_duration_milliseconds_bucket',
      durationUnit: 'ms',
    },
    serviceGraph: { detected: false },
    tempo: { available: true },
    loki: { available: true },
    services: [],
  }),
}));

// The Scenes RED panels (buildDatabaseScene) are exercised in isolation by
// database/scene.test.ts. No test in this codebase renders an EmbeddedScene's
// `.Component` in jsdom (panel visualizations rely on canvas/uPlot which jsdom
// doesn't implement), so this stubs the scene to null here and keeps this
// suite focused on data-fetch gating, table/section wiring, and navigation.
jest.mock('./database/scene', () => ({
  buildDatabaseScene: jest.fn().mockReturnValue(null),
  buildDbTracesExploreUrl: jest.fn().mockReturnValue('/explore?left=stub'),
}));

const emptyEndpoints: EndpointGroups = {
  http: [],
  grpc: [],
  database: [],
  messaging: [],
  internal: [],
  client: [],
  durationUnit: 'ms',
};

const emptyRuntime: RuntimeResponse = {};

const renderTab = (props: Partial<React.ComponentProps<typeof DatabaseTab>> = {}) =>
  render(
    <MemoryRouter>
      <DatabaseTab
        service="checkout"
        namespace="team-a"
        environment="prod"
        fromMs={1000}
        toMs={2000}
        from="now-1h"
        to="now"
        {...props}
      />
    </MemoryRouter>
  );

describe('DatabaseTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows a loading state while fetching', () => {
    (getEndpoints as jest.Mock).mockReturnValue(new Promise(() => {}));
    (getRuntimeMetrics as jest.Mock).mockReturnValue(new Promise(() => {}));

    renderTab();
    expect(screen.getByText(/Checking for database instrumentation/)).toBeInTheDocument();
  });

  it('shows an empty state when no database activity is detected', async () => {
    (getEndpoints as jest.Mock).mockResolvedValue(emptyEndpoints);
    (getRuntimeMetrics as jest.Mock).mockResolvedValue(emptyRuntime);

    renderTab();
    expect(await screen.findByText('No database activity detected')).toBeInTheDocument();
    expect(screen.getByText(/db.system/)).toBeInTheDocument();
  });

  it('shows an error state when the endpoints fetch fails', async () => {
    (getEndpoints as jest.Mock).mockRejectedValue(new Error('boom'));
    (getRuntimeMetrics as jest.Mock).mockResolvedValue(emptyRuntime);

    renderTab();
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('renders db system badges, the query operations table, and the connection pool section', async () => {
    (getEndpoints as jest.Mock).mockResolvedValue({
      ...emptyEndpoints,
      database: [
        {
          spanName: 'SELECT users',
          dbSystem: 'postgresql',
          rate: 10,
          errorRate: 0,
          p50Duration: 2,
          p95Duration: 8,
          p99Duration: 15,
          durationUnit: 'ms',
        },
      ],
    });
    (getRuntimeMetrics as jest.Mock).mockResolvedValue({
      dbPool: {
        status: 'detected',
        pools: [
          {
            name: 'HikariPool-1',
            type: 'hikari',
            active: 2,
            idle: 8,
            max: 10,
            pending: 0,
            timeoutRate: 0,
            utilization: 20,
          },
        ],
      },
    });

    renderTab();

    expect(await screen.findByText('SELECT users')).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('Query Operations')).toBeInTheDocument();
    expect(screen.getByText('Connection Pool Health')).toBeInTheDocument();
    expect(screen.getByText('HikariPool-1')).toBeInTheDocument();
  });

  it('renders the query table but not the pool section when there is no pool data', async () => {
    (getEndpoints as jest.Mock).mockResolvedValue({
      ...emptyEndpoints,
      database: [
        {
          spanName: 'SELECT users',
          dbSystem: 'postgresql',
          rate: 10,
          errorRate: 0,
          p50Duration: 2,
          p95Duration: 8,
          p99Duration: 15,
          durationUnit: 'ms',
        },
      ],
    });
    (getRuntimeMetrics as jest.Mock).mockResolvedValue(emptyRuntime);

    renderTab();

    expect(await screen.findByText('SELECT users')).toBeInTheDocument();
    expect(screen.queryByText('Connection Pool Health')).not.toBeInTheDocument();
  });

  it('forwards onViewTraces with CLIENT span kind when a query operation row is clicked', async () => {
    (getEndpoints as jest.Mock).mockResolvedValue({
      ...emptyEndpoints,
      database: [
        {
          spanName: 'SELECT users',
          dbSystem: 'postgresql',
          rate: 10,
          errorRate: 2,
          p50Duration: 2,
          p95Duration: 8,
          p99Duration: 15,
          durationUnit: 'ms',
        },
      ],
    });
    (getRuntimeMetrics as jest.Mock).mockResolvedValue(emptyRuntime);
    const onViewTraces = jest.fn();

    renderTab({ onViewTraces });
    await screen.findByText('SELECT users');
    fireEvent.click(screen.getByText('SELECT users'));

    expect(onViewTraces).toHaveBeenCalledWith('SELECT users', 'error', 'SPAN_KIND_CLIENT');
  });

  it('renders a "View DB traces" explore link', async () => {
    (getEndpoints as jest.Mock).mockResolvedValue({
      ...emptyEndpoints,
      database: [
        {
          spanName: 'SELECT users',
          dbSystem: 'postgresql',
          rate: 10,
          errorRate: 0,
          p50Duration: 2,
          p95Duration: 8,
          p99Duration: 15,
          durationUnit: 'ms',
        },
      ],
    });
    (getRuntimeMetrics as jest.Mock).mockResolvedValue(emptyRuntime);

    renderTab();
    expect(await screen.findByText('View DB traces')).toBeInTheDocument();
  });
});
