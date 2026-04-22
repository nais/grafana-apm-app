import { buildExploreUrl, buildTempoExploreUrl, buildLokiExploreUrl, buildMimirExploreUrl } from './explore';

/** Parse the `left` param from a Grafana Explore URL */
function parseLeft(url: string): {
  datasource: string;
  queries: Array<Record<string, unknown>>;
  range: { from: string; to: string };
} {
  const u = new URL(url, 'http://grafana.local');
  return JSON.parse(u.searchParams.get('left')!);
}

describe('buildExploreUrl', () => {
  it('serializes datasource and queries into left param', () => {
    const url = buildExploreUrl({
      datasourceUid: 'mimir-uid',
      queries: [{ refId: 'A', expr: 'up' }],
    });
    const left = parseLeft(url);
    expect(left.datasource).toBe('mimir-uid');
    expect(left.queries).toHaveLength(1);
    expect(left.queries[0].expr).toBe('up');
    expect(left.queries[0].refId).toBe('A');
  });

  it('uses default time range when not specified', () => {
    const url = buildExploreUrl({
      datasourceUid: 'ds',
      queries: [{ refId: 'A' }],
    });
    const left = parseLeft(url);
    expect(left.range.from).toBe('now-1h');
    expect(left.range.to).toBe('now');
  });

  it('uses custom time range when provided', () => {
    const url = buildExploreUrl({
      datasourceUid: 'ds',
      queries: [{ refId: 'A' }],
      range: { from: 'now-6h', to: 'now' },
    });
    const left = parseLeft(url);
    expect(left.range.from).toBe('now-6h');
  });
});

describe('buildTempoExploreUrl', () => {
  it('builds TraceQL query with service filter', () => {
    const url = buildTempoExploreUrl('tempo-uid', 'frontend');
    const left = parseLeft(url);
    expect(left.datasource).toBe('tempo-uid');
    expect(left.queries[0].queryType).toBe('traceql');
    expect(left.queries[0].query).toContain('frontend');
  });

  it('includes status code filter in TraceQL', () => {
    const url = buildTempoExploreUrl('tempo', 'svc', { statusCode: 'error' });
    const left = parseLeft(url);
    expect(left.queries[0].query).toContain('status=error');
  });

  it('includes namespace filter in TraceQL', () => {
    const url = buildTempoExploreUrl('tempo', 'svc', { namespace: 'otel-demo' });
    const left = parseLeft(url);
    expect(left.queries[0].query).toContain('otel-demo');
  });

  it('escapes service names with special chars', () => {
    const url = buildTempoExploreUrl('tempo', 'my"service');
    const left = parseLeft(url);
    // Double quotes should be escaped in the TraceQL string
    expect(left.queries[0].query).toContain('my\\"service');
  });

  it('combines multiple filters', () => {
    const url = buildTempoExploreUrl('tempo', 'svc', {
      namespace: 'ns',
      statusCode: 'error',
      operation: 'GET /api',
    });
    const left = parseLeft(url);
    const query = left.queries[0].query as string;
    expect(query).toContain('svc');
    expect(query).toContain('ns');
    expect(query).toContain('status=error');
    expect(query).toContain('GET /api');
  });
});

describe('buildLokiExploreUrl', () => {
  it('builds LogQL query with service filter', () => {
    const url = buildLokiExploreUrl('loki-uid', 'backend');
    const left = parseLeft(url);
    expect(left.datasource).toBe('loki-uid');
    expect(left.queries[0].expr).toContain('backend');
  });

  it('includes trace ID as line filter', () => {
    const url = buildLokiExploreUrl('loki', 'svc', { traceId: 'abc123def' });
    const left = parseLeft(url);
    expect(left.queries[0].expr).toContain('abc123def');
  });

  it('includes namespace in label selector', () => {
    const url = buildLokiExploreUrl('loki', 'svc', { namespace: 'otel-demo' });
    const left = parseLeft(url);
    expect(left.queries[0].expr).toContain('otel-demo');
  });
});

describe('buildMimirExploreUrl', () => {
  it('passes PromQL expression directly', () => {
    const expr = 'sum(rate(http_requests_total[5m]))';
    const url = buildMimirExploreUrl('mimir-uid', expr);
    const left = parseLeft(url);
    expect(left.datasource).toBe('mimir-uid');
    expect(left.queries[0].expr).toBe(expr);
  });
});
