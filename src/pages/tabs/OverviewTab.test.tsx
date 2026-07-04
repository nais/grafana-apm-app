import React from 'react';
import { render, screen } from '@testing-library/react';
import { OverviewTab } from './OverviewTab';
import { HealthSummary } from '../../api/client';

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
    graphNodes: [],
    graphEdges: [],
    service: 'app',
    onViewAllOperations: jest.fn(),
    onNavigateService: jest.fn(),
  };
}

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
