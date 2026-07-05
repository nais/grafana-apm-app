import React from 'react';
import { render, screen } from '@testing-library/react';
import { DependencySignal } from './DependencySignal';
import { ConnectedServicesResponse, DependencySummary, HealthSummary } from '../../../api/client';

const DEPENDENCIES: DependencySummary[] = [
  { name: 'postgres', type: 'database', rate: 10, errorRate: 0, p95Duration: 5, durationUnit: 'ms', impact: 1 },
];

const CONNECTED: ConnectedServicesResponse = {
  inbound: [
    { name: 'caller-a', rate: 4, errorRate: 0, p95Duration: 2, durationUnit: 'ms' },
    { name: 'caller-b', rate: 2, errorRate: 0, p95Duration: 3, durationUnit: 'ms' },
  ],
  outbound: [],
};

describe('DependencySignal', () => {
  it('renders nothing when there are no dependencies and no callers', () => {
    const { container } = render(
      <DependencySignal connected={{ inbound: [], outbound: [] }} dependencies={[]} health={null} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a neutral count summary when nothing is unhealthy', () => {
    render(<DependencySignal connected={CONNECTED} dependencies={DEPENDENCIES} health={null} />);
    expect(screen.getByText('1 dependency · 2 callers →')).toBeInTheDocument();
  });

  it('handles singular/plural counts and a dependency-only case (no callers)', () => {
    render(<DependencySignal connected={{ inbound: [], outbound: [] }} dependencies={DEPENDENCIES} health={null} />);
    expect(screen.getByText('1 dependency →')).toBeInTheDocument();
  });

  it('surfaces the degraded-dependency count as the actionable bit', () => {
    const health: HealthSummary = {
      rate: 1,
      errorRate: 1,
      p95Duration: 1,
      durationUnit: 'ms',
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
        },
      ],
    };
    render(<DependencySignal connected={CONNECTED} dependencies={DEPENDENCIES} health={health} />);
    expect(screen.getByText('1 dependency · 1 unhealthy · 2 callers →')).toBeInTheDocument();
  });

  it('invokes onViewDependencies when clicked, linking to the Dependencies tab', () => {
    const onViewDependencies = jest.fn();
    render(
      <DependencySignal
        connected={CONNECTED}
        dependencies={DEPENDENCIES}
        health={null}
        onViewDependencies={onViewDependencies}
      />
    );
    screen.getByText('1 dependency · 2 callers →').click();
    expect(onViewDependencies).toHaveBeenCalledTimes(1);
  });
});
