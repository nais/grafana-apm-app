import { buildDatabaseScene, buildDbTracesExploreUrl, BuildDatabaseSceneParams } from './scene';

const defaultParams: BuildDatabaseSceneParams = {
  service: 'checkout',
  namespace: 'team-a',
  envFilter: 'prod',
  from: 'now-1h',
  to: 'now',
  metricsUid: 'prometheus-uid',
  tracesUid: 'tempo-uid',
  callsMetric: 'traces_spanmetrics_calls_total',
  durationBucket: 'traces_spanmetrics_duration_milliseconds_bucket',
  durationUnit: 'ms',
  serviceNameLabel: 'service_name',
  serviceNamespaceLabel: 'service_namespace',
  deploymentEnvLabel: 'k8s_cluster_name',
};

describe('buildDatabaseScene', () => {
  it('returns null when callsMetric is empty', () => {
    expect(buildDatabaseScene({ ...defaultParams, callsMetric: '' })).toBeNull();
  });

  it('returns null when durationBucket is empty', () => {
    expect(buildDatabaseScene({ ...defaultParams, durationBucket: '' })).toBeNull();
  });

  it('returns null when metricsUid is empty', () => {
    expect(buildDatabaseScene({ ...defaultParams, metricsUid: '' })).toBeNull();
  });

  it('returns a valid EmbeddedScene when all required params are provided', () => {
    const scene = buildDatabaseScene(defaultParams);
    expect(scene).not.toBeNull();
    expect(scene!.state).toBeDefined();
  });

  it('filters to CLIENT-kind spans with a non-empty db.system label', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('SPAN_KIND_CLIENT');
    expect(serialized).toContain('db_system=~\\".+\\"');
  });

  it('includes service, namespace and environment in scene queries', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('checkout');
    expect(serialized).toContain('team-a');
    expect(serialized).toContain('prod');
  });

  it('omits the namespace filter when namespace is empty', () => {
    const scene = buildDatabaseScene({ ...defaultParams, namespace: '' });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('service_name=\\"checkout\\"');
    expect(serialized).not.toContain('service_namespace=\\"\\"');
  });

  it('omits the environment filter when envFilter is empty', () => {
    const scene = buildDatabaseScene({ ...defaultParams, envFilter: '' });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).not.toContain('k8s_cluster_name=\\"\\"');
  });

  it('uses label overrides when provided', () => {
    const scene = buildDatabaseScene({
      ...defaultParams,
      serviceNameLabel: 'service',
      serviceNamespaceLabel: 'k8s_namespace_name',
      deploymentEnvLabel: 'deployment_environment',
    });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('service=\\"checkout\\"');
    expect(serialized).toContain('k8s_namespace_name=\\"team-a\\"');
    expect(serialized).toContain('deployment_environment=\\"prod\\"');
  });

  it('groups rate, error, and duration queries by db_system', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('sum by (db_system)');
    expect(serialized).toContain('histogram_quantile(0.95');
  });

  it('zero-fills the errors query so services without error samples render 0% instead of no data', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    // `ratio * 100 or (rate * 0)` — verified against production services with
    // real db traffic and zero errors (pdl-api, pensjon-representasjon,
    // fpinntektsmelding): the plain ratio returns an empty vector for all three.
    expect(serialized).toMatch(
      /\* 100 or sum by \(db_system\) \(rate\(traces_spanmetrics_calls_total\{[^}]*\}\[\$__rate_interval\]\)\) \* 0/
    );
  });

  it('omits the RED row and queries-per-request stat when hasDbSpans is false', () => {
    const scene = buildDatabaseScene({ ...defaultParams, hasDbSpans: false, hasDbPool: true });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).not.toContain('traces_spanmetrics_calls_total');
    expect(serialized).not.toContain('Queries per request');
    expect(serialized).not.toContain('SPAN_KIND_SERVER');
    expect(serialized).toContain('db_client_connections_wait_time_milliseconds_bucket');
  });

  it('includes the RED row when hasDbSpans is not specified (default true)', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('traces_spanmetrics_calls_total');
  });

  it('does not build a per-host breakdown (removed in the #119 redesign)', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).not.toContain('server_address');
    expect(serialized).not.toContain('Per-host breakdown');
  });

  it('adds a queries-per-request ratio: db CLIENT spans divided by inbound SERVER spans', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('Queries per request');
    // Denominator selects inbound SERVER spans (HTTP + gRPC).
    expect(serialized).toContain('SPAN_KIND_SERVER');
    // Numerator is the same CLIENT db-span rate the Rate panel sums.
    expect(serialized).toMatch(
      /sum\(rate\(traces_spanmetrics_calls_total\{[^}]*SPAN_KIND_CLIENT[^}]*\}\[\$__rate_interval\]\)\)/
    );
  });

  it('guards the ratio against divide-by-zero so non-HTTP services read N/A instead of +Inf', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    // `sum(db) / (sum(inbound) > 0)` — the `> 0` filter drops the series when a
    // service has no inbound SERVER spans (batch jobs, pure Kafka consumers) or
    // a zero request rate in-window, leaving the stat empty (rendered as N/A)
    // rather than dividing by zero.
    expect(serialized).toMatch(
      /\/ \(sum\(rate\(traces_spanmetrics_calls_total\{[^}]*SPAN_KIND_SERVER[^}]*\}\[\$__rate_interval\]\)\) > 0\)/
    );
    // The stat surfaces the empty result as an explicit N/A rather than "No data".
    expect(serialized).toContain('N/A');
  });

  it('omits the connection-acquisition panels when hasDbPool is false (the default)', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).not.toContain('db_client_connections_wait_time_milliseconds_bucket');
    expect(serialized).not.toContain('db_client_connections_create_time_milliseconds_bucket');
  });

  it('includes wait-time and create-time acquisition panels grouped by pool_name when hasDbPool is true', () => {
    const scene = buildDatabaseScene({ ...defaultParams, hasDbPool: true });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('db_client_connections_wait_time_milliseconds_bucket');
    expect(serialized).toContain('db_client_connections_create_time_milliseconds_bucket');
    expect(serialized).toContain('sum by (le, pool_name)');
  });

  it('filters connection-pool queries using the runtime app/namespace label convention, not service_name', () => {
    const scene = buildDatabaseScene({ ...defaultParams, hasDbPool: true });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('app=\\"checkout\\"');
    expect(serialized).toContain('namespace=\\"team-a\\"');
  });
});

describe('buildDbTracesExploreUrl', () => {
  it('builds a TraceQL query scoped to CLIENT spans with a db.system attribute', () => {
    const url = buildDbTracesExploreUrl('tempo-uid', 'checkout');
    expect(url).toContain('/explore');
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('resource.service.name=\\"checkout\\"');
    expect(decoded).toContain('kind=client');
    expect(decoded).toContain('span.db.system!=\\"\\"');
  });

  it('includes the namespace filter when provided', () => {
    const url = buildDbTracesExploreUrl('tempo-uid', 'checkout', 'team-a');
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('resource.service.namespace=\\"team-a\\"');
  });

  it('omits the namespace filter when not provided', () => {
    const url = buildDbTracesExploreUrl('tempo-uid', 'checkout');
    const decoded = decodeURIComponent(url);
    expect(decoded).not.toContain('resource.service.namespace');
  });
});
