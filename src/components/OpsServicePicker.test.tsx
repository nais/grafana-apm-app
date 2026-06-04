import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { OpsServicePicker } from './OpsServicePicker';

describe('OpsServicePicker', () => {
  it('filters services and toggles watchlist membership', () => {
    const onAdd = jest.fn();
    const onRemove = jest.fn();

    render(
      <OpsServicePicker
        isOpen
        services={[
          { namespace: 'demo', name: 'api', rate: 1, errorRate: 0, p95Duration: 10, durationUnit: 'ms' },
          { namespace: 'demo', name: 'frontend', rate: 1, errorRate: 0, p95Duration: 10, durationUnit: 'ms' },
        ]}
        watchlist={[{ namespace: 'demo', service: 'api' }]}
        onDismiss={jest.fn()}
        onAdd={onAdd}
        onRemove={onRemove}
      />
    );

    expect(screen.getByText('demo/api')).toBeInTheDocument();
    expect(screen.getByText('demo/frontend')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledWith('demo', 'api');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith('demo', 'frontend');

    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'front' } });
    expect(screen.queryByText('demo/api')).not.toBeInTheDocument();
    expect(screen.getByText('demo/frontend')).toBeInTheDocument();
  });
});
