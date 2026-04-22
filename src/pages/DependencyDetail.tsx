import React, { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, Icon, LoadingPlaceholder, Alert, LinkButton } from '@grafana/ui';
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { css } from '@emotion/css';
import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  SceneTimeRange,
  PanelBuilders,
  EmbeddedScene,
  behaviors,
} from '@grafana/scenes';
import { DashboardCursorSync } from '@grafana/schema';
import {
  getDependencyDetail,
  getServices,
  DependencySummary,
  DependencyDetailResponse,
  DependencyOperation,
  ServiceSummary,
} from '../api/client';
import { formatDuration, formatRate, formatErrorRate } from '../utils/format';
import { useTimeRange } from '../utils/timeRange';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { DepTypeIcon } from '../components/DepTypeIcon';
import { SortHeader, ImpactBar, useTableSort, getTableStyles } from '../components/SortableTable';
import { useFetch } from '../utils/useFetch';
import { usePluginDatasources } from '../utils/datasources';
import { useCapabilities } from '../utils/capabilities';
import { otel } from '../otelconfig';

function DependencyDetail() {
  const { name = '' } = useParams<{ name: string }>();
  const styles = useStyles2(getStyles);
  const appNavigate = useAppNavigate();
  const [searchParams] = useSearchParams();
  const envFilter = sanitizeParam(searchParams.get('environment') ?? '');
  const { fromMs, toMs, from, to } = useTimeRange();
  const ds = usePluginDatasources(envFilter || undefined);
  const { caps } = useCapabilities();
  const { data, loading, error } = useFetch<DependencyDetailResponse>(
    () => getDependencyDetail(name, fromMs, toMs, envFilter || undefined),
    [name, fromMs, toMs, envFilter]
  );

  // Resolve namespaces for upstream services (they're internal and should link to service overview)
  const { data: services } = useFetch<ServiceSummary[]>(() => getServices(fromMs, toMs), [fromMs, toMs]);
  const serviceNsMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const svc of services ?? []) {
      m.set(svc.name, svc.namespace);
    }
    return m;
  }, [services]);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<keyof DependencySummary>('impact');

  const sorted = useMemo(() => {
    if (!data) {
      return [];
    }
    return [...data.upstreams].sort(comparator);
  }, [data, comparator]);

  // Build Scenes RED panels for the dependency.
  // Uses service graph metrics with an OR fallback to spanmetrics, since the
  // dependency may only appear in one source (e.g. external APIs often only
  // exist in spanmetrics via server_address / http_host).
  const redScene = useMemo(() => {
    const sgPrefix = caps?.serviceGraph?.prefix || 'traces_service_graph';
    const callsMetric = caps?.spanMetrics?.callsMetric || 'traces_span_metrics_calls_total';
    const durationBucket = caps?.spanMetrics?.durationMetric || 'traces_span_metrics_duration_milliseconds_bucket';
    const smDurationUnit = caps?.spanMetrics?.durationUnit || 'ms';

    if (!ds.metricsUid || !name) {
      return null;
    }

    const timeRange = new SceneTimeRange({ from, to });
    const safeName = name.replace(/"/g, '\\"');
    const serverFilter = `${otel.labels.server}="${safeName}"`;
    // Spanmetrics fallback: server_address exact OR http_host with optional :443
    const smAddrFilter = `${otel.labels.serverAddress}="${safeName}", ${otel.labels.spanKind}="${otel.spanKinds.client}"`;
    const smHostFilter = `${otel.labels.httpHost}=~"${safeName}(:443)?", ${otel.labels.spanKind}="${otel.spanKinds.client}"`;

    const rateQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      minInterval: '5m',
      queries: [
        {
          refId: 'A',
          expr: `sum(rate(${sgPrefix}_request_total{${serverFilter}}[$__rate_interval])) or sum(rate(${callsMetric}{${smAddrFilter}}[$__rate_interval])) or sum(rate(${callsMetric}{${smHostFilter}}[$__rate_interval]))`,
          legendFormat: 'Request Rate',
        },
      ],
    });

    const errorQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      minInterval: '5m',
      queries: [
        {
          refId: 'A',
          expr: [
            `sum(rate(${sgPrefix}_request_failed_total{${serverFilter}}[$__rate_interval])) / sum(rate(${sgPrefix}_request_total{${serverFilter}}[$__rate_interval])) * 100`,
            `sum(rate(${callsMetric}{${smAddrFilter}, ${otel.labels.statusCode}="${otel.statusCodes.error}"}[$__rate_interval])) / sum(rate(${callsMetric}{${smAddrFilter}}[$__rate_interval])) * 100`,
          ].join(' or '),
          legendFormat: 'Error %',
        },
      ],
    });

    // Service graph duration is always in seconds; spanmetrics may be ms or s.
    const smDurationDiv = smDurationUnit === 'ms' ? ' / 1000' : '';

    const durationQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      minInterval: '5m',
      queries: [
        {
          refId: 'A',
          expr: `histogram_quantile(0.95, sum by (le) (rate(${sgPrefix}_request_server_seconds_bucket{${serverFilter}}[$__rate_interval]))) or histogram_quantile(0.95, sum by (le) (rate(${durationBucket}{${smAddrFilter}}[$__rate_interval])))${smDurationDiv}`,
          legendFormat: 'P95',
        },
        {
          refId: 'B',
          expr: `histogram_quantile(0.50, sum by (le) (rate(${sgPrefix}_request_server_seconds_bucket{${serverFilter}}[$__rate_interval]))) or histogram_quantile(0.50, sum by (le) (rate(${durationBucket}{${smAddrFilter}}[$__rate_interval])))${smDurationDiv}`,
          legendFormat: 'P50',
        },
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      body: new SceneFlexLayout({
        direction: 'row',
        children: [
          new SceneFlexItem({
            height: 200,
            body: PanelBuilders.timeseries().setTitle('Request Rate').setData(rateQuery).setUnit('reqps').build(),
          }),
          new SceneFlexItem({
            height: 200,
            body: PanelBuilders.timeseries().setTitle('Error Rate').setData(errorQuery).setUnit('percent').build(),
          }),
          new SceneFlexItem({
            height: 200,
            body: PanelBuilders.timeseries()
              .setTitle('Duration (P95 / P50)')
              .setData(durationQuery)
              .setUnit('s')
              .build(),
          }),
        ],
      }),
    });
  }, [name, from, to, ds.metricsUid, caps]);

  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        <div className={styles.header}>
          <LinkButton
            variant="secondary"
            size="sm"
            icon="arrow-left"
            fill="text"
            onClick={() => {
              appNavigate('dependencies');
            }}
          >
            Dependencies
          </LinkButton>
        </div>

        {loading && <LoadingPlaceholder text="Loading dependency details..." />}

        {error && (
          <Alert severity="error" title="Error">
            {error}
          </Alert>
        )}

        {!loading && !error && data && (
          <>
            {/* Summary card */}
            <div className={styles.summaryCard}>
              <div className={styles.summaryTitle}>
                <DepTypeIcon type={data.dependency.type} size={28} />
                <h2 className={styles.depName}>{name}</h2>
                <span className={styles.typeBadge}>{data.dependency.type}</span>
              </div>
              <div className={styles.summaryStats}>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Throughput</span>
                  <span className={styles.statValue}>{formatRate(data.dependency.rate)}</span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Error Rate</span>
                  <span className={data.dependency.errorRate > 0 ? styles.statValueError : styles.statValue}>
                    {formatErrorRate(data.dependency.errorRate)}
                  </span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Latency (P95)</span>
                  <span className={styles.statValue}>
                    {formatDuration(data.dependency.p95Duration, data.dependency.durationUnit)}
                  </span>
                </div>
              </div>
            </div>

            {/* RED metric time-series graphs */}
            {redScene && (
              <div className={styles.redPanels}>
                <redScene.Component model={redScene} />
              </div>
            )}

            {/* Upstream services */}
            <h3 className={styles.sectionTitle}>Upstream Services</h3>
            <p className={styles.sectionDesc}>Services that call this dependency, ranked by impact.</p>

            {sorted.length === 0 ? (
              <Alert severity="info" title="No upstream data">
                No upstream services found for this dependency.
              </Alert>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <SortHeader
                      field="name"
                      label="Service"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      field="rate"
                      label="Throughput"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      field="errorRate"
                      label="Error %"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      field="p95Duration"
                      label="Latency (P95)"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      field="impact"
                      label="Impact"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((upstream) => (
                    <tr
                      key={upstream.name}
                      className={styles.clickableRow}
                      onClick={() => {
                        const ns = serviceNsMap.get(upstream.name);
                        if (ns) {
                          appNavigate(`services/${encodeURIComponent(ns)}/${encodeURIComponent(upstream.name)}`);
                        }
                      }}
                    >
                      <td className={styles.linkNameCell} title={upstream.name}>
                        <Icon name="gf-layout-simple" size="sm" />
                        <span style={{ marginLeft: 8 }}>{upstream.name}</span>
                      </td>
                      <td className={styles.numCell}>{formatRate(upstream.rate)}</td>
                      <td className={upstream.errorRate > 0 ? styles.errorCell : styles.numCell}>
                        {formatErrorRate(upstream.errorRate)}
                      </td>
                      <td className={styles.numCell}>{formatDuration(upstream.p95Duration, upstream.durationUnit)}</td>
                      <td className={styles.numCell}>
                        <ImpactBar impact={upstream.impact} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Operations calling this dependency */}
            {data.operations && data.operations.length > 0 && (
              <>
                <h3 className={styles.sectionTitle}>Operations</h3>
                <p className={styles.sectionDesc}>
                  Client-side operations that call this dependency (from spanmetrics <code>peer.service</code>{' '}
                  dimension).
                </p>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Operation</th>
                      <th>Calling Service</th>
                      <th>Throughput</th>
                      <th>Error %</th>
                      <th>Latency (P95)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.operations.map((op: DependencyOperation, idx: number) => (
                      <tr key={`${op.spanName}-${op.callingService}-${idx}`}>
                        <td className={styles.nameCell} title={op.spanName}>
                          {op.spanName}
                        </td>
                        <td title={op.callingService}>{op.callingService}</td>
                        <td className={styles.numCell}>{formatRate(op.rate)}</td>
                        <td className={op.errorRate > 0 ? styles.errorCell : styles.numCell}>
                          {formatErrorRate(op.errorRate)}
                        </td>
                        <td className={styles.numCell}>{formatDuration(op.p95Duration, op.durationUnit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  ...getTableStyles(theme),
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    padding: 0;
  `,
  header: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  summaryCard: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)} ${theme.spacing(3)};
    margin-bottom: ${theme.spacing(3)};
  `,
  redPanels: css`
    margin-bottom: ${theme.spacing(3)};
  `,
  summaryTitle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(2)};
  `,
  depIcon: css`
    font-size: 24px;
  `,
  depName: css`
    margin: 0;
    font-size: ${theme.typography.h2.fontSize};
  `,
  typeBadge: css`
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.canvas};
    border: 1px solid ${theme.colors.border.medium};
  `,
  summaryStats: css`
    display: flex;
    gap: ${theme.spacing(4)};
  `,
  statItem: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  statLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  statValue: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
  `,
  statValueError: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.error.text};
  `,
  sectionTitle: css`
    margin-top: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(0.5)};
    font-size: ${theme.typography.h4.fontSize};
  `,
  sectionDesc: css`
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(2)};
  `,
  linkNameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: ${theme.colors.text.link};
  `,
});

export default DependencyDetail;
