import {
  buildExploreUrl,
  buildTempoExploreUrl,
  buildLokiExploreUrl,
  buildMimirExploreUrl,
  buildLogsDrilldownUrl,
  buildMetricsDrilldownUrl,
  buildTracesDrilldownUrl,
  buildExceptionTracesExploreUrl,
  buildTraceExploreUrl,
} from './explore';

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

describe('buildTraceExploreUrl', () => {
  it('opens a single trace by ID via a traceql query on the Tempo datasource', () => {
    const url = buildTraceExploreUrl('tempo-uid', 'abc123def456');
    const left = parseLeft(url);
    expect(left.datasource).toBe('tempo-uid');
    expect(left.queries[0].queryType).toBe('traceql');
    expect(left.queries[0].query).toBe('abc123def456');
  });

  it('uses the provided lookup window when both bounds are given', () => {
    const url = buildTraceExploreUrl('tempo-uid', 'abc123', { from: '1700000000000', to: '1700003600000' });
    const left = parseLeft(url);
    expect(left.range.from).toBe('1700000000000');
    expect(left.range.to).toBe('1700003600000');
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

  it('uses label overrides when provided', () => {
    const url = buildLokiExploreUrl('loki', 'my-svc', {
      namespace: 'my-ns',
      serviceNameLabel: 'service',
      serviceNamespaceLabel: 'k8s_namespace_name',
    });
    const left = parseLeft(url);
    expect(left.queries[0].expr).toContain('service="my-svc"');
    expect(left.queries[0].expr).toContain('k8s_namespace_name="my-ns"');
    expect(left.queries[0].expr).not.toContain('service_name');
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

describe('buildLogsDrilldownUrl', () => {
  it('builds a service-scoped path under the default `service` label slug', () => {
    const url = buildLogsDrilldownUrl('loki-uid', 'backend');
    expect(url.startsWith('/a/grafana-lokiexplore-app/explore/service/backend/logs?')).toBe(true);
  });

  it('includes var-ds and a var-filters entry for the service label', () => {
    const url = buildLogsDrilldownUrl('loki-uid', 'backend');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('var-ds')).toBe('loki-uid');
    expect(params.getAll('var-filters')).toContain('service_name|=|backend');
  });

  it('defaults the time range to now-1h/now', () => {
    const url = buildLogsDrilldownUrl('loki-uid', 'backend');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('from')).toBe('now-1h');
    expect(params.get('to')).toBe('now');
  });

  it('uses a custom time range when provided', () => {
    const url = buildLogsDrilldownUrl('loki-uid', 'backend', { from: 'now-6h', to: 'now' });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('from')).toBe('now-6h');
  });

  it('adds a namespace filter when provided', () => {
    const url = buildLogsDrilldownUrl('loki-uid', 'backend', { namespace: 'otel-demo' });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.getAll('var-filters')).toContain('service_namespace|=|otel-demo');
  });

  it('uses the overridden label as both the path slug and filter key', () => {
    const url = buildLogsDrilldownUrl('loki-uid', 'my-svc', { serviceNameLabel: 'service' });
    expect(url.startsWith('/a/grafana-lokiexplore-app/explore/service/my-svc/logs?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.getAll('var-filters')).toContain('service|=|my-svc');
  });

  it('escapes slashes in the path segment (mirrors escapePrimaryLabel)', () => {
    const url = buildLogsDrilldownUrl('loki-uid', 'my/service');
    expect(url).toContain('/explore/service/my-service/logs');
  });

  it('escapes pipe/comma delimiters in filter values', () => {
    const url = buildLogsDrilldownUrl('loki-uid', 'svc|weird,name');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.getAll('var-filters')).toContain('service_name|=|svc__gfp__weird__gfc__name');
  });
});

describe('buildMetricsDrilldownUrl', () => {
  it('builds the drilldown path with var-ds and a service var-filters entry', () => {
    const url = buildMetricsDrilldownUrl('mimir-uid', 'backend');
    expect(url.startsWith('/a/grafana-metricsdrilldown-app/drilldown?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('var-ds')).toBe('mimir-uid');
    expect(params.getAll('var-filters')).toContain('service_name|=|backend');
  });

  it('includes a metric param when provided', () => {
    const url = buildMetricsDrilldownUrl('mimir-uid', 'backend', { metric: 'http_server_duration_seconds' });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('metric')).toBe('http_server_duration_seconds');
  });

  it('omits the metric param when not provided', () => {
    const url = buildMetricsDrilldownUrl('mimir-uid', 'backend');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.has('metric')).toBe(false);
  });

  it('adds a namespace filter when provided', () => {
    const url = buildMetricsDrilldownUrl('mimir-uid', 'backend', { namespace: 'otel-demo' });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.getAll('var-filters')).toContain('service_namespace|=|otel-demo');
  });

  it('defaults the time range to now-1h/now', () => {
    const url = buildMetricsDrilldownUrl('mimir-uid', 'backend');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('from')).toBe('now-1h');
    expect(params.get('to')).toBe('now');
  });
});

describe('buildTracesDrilldownUrl', () => {
  it('builds the explore path with var-ds and a TraceQL resource attribute filter', () => {
    const url = buildTracesDrilldownUrl('tempo-uid', 'backend');
    expect(url.startsWith('/a/grafana-exploretraces-app/explore?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('var-ds')).toBe('tempo-uid');
    expect(params.getAll('var-filters')).toContain('resource.service.name|=|backend');
  });

  it('always sets var-primarySignal=true (a filter is always present)', () => {
    const url = buildTracesDrilldownUrl('tempo-uid', 'backend');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('var-primarySignal')).toBe('true');
  });

  it('adds a namespace filter using the resource.service.namespace TraceQL path', () => {
    const url = buildTracesDrilldownUrl('tempo-uid', 'backend', { namespace: 'otel-demo' });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.getAll('var-filters')).toContain('resource.service.namespace|=|otel-demo');
  });

  it('sets var-metric=errors when statusCode is error', () => {
    const url = buildTracesDrilldownUrl('tempo-uid', 'backend', { statusCode: 'error' });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('var-metric')).toBe('errors');
  });

  it('omits var-metric when no statusCode is given', () => {
    const url = buildTracesDrilldownUrl('tempo-uid', 'backend');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.has('var-metric')).toBe(false);
  });

  it('defaults the time range to now-1h/now', () => {
    const url = buildTracesDrilldownUrl('tempo-uid', 'backend');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('from')).toBe('now-1h');
    expect(params.get('to')).toBe('now');
  });
});

describe('buildExceptionTracesExploreUrl', () => {
  it('builds an event-scope TraceQL query for exception span events', () => {
    const url = buildExceptionTracesExploreUrl('tempo-uid', 'my-app', { exceptionType: 'PSQLException' });
    const left = JSON.parse(new URLSearchParams(url.split('?')[1]).get('left')!);
    expect(left.datasource).toBe('tempo-uid');
    expect(left.queries[0].query).toBe(
      '{resource.service.name="my-app" && event:name="exception" && event.exception.type="PSQLException"}'
    );
  });

  it('omits the type filter when no exception type is known', () => {
    const url = buildExceptionTracesExploreUrl('tempo-uid', 'my-app');
    const left = JSON.parse(new URLSearchParams(url.split('?')[1]).get('left')!);
    expect(left.queries[0].query).toBe('{resource.service.name="my-app" && event:name="exception"}');
  });
});
