import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryOperationsTable } from './QueryOperationsTable';
import { EndpointSummary } from '../../../api/client';

const operations: EndpointSummary[] = [
  {
    spanName: 'SELECT users',
    dbSystem: 'postgresql',
    rate: 12.5,
    errorRate: 0,
    p50Duration: 2,
    p95Duration: 8,
    p99Duration: 15,
    durationUnit: 'ms',
  },
  {
    spanName: 'INSERT orders',
    dbSystem: 'postgresql',
    rate: 3.1,
    errorRate: 2.4,
    p50Duration: 5,
    p95Duration: 40,
    p99Duration: 90,
    durationUnit: 'ms',
  },
];

const renderWithRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('QueryOperationsTable', () => {
  it('renders one row per operation with db system badge', () => {
    renderWithRouter(<QueryOperationsTable operations={operations} durationUnit="ms" />);

    expect(screen.getByText('SELECT users')).toBeInTheDocument();
    expect(screen.getByText('INSERT orders')).toBeInTheDocument();
    expect(screen.getAllByText('postgresql')).toHaveLength(2);
  });

  it('sorts by rate descending by default', () => {
    renderWithRouter(<QueryOperationsTable operations={operations} durationUnit="ms" />);

    const rows = screen.getAllByRole('row').slice(1); // skip header
    expect(rows[0]).toHaveTextContent('SELECT users');
    expect(rows[1]).toHaveTextContent('INSERT orders');
  });

  it('calls onViewTraces with error status when the row has errors', () => {
    const onViewTraces = jest.fn();
    renderWithRouter(<QueryOperationsTable operations={operations} durationUnit="ms" onViewTraces={onViewTraces} />);

    fireEvent.click(screen.getByText('INSERT orders'));
    expect(onViewTraces).toHaveBeenCalledWith('INSERT orders', 'error');
  });

  it('calls onViewTraces with empty status when the row has no errors', () => {
    const onViewTraces = jest.fn();
    renderWithRouter(<QueryOperationsTable operations={operations} durationUnit="ms" onViewTraces={onViewTraces} />);

    fireEvent.click(screen.getByText('SELECT users'));
    expect(onViewTraces).toHaveBeenCalledWith('SELECT users', '');
  });

  it('does not attach click handlers when onViewTraces is not provided', () => {
    renderWithRouter(<QueryOperationsTable operations={operations} durationUnit="ms" />);
    const row = screen.getByText('SELECT users').closest('tr');
    expect(row).not.toHaveAttribute('title');
  });

  // --- Accessibility (WCAG 1.3.1 / 4.1.2) ---

  it('names the table and reflects the active sort via aria-sort', () => {
    renderWithRouter(<QueryOperationsTable operations={operations} durationUnit="ms" />);
    expect(screen.getByRole('table', { name: 'Database operations' })).toBeInTheDocument();
    // Default sort is rate descending.
    expect(screen.getByRole('columnheader', { name: /Rate/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /System/ })).toHaveAttribute('aria-sort', 'none');
  });

  it('toggles aria-sort when the header button is activated', () => {
    renderWithRouter(<QueryOperationsTable operations={operations} durationUnit="ms" />);
    fireEvent.click(screen.getByRole('button', { name: /Rate/ }));
    expect(screen.getByRole('columnheader', { name: /Rate/ })).toHaveAttribute('aria-sort', 'ascending');
  });
});
