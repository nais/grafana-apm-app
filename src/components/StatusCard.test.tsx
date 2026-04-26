import React from 'react';
import { render, screen } from '@testing-library/react';
import { StatusCard, StatusCardProps } from './StatusCard';
import { ServiceSummary } from '../api/client';

const baseService: ServiceSummary = {
  name: 'my-api',
  namespace: 'myteam',
  environment: 'prod',
  rate: 42.5,
  errorRate: 0.3,
  p95Duration: 120,
  durationUnit: 'ms',
};

const criticalService: ServiceSummary = {
  ...baseService,
  name: 'payment-svc',
  errorRate: 8.2,
  p95Duration: 3200,
};

function renderCard(overrides: Partial<StatusCardProps> = {}) {
  const props: StatusCardProps = {
    service: baseService,
    status: 'healthy',
    ...overrides,
  };
  return render(<StatusCard {...props} />);
}

describe('StatusCard', () => {
  it('renders service name', () => {
    renderCard();
    expect(screen.getByText('my-api')).toBeInTheDocument();
  });

  it('renders environment badge', () => {
    renderCard();
    expect(screen.getByText('prod')).toBeInTheDocument();
  });

  it('renders metrics for healthy service', () => {
    renderCard();
    expect(screen.getByText(/42\.50 req\/s/)).toBeInTheDocument();
    expect(screen.getByText(/0\.3% err/)).toBeInTheDocument();
    expect(screen.getByText(/p95: 120ms/)).toBeInTheDocument();
  });

  it('has accessible label with health status', () => {
    renderCard({ status: 'critical', service: criticalService });
    expect(screen.getByRole('button', { name: /payment-svc: Critical/ })).toBeInTheDocument();
  });

  it('renders noData state with last seen', () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    renderCard({
      status: 'noData',
      lastSeen: fiveMinAgo,
    });
    expect(screen.getByText('NO DATA')).toBeInTheDocument();
    expect(screen.getByText(/seen 5 min ago/)).toBeInTheDocument();
  });

  it('renders noData state without last seen', () => {
    renderCard({ status: 'noData' });
    expect(screen.getByText('NO DATA')).toBeInTheDocument();
    expect(screen.queryByText(/seen/)).not.toBeInTheDocument();
  });

  it('renders trend arrows when previous data is available', () => {
    const previous: ServiceSummary = {
      ...baseService,
      errorRate: 0.1,
      p95Duration: 150,
      rate: 40,
    };
    renderCard({ previous });
    // Error rate went up (0.1 → 0.3), p95 went down (150 → 120), rate went up
    expect(screen.getAllByText('↑').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('↓').length).toBeGreaterThanOrEqual(1);
  });

  it('does not show metrics in noData state', () => {
    renderCard({ status: 'noData' });
    expect(screen.queryByText(/req\/s/)).not.toBeInTheDocument();
    expect(screen.queryByText(/err/)).not.toBeInTheDocument();
  });
});
