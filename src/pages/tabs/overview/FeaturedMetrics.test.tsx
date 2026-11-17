import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { EmbeddedScene, SceneFlexLayout, SceneQueryRunner } from '@grafana/scenes';
import { FeaturedMetrics } from './FeaturedMetrics';
import { CustomMetric } from '../../../api/client';

const mockStorage = { getItem: jest.fn(), setItem: jest.fn() };
jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  usePluginUserStorage: () => mockStorage,
}));

jest.mock('@grafana/scenes', () => ({
  EmbeddedScene: jest.fn().mockImplementation((config) => ({
    ...config,
    Component: () => <div data-testid="selected-metrics-scene" />,
  })),
  SceneFlexLayout: jest.fn().mockImplementation((config) => config),
  SceneFlexItem: jest.fn().mockImplementation((config) => config),
  SceneQueryRunner: jest.fn().mockImplementation((config) => config),
  SceneTimeRange: jest.fn().mockImplementation((config) => config),
  PanelBuilders: {
    timeseries: () => {
      const builder = {
        setTitle: () => builder,
        setData: () => builder,
        setDescription: () => builder,
        setUnit: () => builder,
        build: () => ({}),
      };
      return builder;
    },
  },
}));

jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Combobox: ({ value, options, onChange, disabled, 'aria-labelledby': labelledBy }: any) => (
    <select
      aria-labelledby={labelledBy}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange({ value: e.target.value })}
    >
      {options.map((option: { value: string; label: string }) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const counter: CustomMetric = {
  name: 'orders_total',
  type: 'counter',
  chart: 'rate',
  help: '',
  unit: '',
  series: 2,
  highCardinality: false,
};
const gauge: CustomMetric = {
  ...counter,
  name: 'queue_depth',
  type: 'gauge',
  chart: 'gauge',
};
const histogram: CustomMetric = {
  ...counter,
  name: 'processing_seconds',
  type: 'histogram',
  chart: 'p95',
  unit: 'seconds',
};
const expensive: CustomMetric = { ...counter, name: 'expensive_total', highCardinality: true };

function Location() {
  const location = useLocation();
  return <span data-testid="location">{location.search}</span>;
}

function renderMetrics(initialEntry = '/services/team/app?tab=overview&environment=dev', service = 'app') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <FeaturedMetrics
        namespace="team"
        service={service}
        data={{ metrics: [counter, gauge, histogram, expensive], truncated: false }}
        loading={false}
        error={null}
      />
      <Location />
    </MemoryRouter>
  );
}

