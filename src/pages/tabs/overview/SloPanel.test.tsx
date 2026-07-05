import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SloPanel } from './SloPanel';
import * as sloData from './sloData';

const pushMock = jest.fn();
const publishMock = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getAppEvents: () => ({ publish: publishMock }),
  locationService: { push: (...args: unknown[]) => pushMock(...args) },
}));

jest.mock('../../../utils/capabilities', () => ({
  ...jest.requireActual('../../../utils/capabilities'),
  useCapabilities: () => ({
    caps: { spanMetrics: { detected: true, callsMetric: 'traces_spanmetrics_calls_total' } },
    loading: false,
  }),
}));

jest.mock('../../../utils/datasources', () => ({
  usePluginDatasources: () => ({ metricsUid: 'mimir', tracesUid: 'tempo', logsUid: 'loki' }),
}));

// Keep the pure compute/selector logic real; only stub the network calls.
jest.mock('./sloData', () => ({
  ...jest.requireActual('./sloData'),
  fetchSloMetrics: jest.fn(),
  fetchSloBurnTemplateUrl: jest.fn(),
}));

const mockedFetchMetrics = sloData.fetchSloMetrics as jest.MockedFunction<typeof sloData.fetchSloMetrics>;
const mockedFetchTemplate = sloData.fetchSloBurnTemplateUrl as jest.MockedFunction<
  typeof sloData.fetchSloBurnTemplateUrl
>;

function LocationDisplay() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

function renderPanel(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SloPanel namespace="team-a" service="my-svc" environment="prod-gcp" />
      <LocationDisplay />
    </MemoryRouter>
  );
}

beforeEach(() => {
  pushMock.mockReset();
  publishMock.mockReset();
  mockedFetchTemplate.mockReset();
});

describe('SloPanel', () => {
  it('renders compliance, remaining budget and burn rate for the default 99.9% target', async () => {
    mockedFetchMetrics.mockResolvedValue({ errorRatio30d: 0.0002, total30d: 1_000_000, errorRatio1h: 0.0001 });
    renderPanel();

    // compliance = (1-0.0002)*100 → 99.980%
    expect(await screen.findByText('99.980%')).toBeInTheDocument();
    // budget remaining = 80%
    expect(screen.getByText('80%')).toBeInTheDocument();
    // burn = 0.0001 / 0.001 = 0.10× budget
    expect(screen.getByText('0.10')).toBeInTheDocument();
    // The burn-rate alert actions link to the create-alerts how-to.
    const docsLink = screen.getByRole('link', { name: /About alert templates/ });
    expect(docsLink).toHaveAttribute('href', 'https://doc.nais.io/observability/apm/how-to/create-alerts/');
  });

  it('exposes the colour-coded budget bar status as text (WCAG 1.4.1)', async () => {
    mockedFetchMetrics.mockResolvedValue({ errorRatio30d: 0.0002, total30d: 1_000_000, errorRatio1h: 0.0001 });
    renderPanel();
    await screen.findByText('99.980%');
    // The budget bar colour (healthy/warning/critical) is also carried as text.
    expect(screen.getByRole('img', { name: /Error budget status:/ })).toBeInTheDocument();
    // The SLO target radio group is named for context.
    expect(screen.getByRole('radiogroup', { name: 'SLO target' })).toBeInTheDocument();
  });

  it('degrades honestly to "not enough data" when 30d traffic is too low', async () => {
    mockedFetchMetrics.mockResolvedValue({ errorRatio30d: 0.0002, total30d: 100, errorRatio1h: null });
    renderPanel();

    await waitFor(() => expect(screen.getAllByText('Not enough data').length).toBeGreaterThan(0));
    // compliance + budget both degrade
    expect(screen.getAllByText('Not enough data')).toHaveLength(2);
  });

  it('persists the SLO target to the URL and recomputes when the selector changes', async () => {
    mockedFetchMetrics.mockResolvedValue({ errorRatio30d: 0.0002, total30d: 1_000_000, errorRatio1h: 0.0001 });
    renderPanel();

    await screen.findByText('99.980%');
    // default has 80% remaining against the 99.9% budget
    expect(screen.getByText('80%')).toBeInTheDocument();

    fireEvent.click(screen.getByText('99.99%'));

    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toContain('slo=0.9999'));
    // against the 10x-smaller 99.99% budget the same error rate is 200% consumed → -100% remaining
    expect(await screen.findByText('-100%')).toBeInTheDocument();
  });

  it('creates the fast-burn alert via the template flow', async () => {
    mockedFetchMetrics.mockResolvedValue({ errorRatio30d: 0.0002, total30d: 1_000_000, errorRatio1h: 0.0001 });
    mockedFetchTemplate.mockResolvedValue('/alerting/new?defaults=%7B%7D');
    renderPanel();

    await screen.findByText('99.980%');
    fireEvent.click(screen.getByText('Fast burn (page)'));

    await waitFor(() => expect(mockedFetchTemplate).toHaveBeenCalled());
    expect(mockedFetchTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'my-svc',
        namespace: 'team-a',
        environment: 'prod-gcp',
        window: 'fast',
        target: 0.999,
      })
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(pushMock.mock.calls[0][0]).toContain('/alerting/new?defaults=');
  });

  it('passes the selected target through to the slow-burn alert', async () => {
    mockedFetchMetrics.mockResolvedValue({ errorRatio30d: 0.0002, total30d: 1_000_000, errorRatio1h: 0.0001 });
    mockedFetchTemplate.mockResolvedValue('/alerting/new?defaults=%7B%7D');
    renderPanel('/?slo=0.995');

    await screen.findByText('99.980%');
    fireEvent.click(screen.getByText('Slow burn (ticket)'));

    await waitFor(() => expect(mockedFetchTemplate).toHaveBeenCalled());
    expect(mockedFetchTemplate).toHaveBeenCalledWith(expect.objectContaining({ window: 'slow', target: 0.995 }));
  });
});
