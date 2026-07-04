import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ServiceOverview from './ServiceOverview';
import * as capabilitiesUtils from '../utils/capabilities';

/**
 * Tab registry tests (#69 P1/P7): the Issues tab is capability-gated on Loki
 * exactly like Logs, and the tab historically labeled "Operations" now reads
 * "Endpoints" — a label-only rename, the URL value (`tab=server`) is
 * untouched (docs/url-contract.md). All heavy Scene-composed tab bodies are
 * stubbed here; this file only exercises the TabsBar registry, not tab
 * content (each tab has its own test file for that).
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
jest.mock('./tabs/ServerTab', () => ({ ServerTab: () => <div data-testid="server-tab" /> }));
jest.mock('./tabs/FrontendTab', () => ({ FrontendTab: () => <div data-testid="frontend-tab" /> }));
jest.mock('./tabs/RuntimeTab', () => ({ RuntimeTab: () => <div data-testid="runtime-tab" /> }));
jest.mock('./tabs/DependenciesTab', () => ({ DependenciesTab: () => <div data-testid="dependencies-tab" /> }));
jest.mock('./tabs/TracesTab', () => ({ TracesTab: () => <div data-testid="traces-tab" /> }));
jest.mock('./tabs/LogsTab', () => ({ LogsTab: () => <div data-testid="logs-tab" /> }));
jest.mock('./tabs/DatabaseTab', () => ({ DatabaseTab: () => <div data-testid="database-tab" /> }));

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

describe('ServiceOverview tab registry (#69 P1/P7)', () => {
  it('shows the Issues tab and labels the endpoints tab "Endpoints" when Loki is available', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: baseCaps, loading: false });
    renderPage();

    expect(screen.getByText('Issues')).toBeInTheDocument();
    expect(screen.getByText('Endpoints')).toBeInTheDocument();
    expect(screen.queryByText('Operations')).not.toBeInTheDocument();
  });

  it('hides the Issues tab when Loki is unavailable, but Endpoints stays', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({
      caps: { ...baseCaps, loki: { available: false } },
      loading: false,
    });
    renderPage();

    expect(screen.queryByText('Issues')).not.toBeInTheDocument();
    expect(screen.getByText('Endpoints')).toBeInTheDocument();
  });

  it('the Endpoints tab click keeps the stable tab=server URL value', () => {
    (capabilitiesUtils.useCapabilities as jest.Mock).mockReturnValue({ caps: baseCaps, loading: false });
    renderPage();

    fireEvent.click(screen.getByText('Endpoints'));

    const params = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
    expect(params.get('tab')).toBe('server');
    expect(screen.getByTestId('server-tab')).toBeInTheDocument();
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
