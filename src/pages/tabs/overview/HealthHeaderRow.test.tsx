import React from 'react';
import { render, screen } from '@testing-library/react';
import { HealthHeaderRow } from './HealthHeaderRow';
import { HealthSummary } from '../../../api/client';

function health(overrides: Partial<HealthSummary> = {}): HealthSummary {
  return {
    rate: 120,
    errorRate: 0.3,
    p95Duration: 42,
    durationUnit: 'ms',
    prevRate: 100,
    prevErrorRate: 0.3,
    prevP95Duration: 42,
    ...overrides,
  };
}

describe('HealthHeaderRow', () => {
  it('renders nothing while loading with no data yet', () => {
    const { container } = render(<HealthHeaderRow health={null} loading={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a loading placeholder when loading and no data is available yet', () => {
    render(<HealthHeaderRow health={null} loading={true} />);
    expect(screen.getByText(/loading health/i)).toBeInTheDocument();
  });

  it('renders the RED trio as formatted big numbers', () => {
    render(<HealthHeaderRow health={health()} loading={false} />);
    expect(screen.getByText('Request rate')).toBeInTheDocument();
    expect(screen.getByText('120.00 req/s')).toBeInTheDocument();
    expect(screen.getByText('Error rate')).toBeInTheDocument();
    expect(screen.getByText('0.3%')).toBeInTheDocument();
    expect(screen.getByText('P95 latency')).toBeInTheDocument();
    expect(screen.getByText('42ms')).toBeInTheDocument();
  });

  it('shows a red delta when error rate regressed by more than 20%', () => {
    render(<HealthHeaderRow health={health({ errorRate: 1.0, prevErrorRate: 0.3 })} loading={false} />);
    // (1.0 - 0.3) / 0.3 = +233%
    expect(screen.getByText(/\+233\.3% vs previous period/)).toBeInTheDocument();
  });

  it('shows a green delta when P95 latency improved', () => {
    render(<HealthHeaderRow health={health({ p95Duration: 30, prevP95Duration: 60 })} loading={false} />);
    expect(screen.getByText(/-50\.0% vs previous period/)).toBeInTheDocument();
  });

  it('does not color the request-rate delta even on a large increase', () => {
    render(<HealthHeaderRow health={health({ rate: 1000, prevRate: 100 })} loading={false} />);
    const deltaEl = screen.getByText(/\+900\.0% vs previous period/);
    // Neutral polarity — must not carry the "bad"/"good" severity classes.
    expect(deltaEl.className).not.toMatch(/deltaBad|deltaGood|deltaWarn/);
  });

  it('shows "no previous-period data" when there is no baseline', () => {
    render(
      <HealthHeaderRow
        health={health({ prevRate: undefined, prevErrorRate: undefined, prevP95Duration: undefined })}
        loading={false}
      />
    );
    expect(screen.getAllByText('no previous-period data')).toHaveLength(3);
  });
});
