/**
 * ExceptionDrawer — section order (#69 P8), collapsed-by-default sections,
 * and the M6 user-feedback section. Session replay behavior is covered
 * separately in ExceptionDrawer.replay.test.tsx.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { of } from 'rxjs';
import { ExceptionDrawer } from './ExceptionDrawer';
import * as client from '../../../../api/client';
import * as replayApi from '../replay/fetchReplay';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: (options: unknown) => mockFetch(options) }),
  getAppEvents: () => ({ publish: jest.fn() }),
  locationService: { push: jest.fn() },
}));

jest.mock('../../../../utils/datasources', () => ({
  usePluginLabelOverrides: () => ({}),
}));

jest.mock('../../../../api/client', () => ({
  ...jest.requireActual('../../../../api/client'),
  getTriageStates: jest.fn().mockResolvedValue({}),
  postTriageAction: jest.fn(),
  getFeedback: jest.fn().mockResolvedValue({ feedback: [] }),
}));

jest.mock('../replay/fetchReplay', () => ({
  ...jest.requireActual('../replay/fetchReplay'),
  probeReplay: jest.fn().mockResolvedValue({ hasChunks: false, mode: null, chunkCount: 0 }),
  fetchReplay: jest.fn(),
}));

const getFeedback = client.getFeedback as jest.Mock;
const probeReplay = replayApi.probeReplay as jest.Mock;

const exceptionLine =
  'timestamp=2026-07-03T10:00:00Z kind=exception type=TypeError value="boom" hash=abc123 ' +
  'stacktrace="at foo (bar.js:1:1)" session_id=sess-1 browser_name=Firefox browser_version=140 app_name=my-app';

function lokiFetchImpl(options: any) {
  const query: string = options?.params?.query ?? '';
  if (query.includes('hash=')) {
    // Occurrence query for the exception hash.
    return of({ data: { data: { result: [{ stream: {}, values: [['1751536800000000000', exceptionLine]] }] } } });
  }
  // Breadcrumbs query — empty session timeline is fine for these tests.
  return of({ data: { data: { result: [] } } });
}

function renderDrawer() {
  return render(
    <MemoryRouter initialEntries={['/?issueId=v1:abc123']}>
      <ExceptionDrawer
        hashes={['abc123']}
        service="my-app"
        namespace="ns"
        logsUid="loki-uid"
        selectedSessionId="sess-1"
        onSessionChange={jest.fn()}
        onClose={jest.fn()}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockFetch.mockReset().mockImplementation(lokiFetchImpl);
  getFeedback.mockReset().mockResolvedValue({ feedback: [] });
  probeReplay.mockReset().mockResolvedValue({ hasChunks: false, mode: null, chunkCount: 0 });
});

describe('opening effect (fetch-once regression)', () => {
  // Regression test: the main occurrence-fetch effect used to list the raw
  // `labelOverrides` object as a dependency even though the effect body only
  // ever reads the already-derived `clusterStream` string. `usePluginLabelOverrides`
  // is mocked here (as in the rest of this file) to return a fresh object on
  // every call — exactly what happens if the memoization it normally relies on
  // ever lapses. With the object in the deps array, every state update from the
  // fetch's own `.then()` produced a new render, which produced a new
  // `labelOverrides` reference, which re-triggered the effect — a
  // self-sustaining refetch loop (observed as 4+ calls before the fix, exactly
  // 1 after). Asserting call count here (not just eventual UI state) is the
  // only way to catch a loop like this, since every extra fetch resolves to
  // the same data and the UI looks correct regardless.
  it('fetches the exception occurrence query exactly once for a given issueId', async () => {
    renderDrawer();
    await screen.findByText(/boom/);

    // Give any spurious extra effect run a chance to fire and resolve before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const occurrenceCalls = mockFetch.mock.calls.filter(([opts]: [any]) =>
      (opts?.params?.query ?? '').includes('hash=')
    );
    expect(occurrenceCalls).toHaveLength(1);
  });
});

describe('section order (P8 drawer internal reorder)', () => {
  it('renders the stack trace above the collapsed context and breadcrumb sections', async () => {
    renderDrawer();
    await screen.findByText(/boom/);

    const stackHeading = screen.getByText('Stack Trace');
    const contextLabel = screen.getByText(/Occurrence context/);
    const breadcrumbLabel = screen.getByText(/Session timeline/);

    // DOCUMENT_POSITION_FOLLOWING means the compared node comes after `stackHeading`.
    expect(stackHeading.compareDocumentPosition(contextLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stackHeading.compareDocumentPosition(breadcrumbLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a compact impact strip above the stack trace', async () => {
    renderDrawer();
    await screen.findByText(/boom/);

    const impactStrip = screen.getByText(/^1 occurrence$/);
    const stackHeading = screen.getByText('Stack Trace');
    expect(impactStrip.compareDocumentPosition(stackHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/^1 session$/)).toBeInTheDocument();
  });
});

describe('collapsed-by-default sections', () => {
  it('keeps occurrence context collapsed until toggled', async () => {
    renderDrawer();
    await screen.findByText(/boom/);

    expect(screen.queryByText('Aggregate Impact')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Occurrence context/ }));

    expect(await screen.findByText('Aggregate Impact')).toBeInTheDocument();
    expect(screen.getByText('Most Recent Occurrence')).toBeInTheDocument();
  });

  it('keeps the session timeline collapsed until toggled', async () => {
    renderDrawer();
    await screen.findByText(/boom/);

    expect(screen.queryByText('No session events found.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Session timeline/ }));

    expect(await screen.findByText('No session events found.')).toBeInTheDocument();
  });
});

describe('user feedback section (M6)', () => {
  it('renders entries newest-first with category badge, message, email and page URL', async () => {
    const now = Date.now();
    getFeedback.mockResolvedValue({
      feedback: [
        { timeMs: now - 3 * 60_000, category: 'idea', message: 'Add dark mode' },
        {
          timeMs: now - 60_000,
          category: 'bug',
          message: 'Broken button',
          email: 'user@example.com',
          pageUrl: 'https://example.com/page.',
        },
        { timeMs: now - 2 * 60_000, category: 'other', message: 'Something else' },
      ],
    });

    renderDrawer();
    await screen.findByText(/boom/);

    const heading = await screen.findByText('User Feedback (3)');
    expect(heading).toBeInTheDocument();
    expect(screen.getByText('Broken button')).toBeInTheDocument();
    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/page')).toBeInTheDocument(); // trailing "." stripped
    expect(screen.getByText('Add dark mode')).toBeInTheDocument();
    expect(screen.getByText('Something else')).toBeInTheDocument();
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText('idea')).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();

    // Newest-first ordering: "Broken button" (1m ago) before "Something else" (2m ago) before "Add dark mode" (3m ago).
    const brokenButton = screen.getByText('Broken button');
    const somethingElse = screen.getByText('Something else');
    const addDarkMode = screen.getByText('Add dark mode');
    expect(brokenButton.compareDocumentPosition(somethingElse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(somethingElse.compareDocumentPosition(addDarkMode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('caps display at 20 entries and notes how many more', async () => {
    const now = Date.now();
    const entries = Array.from({ length: 25 }, (_, i) => ({
      timeMs: now - i * 1000,
      category: 'bug',
      message: `Feedback ${i}`,
    }));
    getFeedback.mockResolvedValue({ feedback: entries });

    renderDrawer();
    await screen.findByText(/boom/);

    await screen.findByText('User Feedback (25)');
    expect(screen.getByText('+5 more')).toBeInTheDocument();
    expect(screen.getByText('Feedback 0')).toBeInTheDocument();
    expect(screen.queryByText('Feedback 20')).not.toBeInTheDocument();
  });

  it('hides the section entirely when there is no feedback', async () => {
    getFeedback.mockResolvedValue({ feedback: [] });
    renderDrawer();
    await screen.findByText(/boom/);

    await waitFor(() => expect(getFeedback).toHaveBeenCalled());
    expect(screen.queryByText(/User Feedback/)).not.toBeInTheDocument();
  });

  it('hides the section when the backend reports feedback unavailable', async () => {
    getFeedback.mockResolvedValue({
      feedback: [{ timeMs: Date.now(), category: 'bug', message: 'ignored' }],
      unavailable: true,
    });
    renderDrawer();
    await screen.findByText(/boom/);

    await waitFor(() => expect(getFeedback).toHaveBeenCalled());
    expect(screen.queryByText(/User Feedback/)).not.toBeInTheDocument();
  });

  it('hides the section when getFeedback rejects', async () => {
    getFeedback.mockRejectedValue(new Error('network error'));
    renderDrawer();
    await screen.findByText(/boom/);

    await waitFor(() => expect(getFeedback).toHaveBeenCalled());
    expect(screen.queryByText(/User Feedback/)).not.toBeInTheDocument();
  });

  it('calls getFeedback with the issue fingerprint and time range, no session filter', async () => {
    renderDrawer();
    await screen.findByText(/boom/);

    await waitFor(() =>
      expect(getFeedback).toHaveBeenCalledWith(
        'ns',
        'my-app',
        expect.any(Number),
        expect.any(Number),
        undefined,
        undefined,
        'v1:abc123'
      )
    );
  });
});

describe('contextual docs links', () => {
  it('links the triage controls to the triage-an-issue how-to', async () => {
    renderDrawer();
    await screen.findByText(/boom/);

    const link = screen.getByRole('link', { name: /How triage works/ });
    expect(link).toHaveAttribute('href', 'https://doc.nais.io/observability/apm/how-to/triage-an-issue/');
  });

  it('links the alert action to the create-alerts how-to', async () => {
    renderDrawer();
    await screen.findByText(/boom/);

    const link = screen.getByRole('link', { name: /About alert templates/ });
    expect(link).toHaveAttribute('href', 'https://doc.nais.io/observability/apm/how-to/create-alerts/');
  });

  it('links the feedback section to the collect-user-feedback how-to', async () => {
    getFeedback.mockResolvedValue({
      feedback: [{ timeMs: Date.now(), category: 'bug', message: 'Broken button' }],
    });
    renderDrawer();
    await screen.findByText(/boom/);

    const link = await screen.findByRole('link', { name: /Collect user feedback/ });
    expect(link).toHaveAttribute('href', 'https://doc.nais.io/observability/apm/how-to/collect-user-feedback/');
  });
});
