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

/**
 * Minimum inbound (SERVER|CONSUMER) span rate, in calls/s, for the
 * queries-per-request-or-message ratio to be rendered at all — see the
 * `KNOWN LIMITATION` block above `ratioQuery` for the reasoning and the live
 * evidence behind the value. Exported so the tests and the panel's own
 * description text quote the same number as the query does.
 */
export const INBOUND_FLOOR_RPS = 0.1;

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
 * Queries-per-request-or-message ratio (per Database-tab redesign PRD, issue
 * #119): database operations per inbound unit of work. Numerator is the same
 * outbound CLIENT db-span rate the Rate panel sums; denominator is the inbound
 * SERVER *or* CONSUMER span rate for the service — i.e. HTTP/gRPC requests *or*
 * consumed Kafka messages. The original SERVER-only denominator read N/A for
 * the many nais apps that are Kafka-driven rather than HTTP servers (verified
 * 2026-07-06 against prod Mimir: spenn/tbd has an empty SERVER rate but a
 * ~60/s CONSUMER rate and ~0.08/s db calls → a real ~0.0015 queries/message
 * once consumers are counted). Kept on the tab's existing span-metrics source
 * rather than the raw db_client_operation_/http_server_ metric families so the
 * label conventions (service_name/namespace/env) stay consistent with the RED
 * panels. An absolute floor on the denominator (#132, INBOUND_FLOOR_RPS) drops
 * the series unless the inbound rate is above it — covering both services with
 * genuinely no inbound work (pure batch jobs, e.g.
 * aareg-mottak-opptjeningsgrunnlag/arbeidsforhold: no SERVER and no CONSUMER
 * spans, ~9/s db calls) and scheduler-driven ones whose trickle of inbound
 * traffic would otherwise inflate the ratio. A high value flags an N+1 pattern.
 *
 * The top row is a compact stat strip so it stays informative for all three
 * app shapes (HTTP server, Kafka consumer, pure batch): the ratio sits
 * alongside an always-present Query-rate stat plus Errors% and P95 companions.
 * When the ratio has no usable denominator (batch jobs, scheduler-driven apps)
 * it renders an explicit "too little inbound traffic to compare" no-value
 * state instead of a lone bare N/A,
 * and the neighbouring Query-rate stat still shows the raw db throughput — so
 * the header never reads as broken.
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
  // Inbound work: SERVER-kind spans (HTTP + gRPC requests) *or* CONSUMER-kind
  // spans (Kafka messages consumed). Used as the denominator of the
  // queries-per-request-or-message ratio. Broadened from SERVER-only so
  // Kafka-driven apps (the majority of nais workloads) get a real ratio
  // instead of N/A.
  const inboundFilter = `${svcFilter}, ${otel.labels.spanKind}=~"${otel.spanKinds.server}|${otel.spanKinds.consumer}"`;
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

  // Queries-per-request-or-message ratio — the always-on N+1 smell (PRD #119
  // §4.1). db operations ÷ inbound requests-or-messages.
  //
  // The denominator carries an absolute floor (issue #132, option 1): the
  // inbound rate only counts as a usable denominator strictly above
  // INBOUND_FLOOR_RPS calls/s. At or below it the expression is empty and the
  // stat falls back to its no-value state. The floor subsumes the old `> 0`
  // divide-by-zero guard.
  //
  // Why a floor: the denominator only counts inbound SERVER (HTTP/gRPC) and
  // CONSUMER (Kafka) spans. Work kicked off by an in-process scheduler or timer
  // roots at a SPAN_KIND_INTERNAL span, which is in *neither* the numerator nor
  // the denominator. If such an app also serves a trickle of inbound traffic,
  // its db-client rate is divided by that tiny inbound rate and the ratio
  // balloons into a false "severe N+1" — and the `> 0` guard only rejected an
  // *exactly-empty* denominator, so a tiny-but-nonzero one passed straight
  // through. Live evidence (prod Mimir, 5m rate, 2026-07-06) against the
  // current 0.1/s floor — ratios recomputed from the rounded rates shown, so
  // they differ slightly from the unrounded ones quoted in #132:
  //
  //   pdl-api            60.8 db/s ÷ 34.6 inbound/s  = 1.76   → shown (genuine)
  //   spenn              0.07 db/s ÷ 62 inbound/s    = 0.0011 → shown (Kafka)
  //   syfosmregister     0.56 db/s ÷ 0.058 inbound/s = 9.7    → no value
  //   fpinntektsmelding  9.1 db/s ÷ 0.004 inbound/s  = 2275   → no value
  //
  // The rejected alternative was a relative guard (`inbound > db_rate / N`,
  // #132 option 2): it is algebraically a ceiling on the displayed ratio, so it
  // hides genuine severe N+1s at healthy inbound rates and leaves the 20/50
  // threshold bands below unreachable — exactly the signal this stat exists for.
  //
  // KNOWN LIMITATION — the floor removes the two known-bad samples, not the
  // class of error behind them:
  //  - A scheduler-driven app that clears the floor still lies: 0.2 inbound/s
  //    against 20 db/s renders a red 100 that is a scheduling artifact, not an
  //    N+1. Fixing the class means counting SPAN_KIND_INTERNAL root spans in the
  //    denominator (the work the ratio actually misses) or #132 option 3
  //    (cap-and-annotate). Worth doing when a false red is actually reported.
  //  - syfosmregister sits only ~1.7x below the floor, so one traffic uptick
  //    puts its inflated ratio back on screen.
  //  - The stat reduces with Grafana's default lastNotNull, so a service
  //    oscillating around the floor shows the last ratio that *did* clear it
  //    (i.e. a stale value), not the no-value state — that state only appears
  //    when the whole window is below the floor.
  //  - The floor is absolute, so an app whose *whole* traffic profile is below
  //    it (a genuinely low-volume HTTP service, not just a scheduler-driven one)
  //    loses the ratio too.
  // In every one of those cases the always-present Query-rate companion stat
  // below is the honest signal.
  const ratioQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr:
          `sum(rate(${callsMetric}{${dbFilter}}[$__rate_interval])) ` +
          `/ (sum(rate(${callsMetric}{${inboundFilter}}[$__rate_interval])) > ${INBOUND_FLOOR_RPS})`,
      },
    ],
  });

  // Companion header stats (always meaningful, even when the ratio is empty).
  // Query rate: raw outbound db throughput — present for every db-emitting app,
  // so batch jobs with no inbound work still get an informative header number.
  const queryRateStatQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `sum(rate(${callsMetric}{${dbFilter}}[$__rate_interval]))`,
      },
    ],
  });

  // Errors %: single-value mirror of the RED error panel. Same `or ... * 0`
  // zero-fill so it reads 0% rather than an empty "No data" when there are no
  // error samples in-window.
  const errorRateStatQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr:
          `sum(rate(${callsMetric}{${dbFilter}, ${otel.labels.statusCode}="${otel.statusCodes.error}"}[$__rate_interval])) ` +
          `/ sum(rate(${callsMetric}{${dbFilter}}[$__rate_interval])) * 100 ` +
          `or sum(rate(${callsMetric}{${dbFilter}}[$__rate_interval])) * 0`,
      },
    ],
  });

  // P95: single-value mirror of the RED duration panel, in the tab's duration unit.
  const p95StatQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `histogram_quantile(0.95, sum by (${otel.labels.le}) (rate(${durationBucket}{${dbFilter}}[$__rate_interval])))`,
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
                body: new SceneFlexLayout({
                  direction: 'row',
                  children: [
                    new SceneFlexItem({
                      body: PanelBuilders.stat()
                        .setTitle('Queries per request or message')
                        .setDescription(
                          'Database operations per inbound unit of work — outbound db CLIENT spans ÷ inbound ' +
                            'SERVER (HTTP/gRPC request) or CONSUMER (Kafka message) spans. A high value is the ' +
                            'classic N+1 smell — many small queries where a single JOIN or batch-fetch would do; ' +
                            'use "View DB traces" above to inspect the offending requests. Shows "too little ' +
                            `inbound traffic to compare" at or below ${INBOUND_FLOOR_RPS} inbound requests or ` +
                            'messages per second — a denominator that small turns scheduler- or timer-driven db ' +
                            'work into a false N+1 (and covers batch jobs with no inbound spans at all) — read ' +
                            'the Query rate stat beside it for their raw throughput.'
                        )
                        .setData(ratioQuery)
                        .setUnit('none')
                        .setDecimals(1)
                        .setNoValue('too little inbound traffic to compare')
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
                      body: PanelBuilders.stat()
                        .setTitle('Query rate')
                        .setDescription(
                          'Total outbound database call rate (all db systems). Always populated for a ' +
                            'db-emitting service, so the header stays meaningful even for batch jobs where the ' +
                            'queries-per-request ratio is undefined.'
                        )
                        .setData(queryRateStatQuery)
                        .setUnit('reqps')
                        .setDecimals(2)
                        .setNoValue('N/A')
                        .build(),
                    }),
                    new SceneFlexItem({
                      body: PanelBuilders.stat()
                        .setTitle('Errors')
                        .setDescription('Percentage of database calls resulting in an error status (all db systems).')
                        .setData(errorRateStatQuery)
                        .setUnit('percent')
                        .setDecimals(2)
                        .setNoValue('N/A')
                        .setThresholds({
                          mode: ThresholdsMode.Absolute,
                          steps: [
                            { value: null as unknown as number, color: 'green' },
                            { value: 1, color: 'orange' },
                            { value: 5, color: 'red' },
                          ],
                        })
                        .build(),
                    }),
                    new SceneFlexItem({
                      body: PanelBuilders.stat()
                        .setTitle('Duration (P95)')
                        .setDescription('P95 database call latency across all db systems.')
                        .setData(p95StatQuery)
                        .setUnit(panelDurationUnit)
                        .setNoValue('N/A')
                        .build(),
                    }),
                  ],
                }),
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
