import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FieldType, LoadingState, PanelData, toDataFrame } from '@grafana/data';
import { TraceDrawer } from './TraceDrawer';
import { otel } from '../../otelconfig';

/**
 * The drawer builds its Scenes inline, so @grafana/scenes is mocked to capture the query
 * models: what has to hold is which trace is fetched, which logs are searched and when the
 * drawer shows at all, not that a real trace view renders in jsdom.
 */

interface CapturedRunner {
  datasource: { uid: string; type: string };
  queries: Array<Record<string, unknown>>;
}

const runners: CapturedRunner[] = [];
const panelOptions: Array<Record<string, unknown>> = [];
// What the Tempo lookup has returned; undefined while it is in flight.
let traceData: PanelData | undefined;

jest.mock('@grafana/scenes', () => {
  const builder = () => {
    const options: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    for (const m of ['setTitle', 'setDisplayMode', 'setData']) {
      b[m] = () => b;
    }
    b.setOption = (key: string, value: unknown) => ((options[key] = value), b);
    b.build = () => {
      panelOptions.push(options);
      return { state: { options }, onOptionsChange: jest.fn() };
    };
    return b;
  };
  return {
    SceneTimeRange: jest.fn().mockImplementation((cfg: unknown) => cfg),
    SceneQueryRunner: jest.fn().mockImplementation((cfg: CapturedRunner) => {
      runners.push(cfg);
      return { ...cfg, useState: () => ({ data: traceData }) };
    }),
    SceneDataTransformer: jest.fn().mockImplementation((cfg: unknown) => cfg),
    EmbeddedScene: jest.fn().mockImplementation((cfg: unknown) => ({ ...(cfg as object), Component: () => null })),
    SceneFlexLayout: jest.fn().mockImplementation((cfg: unknown) => cfg),
    SceneFlexItem: jest.fn().mockImplementation((cfg: unknown) => cfg),
    PanelBuilders: { traces: builder, logs: builder },
  };
});

jest.mock('../../utils/timeRange', () => ({
  useTimeRange: () => ({ fromMs: 1_000_000, toMs: 2_000_000 }),
}));

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

// A loaded trace: frontend calling cartservice.
const loaded = {
  state: LoadingState.Done,
  series: [
    toDataFrame({
      fields: [
        { name: 'parentSpanID', type: FieldType.string, values: ['', 'a'] },
        { name: 'operationName', type: FieldType.string, values: ['GET /cart', 'GET /api/cart'] },
        { name: 'serviceName', type: FieldType.string, values: ['frontend', 'cartservice'] },
        { name: 'startTime', type: FieldType.number, values: [1_500_000, 1_500_010] },
        { name: 'duration', type: FieldType.number, values: [200, 150] },
        { name: 'statusCode', type: FieldType.number, values: [0, 0] },
      ],
    }),
  ],
} as unknown as PanelData;

const renderDrawer = (search: string, props: { logsUid?: string; clusterFilter?: string } = {}) =>
  render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <TraceDrawer tracesUid="tempo-uid" logsServiceLabel="service_name" {...props} />
    </MemoryRouter>
  );

const lokiRunner = () => runners.find((r) => r.datasource.type === 'loki');

beforeEach(() => {
  runners.length = 0;
  panelOptions.length = 0;
  traceData = undefined;
});

it('stays closed without a trace in the URL', () => {
  renderDrawer('?tab=traces');
  expect(screen.queryByText('Trace')).not.toBeInTheDocument();
  expect(runners).toHaveLength(0);
});

it('stays closed when the trace param is not a trace ID', () => {
  renderDrawer('?traceId=abc%22%7D%20%7C%20x');
  expect(runners).toHaveLength(0);
});

it('looks the trace up in the Tempo datasource, focused on the span from the URL', () => {
  renderDrawer(`?traceId=${TRACE}&spanId=00f067aa0ba902b7`);
  expect(runners[0]).toEqual(
    expect.objectContaining({
      datasource: { uid: 'tempo-uid', type: 'tempo' },
      queries: [{ refId: 'A', queryType: 'traceql', query: TRACE }],
    })
  );
  expect(panelOptions[0].focusedSpanId).toBe('00f067aa0ba902b7');
  expect(screen.getByText(TRACE)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Open in Explore/ })).toHaveAttribute(
    'href',
    expect.stringContaining('tempo-uid')
  );
});

it('waits for the trace before searching logs, rather than scanning the page range', () => {
  renderDrawer(`?traceId=${TRACE}`, { logsUid: 'loki-uid' });
  fireEvent.click(screen.getByText('Logs'));
  expect(screen.getByText('Loading the trace…')).toBeInTheDocument();
  expect(lokiRunner()).toBeUndefined();
});

it("searches the logs of the trace's services, by line and by structured metadata", () => {
  traceData = loaded;
  renderDrawer(`?traceId=${TRACE}`, { logsUid: 'loki-uid' });
  fireEvent.click(screen.getByText('Logs'));
  const loki = lokiRunner();
  expect(loki?.datasource.uid).toBe('loki-uid');
  expect(loki?.queries.map((q) => q.refId)).toEqual(['A', 'B']);
  expect(loki?.queries[0].expr).toMatch(new RegExp(`^\\{service_name=~"frontend\\|cartservice"\\} \\|= "${TRACE}"`));
  expect(loki?.queries[1].expr).toContain(`| trace_id="${TRACE}"`);
});

it('scopes a shared Loki to the environment with the built-in label when none is configured', () => {
  traceData = loaded;
  renderDrawer(`?traceId=${TRACE}`, { logsUid: 'loki-uid', clusterFilter: 'prod' });
  fireEvent.click(screen.getByText('Logs'));
  expect(lokiRunner()?.queries[0].expr).toContain(`, ${otel.labels.deploymentEnv}="prod"}`);
});

it('tells a trace Tempo does not have from a lookup that failed', () => {
  traceData = { state: LoadingState.Done, series: [] } as unknown as PanelData;
  const { unmount } = renderDrawer(`?traceId=${TRACE}`);
  expect(screen.getByText('Trace not found')).toBeInTheDocument();
  unmount();

  traceData = { state: LoadingState.Error, series: [], errors: [{ message: 'Forbidden' }] } as unknown as PanelData;
  renderDrawer(`?traceId=${TRACE}`);
  expect(screen.getByText('Could not load the trace')).toBeInTheDocument();
  expect(screen.getByText('Forbidden')).toBeInTheDocument();
  expect(screen.queryByText('Trace not found')).not.toBeInTheDocument();
});

it('has no Logs tab without a Loki datasource', () => {
  renderDrawer(`?traceId=${TRACE}`);
  expect(screen.queryByText('Logs')).not.toBeInTheDocument();
});
