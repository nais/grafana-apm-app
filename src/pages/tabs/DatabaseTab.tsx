import React, { useMemo } from 'react';
import { useStyles2, LinkButton, Badge, Alert, TextLink } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getEndpoints, getRuntimeMetrics, EndpointGroups, RuntimeResponse } from '../../api/client';
import { useFetch } from '../../utils/useFetch';
import { usePluginDatasources, usePluginLabelOverrides } from '../../utils/datasources';
import { useCapabilities, getMetricNames } from '../../utils/capabilities';
import { DataState } from '../../components/DataState';
import { DepTypeIcon, formatDepType } from '../../components/DepTypeIcon';
import { otel } from '../../otelconfig';
import { buildDatabaseScene, buildDbTracesExploreUrl } from './database/scene';
import { apmDocs } from '../../utils/docsLinks';
import { useSceneTimeSync } from '../../utils/useSceneTimeSync';
import { QueryOperationsTable } from './database/QueryOperationsTable';
import { ConnectionPoolSection } from './database/ConnectionPoolSection';

interface DatabaseTabProps {
  service: string;
  namespace: string;
  environment?: string;
  fromMs: number;
  toMs: number;
  from: string;
  to: string;
  onViewTraces?: (spanName: string, status?: string, spanKind?: string) => void;
}

/**
 * Database tab (issue #14) — a unified, per-service view of database
 * performance: which db systems the service talks to, RED metrics and
 * per-operation analytics from span metrics, connection-pool health from
 * runtime instrumentation, and connection-acquisition timing.
 *
 * Verified directly against production Mimir/Tempo (2026-07-04, via the local
 * Grafana instance proxying nav.cloud.nais.io datasources) rather than built
 * from the PRD's aspirational metric list in isolation:
 *  - `traces_spanmetrics_calls_total{db_system!=""}` carries real db_system,
 *    db_operation, server_address, span_kind=SPAN_KIND_CLIENT samples for
 *    postgresql/oracle/mongodb/redis/db2/h2/opensearch — confirming
 *    ServerTab's "Database Operations" data (endpoints.database) and the
 *    RED-panel query shape below both hold up.
 *  - `db_client_connections_wait_time_milliseconds_bucket` /
 *    `..._create_time_milliseconds_bucket` (the PRD's "connection acquisition
 *    time distribution") DO exist with live samples — see hasDbPool wiring
 *    below and the detailed note in ./database/scene.ts.
 *  - `db.statement` / query-fingerprinting is NOT available via any metric
 *    (spanmetrics nor db.client.*) — still deferred, drill down via "View DB
 *    traces" instead.
 *
 * Reference services (every section exercised live via POST /api/ds/query and
 * the plugin's own /endpoints + /runtime resources):
 *  - pdl/pdl-api (mongodb): spans + 19 operations, NO pool metrics → variant 2.
 *  - pensjon-person/pensjon-representasjon (oracle): spans + 2 operations;
 *    Oracle UCP emits db_client_connections_max gauges but no HikariCP gauges
 *    and no wait/create histograms, so runtime.dbPool is null → variant 2.
 *  - teamforeldrepenger/fpinntektsmelding (postgresql): spans + HikariCP pool
 *    + wait/create histograms → all sections render.
 */
