import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AlertsTab, FiringStateCell } from './AlertsTab';
import * as client from '../../api/client';
import { AlertRuleSummary, ServiceAlertRule } from '../../api/client';

jest.mock('../../api/client', () => ({
  ...jest.requireActual('../../api/client'),
  getServiceAlerts: jest.fn(),
  getAlertTemplate: jest.fn(),
  getNewExceptionsPrometheusRule: jest.fn(),
}));

const mockPush = jest.fn();
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: jest.fn(), get: jest.fn().mockResolvedValue([]) }),
  getAppEvents: () => ({ publish: jest.fn() }),
  locationService: { push: (url: string) => mockPush(url) },
}));

const getServiceAlerts = client.getServiceAlerts as jest.Mock;
const getAlertTemplate = client.getAlertTemplate as jest.Mock;
const getNewExceptionsPrometheusRule = client.getNewExceptionsPrometheusRule as jest.Mock;

const PROMETHEUS_RULE = [
  'apiVersion: monitoring.coreos.com/v1',
  'kind: PrometheusRule',
  'metadata:',
  '  name: "nais-apm-new-exceptions-orders"',
].join('\n');

function renderTab(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AlertsTab namespace="teamorders" service="orders" environment="prod-gcp" />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockPush.mockReset();
  getServiceAlerts.mockReset().mockResolvedValue({ rules: [] });
  getAlertTemplate.mockReset().mockResolvedValue({ url: '/alerting/new?defaults=%7B%7D', defaults: {} });
  getNewExceptionsPrometheusRule.mockReset().mockResolvedValue(PROMETHEUS_RULE);
});

