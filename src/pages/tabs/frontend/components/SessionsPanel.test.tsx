import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SessionsPanel } from './SessionsPanel';
import * as client from '../../../../api/client';

jest.mock('../../../../api/client', () => ({
  ...jest.requireActual('../../../../api/client'),
  getFrontendSessions: jest.fn(),
}));

/** Exposes the router's current query string so row-click params can be asserted. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <SessionsPanel namespace="ns" service="svc" />
      <LocationProbe />
    </MemoryRouter>
  );
}

const SESSION = {
  sessionId: 'sess-abcdef123456',
  firstSeenMs: Date.now() - 3 * 3_600_000,
  lastSeenMs: Date.now() - 2 * 3_600_000,
  events: 42,
  errors: 3,
  userId: 'u-1',
  userEmail: 'alice@nav.no',
  browser: 'Chrome',
  os: 'macOS',
  appVersion: 'deadbeef0123456789',
  pages: 4,
};

describe('SessionsPanel', () => {
  const getFrontendSessions = client.getFrontendSessions as jest.Mock;

  beforeEach(() => {
    getFrontendSessions.mockReset();
  });

  it('renders session rows with user, browser, counts, and relative last-seen', async () => {
    getFrontendSessions.mockResolvedValue({
      sessions: [
        SESSION,
        {
          sessionId: 'sess-000000000000',
          firstSeenMs: 0,
          lastSeenMs: 0,
          events: 5,
          errors: 0,
          userId: '',
          userEmail: '',
          browser: '',
          os: '',
          appVersion: '',
          pages: 0,
        },
      ],
      truncated: false,
      unavailable: false,
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText('sess-abcde')).toBeInTheDocument());

    // Short id with the full session id on the title attribute
    expect(screen.getByText('sess-abcde')).toHaveAttribute('title', 'sess-abcdef123456');
    expect(screen.getByText('alice@nav.no')).toBeInTheDocument();
    expect(screen.getByText('Chrome / macOS')).toBeInTheDocument();
    expect(screen.getByText('deadbeef01')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('2h ago')).toBeInTheDocument();

    // The anonymous session degrades to dashes: user, browser, version, pages, last seen
    expect(screen.getAllByText('—')).toHaveLength(5);
  });

  it('passes the debounced search text to the API as q', async () => {
    getFrontendSessions.mockResolvedValue({ sessions: [], truncated: false, unavailable: false });
    renderPanel();

    await waitFor(() => expect(getFrontendSessions).toHaveBeenCalled());
    expect(getFrontendSessions).toHaveBeenLastCalledWith(
      'ns',
      'svc',
      expect.any(Number),
      expect.any(Number),
      undefined,
      ''
    );

    fireEvent.change(screen.getByPlaceholderText('Session id, user id, or email…'), {
      target: { value: 'alice' },
    });

    await waitFor(() =>
      expect(getFrontendSessions).toHaveBeenLastCalledWith(
        'ns',
        'svc',
        expect.any(Number),
        expect.any(Number),
        undefined,
        'alice'
      )
    );
  });

  it('deep-links a row click to the Logs tab filtered on the session id', async () => {
    getFrontendSessions.mockResolvedValue({ sessions: [SESSION], truncated: false, unavailable: false });
    renderPanel();

    await waitFor(() => expect(screen.getByText('sess-abcde')).toBeInTheDocument());
    fireEvent.click(screen.getByText('sess-abcde'));

    const search = screen.getByTestId('location-search').textContent ?? '';
    const params = new URLSearchParams(search);
    expect(params.get('tab')).toBe('logs');
    expect(params.get('logSearch')).toBe('sess-abcdef123456');
    expect(params.get('includeFaro')).toBe('true');
  });

  it('renders the empty state when there are no sessions', async () => {
    getFrontendSessions.mockResolvedValue({ sessions: [], truncated: false, unavailable: false });
    renderPanel();

    await waitFor(() => expect(screen.getByText('No sessions')).toBeInTheDocument());
  });

  it('surfaces Loki unavailability', async () => {
    getFrontendSessions.mockResolvedValue({ sessions: [], truncated: false, unavailable: true });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Loki is not available')).toBeInTheDocument());
  });

  it('names the table and labels the search input (WCAG 1.3.1 / 4.1.2)', async () => {
    getFrontendSessions.mockResolvedValue({ sessions: [SESSION], truncated: false, unavailable: false });
    renderPanel();
    await waitFor(() => expect(screen.getByText('sess-abcde')).toBeInTheDocument());
    expect(screen.getByRole('table', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search sessions' })).toBeInTheDocument();
  });

  it('notes the narrowed counting window and truncation', async () => {
    getFrontendSessions.mockResolvedValue({
      sessions: [SESSION],
      truncated: true,
      unavailable: false,
      windowSeconds: 3600,
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Events (last 60m)')).toBeInTheDocument());
    expect(screen.getByText(/Showing the top 1 sessions/)).toBeInTheDocument();
  });
});
