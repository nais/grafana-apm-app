import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScorecardBadge } from './ScorecardBadge';
import { getScorecard, ScorecardResponse } from '../api/scorecard';

jest.mock('../api/scorecard', () => ({
  getScorecard: jest.fn(),
}));

const mockGetScorecard = getScorecard as jest.MockedFunction<typeof getScorecard>;

const baseResponse: ScorecardResponse = {
  readiness: {
    score: 4,
    total: 6,
    checks: [
      { key: 'spanMetrics', label: 'Span metrics (RED)', ok: true, hint: 'Enable auto-instrumentation.' },
      { key: 'traces', label: 'Traces in Tempo', ok: true, hint: 'Export OTLP traces.' },
      { key: 'logs', label: 'Logs in Loki', ok: true, hint: 'Ship logs to Loki.' },
      { key: 'runtimeMetrics', label: 'Runtime metrics', ok: true, hint: 'Enable the OTel agent.' },
      { key: 'browserTelemetry', label: 'Browser telemetry (Faro)', ok: false, hint: 'Instrument with @nais/apm.' },
      { key: 'alertRules', label: 'Alert rules', ok: false, hint: 'Create an alert rule.' },
    ],
  },
  console: { configured: false },
};

describe('ScorecardBadge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the score once loaded', async () => {
    mockGetScorecard.mockResolvedValue(baseResponse);
    render(<ScorecardBadge namespace="team-a" service="my-app" />);
    expect(await screen.findByTestId('scorecard-badge')).toHaveTextContent('4/6 observability checks');
  });

  it('renders nothing while loading and nothing on error', async () => {
    let reject: (e: Error) => void = () => {};
    mockGetScorecard.mockReturnValue(new Promise((_, r) => (reject = r)));
    const { container } = render(<ScorecardBadge namespace="team-a" service="my-app" />);
    // In flight: no badge, no placeholder — zero layout shift.
    expect(container).toBeEmptyDOMElement();

    reject(new Error('boom'));
    await waitFor(() => expect(mockGetScorecard).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('opens a toggletip listing checks with hints for failing ones', async () => {
    mockGetScorecard.mockResolvedValue(baseResponse);
    render(<ScorecardBadge namespace="team-a" service="my-app" />);
    fireEvent.click(await screen.findByTestId('scorecard-badge'));

    const details = await screen.findByTestId('scorecard-details');
    expect(details).toHaveTextContent('Span metrics (RED)');
    expect(details).toHaveTextContent('Browser telemetry (Faro)');
    // Hints only for failing checks.
    expect(details).toHaveTextContent('Instrument with @nais/apm.');
    expect(details).toHaveTextContent('Create an alert rule.');
    expect(details).not.toHaveTextContent('Enable auto-instrumentation.');
    // Console unconfigured → the ownership section stays hidden, silently.
    expect(details).not.toHaveTextContent('Ownership');
  });

  it('shows Console ownership links when configured', async () => {
    mockGetScorecard.mockResolvedValue({
      ...baseResponse,
      console: {
        configured: true,
        teamSlug: 'team-a',
        slackChannel: '#team-a-alerts',
        repositoryUrl: 'https://github.com/navikt/my-app',
        ingresses: ['https://my-app.nav.no'],
      },
    });
    render(<ScorecardBadge namespace="team-a" service="my-app" />);
    fireEvent.click(await screen.findByTestId('scorecard-badge'));

    const details = await screen.findByTestId('scorecard-details');
    expect(details).toHaveTextContent('Ownership');
    expect(details).toHaveTextContent('team-a — #team-a-alerts');
    expect(screen.getByRole('link', { name: 'Repository' })).toHaveAttribute(
      'href',
      'https://github.com/navikt/my-app'
    );
    expect(screen.getByRole('link', { name: 'my-app.nav.no' })).toHaveAttribute('href', 'https://my-app.nav.no');
  });

  // --- Accessibility (WCAG 1.4.1 / 4.1.2) ---

  it('announces each check pass/fail state that is otherwise only an icon colour', async () => {
    mockGetScorecard.mockResolvedValue(baseResponse);
    render(<ScorecardBadge namespace="team-a" service="my-app" />);
    fireEvent.click(await screen.findByTestId('scorecard-badge'));
    await screen.findByTestId('scorecard-details');
    // 4 enabled + 2 not-enabled checks, each with a text alternative for the status icon.
    expect(screen.getAllByRole('img', { name: 'Enabled' })).toHaveLength(4);
    expect(screen.getAllByRole('img', { name: 'Not enabled' })).toHaveLength(2);
  });

  it('renders a not-applicable check as N/A, excluded from the score', async () => {
    // A pure JVM backend: browserTelemetry is N/A and the backend reports 4/5.
    const response: ScorecardResponse = {
      ...baseResponse,
      readiness: {
        score: 4,
        total: 5,
        checks: baseResponse.readiness.checks.map((check) =>
          check.key === 'browserTelemetry'
            ? { ...check, notApplicable: true, hint: 'Not applicable — java backend with no browser frontend.' }
            : check
        ),
      },
    };
    mockGetScorecard.mockResolvedValue(response);
    render(<ScorecardBadge namespace="team-a" service="my-app" />);

    const badge = await screen.findByTestId('scorecard-badge');
    expect(badge).toHaveTextContent('4/5 observability checks');

    fireEvent.click(badge);
    await screen.findByTestId('scorecard-details');
    expect(screen.getByRole('img', { name: 'Not applicable' })).toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
    expect(screen.getByText(/java backend with no browser frontend/)).toBeInTheDocument();
    // The N/A check no longer counts as "Not enabled".
    expect(screen.getAllByRole('img', { name: 'Not enabled' })).toHaveLength(1);
  });
});
