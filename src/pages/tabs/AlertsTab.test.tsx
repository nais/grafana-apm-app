import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AlertsTab } from './AlertsTab';
import * as client from '../../api/client';

jest.mock('../../api/client', () => ({
  ...jest.requireActual('../../api/client'),
  getServiceAlerts: jest.fn(),
  getAlertTemplate: jest.fn(),
}));

const mockPush = jest.fn();
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: jest.fn() }),
  getAppEvents: () => ({ publish: jest.fn() }),
  locationService: { push: (url: string) => mockPush(url) },
}));

const getServiceAlerts = client.getServiceAlerts as jest.Mock;
const getAlertTemplate = client.getAlertTemplate as jest.Mock;

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
});

describe('AlertsTab (#32/#33 home)', () => {
  it('lists rules with a source badge and a "—" state seam for firing detail', async () => {
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
        },
      ],
    });

    renderTab();

    await waitFor(() => expect(screen.getByText('OrdersHighErrorRate')).toBeInTheDocument());
    expect(screen.getByText('Orders erroring')).toBeInTheDocument();
    expect(screen.getByText('grafana')).toBeInTheDocument();
    // firingState is unset in v1 → the state column renders a dash (the #32/#33 seam).
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders firingState when the #32/#33 enrichment provides it', async () => {
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
          firingState: { state: 'firing' },
        },
      ],
    });

    renderTab();

    await waitFor(() => expect(screen.getByText('OrdersHighErrorRate')).toBeInTheDocument());
    expect(screen.getByText('firing')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
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
});
