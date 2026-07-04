import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  SceneTimePicker,
  SceneTimeRange,
  SceneRefreshPicker,
  PanelBuilders,
  EmbeddedScene,
  behaviors,
} from '@grafana/scenes';
import { DashboardCursorSync } from '@grafana/schema';
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
   * rows (RED + per-host) so a pool-only service doesn't render three empty
   * panels. Defaults to true. */
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
 * Builds the Database tab's RED time-series panels (Rate / Errors / P95
 * Duration, broken down by db.system) plus a per-host breakdown table.
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
 * per-host, and (zero-filled) error panels all return data for all three.
 *
 * Per-host breakdown relies on the `server_address` label, which spanmetrics
 * pipelines populate from the client span's `server.address` attribute (used
 * elsewhere for dependency host resolution — see servicemap.go). Not every
 * database client library populates this attribute, so the panel may be
 * empty for some services; that's a genuine "no data" rather than a query bug.
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

  const hostQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    queries: [
      {
        refId: 'A',
        instant: true,
        format: 'table',
        expr: `sum by (${otel.labels.dbSystem}, ${otel.labels.serverAddress}) (rate(${callsMetric}{${dbFilter}}[$__rate_interval]))`,
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
    controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
    body: new SceneFlexLayout({
      direction: 'column',
      children: [
        ...(hasDbSpans
          ? [
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
              new SceneFlexItem({
                height: 250,
                body: PanelBuilders.table()
                  .setTitle('Per-host breakdown')
                  .setDescription(
                    'Call rate by db.system and server.address. Empty when the database client does not populate the server.address attribute.'
                  )
                  .setData(hostQuery)
                  .build(),
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
