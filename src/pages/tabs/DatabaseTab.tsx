import React, { useMemo } from 'react';
import { useStyles2, LinkButton, Badge } from '@grafana/ui';
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
  const hasDbPool = !!dbPool && dbPool.pools.length > 0;
  const hasDbData = dbOperations.length > 0 || hasDbPool;

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
      hasDbPool,
    ]
  );
  const sceneKey = `${ds.metricsUid}|${callsMetric}|${durationBucket}|${environment ?? ''}|${hasDbPool}`;

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

        {scene && (
          <div className={styles.sceneWrapper}>
            <scene.Component model={scene} key={sceneKey} />
          </div>
        )}

        {dbOperations.length > 0 && (
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

        {dbPool && dbPool.pools.length > 0 && (
          <div className={styles.section}>
            <ConnectionPoolSection dbPool={dbPool} />
          </div>
        )}
      </div>
    </DataState>
  );
}

function EmptyStateBody() {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.emptyBody}>
      <p>
        No outbound database calls or connection-pool metrics were found for this service in the selected time range.
      </p>
      <p>This tab needs one of:</p>
      <ul>
        <li>
          Outbound (CLIENT) spans carrying OpenTelemetry database semantic-convention attributes (<code>db.system</code>
          , <code>db.operation</code>) — auto-instrumentation libraries (JDBC, node-postgres, Go database/sql wrappers,
          etc.) set these automatically.
        </li>
        <li>
          Connection-pool metrics (e.g. HikariCP via Micrometer, or an equivalent pool exporter) scraped as Prometheus
          metrics.
        </li>
      </ul>
    </div>
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
  sceneWrapper: css`
    min-height: 490px;
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
});
