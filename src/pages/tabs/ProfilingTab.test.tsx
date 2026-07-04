import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProfilingTab } from './ProfilingTab';

/**
 * ProfilingTab builds a Scene inline, so @grafana/scenes is mocked to capture
 * the SceneQueryRunner query models — the load-bearing part is that the
 * grafana-pyroscope-datasource query shape (queryType / profileTypeId /
 * labelSelector) is correct, not that a real flame graph renders in jsdom.
 */

interface CapturedQuery {
  datasource: { uid: string; type: string };
  queries: Array<Record<string, unknown>>;
}

const capturedRunners: CapturedQuery[] = [];

jest.mock('@grafana/scenes', () => {
  const panel = () => ({ setTitle: () => panel(), setData: () => panel(), build: () => ({}) });
  return {
    SceneTimeRange: jest.fn().mockImplementation((cfg: unknown) => cfg),
    SceneQueryRunner: jest.fn().mockImplementation((cfg: CapturedQuery) => {
      capturedRunners.push(cfg);
      return cfg;
    }),
    EmbeddedScene: jest.fn().mockImplementation((cfg: unknown) => ({ ...(cfg as object), Component: () => null })),
    SceneFlexLayout: jest.fn().mockImplementation((cfg: unknown) => cfg),
    SceneFlexItem: jest.fn().mockImplementation((cfg: unknown) => cfg),
    PanelBuilders: { timeseries: panel, flamegraph: panel },
  };
});

jest.mock('../../utils/timeRange', () => ({
  useTimeRange: () => ({ from: 'now-1h', to: 'now', fromMs: 1_000_000, toMs: 2_000_000 }),
}));

jest.mock('../../utils/useSceneTimeSync', () => ({ useSceneTimeSync: jest.fn() }));

jest.mock('@grafana/ui', () => ({
  useStyles2: () => ({ wrapper: '', controls: '', label: '', sceneWrapper: '' }),
  Combobox: ({
    options,
    value,
    onChange,
  }: {
    options: Array<{ label: string; value: string }>;
    value: string;
    onChange: (v: { value: string }) => void;
  }) => (
    <select aria-label="Profile type" value={value} onChange={(e) => onChange({ value: e.currentTarget.value })}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

describe('ProfilingTab query model', () => {
  beforeEach(() => {
    capturedRunners.length = 0;
  });

  it('builds metrics + profile Pyroscope queries for CPU with a service_name label selector', () => {
    render(<ProfilingTab service="my-svc" namespace="team-a" pyroscopeUid="pyro-uid" />);

    // One metrics runner + one profile runner.
    expect(capturedRunners).toHaveLength(2);
    for (const r of capturedRunners) {
      expect(r.datasource).toEqual({ uid: 'pyro-uid', type: 'grafana-pyroscope-datasource' });
      expect(r.queries[0].profileTypeId).toBe('process_cpu:cpu:nanoseconds:cpu:nanoseconds');
      expect(r.queries[0].labelSelector).toBe('{service_name="my-svc"}');
    }
    const queryTypes = capturedRunners.map((r) => r.queries[0].queryType);
    expect(queryTypes).toEqual(expect.arrayContaining(['metrics', 'profile']));
  });

  it('respects a serviceNameLabel override in the label selector', () => {
    render(<ProfilingTab service="my-svc" namespace="team-a" pyroscopeUid="pyro-uid" serviceNameLabel="app" />);
    expect(capturedRunners[0].queries[0].labelSelector).toBe('{app="my-svc"}');
  });

  it('rebuilds the queries with the selected memory profile type', () => {
    render(<ProfilingTab service="my-svc" namespace="team-a" pyroscopeUid="pyro-uid" />);
    capturedRunners.length = 0;

    fireEvent.change(screen.getByLabelText('Profile type'), {
      target: { value: 'memory:inuse_space:bytes:space:bytes' },
    });

    expect(capturedRunners.length).toBeGreaterThanOrEqual(2);
    for (const r of capturedRunners) {
      expect(r.queries[0].profileTypeId).toBe('memory:inuse_space:bytes:space:bytes');
    }
  });
});