describe('AlertsTab (#32/#33 home)', () => {
  it('lists rules with a source badge and the derived firing state (#33)', async () => {
    getServiceAlerts.mockResolvedValue({
      rules: [
        {
          name: 'OrdersHighErrorRate',
          state: 'firing',
          severity: 'critical',
          summary: 'Orders erroring',
          description: '',
          activeSince: '',
          activeCount: 1,
          groupName: 'orders-alerts',
          source: 'grafana',
          firingState: {
            state: 'firing',
            activeCount: 1,
            instances: [{ state: 'firing', value: '0.12' }],
            value: '0.12',
          },
        },
      ],
    });

    renderTab();

    await waitFor(() => expect(screen.getByText('OrdersHighErrorRate')).toBeInTheDocument());
    expect(screen.getByText('Orders erroring')).toBeInTheDocument();
    expect(screen.getByText('grafana')).toBeInTheDocument();
    // The read-only firing state (#33) renders directly from the rule now.
    expect(screen.getByText('firing')).toBeInTheDocument();
    expect(screen.getByText(/current value 0\.12/)).toBeInTheDocument();
  });

  it('renders a dash when a rule carries no firing state', async () => {
    getServiceAlerts.mockResolvedValue({
      rules: [
        {
          name: 'OrdersHighErrorRate',
          state: 'firing',
          severity: 'critical',
          summary: '',
          description: '',
          activeSince: '',
          activeCount: 1,
          groupName: 'orders-alerts',
          source: 'mimir',
          // firingState omitted — defensive rendering falls back to a dash.
        },
      ],
    });

    renderTab();

    await waitFor(() => expect(screen.getByText('OrdersHighErrorRate')).toBeInTheDocument());
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the empty state but still offers create-alert templates', async () => {
    getServiceAlerts.mockResolvedValue({ rules: [] });

    renderTab();

    await waitFor(() => expect(screen.getByText('No alerts configured for this service.')).toBeInTheDocument());
    // The create-alert catalog is offered regardless of whether rules exist.
    expect(screen.getByText('Error rate')).toBeInTheDocument();
    expect(screen.getByText('SLO fast burn (page)')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Create alert/ }).length).toBeGreaterThan(0);
  });

  it('surfaces the unavailable state', async () => {
    getServiceAlerts.mockResolvedValue({ rules: [], unavailable: true, errorMessage: 'nope' });

    renderTab();

    await waitFor(() => expect(screen.getByText('Alert rules are currently unavailable.')).toBeInTheDocument());
  });

  it('opens the firing-alert detail drawer (#32) from a firing row', async () => {
    getServiceAlerts.mockResolvedValue({
      rules: [
        {
          name: 'OrdersHighErrorRate',
          state: 'firing',
          severity: 'critical',
          summary: 'Orders erroring',
          description: '',
          activeSince: new Date(Date.now() - 20 * 60_000).toISOString(),
          activeCount: 1,
          groupName: 'orders-alerts',
          source: 'grafana',
          expression: 'sum(rate(calls_total[5m])) > 0.05',
          forDuration: 300,
          firingState: {
            state: 'firing',
            activeCount: 1,
            instances: [{ state: 'firing', value: '0.12', labels: { endpoint: '/checkout' } }],
            value: '0.12',
          },
        },
      ],
    });

    renderTab();

    // The firing rule name is a button that opens the drawer.
    const trigger = await screen.findByRole('button', { name: 'OrdersHighErrorRate' });
    fireEvent.click(trigger);

    // Drawer content: the condition block appears.
    await waitFor(() => expect(screen.getByText('Current value')).toBeInTheDocument());
    expect(screen.getByText('Evaluation window')).toBeInTheDocument();
  });

  it('opens the drawer directly from a shared firingAlert URL param (#32)', async () => {
    getServiceAlerts.mockResolvedValue({
      rules: [
        {
          name: 'OrdersHighErrorRate',
          state: 'firing',
          severity: 'critical',
          summary: 'Orders erroring',
          description: '',
          activeSince: new Date(Date.now() - 20 * 60_000).toISOString(),
          activeCount: 1,
          groupName: 'orders-alerts',
          source: 'mimir',
          firingState: {
            state: 'firing',
            activeCount: 1,
            instances: [{ state: 'firing', value: '0.12', labels: { endpoint: '/checkout' } }],
            value: '0.12',
          },
        },
      ],
    });

    renderTab(['/?firingAlert=OrdersHighErrorRate']);

    await waitFor(() => expect(screen.getByText('Current value')).toBeInTheDocument());
    // Footer deep link uses the name-search fallback (no rule UID available).
    expect(screen.getByRole('link', { name: /Open in Grafana Alerting/ })).toHaveAttribute(
      'href',
      '/alerting/list?search=OrdersHighErrorRate'
    );
  });

  it('creates an alert via the template flow and navigates to the pre-filled editor', async () => {
    renderTab();

    await waitFor(() => expect(screen.getByText('Error rate')).toBeInTheDocument());

    // cardTitle → cardBody → card; the Create alert button is the card's sibling.
    const errorRateCard = screen.getByText('Error rate').parentElement!.parentElement!;
    fireEvent.click(within(errorRateCard).getByRole('button', { name: /Create alert/ }));

    await waitFor(() =>
      expect(getAlertTemplate).toHaveBeenCalledWith(
        'error-rate',
        expect.objectContaining({ namespace: 'teamorders', service: 'orders', environment: 'prod-gcp' })
      )
    );
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/alerting/new?defaults=')));
  });

  // #123 Phase 1: the self-serve "new issue -> Slack" path. This section is
  // deliberately NOT under the "Under construction" banner - it needs nothing
  // provisioned per team, unlike the Grafana-folder/contact-point work.
  it('renders the new-issues PrometheusRule with a copy button', async () => {
    renderTab();

    await waitFor(() => expect(screen.getByText(/New issues in your Slack channel/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/kind: PrometheusRule/)).toBeInTheDocument());

    expect(getNewExceptionsPrometheusRule).toHaveBeenCalledWith({
      namespace: 'teamorders',
      service: 'orders',
      environment: 'prod-gcp',
    });
    expect(screen.getByRole('button', { name: /Copy manifest/ })).toBeInTheDocument();
    // Faro-only: the recording rule filters session_id!="", so a backend-only
    // app gets a rule that never fires. Say so in THIS section (the web-vitals
    // card carries the same sentence), and give the check for it.
    const section = screen.getByText(/New issues in your Slack channel/).closest('section')!;
    expect(within(section).getByText(/Requires frontend \(Faro\) telemetry/)).toBeInTheDocument();
    expect(within(section).getByText(/count\(loki:apm:exception_sessions:count1m/)).toBeInTheDocument();
  });

  // The manifest is fetched, so there is a window before it resolves. Showing
  // the error text in that window tells the user the feature is broken when it
  // is merely loading.
  it('shows a loading placeholder, not the error text, while the manifest is in flight', async () => {
    let resolveRule: (yaml: string) => void = () => {};
    getNewExceptionsPrometheusRule.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRule = resolve;
      })
    );

    renderTab();

    await waitFor(() => expect(screen.getByText(/Preparing the PrometheusRule/)).toBeInTheDocument());
    expect(screen.queryByText(/Could not render the PrometheusRule/)).not.toBeInTheDocument();

    resolveRule(PROMETHEUS_RULE);
    await waitFor(() => expect(screen.getByText(/kind: PrometheusRule/)).toBeInTheDocument());
    expect(screen.queryByText(/Preparing the PrometheusRule/)).not.toBeInTheDocument();
  });

  it('shows a message instead of an empty code block when the manifest cannot be rendered', async () => {
    getNewExceptionsPrometheusRule.mockRejectedValue(new Error('boom'));
    renderTab();

    await waitFor(() =>
      expect(screen.getByText(/Could not render the PrometheusRule for this service/)).toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: /Copy manifest/ })).not.toBeInTheDocument();
  });
});

