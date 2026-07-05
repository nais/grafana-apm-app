import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FiringAlertDrawer } from './FiringAlertDrawer';
import { ServiceAlertRule, deriveFiringState, AlertRuleSummary } from '../../../api/client';

const mockGet = jest.fn();
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ get: (...args: unknown[]) => mockGet(...args) }),
}));

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue([]);
});

function renderDrawer(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function rule(overrides: Partial<AlertRuleSummary> = {}): ServiceAlertRule {
  const summary: AlertRuleSummary = {
    name: 'OrdersHighErrorRate',
    state: 'firing',
    severity: 'critical',
    summary: 'Orders erroring',
    description: 'More than 5% of requests failing',
    activeSince: new Date(Date.now() - 30 * 60_000).toISOString(),
    activeCount: 2,
    groupName: 'orders-alerts',
    source: 'grafana',
    expression: 'sum(rate(calls_total{service_name="orders"}[5m])) > 0.05',
    forDuration: 300,
    runbookUrl: 'https://runbooks.example/orders',
    instances: [
      { state: 'firing', value: '0.12', labels: { endpoint: '/checkout', service: 'orders' } },
      { state: 'firing', value: '0.08', labels: { endpoint: '/cart', service: 'orders' } },
    ],
    ...overrides,
  };
  return { ...summary, firingState: deriveFiringState(summary) };
}

describe('FiringAlertDrawer (#32)', () => {
  it('renders the firing detail from the resolved rule', async () => {
    renderDrawer(
      <FiringAlertDrawer
        rule={rule()}
        ruleName="OrdersHighErrorRate"
        namespace="teamorders"
        service="orders"
        environment="prod-gcp"
        onClose={jest.fn()}
      />
    );

    // Header: rule name, source badge, firing state.
    expect(screen.getAllByText('OrdersHighErrorRate').length).toBeGreaterThan(0);
    expect(screen.getByText('grafana')).toBeInTheDocument();
    expect(screen.getByText('firing')).toBeInTheDocument();

    // Condition: current value + eval window (from the `for` duration).
    expect(screen.getByText('Current value')).toBeInTheDocument();
    expect(screen.getByText('0.12')).toBeInTheDocument();
    expect(screen.getByText('Evaluation window')).toBeInTheDocument();

    // Instance labels rendered.
    expect(screen.getByText(/endpoint="\/checkout"/)).toBeInTheDocument();
    expect(screen.getByText(/endpoint="\/cart"/)).toBeInTheDocument();

    // Annotations verbatim + runbook button.
    expect(screen.getByText('More than 5% of requests failing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open runbook/ })).toBeInTheDocument();

    // Footer: Grafana Alerting name-search fallback (no UID on the summary).
    const grafanaLink = screen.getByRole('link', { name: /Open in Grafana Alerting/ });
    expect(grafanaLink).toHaveAttribute('href', '/alerting/list?search=OrdersHighErrorRate');

    // RED panel link scoped to the backend tab.
    const redLink = screen.getByRole('link', { name: /Service metrics around the firing window/ });
    expect(redLink.getAttribute('href')).toContain('tab=backend');
  });

  it('emits a related-Issue link only when a label confidently resolves', async () => {
    renderDrawer(
      <FiringAlertDrawer
        rule={rule({
          instances: [{ state: 'firing', value: '11', labels: { fingerprint: 'v1:9f2ab31c04d7e655' } }],
        })}
        ruleName="ExceptionSpike"
        namespace="teamorders"
        service="orders"
        onClose={jest.fn()}
      />
    );

    const issueLink = screen.getByRole('link', { name: /Related issue/ });
    expect(issueLink.getAttribute('href')).toContain('issueId=v1%3A9f2ab31c04d7e655');
  });

  it('renders NO related-Issue link when labels do not resolve (no wrong link)', async () => {
    renderDrawer(
      <FiringAlertDrawer
        rule={rule({ instances: [{ state: 'firing', value: '0.1', labels: { endpoint: '/checkout' } }] })}
        ruleName="OrdersHighErrorRate"
        namespace="teamorders"
        service="orders"
        onClose={jest.fn()}
      />
    );

    expect(screen.queryByRole('link', { name: /Related issue/ })).not.toBeInTheDocument();
  });

  it('degrades to "state unavailable" when the rule cannot be resolved', async () => {
    renderDrawer(
      <FiringAlertDrawer
        rule={undefined}
        ruleName="OrdersHighErrorRate"
        namespace="teamorders"
        service="orders"
        loading={false}
        onClose={jest.fn()}
      />
    );

    expect(screen.getByText(/Firing state is unavailable/)).toBeInTheDocument();
    // Even degraded, the Grafana Alerting deep link is still offered.
    expect(screen.getByRole('link', { name: /Open in Grafana Alerting/ })).toBeInTheDocument();
  });

  it('shows the last deploy before firing when a deploy annotation is found', async () => {
    const activeAtMs = Date.now() - 30 * 60_000;
    mockGet.mockResolvedValue([
      { time: activeAtMs - 5 * 60_000, text: 'ignored', tags: ['nais-apm:deploy', 'version:1.2.3'] },
      { time: activeAtMs + 60_000, text: 'after', tags: ['nais-apm:deploy', 'version:1.2.4'] },
    ]);

    renderDrawer(
      <FiringAlertDrawer
        rule={rule({ activeSince: new Date(activeAtMs).toISOString() })}
        ruleName="OrdersHighErrorRate"
        namespace="teamorders"
        service="orders"
        onClose={jest.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText(/Last deploy before firing/)).toBeInTheDocument());
    // The deploy AFTER activeAt must be excluded — only 1.2.3 qualifies.
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(screen.queryByText('1.2.4')).not.toBeInTheDocument();
  });
});