describe('FeaturedMetrics', () => {
  const runner = SceneQueryRunner as unknown as jest.Mock;
  const saved = new Map<string, string>();
  beforeEach(() => {
    runner.mockClear();
    saved.clear();
    mockStorage.getItem.mockReset().mockImplementation(async (key: string) => saved.get(key) ?? null);
    mockStorage.setItem.mockReset().mockImplementation(async (key: string, value: string) => {
      saved.set(key, value);
    });
  });

  it('offers chartable metrics and charts a selection using the service filter', async () => {
    renderMetrics();
    const toggle = screen.getByRole('button', { name: 'Select metrics' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const selectors = screen.getAllByRole('combobox');
    expect(selectors).toHaveLength(3);
    expect(screen.queryByRole('option', { name: 'expensive_total' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('selected-metrics-scene')).not.toBeInTheDocument();

    await waitFor(() => expect(selectors[0]).toBeEnabled());
    fireEvent.change(selectors[0], { target: { value: 'orders_total' } });
    expect(screen.getByTestId('selected-metrics-scene')).toBeInTheDocument();
    expect(runner.mock.calls.at(-1)[0].queries[0].expr).toBe(
      'sum(rate(orders_total{app="app", namespace="team"}[$__rate_interval]))'
    );
    expect(screen.getByTestId('location')).toHaveTextContent('tab=overview');
    expect(screen.getByTestId('location')).toHaveTextContent('environment=dev');
    expect(screen.getByTestId('location')).toHaveTextContent('overviewMetric1=orders_total');

    fireEvent.change(selectors[1], { target: { value: 'queue_depth' } });
    expect(runner.mock.calls.at(-1)[0].queries[0].expr).toBe('avg(queue_depth{app="app", namespace="team"})');
    expect(screen.getByTestId('location')).toHaveTextContent('overviewMetric2=queue_depth');
    expect(screen.queryAllByRole('option', { name: 'orders_total' })).toHaveLength(1);

    fireEvent.change(selectors[2], { target: { value: 'processing_seconds' } });
    const layout = SceneFlexLayout as unknown as jest.Mock;
    expect(layout.mock.calls.at(-1)[0].children).toHaveLength(3);
    expect(runner.mock.calls.at(-1)[0].queries[0].expr).toContain('processing_seconds_bucket');
  });

  it('restores URL selections and drops a cleared slot without changing other selections', async () => {
    renderMetrics('/services/team/app?overviewMetric1=orders_total&overviewMetric2=queue_depth');
    expect(screen.getByTestId('selected-metrics-scene')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /selected metrics.*configure/i }));
    const selectors = screen.getAllByRole('combobox');
    expect(selectors[0]).toHaveValue('orders_total');
    expect(selectors[1]).toHaveValue('queue_depth');
    await waitFor(() => expect(selectors[0]).toBeEnabled());
    fireEvent.change(selectors[0], { target: { value: '' } });
    expect(screen.getByTestId('location')).not.toHaveTextContent('overviewMetric1=');
    expect(screen.getByTestId('location')).toHaveTextContent('overviewMetric2=queue_depth');
  });

  it('collapses only the controls without rebuilding or hiding the graphs', () => {
    renderMetrics('/services/team/app?overviewMetric1=orders_total');
    const toggle = screen.getByRole('button', { name: /selected metrics.*configure/i });
    const initialQueries = runner.mock.calls.length;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const graph = screen.getByTestId('selected-metrics-scene');
    expect(graph.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    fireEvent.click(toggle);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByTestId('selected-metrics-scene')).toBeInTheDocument();
    expect(runner).toHaveBeenCalledTimes(initialQueries);
  });

  it('keeps the mounted scene across discovery refreshes but rebuilds when a selected chart changes', () => {
    const sceneBuilder = EmbeddedScene as unknown as jest.Mock;
    sceneBuilder.mockClear();
    const entry = '/services/team/app?overviewMetric1=orders_total';
    const content = (metrics: CustomMetric[]) => (
      <MemoryRouter initialEntries={[entry]}>
        <FeaturedMetrics
          namespace="team"
          service="app"
          data={{ metrics, truncated: false }}
          loading={false}
          error={null}
        />
      </MemoryRouter>
    );
    const view = render(content([counter, gauge]));
    const graph = screen.getByTestId('selected-metrics-scene');
    expect(sceneBuilder).toHaveBeenCalledTimes(1);

    view.rerender(
      content([
        { ...counter, series: 99 },
        { ...gauge, help: 'Unselected metric changed' },
      ])
    );
    expect(sceneBuilder).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('selected-metrics-scene')).toBe(graph);

    view.rerender(content([{ ...counter, chart: 'gauge', help: 'Now a gauge' }, gauge]));
    expect(sceneBuilder).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('selected-metrics-scene')).not.toBe(graph);
    expect(runner.mock.calls.at(-1)[0].queries[0].expr).toBe('avg(orders_total{app="app", namespace="team"})');
  });

  it('does not chart an unknown or high-cardinality URL selection', () => {
    renderMetrics('/services/team/app?overviewMetric1=expensive_total&overviewMetric2=unknown');
    expect(screen.queryByTestId('selected-metrics-scene')).not.toBeInTheDocument();
  });

  it('restores saved selections for this service after navigating away and back', async () => {
    const firstVisit = renderMetrics();
    fireEvent.click(screen.getByRole('button', { name: 'Select metrics' }));
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).toBeEnabled());
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'orders_total' } });
    await waitFor(() => expect(saved.get('selectedMetrics:team/app')).toBe('["orders_total","",""]'));
    firstVisit.unmount();

    const revisit = renderMetrics('/services/team/app');
    await waitFor(() => expect(screen.getByTestId('selected-metrics-scene')).toBeInTheDocument());
    revisit.unmount();

    renderMetrics('/services/team/app', 'other');
    await waitFor(() => expect(mockStorage.getItem).toHaveBeenCalledWith('selectedMetrics:team/other'));
    expect(screen.queryByTestId('selected-metrics-scene')).not.toBeInTheDocument();
  });

  it('loads pinned graphs without adding selections to the URL', async () => {
    saved.set('selectedMetrics:team/app', '["orders_total","queue_depth",""]');
    renderMetrics('/services/team/app');
    await waitFor(() => expect(screen.getByTestId('selected-metrics-scene')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /selected metrics.*configure/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByTestId('location').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /selected metrics.*configure/i }));
    expect(screen.getAllByRole('combobox')[0]).toHaveValue('orders_total');
    expect(screen.getAllByRole('combobox')[1]).toHaveValue('queue_depth');
  });

  it('uses explicit URL selections instead of pinned selections without overwriting storage', async () => {
    saved.set('selectedMetrics:team/app', '["orders_total","",""]');
    renderMetrics('/services/team/app?overviewMetric2=queue_depth');
    await waitFor(() => expect(mockStorage.getItem).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /selected metrics.*configure/i }));
    expect(screen.getAllByRole('combobox')[0]).toHaveValue('');
    expect(screen.getAllByRole('combobox')[1]).toHaveValue('queue_depth');
    expect(mockStorage.setItem).not.toHaveBeenCalled();
  });

  it('clears a pinned choice and keeps it cleared on return', async () => {
    saved.set('selectedMetrics:team/app', '["orders_total","",""]');
    const firstVisit = renderMetrics('/services/team/app');
    await waitFor(() => expect(screen.getByTestId('selected-metrics-scene')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /selected metrics.*configure/i }));
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '' } });
    await waitFor(() => expect(saved.get('selectedMetrics:team/app')).toBe('["","",""]'));
    firstVisit.unmount();
    renderMetrics('/services/team/app');
    await waitFor(() => expect(mockStorage.getItem).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('selected-metrics-scene')).not.toBeInTheDocument();
  });

  it('shows storage failures rather than silently claiming that selections were saved', async () => {
    mockStorage.setItem.mockRejectedValue(new Error('permission denied'));
    renderMetrics();
    fireEvent.click(screen.getByRole('button', { name: 'Select metrics' }));
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).toBeEnabled());
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'orders_total' } });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save selected metrics: permission denied')
    );
  });

  it('keeps the selectors disabled until saved choices load so an early edit cannot erase the other slots', async () => {
    let finishLoad!: (value: string) => void;
    mockStorage.getItem.mockReturnValue(new Promise<string>((resolve) => (finishLoad = resolve)));
    renderMetrics('/services/team/app');
    fireEvent.click(screen.getByRole('button', { name: 'Select metrics' }));
    const selectors = screen.getAllByRole('combobox');
    expect(selectors).toHaveLength(3);
    for (const selector of selectors) {
      expect(selector).toBeDisabled();
    }
    expect(screen.getByText('Loading saved metrics...')).toBeInTheDocument();
    expect(mockStorage.setItem).not.toHaveBeenCalled();

    finishLoad('["orders_total","queue_depth",""]');
    await waitFor(() => expect(selectors[0]).toBeEnabled());
    expect(selectors[0]).toHaveValue('orders_total');
    expect(selectors[1]).toHaveValue('queue_depth');
    fireEvent.change(selectors[0], { target: { value: 'processing_seconds' } });
    await waitFor(() => expect(saved.get('selectedMetrics:team/app')).toBe('["processing_seconds","queue_depth",""]'));
  });

  it('reports an invalid saved selection so it can be replaced', async () => {
    saved.set('selectedMetrics:team/app', '{"unexpected":"shape"}');
    renderMetrics('/services/team/app');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid saved metric selections'));
    expect(screen.queryByTestId('selected-metrics-scene')).not.toBeInTheDocument();
  });

  it('treats a missing key in existing Grafana storage as no saved metrics', async () => {
    mockStorage.getItem.mockResolvedValue(undefined);
    renderMetrics('/services/team/app');
    fireEvent.click(screen.getByRole('button', { name: 'Select metrics' }));
    await waitFor(() => expect(screen.queryByText('Loading saved metrics...')).not.toBeInTheDocument());
    expect(mockStorage.getItem).toHaveBeenCalledWith('selectedMetrics:team/app');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('selected-metrics-scene')).not.toBeInTheDocument();
  });
});
