import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  SceneTimeRange,
  PanelBuilders,
  EmbeddedScene,
  behaviors,
} from '@grafana/scenes';
import { DashboardCursorSync, ThresholdsMode } from '@grafana/schema';
import { otel } from '../../../otelconfig';
import { sanitizeLabelValue, escapeQueryString } from '../../../utils/sanitize';
import { buildExploreUrl } from '../../../utils/explore';

export interface BuildDatabaseSceneParams {
  service: string;
  namespace: string;
  envFilter: string;
  from: string;
  to: string;
  metricsUid: string;
  tracesUid: string;
  callsMetric: string;
  durationBucket: string;
  durationUnit: string;
  serviceNameLabel?: string;
  serviceNamespaceLabel?: string;
  deploymentEnvLabel?: string;
  /** Whether the backend's /endpoints response has database operations for this
   * service (EndpointGroups.database non-empty). Gates the span-metrics-backed
   * overview rows (queries-per-request ratio + RED) so a pool-only service
   * doesn't render empty panels. Defaults to true. */
  hasDbSpans?: boolean;
  /** Whether RuntimeResponse.dbPool was detected for this service (RuntimeTab's
   * DBPoolRuntime). Gates the connection-acquisition-time panels — see notes
   * below on why they're queried directly here rather than through that API. */
  hasDbPool?: boolean;
}

/**
 * Builds a TraceQL Explore URL scoped to this service's outbound database
 * spans (CLIENT-kind spans carrying a non-empty db.system attribute).
 */
export function buildDbTracesExploreUrl(tracesUid: string, service: string, namespace?: string): string {
  let query = `{${otel.traceQL.serviceName}="${escapeQueryString(service)}" && kind=client && span.db.system!=""`;
  if (namespace) {
    query += ` && ${otel.traceQL.serviceNamespace}="${escapeQueryString(namespace)}"`;
  }
  query += '}';
  return buildExploreUrl({
    datasourceUid: tracesUid,
    queries: [{ refId: 'A', queryType: 'traceql', query }],
  });
}

/**
 * Builds the Database tab's overview panels — a queries-per-request ratio
 * (the always-on N+1 smell) plus the RED time-series (Rate / Errors / P95
 * Duration, broken down by db.system).
 *
 * Data source: the same auto-detected span-metrics calls/duration metrics
 * used everywhere else in the plugin (see utils/capabilities.ts), filtered
 * to CLIENT-kind spans carrying a non-empty db_system label. This mirrors
 * how ServerTab's "Database Operations" section and DependencyDetail's
 * per-dependency RED panels already query the same underlying metrics —
 * no new backend endpoint is required.
 *
 * Every expression here was executed against production Mimir (2026-07-04,
 * via POST /api/ds/query) for three reference services covering the three
 * major db systems: pdl/pdl-api (mongodb, ~112 calls/s), pensjon-person/
 * pensjon-representasjon (oracle, ~2 calls/s), teamforeldrepenger/
 * fpinntektsmelding (postgresql, ~8.6 calls/s). Rate, duration P95,
 * and (zero-filled) error panels all return data for all three.
 *
 * Queries-per-request ratio (per Database-tab redesign PRD, issue #119):
 * database operations per inbound request. Numerator is the same outbound
 * CLIENT db-span rate the Rate panel sums; denominator is the inbound
 * SERVER-span rate for the service (covers HTTP *and* gRPC — a superset of
 * the PRD's http_server_request_count). Kept on the tab's existing
 * span-metrics source rather than the raw db_client_operation_/http_server_
 * metric families so the label conventions (service_name/namespace/env) stay
 * consistent with the RED panels. A `> 0` guard on the denominator drops the
 * series when the service has no inbound requests (batch jobs, pure Kafka
 * consumers) or its request rate is zero in-window, so the stat reads N/A
 * instead of dividing by zero. A high value flags an N+1 pattern.
 *
 * (The per-host `server_address` breakdown was removed in the #119 redesign:
 * "which database host served this" is a DBA/infra concern, not something an
 * application developer acts on in their own code or config.)
 *
 * Connection acquisition time (`hasDbPool` gated): verified directly against
 * production Mimir (2026-07-04) that `db_client_connections_wait_time_milliseconds_bucket`
 * and `..._create_time_milliseconds_bucket` exist with live samples, labeled
 * with the same `app`/`namespace` runtime-metric convention as RuntimeTab's
 * other cards (otel.runtime.appLabel/namespaceLabel), grouped by a `pool_name`
 * label. Note this is a *different* label than the backend's
 * `DBPoolMetrics.PoolLabel = "pool"` (pkg/plugin/otelconfig), which appears to
 * target the legacy Micrometer HikariCP gauges — so RuntimeTab's DBPoolRuntime
 * response may under-report pools that only emit the newer OTel db.client.*
 * metrics. That's a pre-existing backend gap (pkg/plugin/ is out of scope
 * here); this scene queries the histograms directly so the tab isn't blocked
 * on a backend change.
 *
 * Deferred (still not implemented — see issue #14 gap notes):
 *  - Per-query breakdown from `db.statement` (query fingerprinting) — neither
 *    spanmetrics nor the db.client.* metrics carry statement text; would
 *    require a new Tempo/TraceQL trace-attribute aggregation.
 */
