/**
 * Smoke tests for the replay player wrapper. jsdom cannot run the real
 * rrweb player (iframe rendering), so @grafana/rrweb-player is mocked —
 * these tests assert our wiring: constructor props per mode, seek behavior,
 * badge/notice text, and the lazy boundary resolving.
 */
import React, { Suspense } from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@grafana/rrweb-player', () => {
  const instance = { goto: jest.fn(), pause: jest.fn(), $destroy: jest.fn() };
  const ctor = jest.fn().mockImplementation(() => instance);
  return { __esModule: true, default: ctor, __instance: instance };
});

import RrwebPlayer from '@grafana/rrweb-player';
import ReplayPlayer from './ReplayPlayer';
import { LazyReplayPlayer } from './LazyReplayPlayer';
import { ReplayEventWithTime } from './fetchReplay';

const mockCtor = RrwebPlayer as unknown as jest.Mock;
const mockInstance = (jest.requireMock('@grafana/rrweb-player') as any).__instance;

const ev = (timestamp: number, type = 3): ReplayEventWithTime => ({ type, data: {}, timestamp });
const snapshotEvents = [ev(1000, 4), ev(1000, 2)];
const recordingEvents = [ev(1000, 4), ev(1000, 2), ev(5000), ev(60000)];

beforeEach(() => {
  mockCtor.mockClear();
  mockInstance.goto.mockClear();
  mockInstance.pause.mockClear();
  mockInstance.$destroy.mockClear();
});

describe('ReplayPlayer', () => {
  it('renders a snapshot as a static frame: controls hidden, paused, with the masked-snapshot badge', () => {
    render(<ReplayPlayer events={snapshotEvents} mode="snapshot" />);

    expect(screen.getByText('Masked snapshot')).toBeInTheDocument();
    expect(screen.getByText(/Recorded with all text and inputs masked at capture time/)).toBeInTheDocument();

    expect(mockCtor).toHaveBeenCalledTimes(1);
    const { props } = mockCtor.mock.calls[0][0];
    expect(props.showController).toBe(false);
    expect(props.autoPlay).toBe(false);
    expect(props.skipInactive).toBe(false);
    expect(mockInstance.goto).not.toHaveBeenCalled();
  });

  it('renders a recording with controls, skip-inactive, and seeks (paused) to the requested time', () => {
    render(<ReplayPlayer events={recordingEvents} mode="recording" seekToMs={31000} />);

    expect(screen.getByText('Session replay')).toBeInTheDocument();
    expect(screen.getByText(/masked at capture time/)).toBeInTheDocument();

    const { props } = mockCtor.mock.calls[0][0];
    expect(props.showController).toBe(true);
    expect(props.skipInactive).toBe(true);
    // Absolute 31000ms − first event at 1000ms → 30000ms offset, not playing.
    expect(mockInstance.goto).toHaveBeenCalledWith(30000, false);
  });

  it('clamps a pre-recording seek target to the start', () => {
    render(<ReplayPlayer events={recordingEvents} mode="recording" seekToMs={500} />);
    expect(mockInstance.goto).toHaveBeenCalledWith(0, false);
  });

  it('shows an info alert instead of mounting the player when there are not enough events', () => {
    render(<ReplayPlayer events={[ev(1000, 4)]} mode="recording" />);
    expect(screen.getByText('Replay incomplete')).toBeInTheDocument();
    expect(mockCtor).not.toHaveBeenCalled();
  });

  it('tears the player down on unmount', () => {
    const { unmount } = render(<ReplayPlayer events={snapshotEvents} mode="snapshot" />);
    unmount();
    expect(mockInstance.$destroy).toHaveBeenCalled();
  });
});

describe('LazyReplayPlayer', () => {
  it('resolves through the guarded lazy boundary and renders the badge and privacy notice', async () => {
    render(
      <Suspense fallback={<span>loading…</span>}>
        <LazyReplayPlayer events={snapshotEvents} mode="snapshot" />
      </Suspense>
    );

    expect(await screen.findByText('Masked snapshot')).toBeInTheDocument();
    expect(screen.getByText(/Recorded with all text and inputs masked at capture time/)).toBeInTheDocument();
  });
});