export function DatabaseTab({
  service,
  namespace,
  environment,
  fromMs,
  toMs,
  from,
  to,
  onViewTraces,
}: DatabaseTabProps) {
  const styles = useStyles2(getStyles);
  const ds = usePluginDatasources(environment || undefined);
  const labelOverrides = usePluginLabelOverrides();
  const { caps } = useCapabilities();
  const metrics = getMetricNames(caps);
  const callsMetric = caps ? metrics.callsMetric : '';
  const durationBucket = caps ? metrics.durationBucket : '';
  const durationUnit = metrics.durationUnit;

  const {
    data: endpointData,
    loading: endpointsLoading,
    error: endpointsError,
  } = useFetch<EndpointGroups>(
    () => getEndpoints(namespace, service, fromMs, toMs, environment),
    [namespace, service, fromMs, toMs, environment]
  );

  const { data: runtimeData, loading: runtimeLoading } = useFetch<RuntimeResponse>(
    () => getRuntimeMetrics(namespace, service, fromMs, toMs, environment),
    [namespace, service, fromMs, toMs, environment]
  );

  const dbOperations = useMemo(() => endpointData?.database ?? [], [endpointData]);
  const dbPool = runtimeData?.dbPool;
  const dbSystems = useMemo(() => {
    const seen = new Set<string>();
    for (const op of dbOperations) {
      if (op.dbSystem) {
        seen.add(op.dbSystem);
      }
    }
    return [...seen].sort();
  }, [dbOperations]);

  const loading = endpointsLoading || runtimeLoading;
  const hasDbSpans = dbOperations.length > 0;
  const hasDbPool = !!dbPool && dbPool.pools.length > 0;
  const hasDbData = hasDbSpans || hasDbPool;

  const scene = useMemo(
    () =>
      buildDatabaseScene({
        service,
        namespace,
        envFilter: environment ?? '',
        from,
        to,
        metricsUid: ds.metricsUid,
        tracesUid: ds.tracesUid,
        callsMetric,
        durationBucket,
        durationUnit,
        serviceNameLabel: labelOverrides.serviceNameLabel,
        serviceNamespaceLabel: labelOverrides.serviceNamespaceLabel,
        deploymentEnvLabel: labelOverrides.deploymentEnvLabel,
        hasDbSpans,
        hasDbPool,
      }),
    [
      service,
      namespace,
      environment,
      from,
      to,
      ds.metricsUid,
      ds.tracesUid,
      callsMetric,
      durationBucket,
      durationUnit,
      labelOverrides.serviceNameLabel,
      labelOverrides.serviceNamespaceLabel,
      labelOverrides.deploymentEnvLabel,
      hasDbSpans,
      hasDbPool,
    ]
  );
  // Follow header refreshes of relative ranges without rebuilding the scene.
  useSceneTimeSync(scene, fromMs, toMs);
  const sceneKey = `${ds.metricsUid}|${callsMetric}|${durationBucket}|${environment ?? ''}|${hasDbSpans}|${hasDbPool}`;
  // Queries-per-request stat (120) + RED row (220) ≈ 360px; acquisition row ≈ 210px.
  const sceneMinHeight = (hasDbSpans ? 360 : 0) + (hasDbPool ? 210 : 0);

  const onViewDbTraces = onViewTraces
    ? (spanName: string, status?: string) => onViewTraces(spanName, status, otel.spanKinds.client)
    : undefined;

  return (
    <DataState
      loading={loading}
      error={endpointsError ?? null}
      empty={!loading && !endpointsError && !hasDbData}
      loadingText="Checking for database instrumentation..."
      emptyTitle="No database activity detected"
      emptyMessage={<EmptyStateBody />}
    >
      <div className={styles.container}>
        <div className={styles.header}>
          {dbSystems.map((sys) => (
            <span key={sys} className={styles.systemBadge}>
              <DepTypeIcon type={sys} size={20} />
              <span>{formatDepType(sys)}</span>
            </span>
          ))}
          {dbPool && dbPool.pools.length > 0 && (
            <Badge
              text={`${dbPool.pools.length} connection pool${dbPool.pools.length !== 1 ? 's' : ''}`}
              color="orange"
            />
          )}
          {ds.tracesUid && (caps?.tempo?.available ?? true) && (
            <LinkButton
              variant="secondary"
              size="sm"
              icon="compass"
              href={buildDbTracesExploreUrl(ds.tracesUid, service, namespace)}
              className={styles.exploreLink}
            >
              View DB traces
            </LinkButton>
          )}
        </div>

        {hasDbPool && !hasDbSpans && <MissingSpansNote />}

        {scene && (
          <div style={{ minHeight: sceneMinHeight }}>
            <scene.Component model={scene} key={sceneKey} />
          </div>
        )}

        {hasDbSpans && (
          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>Query Operations</h4>
            <p className={styles.sectionSubtitle}>
              Rate, error rate, and latency percentiles per database operation for the selected time range. Query text (
              <code>db.statement</code>) is not aggregated here — use &quot;View DB traces&quot; to inspect individual
              queries.
            </p>
            <QueryOperationsTable
              operations={dbOperations}
              durationUnit={endpointData?.durationUnit ?? 'ms'}
              onViewTraces={onViewDbTraces}
            />
          </div>
        )}

        {hasDbPool && dbPool && (
          <div className={styles.section}>
            <ConnectionPoolSection dbPool={dbPool} />
          </div>
        )}

        {hasDbSpans && !hasDbPool && <MissingPoolMetricsNote />}
      </div>
    </DataState>
  );
}

// ---------------------------------------------------------------------------
// Requirements messaging (interim documentation until team docs exist).
//
// Three variants, derived from what the panels actually query. The data to
// pick the right one is already fetched (endpoints.database + runtime.dbPool),
// so each variant only lists what is actually missing:
//   1. Nothing detected      → full checklist (EmptyStateBody)
//   2. Spans, no pool metrics → pool-specific note (MissingPoolMetricsNote)
//      — e.g. pdl-api (MongoDB driver pools not instrumented) or
//        pensjon-representasjon (Oracle UCP: db_client_connections_max gauges
//        exist but no HikariCP gauges and no wait/create-time histograms, so
//        the backend's pool detection reports nothing).
//   3. Pool metrics, no spans → span-specific note (MissingSpansNote)
// ---------------------------------------------------------------------------

