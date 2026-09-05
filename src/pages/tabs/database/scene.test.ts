import {
  buildDatabaseScene,
  buildDbTracesExploreUrl,
  BuildDatabaseSceneParams,
  INBOUND_FLOOR_RPS,
} from './scene';

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
    expect(serialized).not.toContain('SPAN_KIND_CONSUMER');
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

  it('adds a queries-per-request-or-message ratio: db CLIENT spans divided by inbound SERVER or CONSUMER spans', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('Queries per request or message');
    // Denominator selects inbound work: SERVER spans (HTTP/gRPC) OR CONSUMER
    // spans (Kafka messages), via a regex match — so Kafka-driven apps get a
    // real ratio instead of N/A.
    expect(serialized).toContain('span_kind=~\\"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER\\"');
    // Numerator is the same CLIENT db-span rate the Rate panel sums.
    expect(serialized).toMatch(
      /sum\(rate\(traces_spanmetrics_calls_total\{[^}]*SPAN_KIND_CLIENT[^}]*\}\[\$__rate_interval\]\)\)/
    );
  });

  it('floors the ratio denominator so batch and scheduler-driven services get a no-value state instead of an inflated or +Inf ratio', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    // `sum(db) / (sum(inbound) > INBOUND_FLOOR_RPS)` — the floor drops the series
    // unless the inbound rate clears it. That covers both a genuinely absent
    // denominator (pure batch jobs — 0 never clears the floor, so no
    // divide-by-zero) and a trickle-inbound one that would balloon the ratio into
    // a false N+1 (#132).
    expect(serialized).toMatch(
      new RegExp(
        `/ \\(sum\\(rate\\(traces_spanmetrics_calls_total\\{[^}]*SPAN_KIND_SERVER\\|SPAN_KIND_CONSUMER[^}]*\\}\\[\\$__rate_interval\\]\\)\\) > ${INBOUND_FLOOR_RPS}\\)`
      )
    );
    // The empty result renders an explanatory message, not a bare N/A.
    expect(serialized).toContain('too little inbound traffic to compare');
  });

  it('quotes the same floor in the panel description as the query enforces', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    // Guards against the UI text silently desyncing from the constant.
    expect(serialized).toContain(`at or below ${INBOUND_FLOOR_RPS} inbound requests or messages per second`);
  });

  it('picks an inbound floor that classifies the issue #132 live-evidence services correctly', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    // The query must enforce the exported constant, and the classification below
    // is then run against that same constant.
    expect(serialized).toContain(`[$__rate_interval])) > ${INBOUND_FLOOR_RPS})`);
    const floor = INBOUND_FLOOR_RPS;

    // Prod Mimir, 5m rate, 2026-07-06 (issue #132). `shown` is the guard itself:
    // the stat renders iff the inbound rate clears the floor — independent of
    // how large the resulting ratio is, so a genuine severe N+1 on a healthy
    // service still renders (and still hits the 20/50 threshold bands).
    const evidence = [
      { app: 'pdl-api', inbound: 34.6, shown: true }, // 60.8 db/s ÷ 34.6 = 1.76 q/req, genuine
      { app: 'spenn', inbound: 62, shown: true }, // 0.07 db/s ÷ 62 = 0.0011 q/msg, Kafka
      { app: 'severe-n-plus-one', inbound: 1, shown: true }, // 30 db/s ÷ 1 = 30 q/req: modest but real traffic, must stay visible
      { app: 'syfosmregister', inbound: 0.058, shown: false }, // 0.56 db/s ÷ 0.058 = 9.7, inflated
      { app: 'fpinntektsmelding', inbound: 0.004, shown: false }, // 9.1 db/s ÷ 0.004 = 2275, artifact
      { app: 'aareg-mottak-opptjeningsgrunnlag', inbound: 0, shown: false }, // batch job
    ];
    for (const { app, inbound, shown } of evidence) {
      expect({ app, shown: inbound > floor }).toEqual({ app, shown });
    }
  });

  it('shows a Query-rate companion stat (raw db throughput) so no-inbound batch jobs still have a meaningful header', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('Query rate');
    // A bare summed db call rate — always populated for a db-emitting service,
    // independent of any inbound denominator.
    expect(serialized).toMatch(
      /sum\(rate\(traces_spanmetrics_calls_total\{[^}]*SPAN_KIND_CLIENT[^}]*db_system[^}]*\}\[\$__rate_interval\]\)\)/
    );
  });

  it('shows Errors% and P95 companion stats mirroring the RED panels as single values', () => {
    const scene = buildDatabaseScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    // Errors% single value keeps the `or ... * 0` zero-fill so it reads 0%, not empty.
    expect(serialized).toMatch(
      /\* 100 or sum\(rate\(traces_spanmetrics_calls_total\{[^}]*\}\[\$__rate_interval\]\)\) \* 0/
    );
    // P95 single value (no db_system grouping — a single header number).
    expect(serialized).toMatch(
      /histogram_quantile\(0\.95, sum by \(le\) \(rate\(traces_spanmetrics_duration_milliseconds_bucket\{[^}]*\}\[\$__rate_interval\]\)\)\)/
    );
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
