/**
 * FrontendTab — the no-telemetry SetupPlaceholder is where teams without
 * instrumentation land, so it must surface the Nais APM onboarding links
 * (track-frontend-errors tutorial + the @nais/apm SDK repo).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FrontendTab } from './FrontendTab';
import * as client from '../../api/client';

jest.mock('../../api/client', () => ({
  ...jest.requireActual('../../api/client'),
  getFrontendMetrics: jest.fn(),
  getExceptionGroups: jest.fn().mockResolvedValue({ groups: [] }),
}));

jest.mock('../../utils/datasources', () => ({
  usePluginDatasources: () => ({ metricsUid: 'mimir', tracesUid: 'tempo', logsUid: 'loki' }),
  usePluginLabelOverrides: () => ({}),
}));

jest.mock('../../utils/timeRange', () => ({
  useTimeRange: () => ({ from: 'now-1h', to: 'now', fromMs: 1000, toMs: 2000 }),
}));

const getFrontendMetrics = client.getFrontendMetrics as jest.Mock;

function renderTab() {
  return render(
    <MemoryRouter>
      <FrontendTab service="my-app" namespace="team-a" environment="prod" />
    </MemoryRouter>
  );
}

describe('FrontendTab setup placeholder links', () => {
  beforeEach(() => getFrontendMetrics.mockReset());

  it('links to the track-frontend-errors tutorial and the @nais/apm SDK repo when no telemetry is found', async () => {
    getFrontendMetrics.mockResolvedValue({ available: false });
    renderTab();

    const tutorial = await screen.findByRole('link', { name: /Track frontend errors with Nais APM/ });
    expect(tutorial).toHaveAttribute('href', 'https://doc.nais.io/observability/apm/tutorials/track-frontend-errors/');

    const sdk = screen.getByRole('link', { name: /@nais\/apm SDK/ });
    expect(sdk).toHaveAttribute('href', 'https://github.com/nais/apm');
  });
});
