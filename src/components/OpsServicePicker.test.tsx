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
          {
            namespace: 'demo',
            name: 'api',
            environment: 'prod',
            rate: 1,
            errorRate: 0,
            p95Duration: 10,
            durationUnit: 'ms',
          },
          {
            namespace: 'demo',
            name: 'frontend',
            environment: 'prod',
            rate: 1,
            errorRate: 0,
            p95Duration: 10,
            durationUnit: 'ms',
          },
        ]}
        watchlist={[{ namespace: 'demo', service: 'api', environment: 'prod' }]}
        onDismiss={jest.fn()}
        onAdd={onAdd}
        onRemove={onRemove}
      />
    );

    expect(screen.getByText('demo/api · prod')).toBeInTheDocument();
    expect(screen.getByText('demo/frontend · prod')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledWith('demo', 'api', 'prod');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith('demo', 'frontend', 'prod');

    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'front' } });
    expect(screen.queryByText('demo/api · prod')).not.toBeInTheDocument();
    expect(screen.getByText('demo/frontend · prod')).toBeInTheDocument();
  });

  it('scopes watchlist membership per environment', () => {
    const onAdd = jest.fn();

    render(
      <OpsServicePicker
        isOpen
        services={[
          {
            namespace: 'demo',
            name: 'api',
            environment: 'prod',
            rate: 1,
            errorRate: 0,
            p95Duration: 10,
            durationUnit: 'ms',
          },
          {
            namespace: 'demo',
            name: 'api',
            environment: 'dev',
            rate: 1,
            errorRate: 0,
            p95Duration: 10,
            durationUnit: 'ms',
          },
        ]}
        // Only prod is watched — dev must remain unselected (the bug: adding
        // prod also marked/added dev because entries ignored environment).
        watchlist={[{ namespace: 'demo', service: 'api', environment: 'prod' }]}
        onDismiss={jest.fn()}
        onAdd={onAdd}
        onRemove={jest.fn()}
      />
    );

    // Exactly one row is watched (prod → Remove); the dev row is still addable.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    const addButton = screen.getByRole('button', { name: 'Add' });

    // Clicking Add on the dev row adds dev only, not prod.
    fireEvent.click(addButton);
    expect(onAdd).toHaveBeenCalledWith('demo', 'api', 'dev');
  });
});
