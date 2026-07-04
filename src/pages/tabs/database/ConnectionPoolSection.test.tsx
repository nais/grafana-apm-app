import React from 'react';
import { render, screen } from '@testing-library/react';
import { ConnectionPoolSection } from './ConnectionPoolSection';
import { DBPoolRuntime } from '../../../api/client';

const dbPool: DBPoolRuntime = {
  status: 'detected',
  pools: [
    { name: 'HikariPool-1', type: 'hikari', active: 2, idle: 8, max: 10, pending: 0, timeoutRate: 0, utilization: 20 },
    {
      name: 'HikariPool-2',
      type: 'hikari',
      active: 9,
      idle: 1,
      max: 10,
      pending: 1.2,
      timeoutRate: 0.05,
      utilization: 90,
    },
  ],
};

describe('ConnectionPoolSection', () => {
  it('renders one row per pool', () => {
    render(<ConnectionPoolSection dbPool={dbPool} />);
    expect(screen.getByText('HikariPool-1')).toBeInTheDocument();
    expect(screen.getByText('HikariPool-2')).toBeInTheDocument();
  });

  it('shows the pool count badge', () => {
    render(<ConnectionPoolSection dbPool={dbPool} />);
    expect(screen.getByText('2 pools')).toBeInTheDocument();
  });

  it('renders nothing when there are no pools', () => {
    const { container } = render(<ConnectionPoolSection dbPool={{ status: 'detected', pools: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  // --- Accessibility (WCAG 1.3.1 / 1.4.1) ---

  it('names the table and gives the colour-coded utilization bar a text equivalent', () => {
    render(<ConnectionPoolSection dbPool={dbPool} />);
    expect(screen.getByRole('table', { name: 'Connection pool health' })).toBeInTheDocument();
    // The fill colour (health band) is also exposed as text, not colour alone.
    expect(screen.getByRole('img', { name: '20% utilization, healthy' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '90% utilization, warning' })).toBeInTheDocument();
  });
});
