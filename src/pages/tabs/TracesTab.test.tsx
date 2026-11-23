import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { PanelBuilders, SceneQueryRunner, SceneTimeRange } from '@grafana/scenes';
import { useTimeRange } from '../../utils/timeRange';
import { TracesTab } from './TracesTab';

jest.mock('@grafana/scenes', () => {
  const panel = {
    setTitle: jest.fn().mockReturnThis(),
    setData: jest.fn().mockReturnThis(),
    setOption: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  };
  return {
    SceneTimeRange: jest.fn(),
    SceneQueryRunner: jest.fn(),
    EmbeddedScene: jest.fn().mockImplementation(() => ({ Component: () => null })),
    SceneFlexLayout: jest.fn(),
    SceneFlexItem: jest.fn(),
    PanelBuilders: { table: () => panel },
  };
});

jest.mock('../../utils/timeRange', () => ({
  useTimeRange: jest.fn(),
}));

jest.mock('../../components/TraceDrawer/traceDrawerData', () => ({
  traceDrawerData: jest.fn(),
}));

jest.mock('./traces/TraceBreakdowns', () => ({
  TraceBreakdowns: () => null,
}));

describe('TracesTab search ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(useTimeRange).mockReturnValue({
      from: 'now-5m',
      to: 'now',
      fromMs: 1_000_000,
      toMs: 1_300_000,
      setTimeRange: jest.fn(),
      refresh: jest.fn(),
    });
  });

  it('requests the 20 most recent traces and displays newest first', () => {
    render(<TracesTab service="my-svc" namespace="team-a" tracesUid="tempo-uid" from="now-5m" to="now" />);

    expect(SceneQueryRunner).toHaveBeenLastCalledWith({
      datasource: { uid: 'tempo-uid', type: 'tempo' },
      queries: [
        {
          refId: 'A',
          queryType: 'traceql',
          query: '{resource.service.name="my-svc"} with (most_recent=true)',
          tableType: 'traces',
          limit: 20,
        },
      ],
    });
    expect(PanelBuilders.table().setOption).toHaveBeenCalledWith('sortBy', [{ displayName: 'Start time', desc: true }]);
  });

  it('keeps most-recent ordering when filters change', () => {
    render(
      <TracesTab
        service="my-svc"
        namespace="team-a"
        tracesUid="tempo-uid"
        from="now-5m"
        to="now"
        initialStatus="error"
        initialSpanKind="SPAN_KIND_SERVER"
      />
    );

    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '100' } });

    expect(SceneQueryRunner).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queries: [
          expect.objectContaining({
            query:
              '{resource.service.name="my-svc" && kind=server && status=error && duration >= 100ms} with (most_recent=true)',
            limit: 20,
          }),
        ],
      })
    );
  });

  it('can request 100 traces and switch back to 20 without losing filters', () => {
    render(
      <TracesTab
        service="my-svc"
        namespace="team-a"
        tracesUid="tempo-uid"
        from="now-5m"
        to="now"
        initialStatus="error"
      />
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Traces:' }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Traces:' }), { key: 'End' });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Traces:' }), { key: 'Enter' });

    expect(SceneQueryRunner).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queries: [
          expect.objectContaining({
            query: '{resource.service.name="my-svc" && status=error} with (most_recent=true)',
            limit: 100,
          }),
        ],
      })
    );

    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '100' } });
    expect(SceneQueryRunner).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queries: [expect.objectContaining({ limit: 100 })],
      })
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Traces:' }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Traces:' }), { key: 'Home' });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Traces:' }), { key: 'Enter' });
    expect(SceneQueryRunner).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queries: [
          expect.objectContaining({
            query: '{resource.service.name="my-svc" && status=error && duration >= 100ms} with (most_recent=true)',
            limit: 20,
          }),
        ],
      })
    );
  });

  it('rebuilds the most-recent search for a wider selected time window', () => {
    const props = { service: 'my-svc', namespace: 'team-a', tracesUid: 'tempo-uid', from: 'now-5m', to: 'now' };
    const { rerender } = render(<TracesTab {...props} />);
    jest.mocked(useTimeRange).mockReturnValue({
      from: 'now-30m',
      to: 'now',
      fromMs: 1_000_000,
      toMs: 2_800_000,
      setTimeRange: jest.fn(),
      refresh: jest.fn(),
    });

    rerender(<TracesTab {...props} from="now-30m" />);

    expect(SceneTimeRange).toHaveBeenLastCalledWith({
      from: new Date(1_000_000).toISOString(),
      to: new Date(2_800_000).toISOString(),
    });
    expect(SceneQueryRunner).toHaveBeenCalledTimes(2);
    expect(SceneQueryRunner).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queries: [
          expect.objectContaining({
            query: '{resource.service.name="my-svc"} with (most_recent=true)',
            limit: 20,
          }),
        ],
      })
    );
  });
});
