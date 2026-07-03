import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { RefreshControl } from './RefreshControl';

// Grafana's Combobox needs canvas measurement + virtualization to show its
// dropdown, which jsdom can't drive reliably. Swap in a plain <select> so
// tests can exercise the selection wiring with fireEvent.change. The real
// Combobox rendering is covered by the ServiceInventory page test.
jest.mock('@grafana/ui', () => {
  const actual = jest.requireActual('@grafana/ui');
  return {
    ...actual,
    Combobox: (props: {
      'aria-label'?: string;
      options: Array<{ label: string; value: string }>;
      value: string;
      onChange: (v: { value: string }) => void;
    }) => (
      <select
        aria-label={props['aria-label']}
        value={props.value}
        onChange={(e) => props.onChange({ value: e.currentTarget.value })}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ),
  };
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="search">{location.search}</div>;
}

function renderControl(onRefresh: jest.Mock, initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <RefreshControl onRefresh={onRefresh} />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe('RefreshControl', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is off by default: no countdown, no URL param, and never fires onRefresh', () => {
    jest.useFakeTimers();
    const onRefresh = jest.fn();
    renderControl(onRefresh);

    expect(screen.getByRole('combobox')).toHaveValue('off');
    expect(screen.queryByTestId('refresh-countdown')).not.toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('');

    act(() => {
      jest.advanceTimersByTime(600000);
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('persists the selected interval to the URL as refresh=30s', () => {
    const onRefresh = jest.fn();
    renderControl(onRefresh);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '30s' } });
    expect(screen.getByTestId('search')).toHaveTextContent('refresh=30s');
  });

  it('removes the URL param when switched back to off', () => {
    const onRefresh = jest.fn();
    renderControl(onRefresh, '/?refresh=1m');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'off' } });
    expect(screen.getByTestId('search')).not.toHaveTextContent('refresh');
  });

  it('fires onRefresh on every tick and shows a countdown when active', () => {
    jest.useFakeTimers();
    const onRefresh = jest.fn();
    renderControl(onRefresh, '/?refresh=30s');

    expect(screen.getByTestId('refresh-countdown')).toHaveTextContent('30s');

    act(() => {
      jest.advanceTimersByTime(30000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(30000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('always invokes the latest onRefresh even when the prop identity changes', () => {
    jest.useFakeTimers();
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(
      <MemoryRouter
        initialEntries={['/?refresh=30s']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <RefreshControl onRefresh={first} />
      </MemoryRouter>
    );

    rerender(
      <MemoryRouter
        initialEntries={['/?refresh=30s']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <RefreshControl onRefresh={second} />
      </MemoryRouter>
    );

    act(() => {
      jest.advanceTimersByTime(30000);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('treats an unknown refresh value in the URL as off', () => {
    jest.useFakeTimers();
    const onRefresh = jest.fn();
    renderControl(onRefresh, '/?refresh=bogus');

    expect(screen.getByRole('combobox')).toHaveValue('off');
    act(() => {
      jest.advanceTimersByTime(600000);
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
