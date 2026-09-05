import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CHECK_SNIPPETS, ScorecardBadge } from './ScorecardBadge';
import { getScorecard, ScorecardResponse } from '../api/scorecard';
import * as client from '../api/client';

jest.mock('../api/scorecard', () => ({
  getScorecard: jest.fn(),
}));

jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  getAlertTemplate: jest.fn(),
}));

const mockPush = jest.fn();
jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getAppEvents: () => ({ publish: jest.fn() }),
  locationService: { push: (url: string) => mockPush(url) },
}));

const mockGetScorecard = getScorecard as jest.MockedFunction<typeof getScorecard>;
const mockGetAlertTemplate = client.getAlertTemplate as jest.Mock;

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

/** All six checks failing, so every per-check action is reachable in one render. */
const allFailing: ScorecardResponse = {
  ...baseResponse,
  readiness: {
    score: 0,
    total: 6,
    checks: baseResponse.readiness.checks.map((check) => ({ ...check, ok: false })),
  },
};

async function openDetails(response: ScorecardResponse = allFailing) {
  mockGetScorecard.mockResolvedValue(response);
  render(<ScorecardBadge namespace="team-a" service="my-app" environment="prod-gcp" />);
  fireEvent.click(await screen.findByTestId('scorecard-badge'));
  return screen.findByTestId('scorecard-details');
}

describe('ScorecardBadge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPush.mockReset();
    mockGetAlertTemplate.mockReset().mockResolvedValue({ url: '/alerting/new?defaults=%7B%7D', defaults: {} });
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

  // --- Actionability (#143 Phase 1) ---

  describe('per-check actions', () => {
    it.each([
      ['spanMetrics', 'https://doc.nais.io/observability/apm/tutorials/get-started/'],
      ['traces', 'https://doc.nais.io/observability/apm/tutorials/get-started/'],
      ['logs', 'https://doc.nais.io/observability/apm/how-to/log-patterns/'],
      ['runtimeMetrics', 'https://doc.nais.io/observability/apm/tutorials/get-started/'],
      ['browserTelemetry', 'https://doc.nais.io/observability/apm/tutorials/track-frontend-errors/'],
      ['alertRules', 'https://doc.nais.io/observability/apm/how-to/create-alerts/'],
    ])('deep-links %s to its docs how-to', async (key, href) => {
      await openDetails();
      const actions = screen.getByTestId(`check-actions-${key}`);
      expect(within(actions).getByRole('link', { name: /Docs/ })).toHaveAttribute('href', href);
    });

    it('keeps the docs link but drops the fix actions on a not-applicable check', async () => {
      await openDetails({
        ...allFailing,
        readiness: {
          ...allFailing.readiness,
          checks: allFailing.readiness.checks.map((check) =>
            check.key === 'browserTelemetry' ? { ...check, notApplicable: true } : check
          ),
        },
      });
      const actions = screen.getByTestId('check-actions-browserTelemetry');
      expect(within(actions).getByRole('link', { name: /Docs/ })).toBeInTheDocument();
      expect(within(actions).queryByRole('button')).not.toBeInTheDocument();
    });

    it('offers a nais.yaml snippet only for the manifest-driven checks', async () => {
      await openDetails();
      for (const key of ['spanMetrics', 'logs', 'runtimeMetrics']) {
        expect(
          within(screen.getByTestId(`check-actions-${key}`)).getByRole('button', { name: /Copy nais\.yaml/ })
        ).toBeInTheDocument();
      }
      for (const key of ['traces', 'browserTelemetry', 'alertRules']) {
        expect(
          within(screen.getByTestId(`check-actions-${key}`)).queryByRole('button', { name: /Copy nais\.yaml/ })
        ).not.toBeInTheDocument();
      }
    });

    // The clipboard plumbing is Grafana's (ClipboardButton); what's ours is the
    // YAML it hands over — the spec key paths from the nais Application CRD.
    it('copies a nais.yaml block whose keys match the nais Application spec', () => {
      expect(CHECK_SNIPPETS.logs).toBe(
        ['spec:', '  observability:', '    logging:', '      destinations:', '        - id: loki'].join('\n')
      );
      expect(CHECK_SNIPPETS.spanMetrics).toContain('    autoInstrumentation:\n      enabled: true\n      runtime:');
      expect(CHECK_SNIPPETS.runtimeMetrics).toBe(CHECK_SNIPPETS.spanMetrics);
    });

    it('fetches the error-rate prefill and navigates to the new-rule form', async () => {
      await openDetails();
      fireEvent.click(
        within(screen.getByTestId('check-actions-alertRules')).getByRole('button', { name: /Alert on error rate/ })
      );

      await waitFor(() => expect(mockGetAlertTemplate).toHaveBeenCalled());
      expect(mockGetAlertTemplate).toHaveBeenCalledWith('error-rate', {
        namespace: 'team-a',
        service: 'my-app',
        environment: 'prod-gcp',
      });
      await waitFor(() => expect(mockPush).toHaveBeenCalled());
      expect(mockPush.mock.calls[0][0]).toContain('/alerting/new?defaults=');
      expect(mockPush.mock.calls[0][0]).toContain('returnTo=');
    });

    it('re-enables the alert action when the prefill fetch fails', async () => {
      mockGetAlertTemplate.mockRejectedValue(new Error('boom'));
      await openDetails();
      const button = within(screen.getByTestId('check-actions-alertRules')).getByRole('button', {
        name: /Alert on error rate/,
      });
      fireEvent.click(button);
      await waitFor(() => expect(mockGetAlertTemplate).toHaveBeenCalled());
      expect(mockPush).not.toHaveBeenCalled();
      await waitFor(() => expect(button).not.toBeDisabled());
    });

    it('shows no actions for a passing check', async () => {
      await openDetails(baseResponse);
      expect(screen.queryByTestId('check-actions-spanMetrics')).not.toBeInTheDocument();
      expect(screen.getByTestId('check-actions-alertRules')).toBeInTheDocument();
    });
  });
});
