import { buildExploreUrl, buildTempoExploreUrl, buildLokiExploreUrl, buildMimirExploreUrl } from './explore';

describe('buildExploreUrl', () => {
  it('builds a url with datasource and queries', () => {
    const url = buildExploreUrl({
      datasourceUid: 'mimir',
      queries: [{ refId: 'A', expr: 'up' }],
    });
    expect(url).toContain('/explore');
    expect(url).toContain('mimir');
  });
});

describe('buildTempoExploreUrl', () => {
  it('builds a tempo url with service filter', () => {
    const url = buildTempoExploreUrl('tempo', 'frontend');
    expect(url).toContain('tempo');
    expect(url).toContain('frontend');
  });

  it('includes status code filter', () => {
    const url = buildTempoExploreUrl('tempo', 'frontend', { statusCode: 'error' });
    expect(url).toContain('error');
  });

  it('includes namespace filter', () => {
    const url = buildTempoExploreUrl('tempo', 'frontend', { namespace: 'otel-demo' });
    expect(url).toContain('service.namespace');
    expect(url).toContain('otel-demo');
  });
});

describe('buildLokiExploreUrl', () => {
  it('builds a loki url with service filter', () => {
    const url = buildLokiExploreUrl('loki', 'frontend');
    expect(url).toContain('loki');
    expect(url).toContain('frontend');
  });

  it('includes trace ID filter', () => {
    const url = buildLokiExploreUrl('loki', 'frontend', { traceId: 'abc123' });
    expect(url).toContain('abc123');
  });

  it('includes namespace filter', () => {
    const url = buildLokiExploreUrl('loki', 'frontend', { namespace: 'otel-demo' });
    expect(url).toContain('service_namespace');
    expect(url).toContain('otel-demo');
  });
});

describe('buildMimirExploreUrl', () => {
  it('builds a mimir url with expression', () => {
    const url = buildMimirExploreUrl('mimir', 'sum(rate(my_metric[5m]))');
    expect(url).toContain('mimir');
    expect(url).toContain('my_metric');
  });
});
