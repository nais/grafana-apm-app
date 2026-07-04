import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BackendTab } from './BackendTab';
import { ServerTab } from './ServerTab';
import { RuntimeTab } from './RuntimeTab';
import {
  getEndpoints,
  getGraphQLMetrics,
  getRuntimeMetrics,
  EndpointGroups,
  EndpointSummary,
  RuntimeResponse,
} from '../../api/client';

jest.mock('../../api/client', () => ({
  getEndpoints: jest.fn(),
  getGraphQLMetrics: jest.fn(),
  getRuntimeMetrics: jest.fn(),
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

const httpEndpoint: EndpointSummary = {
  spanName: 'GET /health',
  httpMethod: 'GET',
  httpRoute: '/health',
  rate: 5,
  errorRate: 0,
  p50Duration: 1,
  p95Duration: 3,
  p99Duration: 5,
  durationUnit: 'ms',
};

const emptyRuntime: RuntimeResponse = {};

const containerRuntime: RuntimeResponse = {
  container: {
    status: 'detected',
    cpuUsage: 0.2,
    cpuRequests: 0.5,
    cpuLimits: 1,
    cpuThrottled: 0,
    memoryUsage: 100_000_000,
    memoryRequests: 200_000_000,
    memoryLimits: 400_000_000,
    restarts: 0,
    podCount: 2,
    desiredReplicas: 2,
  },
};

const renderBackendTab = (props: Partial<React.ComponentProps<typeof BackendTab>> = {}) =>
  render(
    <MemoryRouter>
      <BackendTab service="checkout" namespace="team-a" environment="prod" fromMs={1000} toMs={2000} {...props} />
    </MemoryRouter>
  );

describe('BackendTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getGraphQLMetrics as jest.Mock).mockResolvedValue(null);
  });

  it('renders both the Endpoints and Runtime sections', async () => {
    (getEndpoints as jest.Mock).mockResolvedValue({ ...emptyEndpoints, http: [httpEndpoint] });
    (getRuntimeMetrics as jest.Mock).mockResolvedValue(containerRuntime);

    renderBackendTab();

    expect(screen.getByText('Endpoints')).toBeInTheDocument();
    expect(screen.getByText('RED — rate, errors, duration per operation')).toBeInTheDocument();
    expect(await screen.findByText('/health')).toBeInTheDocument();
    expect(screen.getByText('Runtime — process resources')).toBeInTheDocument();
  });

  it('keeps the Runtime section collapsed by default', async () => {
    (getEndpoints as jest.Mock).mockResolvedValue(emptyEndpoints);
    (getRuntimeMetrics as jest.Mock).mockResolvedValue(containerRuntime);

    renderBackendTab();

    // The collapse header renders immediately; its content (the RuntimeTab,
    // and therefore its getRuntimeMetrics fetch) is not mounted until opened.
    expect(screen.getByText('Runtime — process resources')).toBeInTheDocument();
    expect(screen.queryByText('Container Resources')).not.toBeInTheDocument();
    expect(getRuntimeMetrics).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Runtime — process resources'));

    expect(await screen.findByText('Container Resources')).toBeInTheDocument();
  });

  it('forwards onViewTraces from the Endpoints section', async () => {
    (getEndpoints as jest.Mock).mockResolvedValue({ ...emptyEndpoints, http: [httpEndpoint] });
    (getRuntimeMetrics as jest.Mock).mockResolvedValue(emptyRuntime);
    const onViewTraces = jest.fn();

    renderBackendTab({ onViewTraces });
    await screen.findByText('/health');
    fireEvent.click(screen.getByText('/health'));

    expect(onViewTraces).toHaveBeenCalledWith('/health', '');
  });
});

// Backward-compat: BackendTab only wraps ServerTab/RuntimeTab in section
// chrome and forwards props unchanged — neither component was modified, so
// both must keep working exactly as before when mounted on their own (as
// ServiceOverview does today for tab=server / tab=runtime).
describe('ServerTab (standalone, backward-compat)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getGraphQLMetrics as jest.Mock).mockResolvedValue(null);
  });

  it('still renders unchanged outside of BackendTab', async () => {
    (getEndpoints as jest.Mock).mockResolvedValue({ ...emptyEndpoints, http: [httpEndpoint] });

    render(
      <MemoryRouter>
        <ServerTab service="checkout" namespace="team-a" fromMs={1000} toMs={2000} environment="prod" />
      </MemoryRouter>
    );

    expect(await screen.findByText('/health')).toBeInTheDocument();
    expect(screen.getByText('HTTP Endpoints')).toBeInTheDocument();
  });
});

describe('RuntimeTab (standalone, backward-compat)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('still renders unchanged outside of BackendTab', async () => {
    (getRuntimeMetrics as jest.Mock).mockResolvedValue(containerRuntime);

    render(
      <MemoryRouter>
        <RuntimeTab service="checkout" namespace="team-a" environment="prod" fromMs={1000} toMs={2000} />
      </MemoryRouter>
    );

    expect(await screen.findByText('Container Resources')).toBeInTheDocument();
  });
});
