import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ServiceOverview from './ServiceOverview';
import * as capabilitiesUtils from '../utils/capabilities';

/**
 * Tab registry tests: the Issues tab is capability-gated on Loki exactly like
 * Logs; the former Endpoints + Runtime tabs are merged into one "Backend" tab
 * and a new "Alerts" tab sits after Issues (docs/ia-review-2.md). The legacy
 * URL values `tab=server` and `tab=runtime` resolve to `tab=backend` forever
 * (docs/url-contract.md). All heavy Scene-composed tab bodies are stubbed
 * here; this file only exercises the TabsBar registry, not tab content (each
 * tab has its own test file for that).
 */

jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  getAppEvents: () => ({ publish: jest.fn() }),
  locationService: { push: jest.fn() },
  getBackendSrv: () => ({ fetch: jest.fn() }),
}));

jest.mock('../utils/capabilities', () => ({
  ...jest.requireActual('../utils/capabilities'),
  useCapabilities: jest.fn(),
}));

jest.mock('../utils/useServiceData', () => ({
  useServiceData: () => ({
    serviceList: [],
    framework: '',
    envOptions: [],
    hasServerSpans: true,
    operations: [],
    opsLoading: false,
    opsError: null,
    graphNodes: [],
    graphEdges: [],
    connected: null,
    connectedLoading: false,
    depsResp: null,
    depsLoading: false,
    depsError: null,
    health: null,
    healthLoading: false,
  }),
}));

jest.mock('../utils/datasources', () => ({
  usePluginDatasources: () => ({
    metricsUid: 'mimir',
    tracesUid: 'tempo',
    logsUid: 'loki',
    isEnvSpecific: false,
    isLogsEnvSpecific: false,
  }),
  useHasEnvironmentOverrides: () => false,
  usePluginLabelOverrides: () => ({}),
}));

jest.mock('./buildServiceScene', () => ({
  buildServiceScene: () => ({ Component: () => null }),
  buildDeployAnnotationsLayer: () => undefined,
}));

// Every tab body is stubbed — this file tests the registry, not tab content.
jest.mock('./tabs/OverviewTab', () => ({ OverviewTab: () => <div data-testid="overview-tab" /> }));
jest.mock('./tabs/IssuesTab', () => ({ IssuesTab: () => <div data-testid="issues-tab" /> }));
jest.mock('./tabs/AlertsTab', () => ({ AlertsTab: () => <div data-testid="alerts-tab" /> }));
jest.mock('./tabs/BackendTab', () => ({ BackendTab: () => <div data-testid="backend-tab" /> }));
jest.mock('./tabs/FrontendTab', () => ({ FrontendTab: () => <div data-testid="frontend-tab" /> }));
jest.mock('./tabs/DependenciesTab', () => ({ DependenciesTab: () => <div data-testid="dependencies-tab" /> }));
jest.mock('./tabs/TracesTab', () => ({ TracesTab: () => <div data-testid="traces-tab" /> }));
jest.mock('./tabs/LogsTab', () => ({ LogsTab: () => <div data-testid="logs-tab" /> }));
jest.mock('./tabs/DatabaseTab', () => ({ DatabaseTab: () => <div data-testid="database-tab" /> }));
jest.mock('./tabs/ProfilingTab', () => ({ ProfilingTab: () => <div data-testid="profiling-tab" /> }));

function LocationSpy() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderPage(initialEntries: string[] = ['/services/team-a/my-svc']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route
          path="/services/:namespace/:service"
          element={
            <>
              <ServiceOverview />
              <LocationSpy />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const baseCaps = {
  spanMetrics: { detected: true },
  serviceGraph: { detected: true },
  tempo: { available: true },
  loki: { available: true },
  services: [],
};

describe('ServiceOverview tab registry', () => {
  it('shows the Issues, Alerts and merged Backend tabs when Loki is available', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: baseCaps, loading: false });
    renderPage();

    expect(screen.getByText('Issues')).toBeInTheDocument();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText('Backend')).toBeInTheDocument();
    // The former standalone tabs are gone (merged into Backend / renamed).
    expect(screen.queryByText('Endpoints')).not.toBeInTheDocument();
    expect(screen.queryByText('Runtime')).not.toBeInTheDocument();
    expect(screen.queryByText('Operations')).not.toBeInTheDocument();
  });

  it('hides the Issues tab when Loki is unavailable, but Alerts and Backend stay', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({
      caps: { ...baseCaps, loki: { available: false } },
      loading: false,
    });
    renderPage();

    expect(screen.queryByText('Issues')).not.toBeInTheDocument();
    // Alerts is not capability-gated; Backend is always present.
    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText('Backend')).toBeInTheDocument();
  });

  it('the Backend tab click sets tab=backend and mounts the Backend tab', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: baseCaps, loading: false });
    renderPage();

    fireEvent.click(screen.getByText('Backend'));

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
    expect(params.get('tab')).toBe('backend');
    expect(screen.getByTestId('backend-tab')).toBeInTheDocument();
  });

  it('the Alerts tab click sets tab=alerts and mounts the Alerts tab', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: baseCaps, loading: false });
    renderPage();

    fireEvent.click(screen.getByText('Alerts'));

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
    expect(params.get('tab')).toBe('alerts');
    expect(screen.getByTestId('alerts-tab')).toBeInTheDocument();
  });

  it('resolves the legacy tab=server and tab=runtime aliases to the Backend tab', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: baseCaps, loading: false });
    renderPage(['/services/team-a/my-svc?tab=server']);
    expect(screen.getByTestId('backend-tab')).toBeInTheDocument();

    renderPage(['/services/team-a/my-svc?tab=runtime']);
    expect(screen.getAllByTestId('backend-tab').length).toBeGreaterThan(0);
  });

  it('the Issues tab click sets tab=issues and mounts the Issues tab', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: baseCaps, loading: false });
    renderPage();

    fireEvent.click(screen.getByText('Issues'));

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
    expect(params.get('tab')).toBe('issues');
    expect(screen.getByTestId('issues-tab')).toBeInTheDocument();
  });
});

describe('ServiceOverview Profiling tab (M7 Pyroscope gating)', () => {
  const capsWithPyroscope = {
    ...baseCaps,
    pyroscope: { available: true, uid: 'pyro-uid' },
  };

  it('hides the Profiling tab when no Pyroscope capability is present (the production default)', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: baseCaps, loading: false });
    renderPage();

    expect(screen.queryByText('Profiling')).not.toBeInTheDocument();
  });

  it('shows the Profiling tab and mounts it when a Pyroscope datasource is available', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: capsWithPyroscope, loading: false });
    renderPage();

    expect(screen.getByText('Profiling')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Profiling'));

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
    expect(params.get('tab')).toBe('profiling');
    expect(screen.getByTestId('profiling-tab')).toBeInTheDocument();
  });

  it('falls back to Overview when deep-linked to tab=profiling without the datasource', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: baseCaps, loading: false });
    renderPage(['/services/team-a/my-svc?tab=profiling']);

    expect(screen.queryByTestId('profiling-tab')).not.toBeInTheDocument();
    expect(screen.getByTestId('overview-tab')).toBeInTheDocument();
  });
});
