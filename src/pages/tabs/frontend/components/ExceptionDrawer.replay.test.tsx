/**
 * ExceptionDrawer × session replay (#58/#67): the "Play replay" /
 * "View snapshot" button appears only when probeReplay finds chunks for the
 * selected session, and clicking it fetches chunks and mounts the (mocked)
 * lazy player.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { of } from 'rxjs';
import { ExceptionDrawer } from './ExceptionDrawer';
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

jest.mock('../replay/fetchReplay', () => ({
  ...jest.requireActual('../replay/fetchReplay'),
  probeReplay: jest.fn(),
  fetchReplay: jest.fn(),
}));

// Keep the heavy rrweb chunk out of jsdom — the drawer test only cares that
// the lazy player gets mounted with the fetched data.
jest.mock('../replay/LazyReplayPlayer', () => ({
  LazyReplayPlayer: (props: { mode: string }) => <div data-testid="replay-player">mode:{props.mode}</div>,
}));

const probeReplay = replayApi.probeReplay as jest.Mock;
const fetchReplay = replayApi.fetchReplay as jest.Mock;

const exceptionLine =
  'timestamp=2026-07-03T10:00:00Z kind=exception type=TypeError value="boom" hash=abc123 ' +
  'session_id=sess-1 browser_name=Firefox browser_version=140 app_name=my-app';

function lokiFetchImpl(options: any) {
  const query: string = options?.params?.query ?? '';
  if (query.includes('hash=')) {
    // Occurrence query for the exception hash.
    return of({ data: { data: { result: [{ stream: {}, values: [['1751536800000000000', exceptionLine]] }] } } });
  }
  // Breadcrumbs query — empty session timeline is fine here.
  return of({ data: { data: { result: [] } } });
}

function renderDrawer() {
  return render(
    <MemoryRouter>
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
  probeReplay.mockReset();
  fetchReplay.mockReset();
});

it('shows Play replay only when the probe finds recording chunks', async () => {
  probeReplay.mockResolvedValue({ hasChunks: true, mode: 'recording', chunkCount: 3 });
  renderDrawer();

  expect(await screen.findByRole('button', { name: /Play replay/ })).toBeInTheDocument();
  expect(screen.getByText('Session Replay')).toBeInTheDocument();
  expect(probeReplay).toHaveBeenCalledWith(
    expect.objectContaining({ logsUid: 'loki-uid', service: 'my-app', sessionId: 'sess-1' })
  );
  // The replay section footer links to the enable-session-replay how-to.
  const docsLink = screen.getByRole('link', { name: /Enable session replay/ });
  expect(docsLink).toHaveAttribute('href', 'https://doc.nais.io/observability/apm/how-to/enable-session-replay/');
});

it('labels snapshot-only sessions View snapshot', async () => {
  probeReplay.mockResolvedValue({ hasChunks: true, mode: 'snapshot', chunkCount: 1 });
  renderDrawer();

  expect(await screen.findByRole('button', { name: /View snapshot/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Play replay/ })).not.toBeInTheDocument();
});

it('renders no replay section when the probe finds nothing', async () => {
  probeReplay.mockResolvedValue({ hasChunks: false, mode: null, chunkCount: 0 });
  renderDrawer();

  // Wait until the drawer has loaded the exception and the probe resolved.
  await screen.findByText(/boom/);
  await waitFor(() => expect(probeReplay).toHaveBeenCalled());
  expect(screen.queryByText('Session Replay')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Play replay|View snapshot/ })).not.toBeInTheDocument();
});

it('fetches chunks on click and mounts the lazy player', async () => {
  probeReplay.mockResolvedValue({ hasChunks: true, mode: 'recording', chunkCount: 2 });
  fetchReplay.mockResolvedValue({
    events: [
      { type: 4, data: {}, timestamp: 1000 },
      { type: 2, data: {}, timestamp: 1000 },
    ],
    mode: 'recording',
    chunkCount: 2,
  });
  renderDrawer();

  fireEvent.click(await screen.findByRole('button', { name: /Play replay/ }));

  expect(await screen.findByTestId('replay-player')).toHaveTextContent('mode:recording');
  expect(fetchReplay).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }));
});
