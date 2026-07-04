import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LogsTab } from './LogsTab';

/**
 * LogsTab builds its Scene inline, so @grafana/scenes is mocked to capture the
 * SceneQueryRunner query models — the load-bearing thing to verify is that
 * severity filtering compiles to a `detected_level` structured-metadata filter
 * (works on plain-text/logfmt logs) rather than a `| json | level=~"…"` filter
 * (silently drops every non-JSON log), not that a real logs panel renders in
 * jsdom.
 */

interface CapturedQuery {
  refId: string;
  datasource: { uid: string; type: string };
  queries: Array<Record<string, unknown>>;
}

const capturedRunners: CapturedQuery[] = [];

jest.mock('@grafana/scenes', () => {
  const panel = () => ({
    setTitle: () => panel(),
    setData: () => panel(),
    setOption: () => panel(),
    setCustomFieldConfig: () => panel(),
    build: () => ({}),
  });
  return {
    SceneTimeRange: jest.fn().mockImplementation((cfg: unknown) => cfg),
    SceneQueryRunner: jest.fn().mockImplementation((cfg: CapturedQuery) => {
      capturedRunners.push(cfg);
      return cfg;
    }),
    EmbeddedScene: jest.fn().mockImplementation((cfg: unknown) => ({ ...(cfg as object), Component: () => null })),
    SceneFlexLayout: jest.fn().mockImplementation((cfg: unknown) => cfg),
    SceneFlexItem: jest.fn().mockImplementation((cfg: unknown) => cfg),
    PanelBuilders: { timeseries: panel, logs: panel },
  };
});

jest.mock('../../utils/timeRange', () => ({
  useTimeRange: () => ({ fromMs: 1_000_000, toMs: 2_000_000 }),
}));

// PatternsPanel fetches its own data (log patterns API) — irrelevant to the
// severity-filter query model under test here, and would otherwise require
// mocking the analytics API/fetch shape too.
jest.mock('./logs/PatternsPanel', () => ({
  PatternsPanel: () => null,
}));

const renderTab = (search = '') =>
  render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <LogsTab service="my-svc" namespace="team-a" logsUid="loki-uid" from="now-1h" to="now" />
    </MemoryRouter>
  );

function queryRunner(refId: string): CapturedQuery {
  const runner = capturedRunners.find((r) => r.queries[0]?.refId === refId);
  if (!runner) {
    throw new Error(`no captured query runner with refId ${refId}`);
  }
  return runner;
}

describe('LogsTab severity filter', () => {
  beforeEach(() => {
    capturedRunners.length = 0;
    global.fetch = jest
      .fn()
      .mockResolvedValue({ json: () => Promise.resolve({ data: [] }) }) as unknown as typeof fetch;
  });

  it('has no severity filter and no detected_level clause when nothing is selected', () => {
    renderTab();
    expect(queryRunner('A').queries[0].expr).not.toContain('detected_level');
    expect(queryRunner('volume').queries[0].expr).toBe(
      'sum by (detected_level) (count_over_time({service_name="my-svc", kind=""} [$__auto]))'
    );
  });

  it('filters the log query on detected_level (structured metadata) before the JSON parser, not on a body-parsed level field', () => {
    renderTab('?logSeverity=error');
    const expr = queryRunner('A').queries[0].expr as string;
    expect(expr).toContain('| detected_level=~"error"');
    expect(expr).not.toContain('| json | detected_level');
    expect(expr).not.toContain('level=~"error|ERROR|SEVERE"');
    // detected_level filter must come before the `| json` parse stage so
    // non-JSON (plain-text/logfmt) lines are still matched.
    expect(expr.indexOf('detected_level')).toBeLessThan(expr.indexOf('| json'));
  });

  it('filters the volume query on detected_level too, without needing its own json parser', () => {
    renderTab('?logSeverity=error,warn');
    const expr = queryRunner('volume').queries[0].expr as string;
    expect(expr).toBe(
      'sum by (detected_level) (count_over_time({service_name="my-svc", kind=""} | detected_level=~"error|warn" [$__auto]))'
    );
    expect(expr).not.toContain('json');
  });

  it('passes the selected severity values through unchanged (no hand-kept case-variant map)', () => {
    renderTab('?logSeverity=warn');
    const expr = queryRunner('A').queries[0].expr as string;
    expect(expr).toContain('detected_level=~"warn"');
    expect(expr).not.toContain('WARN');
  });
});
