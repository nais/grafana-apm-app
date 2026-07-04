import React from 'react';
import { render, screen } from '@testing-library/react';
import { OverviewTab } from './OverviewTab';
import { ConnectedServicesResponse, DependencySummary, HealthSummary } from '../../api/client';

// Isolate composition: exercise OverviewTab's own section structure without
// pulling in CustomMetricsPanel's fetch/datasource hooks or
// HealthSummarySection's degraded-ops rendering (each has its own test file).
jest.mock('../../components/CustomMetricsPanel', () => ({
  CustomMetricsPanel: () => <div data-testid="custom-metrics-panel" />,
}));
jest.mock('../../components/HealthSummary/HealthSummarySection', () => ({
  HealthSummarySection: () => <div data-testid="health-summary-section" />,
}));
// SloPanel owns its own instant-query/datasource hooks and router usage; its
// behavior is covered by SloPanel.test.tsx.
jest.mock('./overview/SloPanel', () => ({
  SloPanel: () => <div data-testid="slo-panel" />,
}));

function baseProps() {
  return {
    scene: { Component: () => <div data-testid="scene-red-panels" /> } as any,
    namespace: 'team',
    sceneKey: 'k',
    operations: [],
    opsLoading: false,
    opsError: null,
    service: 'app',
    onViewAllOperations: jest.fn(),
  };
}

const DEPENDENCIES: DependencySummary[] = [
  { name: 'postgres', type: 'database', rate: 10, errorRate: 0, p95Duration: 5, durationUnit: 'ms', impact: 1 },
  { name: 'redis', type: 'database', rate: 5, errorRate: 0, p95Duration: 1, durationUnit: 'ms', impact: 1 },
];

const CONNECTED: ConnectedServicesResponse = {
  inbound: [{ name: 'caller-a', rate: 4, errorRate: 0, p95Duration: 2, durationUnit: 'ms' }],
  outbound: [],
};

const HEALTH: HealthSummary = {
  rate: 50,
  errorRate: 1.2,
  p95Duration: 80,
  durationUnit: 'ms',
  prevRate: 40,
  prevErrorRate: 1.2,
  prevP95Duration: 80,
};

describe('OverviewTab section structure', () => {
  it('renders the health header row above the RED panels scene', () => {
    render(<OverviewTab {...baseProps()} health={HEALTH} healthLoading={false} />);

    const container = screen.getByTestId('scene-red-panels').closest('body') as HTMLElement;
    const html = container.innerHTML;
    // "Request rate" (from HealthHeaderRow) must precede the scene marker in
    // document order — the instant health signal is the top of the page (#35).
    expect(html.indexOf('Request rate')).toBeGreaterThan(-1);
    expect(html.indexOf('Request rate')).toBeLessThan(html.indexOf('scene-red-panels'));
  });

  it('passes the health prop through to the header row', () => {
    render(<OverviewTab {...baseProps()} health={HEALTH} healthLoading={false} />);

    expect(screen.getByText('50.00 req/s')).toBeInTheDocument();
    expect(screen.getByText('1.2%')).toBeInTheDocument();
    expect(screen.getByText('80ms')).toBeInTheDocument();
  });

  it('still renders the attention section and the (collapsible) custom metrics section', () => {
    render(<OverviewTab {...baseProps()} health={HEALTH} healthLoading={false} />);

    expect(screen.getByTestId('health-summary-section')).toBeInTheDocument();
    expect(screen.getByTestId('custom-metrics-panel')).toBeInTheDocument();
  });

  it('renders no health header row when health data is unavailable and not loading', () => {
    render(<OverviewTab {...baseProps()} health={null} healthLoading={false} />);

    expect(screen.queryByText('Request rate')).not.toBeInTheDocument();
  });
});

describe('OverviewTab dependency signal (IA review 2, rule 3)', () => {
  it('renders a one-line count summary instead of the topology graph or callers/dependencies tables', () => {
    render(
      <OverviewTab
        {...baseProps()}
        health={HEALTH}
        healthLoading={false}
        connected={CONNECTED}
        dependencies={DEPENDENCIES}
        onViewAllDependencies={jest.fn()}
      />
    );

    // The full detail surfaces (graph + tables) that duplicated the
    // Dependencies tab must be gone.
    expect(screen.queryByText('Service Topology')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Callers \(/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Dependencies \(/)).not.toBeInTheDocument();

    // The compact signal — counts, not a copy — is present instead.
    expect(screen.getByText('2 dependencies · 1 caller →')).toBeInTheDocument();
  });

  it('surfaces the degraded-dependency count as the actionable bit when dependencies are unhealthy', () => {
    const unhealthyHealth: HealthSummary = {
      ...HEALTH,
      degradedDeps: [
        {
          name: 'postgres',
          type: 'database',
          rate: 10,
          errorRate: 8,
          p95Duration: 50,
          durationUnit: 'ms',
          prevErrorRate: 0.5,
          prevP95Duration: 20,
          errorAnomaly: true,
        },
      ],
    };

    render(
      <OverviewTab
        {...baseProps()}
        health={unhealthyHealth}
        healthLoading={false}
        connected={CONNECTED}
        dependencies={DEPENDENCIES}
        onViewAllDependencies={jest.fn()}
      />
    );

    expect(screen.getByText('2 dependencies · 1 unhealthy · 1 caller →')).toBeInTheDocument();
  });

  it('links to the Dependencies tab when clicked', () => {
    const onViewAllDependencies = jest.fn();
    render(
      <OverviewTab
        {...baseProps()}
        health={HEALTH}
        healthLoading={false}
        connected={CONNECTED}
        dependencies={DEPENDENCIES}
        onViewAllDependencies={onViewAllDependencies}
      />
    );

    screen.getByText('2 dependencies · 1 caller →').click();
    expect(onViewAllDependencies).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when there are no dependencies and no callers (content-gated)', () => {
    render(
      <OverviewTab
        {...baseProps()}
        health={HEALTH}
        healthLoading={false}
        connected={{ inbound: [], outbound: [] }}
        dependencies={[]}
        onViewAllDependencies={jest.fn()}
      />
    );

    expect(screen.queryByText(/dependencies/i)).not.toBeInTheDocument();
  });
});
