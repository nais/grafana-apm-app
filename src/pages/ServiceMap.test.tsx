import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ServiceMap from './ServiceMap';

// Swappable per-test fixtures (must be `mock`-prefixed for jest.mock factories).
let mockClusteredResp: {
  nodes: Array<{ id: string; title: string; serviceCount?: number; errorRate?: number }>;
  edges: Array<{ id: string; source: string; target: string }>;
};
let mockFullResp: {
  nodes: Array<{ id: string; title: string; errorRate?: number }>;
  edges: Array<{ id: string; source: string; target: string }>;
};

jest.mock('../api/servicemap', () => ({
  getClusteredServiceMap: jest.fn(() => Promise.resolve(mockClusteredResp)),
  totalClusteredServices: (r: { nodes: Array<{ serviceCount?: number }> } | null) =>
    r ? r.nodes.reduce((s, n) => s + (n.serviceCount ?? 0), 0) : 0,
}));

jest.mock('../api/client', () => ({
  getServiceMap: jest.fn(() => Promise.resolve(mockFullResp)),
}));

jest.mock('../utils/datasources', () => ({
  useConfiguredEnvironments: () => [],
}));

// CopyMermaidButton pulls in mermaid utils irrelevant to these tests.
jest.mock('../components/CopyMermaidButton', () => ({
  CopyMermaidButton: () => null,
}));

// ServiceGraph renders via @xyflow/react + ELK which don't run under jsdom.
// Stub it to a flat list of clickable node buttons so we can assert which data
// set is displayed and exercise node clicks.
jest.mock('../components/ServiceGraph', () => {
  const ReactLocal = require('react');
  return {
    toGraphData: (data: { nodes: Array<{ id: string; title: string }>; edges: unknown[] } | null) => ({
      graphNodes: data ? data.nodes.map((n) => ({ id: n.id, title: n.title })) : [],
      graphEdges: data ? data.edges : [],
    }),
    ServiceGraph: ({
      nodes,
      onNodeClick,
    }: {
      nodes: Array<{ id: string; title: string }>;
      onNodeClick?: (id: string) => void;
    }) =>
      ReactLocal.createElement(
        'div',
        { 'data-testid': 'service-graph' },
        nodes.map((n) =>
          ReactLocal.createElement('button', { key: n.id, onClick: () => onNodeClick && onNodeClick(n.id) }, n.title)
        )
      ),
  };
});

function LocationDisplay() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderMap(route = '/service-map') {
  return render(
    <MemoryRouter initialEntries={[route]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ServiceMap />
      <LocationDisplay />
    </MemoryRouter>
  );
}

const bigClustered = () => ({
  nodes: [
    { id: 'team-alpha', title: 'team-alpha', serviceCount: 40, errorRate: 0 },
    { id: 'team-beta', title: 'team-beta', serviceCount: 20, errorRate: 0 },
  ],
  edges: [{ id: 'team-alpha->team-beta', source: 'team-alpha', target: 'team-beta' }],
});

const smallClustered = () => ({
  nodes: [{ id: 'team-alpha', title: 'team-alpha', serviceCount: 3, errorRate: 0 }],
  edges: [],
});

const fullMap = () => ({
  nodes: [
    { id: 'svc-one', title: 'svc-one', errorRate: 0 },
    { id: 'svc-two', title: 'svc-two', errorRate: 0 },
  ],
  edges: [{ id: 'svc-one->svc-two', source: 'svc-one', target: 'svc-two' }],
});

describe('ServiceMap — global clustered view', () => {
  beforeEach(() => {
    mockClusteredResp = bigClustered();
    mockFullResp = fullMap();
  });

  it('renders the Namespaces / Services view toggle', async () => {
    renderMap();
    await screen.findByText('team-alpha');
    expect(screen.getByText('Namespaces')).toBeInTheDocument();
    expect(screen.getByText('Services')).toBeInTheDocument();
  });

  it('defaults to the Namespaces view when there are more than 50 services', async () => {
    renderMap();
    // Namespace cluster nodes are shown; full-graph service nodes are not.
    expect(await screen.findByText('team-alpha')).toBeInTheDocument();
    expect(screen.getByText('team-beta')).toBeInTheDocument();
    expect(screen.queryByText('svc-one')).not.toBeInTheDocument();
    // Cluster summary line reflects the aggregation.
    expect(screen.getByText(/2 namespaces · 60 services · 1 cross-namespace/)).toBeInTheDocument();
  });

  it('defaults to the Services (full) view for small deployments (<=50 services)', async () => {
    mockClusteredResp = smallClustered();
    renderMap();
    // Full-graph service nodes are shown; namespace clustering is not the default.
    expect(await screen.findByText('svc-one')).toBeInTheDocument();
    expect(screen.getByText('svc-two')).toBeInTheDocument();
    expect(screen.queryByText(/cross-namespace/)).not.toBeInTheDocument();
  });

  it('an explicit ?view=services param overrides the scale default', async () => {
    renderMap('/service-map?view=services');
    expect(await screen.findByText('svc-one')).toBeInTheDocument();
    expect(screen.queryByText('team-alpha')).not.toBeInTheDocument();
  });

  it('clicking a namespace node drills down to the namespace overview page', async () => {
    renderMap();
    const node = await screen.findByText('team-alpha');
    fireEvent.click(node);
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toMatch(/namespaces\/team-alpha$/);
    });
  });

  it('switching the toggle to Services reveals the full graph', async () => {
    renderMap();
    await screen.findByText('team-alpha');
    fireEvent.click(screen.getByText('Services'));
    expect(await screen.findByText('svc-one')).toBeInTheDocument();
  });
});
