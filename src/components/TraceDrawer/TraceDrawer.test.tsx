import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TraceDrawer } from './TraceDrawer';

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
      return { ...cfg, useState: () => ({ data: undefined }) };
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

const renderDrawer = (search: string, logsUid?: string) =>
  render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <TraceDrawer tracesUid="tempo-uid" logsUid={logsUid} logsServiceLabel="service" service="raffles" />
    </MemoryRouter>
  );

beforeEach(() => {
  runners.length = 0;
  panelOptions.length = 0;
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

it("searches the page service's logs for the trace until the trace has loaded", () => {
  renderDrawer(`?traceId=${TRACE}`, 'loki-uid');
  fireEvent.click(screen.getByText('Logs'));
  const loki = runners.find((r) => r.datasource.type === 'loki');
  expect(loki?.datasource.uid).toBe('loki-uid');
  expect(loki?.queries[0].expr).toMatch(new RegExp(`^\\{service="raffles"\\} \\|= "${TRACE}"`));
});

it('has no Logs tab without a Loki datasource', () => {
  renderDrawer(`?traceId=${TRACE}`);
  expect(screen.queryByText('Logs')).not.toBeInTheDocument();
});