export function buildDatabaseScene(params: BuildDatabaseSceneParams): EmbeddedScene | null {
  const {
    service,
    namespace,
    envFilter,
    from,
    to,
    metricsUid,
    tracesUid,
    callsMetric,
    durationBucket,
    durationUnit,
    serviceNameLabel = otel.labels.serviceName,
    serviceNamespaceLabel = otel.labels.serviceNamespace,
    deploymentEnvLabel = otel.labels.deploymentEnv,
    hasDbSpans = true,
    hasDbPool = false,
  } = params;

  if (!metricsUid || !callsMetric || !durationBucket) {
    return null;
  }

  let svcFilter = `${serviceNameLabel}="${sanitizeLabelValue(service)}"`;
  if (namespace) {
    svcFilter += `, ${serviceNamespaceLabel}="${sanitizeLabelValue(namespace)}"`;
  }
  if (envFilter) {
    svcFilter += `, ${deploymentEnvLabel}="${sanitizeLabelValue(envFilter)}"`;
  }
  // Outbound (CLIENT) spans with a populated db.system attribute — the same
  // criteria the backend uses to classify "database" endpoints (see
  // EndpointGroups.database in api/client.ts).
  const dbFilter = `${svcFilter}, ${otel.labels.spanKind}="${otel.spanKinds.client}", ${otel.labels.dbSystem}=~".+"`;
  // Inbound requests: SERVER-kind spans for this service (HTTP + gRPC). Used as
  // the denominator of the queries-per-request ratio.
  const serverFilter = `${svcFilter}, ${otel.labels.spanKind}="${otel.spanKinds.server}"`;
  const panelDurationUnit = durationUnit === 's' ? 's' : 'ms';

  const rateQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `sum by (${otel.labels.dbSystem}) (rate(${callsMetric}{${dbFilter}}[$__rate_interval]))`,
        legendFormat: `{{${otel.labels.dbSystem}}}`,
        exemplar: true,
      },
    ],
  });

  const errorQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        // Zero-fill: services with no error samples in the window would
        // otherwise produce an empty result set and the panel would render
        // "No data" instead of a calm 0% line. Verified against production
        // (pdl-api, pensjon-representasjon, fpinntektsmelding — all with real
        // db traffic and zero errors): the plain ratio was empty for all
        // three, the `or ... * 0` form returns 0 per db_system.
        expr:
          `sum by (${otel.labels.dbSystem}) (rate(${callsMetric}{${dbFilter}, ${otel.labels.statusCode}="${otel.statusCodes.error}"}[$__rate_interval])) ` +
          `/ sum by (${otel.labels.dbSystem}) (rate(${callsMetric}{${dbFilter}}[$__rate_interval])) * 100 ` +
          `or sum by (${otel.labels.dbSystem}) (rate(${callsMetric}{${dbFilter}}[$__rate_interval])) * 0`,
        legendFormat: `{{${otel.labels.dbSystem}}}`,
        exemplar: true,
      },
    ],
  });

  const durationQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `histogram_quantile(0.95, sum by (${otel.labels.le}, ${otel.labels.dbSystem}) (rate(${durationBucket}{${dbFilter}}[$__rate_interval])))`,
        legendFormat: `{{${otel.labels.dbSystem}}} P95`,
      },
    ],
  });

  // Queries-per-request ratio — the always-on N+1 smell (PRD #119 §4.1).
  // db operations ÷ inbound requests. The `> 0` guard on the denominator makes
  // the expression empty (→ stat reads N/A) for services with no inbound
  // SERVER spans, rather than producing +Inf from a divide-by-zero.
  const ratioQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr:
          `sum(rate(${callsMetric}{${dbFilter}}[$__rate_interval])) ` +
          `/ (sum(rate(${callsMetric}{${serverFilter}}[$__rate_interval])) > 0)`,
      },
    ],
  });

  // Connection-pool metrics use the runtime app/namespace label convention
  // (mirrors the backend's Config.RuntimeFilter), not service_name/service_namespace.
  let runtimeFilter = `${otel.runtime.appLabel}="${sanitizeLabelValue(service)}"`;
  if (namespace) {
    runtimeFilter += `, ${otel.runtime.namespaceLabel}="${sanitizeLabelValue(namespace)}"`;
  }
  if (envFilter) {
    runtimeFilter += `, ${deploymentEnvLabel}="${sanitizeLabelValue(envFilter)}"`;
  }
  const poolLabel = otel.runtime.dbPool.poolLabel;

  const waitTimeQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `histogram_quantile(0.95, sum by (${otel.labels.le}, ${poolLabel}) (rate(${otel.runtime.dbPool.waitTimeBucket}{${runtimeFilter}}[$__rate_interval])))`,
        legendFormat: `{{${poolLabel}}}`,
      },
    ],
  });

  const createTimeQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `histogram_quantile(0.95, sum by (${otel.labels.le}, ${poolLabel}) (rate(${otel.runtime.dbPool.createTimeBucket}{${runtimeFilter}}[$__rate_interval])))`,
        legendFormat: `{{${poolLabel}}}`,
      },
    ],
  });

  const exemplarOverride = (b: any) =>
    tracesUid
      ? b.matchFieldsWithName('traceID').overrideLinks([
          {
            title: 'View trace',
            url: '',
            internal: {
              query: { query: '${__value.raw}', queryType: 'traceql' },
              datasourceUid: tracesUid,
              datasourceName: '',
            },
          },
        ])
      : b;

  return new EmbeddedScene({
    $timeRange: new SceneTimeRange({ from, to }),
    $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
    // Time controls live in the global page header.
    controls: [],
    body: new SceneFlexLayout({
      direction: 'column',
      children: [
        ...(hasDbSpans
          ? [
              new SceneFlexItem({
                height: 120,
                width: 300,
                body: PanelBuilders.stat()
                  .setTitle('Queries per request')
                  .setDescription(
                    'Database operations per inbound request (outbound db CLIENT spans ÷ inbound SERVER spans). ' +
                      'A high value is the classic N+1 smell — many small queries where a single JOIN or batch-fetch ' +
                      'would do; use "View DB traces" above to inspect the offending requests. Reads N/A for services ' +
                      'with no inbound requests (e.g. batch jobs or pure Kafka consumers).'
                  )
                  .setData(ratioQuery)
                  .setUnit('none')
                  .setDecimals(1)
                  .setNoValue('N/A')
                  .setThresholds({
                    mode: ThresholdsMode.Absolute,
                    steps: [
                      { value: null as unknown as number, color: 'green' },
                      { value: 20, color: 'orange' },
                      { value: 50, color: 'red' },
                    ],
                  })
                  .build(),
              }),
              new SceneFlexItem({
                body: new SceneFlexLayout({
                  direction: 'row',
                  children: [
                    new SceneFlexItem({
                      height: 220,
                      body: PanelBuilders.timeseries()
                        .setTitle('Rate')
                        .setDescription('Database call rate per second, by db.system')
                        .setData(rateQuery)
                        .setUnit('reqps')
                        .setOverrides(exemplarOverride)
                        .build(),
                    }),
                    new SceneFlexItem({
                      height: 220,
                      body: PanelBuilders.timeseries()
                        .setTitle('Errors')
                        .setDescription('Percentage of database calls resulting in an error status, by db.system')
                        .setData(errorQuery)
                        .setUnit('percent')
                        .setOverrides(exemplarOverride)
                        .build(),
                    }),
                    new SceneFlexItem({
                      height: 220,
                      body: PanelBuilders.timeseries()
                        .setTitle('Duration (P95)')
                        .setDescription('P95 database call latency, by db.system')
                        .setData(durationQuery)
                        .setUnit(panelDurationUnit)
                        .build(),
                    }),
                  ],
                }),
              }),
            ]
          : []),
        ...(hasDbPool
          ? [
              new SceneFlexItem({
                body: new SceneFlexLayout({
                  direction: 'row',
                  children: [
                    new SceneFlexItem({
                      height: 200,
                      body: PanelBuilders.timeseries()
                        .setTitle('Connection Acquisition — Wait Time (P95)')
                        .setDescription(
                          'Time spent waiting for a connection to become available, per pool (db_client_connections_wait_time_milliseconds).'
                        )
                        .setData(waitTimeQuery)
                        .setUnit('ms')
                        .build(),
                    }),
                    new SceneFlexItem({
                      height: 200,
                      body: PanelBuilders.timeseries()
                        .setTitle('Connection Acquisition — Create Time (P95)')
                        .setDescription(
                          'Time spent establishing a new physical connection, per pool (db_client_connections_create_time_milliseconds).'
                        )
                        .setData(createTimeQuery)
                        .setUnit('ms')
                        .build(),
                    }),
                  ],
                }),
              }),
            ]
          : []),
      ],
    }),
  });
}