function summary(overrides: Partial<AlertRuleSummary> = {}): AlertRuleSummary {
  return {
    name: 'OrdersHighErrorRate',
    state: 'firing',
    severity: 'critical',
    summary: 'Orders erroring',
    description: '',
    activeSince: '',
    activeCount: 0,
    groupName: 'orders-alerts',
    source: 'mimir',
    ...overrides,
  };
}

describe('deriveFiringState (#33)', () => {
  it('mirrors the rule state and lifts the first instance value', () => {
    const fs = client.deriveFiringState(
      summary({
        state: 'firing',
        activeSince: '2026-04-25T10:00:00Z',
        activeCount: 2,
        instances: [
          { state: 'firing', value: '0.12', labels: { endpoint: '/checkout' } },
          { state: 'firing', value: '0.08', labels: { endpoint: '/cart' } },
        ],
      })
    );
    expect(fs.state).toBe('firing');
    expect(fs.value).toBe('0.12');
    expect(fs.activeCount).toBe(2);
    expect(fs.instances).toHaveLength(2);
    expect(fs.activeSince).toBe('2026-04-25T10:00:00Z');
  });

  it('leaves value undefined and activeSince absent when there are no instances', () => {
    const fs = client.deriveFiringState(summary({ state: 'inactive', activeCount: 0, activeSince: '' }));
    expect(fs.value).toBeUndefined();
    expect(fs.activeSince).toBeUndefined();
    expect(fs.instances).toHaveLength(0);
  });
});

describe('FiringStateCell (#33)', () => {
  function cellFor(overrides: Partial<AlertRuleSummary>): ServiceAlertRule {
    const s = summary(overrides);
    return { ...s, firingState: client.deriveFiringState(s) };
  }

  it('renders the firing badge with current value, since, and instance labels', () => {
    render(
      <FiringStateCell
        rule={cellFor({
          state: 'firing',
          activeCount: 2,
          activeSince: new Date(Date.now() - 5 * 60_000).toISOString(),
          instances: [
            { state: 'firing', value: '0.12', labels: { endpoint: '/checkout', alertname: 'ignored' } },
            { state: 'firing', value: '0.08', labels: { endpoint: '/cart' } },
          ],
        })}
      />
    );

    expect(screen.getByText('firing')).toBeInTheDocument();
    expect(screen.getByText(/current value 0\.12/)).toBeInTheDocument();
    expect(screen.getByText(/since 5m ago/)).toBeInTheDocument();
    const checkout = screen.getByText(/endpoint="\/checkout"/);
    expect(checkout).toBeInTheDocument();
    // The noisy alertname label is filtered out of the instance summary.
    expect(checkout.textContent).not.toContain('alertname');
    expect(screen.getByText(/endpoint="\/cart"/)).toBeInTheDocument();
  });

  it('shows a truncation hint when instances were capped', () => {
    render(
      <FiringStateCell
        rule={cellFor({
          state: 'firing',
          activeCount: 25,
          instances: [{ state: 'firing', value: '1', labels: { shard: 'a' } }],
          instancesTruncated: true,
        })}
      />
    );
    expect(screen.getByText('…more')).toBeInTheDocument();
  });

  it('renders inactive rules as a plain badge with no instance detail', () => {
    render(<FiringStateCell rule={cellFor({ state: 'inactive', activeCount: 0, instances: [] })} />);
    expect(screen.getByText('inactive')).toBeInTheDocument();
    expect(screen.queryByText(/current value/)).not.toBeInTheDocument();
  });

  it('renders a dash when there is no firing state at all', () => {
    render(<FiringStateCell rule={{ ...summary(), firingState: undefined }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
