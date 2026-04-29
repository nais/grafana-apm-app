import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DependenciesTab } from './DependenciesTab';
import { ConnectedService, DependencySummary } from '../../api/client';

const mockCallers: ConnectedService[] = [
  { name: 'frontend', rate: 10, errorRate: 1.5, p95Duration: 200, durationUnit: 'ms' },
  { name: 'db-node', connectionType: 'database', rate: 5, errorRate: 0, p95Duration: 50, durationUnit: 'ms' },
  {
    name: 'envoy',
    rate: 8,
    errorRate: 0,
    p95Duration: 10,
    durationUnit: 'ms',
    isSidecar: true,
  },
];

const mockDeps: DependencySummary[] = [
  {
    name: 'postgres:5432',
    type: 'database',
    rate: 25,
    errorRate: 0.2,
    p95Duration: 15,
    durationUnit: 'ms',
    impact: 0.9,
  },
  { name: 'redis:6379', type: 'database', rate: 50, errorRate: 0, p95Duration: 2, durationUnit: 'ms', impact: 0.5 },
];

// Wrap in MemoryRouter since useTableSort uses useSearchParams
const renderWithRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('DependenciesTab', () => {
  const noop = jest.fn();

  it('shows both callers and dependencies sections', () => {
    renderWithRouter(
      <DependenciesTab
        service="my-service"
        callers={mockCallers}
        dependencies={mockDeps}
        onNavigateService={noop}
        onNavigateDependency={noop}
      />
    );

    expect(screen.getByText(/Callers \(3\)/)).toBeInTheDocument();
    expect(screen.getByText(/Dependencies \(2\)/)).toBeInTheDocument();
    expect(screen.getByText('frontend')).toBeInTheDocument();
    // postgres:5432 appears in both Attention (has errors) and Databases groups
    expect(screen.getAllByText('postgres:5432').length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty state when both sections are empty', () => {
    renderWithRouter(<DependenciesTab service="my-service" callers={[]} dependencies={[]} onNavigateService={noop} />);

    expect(screen.getByText('No callers or dependencies detected')).toBeInTheDocument();
  });

  it('shows only dependencies when no callers', () => {
    renderWithRouter(
      <DependenciesTab
        service="my-service"
        callers={[]}
        dependencies={mockDeps}
        onNavigateService={noop}
        onNavigateDependency={noop}
      />
    );

    expect(screen.queryByText(/Callers/)).not.toBeInTheDocument();
    expect(screen.getByText(/Dependencies \(2\)/)).toBeInTheDocument();
  });

  it('shows only callers when no dependencies', () => {
    renderWithRouter(
      <DependenciesTab service="my-service" callers={mockCallers} dependencies={[]} onNavigateService={noop} />
    );

    expect(screen.getByText(/Callers \(3\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Dependencies \(/)).not.toBeInTheDocument();
  });

  it('shows loading when both are loading', () => {
    renderWithRouter(
      <DependenciesTab service="my-service" callersLoading={true} depsLoading={true} onNavigateService={noop} />
    );

    expect(screen.getByText(/Loading callers and dependencies/)).toBeInTheDocument();
  });

  it('navigates on caller row click (service rows only)', () => {
    const onNav = jest.fn();
    renderWithRouter(
      <DependenciesTab service="my-service" callers={mockCallers} dependencies={[]} onNavigateService={onNav} />
    );

    // Click navigable service row
    fireEvent.click(screen.getByText('frontend'));
    expect(onNav).toHaveBeenCalledWith('frontend');

    // Non-navigable row (connectionType='database') should not navigate
    onNav.mockClear();
    fireEvent.click(screen.getByText('db-node'));
    expect(onNav).not.toHaveBeenCalled();
  });

  it('navigates on dependency row click', () => {
    const onNav = jest.fn();
    renderWithRouter(
      <DependenciesTab
        service="my-service"
        callers={[]}
        dependencies={mockDeps}
        onNavigateService={jest.fn()}
        onNavigateDependency={onNav}
      />
    );

    // postgres:5432 may appear in multiple groups (Attention + Databases), click first
    fireEvent.click(screen.getAllByText('postgres:5432')[0]);
    expect(onNav).toHaveBeenCalledWith('postgres:5432');
  });

  it('shows sidecar badge on sidecar callers', () => {
    renderWithRouter(
      <DependenciesTab service="my-service" callers={mockCallers} dependencies={[]} onNavigateService={noop} />
    );

    expect(screen.getByText('sidecar')).toBeInTheDocument();
  });

  it('shows error state', () => {
    renderWithRouter(<DependenciesTab service="my-service" depsError="Network error" onNavigateService={noop} />);

    expect(screen.getByText('Network error')).toBeInTheDocument();
  });
});
