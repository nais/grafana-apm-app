import { CustomMetric } from '../api/client';
import { customMetricExploreQuery, customMetricPanels, runtimeMetricFilter } from './customMetricQueries';

const FILTER = 'app="app", namespace="team"';

function metric(over: Partial<CustomMetric>): CustomMetric {
  return { name: 'x', type: 'gauge', help: '', unit: '', series: 1, highCardinality: false, chart: 'gauge', ...over };
}

describe('runtimeMetricFilter', () => {
  it('omits the environment matcher when no environment is selected', () => {
    expect(runtimeMetricFilter('app', 'team')).toBe(FILTER);
    expect(runtimeMetricFilter('app', '')).toBe('app="app"');
  });

  it('uses the default deployment environment label and escapes the selected value', () => {
    expect(runtimeMetricFilter('app', 'team', 'prod"\\west')).toBe(
      'app="app", namespace="team", k8s_cluster_name="prod\\"\\\\west"'
    );
  });

  it('uses a configured deployment environment label', () => {
    expect(runtimeMetricFilter('app', 'team', 'prod', 'deployment_environment')).toBe(
      'app="app", namespace="team", deployment_environment="prod"'
    );
  });
});

describe('customMetricPanels', () => {
  it('charts a counter as a rate', () => {
    const panels = customMetricPanels(
      metric({ name: 'frontend_call_counter', type: 'counter', chart: 'rate' }),
      FILTER
    );
    expect(panels).toHaveLength(1);
    expect(panels[0].title).toBe('frontend_call_counter');
    expect(panels[0].queries[0].expr).toBe(
      'sum(rate(frontend_call_counter{app="app", namespace="team"}[$__rate_interval]))'
    );
  });

  it('charts a native histogram as p95 over _bucket', () => {
    const panels = customMetricPanels(
      metric({ name: 'batch_duration_seconds', type: 'histogram', unit: 'seconds', chart: 'p95' }),
      FILTER
    );
    expect(panels).toHaveLength(1);
    expect(panels[0].unit).toBe('s');
    expect(panels[0].queries[0].expr).toBe(
      'histogram_quantile(0.95, sum by (le) (rate(batch_duration_seconds_bucket{app="app", namespace="team"}[$__rate_interval])))'
    );
  });

  it('charts a summary/timer as throughput + avg (never quantile)', () => {
    const panels = customMetricPanels(
      metric({ name: 'http_server_requests_seconds', type: 'summary', unit: 'seconds', chart: 'summary' }),
      FILTER
    );
    expect(panels).toHaveLength(2);
    // Throughput panel: rate of the _count series (no unit override — it's per-second).
    expect(panels[0].title).toContain('throughput');
    expect(panels[0].unit).toBeUndefined();
    expect(panels[0].queries[0].expr).toBe(
      'sum(rate(http_server_requests_seconds_count{app="app", namespace="team"}[$__rate_interval]))'
    );
    // Avg panel: rate(_sum)/rate(_count), carrying the family's time unit.
    expect(panels[1].title).toContain('avg');
    expect(panels[1].unit).toBe('s');
    expect(panels[1].queries[0].expr).toBe(
      'sum(rate(http_server_requests_seconds_sum{app="app", namespace="team"}[$__rate_interval])) / sum(rate(http_server_requests_seconds_count{app="app", namespace="team"}[$__rate_interval]))'
    );
    // No bucket-based quantile anywhere.
    expect(panels.some((p) => p.queries.some((q) => q.expr.includes('histogram_quantile')))).toBe(false);
  });

  it('charts a gauge as an avg aggregated across pods', () => {
    const panels = customMetricPanels(metric({ name: 'queue_depth', type: 'gauge', chart: 'gauge' }), FILTER);
    expect(panels).toHaveLength(1);
    // avg() drops pod/instance labels so N pod series collapse to one line.
    expect(panels[0].queries[0].expr).toBe('avg(queue_depth{app="app", namespace="team"})');
  });
});

describe('customMetricExploreQuery', () => {
  it('returns the primary panel query for the Explore deep link', () => {
    expect(customMetricExploreQuery(metric({ name: 'q', type: 'gauge', chart: 'gauge' }), FILTER)).toBe(
      'avg(q{app="app", namespace="team"})'
    );
    // For a summary the primary link is throughput (the first panel).
    expect(customMetricExploreQuery(metric({ name: 'lat_seconds', type: 'summary', chart: 'summary' }), FILTER)).toBe(
      'sum(rate(lat_seconds_count{app="app", namespace="team"}[$__rate_interval]))'
    );
  });
});