/**
 * Full checklist shown when neither database spans nor pool metrics were
 * found. Each item corresponds 1:1 to what this tab queries; verified against
 * production 2026-07-04 (pdl-api/mongodb, pensjon-representasjon/oracle,
 * fpinntektsmelding/postgresql).
 */
function EmptyStateBody() {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.emptyBody}>
      <p>
        No outbound database spans and no connection-pool metrics were found for this service in the selected time
        range. If the app does talk to a database, check the following — each item maps directly to what this tab reads:
      </p>
      <ol className={styles.checklist}>
        <li>
          <strong>Database client spans.</strong> The app must export OpenTelemetry CLIENT-kind spans for its database
          calls, carrying the <code>db.system</code> attribute (and ideally <code>db.operation</code>).
          Auto-instrumentation produces these without code changes: the OTel Java agent (JDBC, MongoDB driver,
          Lettuce/Redis), OTel Node.js instrumentations (<code>pg</code>, <code>mysql2</code>, <code>mongodb</code>,{' '}
          <code>ioredis</code>), and equivalents for Go and Python.
        </li>
        <li>
          <strong>Span-metrics aggregation.</strong> Those spans must be aggregated into{' '}
          <code>traces_spanmetrics_*</code> metrics with <code>db_system</code> as a dimension. This is platform-side
          (Tempo metrics-generator) and is usually already in place on nais — if the Traces tab shows database spans but
          this tab stays empty, that pipeline is the place to look.
        </li>
        <li>
          <strong>Connection-pool metrics (only for the pool panels).</strong> Pool health and
          connection-acquisition-time charts additionally need <code>db.client.connections.*</code> metrics (
          <code>db_client_connections_*</code> in Prometheus). The OTel Java agent emits these out of the box for
          JDBC/HikariCP pools. Driver-managed pools (e.g. the MongoDB Java driver) and Oracle UCP are not surfaced here
          today.
        </li>
      </ol>
      <p className={styles.docsLink}>
        <TextLink href={apmDocs.databaseQueries()} external variant="bodySmall">
          Instrument database queries with Nais APM
        </TextLink>
      </p>
    </div>
  );
}

/**
 * Shown when database spans exist but no connection-pool metrics — the query
 * sections render, so only the pool-specific requirement is listed.
 */
function MissingPoolMetricsNote() {
  const styles = useStyles2(getStyles);
  return (
    <Alert severity="info" title="Connection-pool metrics not detected">
      <div className={styles.emptyBody}>
        <p>
          Query analytics above come from this service&apos;s database spans. Pool health and
          connection-acquisition-time panels additionally need <code>db.client.connections.*</code> metrics (
          <code>db_client_connections_*</code> in Prometheus). The OTel Java agent emits these out of the box for
          JDBC/HikariCP pools. Driver-managed pools (e.g. the MongoDB Java driver) and Oracle UCP are not surfaced here
          today.
        </p>
        <p className={styles.docsLink}>
          <TextLink href={apmDocs.databaseQueries()} external variant="bodySmall">
            Instrument database queries with Nais APM
          </TextLink>
        </p>
      </div>
    </Alert>
  );
}

/**
 * Shown when connection-pool metrics exist but no database spans — the pool
 * sections render, so only the span-side requirements are listed.
 */
function MissingSpansNote() {
  const styles = useStyles2(getStyles);
  return (
    <Alert severity="info" title="No database spans detected">
      <div className={styles.emptyBody}>
        <p>
          Connection-pool metrics are present, but query analytics (rate, errors, latency per operation) need
          OpenTelemetry CLIENT-kind spans with a <code>db.system</code> attribute, aggregated through the span-metrics
          pipeline (<code>traces_spanmetrics_*</code> with a <code>db_system</code> dimension). Auto-instrumentation
          (OTel Java agent, Node.js <code>pg</code>/<code>mongodb</code> instrumentations) produces these spans without
          code changes; the span-metrics aggregation is platform-side and usually already in place on nais.
        </p>
        <p className={styles.docsLink}>
          <TextLink href={apmDocs.databaseQueries()} external variant="bodySmall">
            Instrument database queries with Nais APM
          </TextLink>
        </p>
      </div>
    </Alert>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(3)};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    flex-wrap: wrap;
  `,
  systemBadge: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    padding: 2px ${theme.spacing(1)} 2px 2px;
    border-radius: 999px;
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  exploreLink: css`
    margin-left: auto;
  `,
  section: css`
    display: flex;
    flex-direction: column;
  `,
  sectionTitle: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin: 0 0 ${theme.spacing(0.5)} 0;
    color: ${theme.colors.text.primary};
  `,
  sectionSubtitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin: 0 0 ${theme.spacing(1)} 0;
  `,
  emptyBody: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    code {
      font-family: ${theme.typography.fontFamilyMonospace};
    }
  `,
  checklist: css`
    margin: 0;
    padding-left: ${theme.spacing(2.5)};
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  docsLink: css`
    margin: 0;
  `,
});
