import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, Tab, TabsBar, Icon, LinkButton, Select, LoadingPlaceholder, Alert } from '@grafana/ui';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { css } from '@emotion/css';
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
import { buildTempoExploreUrl, buildLokiExploreUrl, buildMimirExploreUrl } from '../utils/explore';
import { getOperations, getServices, OperationSummary } from '../api/client';
import { formatDuration } from '../utils/format';
import { usePluginDatasources } from '../utils/datasources';
import { useTimeRange } from '../utils/timeRange';
import { useCapabilities, getMetricNames } from '../utils/capabilities';
import { useAppNavigate } from '../utils/navigation';
import { TracesTab } from './tabs/TracesTab';
import { LogsTab } from './tabs/LogsTab';
import { ServiceMapTab } from './tabs/ServiceMapTab';
import { DependenciesTab } from './tabs/DependenciesTab';

type TabId = 'overview' | 'dependencies' | 'traces' | 'logs' | 'service-map';

const PERCENTILE_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'P50', value: '0.50' },
  { label: 'P90', value: '0.90' },
  { label: 'P95', value: '0.95' },
  { label: 'P99', value: '0.99' },
];

const SDK_BADGES: Record<string, { label: string; bg: string }> = {
  java: { label: 'JAVA', bg: '#E76F00' },
  go: { label: 'GO', bg: '#00ADD8' },
  dotnet: { label: '.NET', bg: '#512BD4' },
  python: { label: 'PY', bg: '#3776AB' },
  nodejs: { label: 'JS', bg: '#68A063' },
  ruby: { label: 'RUBY', bg: '#CC342D' },
  rust: { label: 'RUST', bg: '#DEA584' },
};

function ServiceOverview() {
  const { namespace = '', service = '' } = useParams<{ namespace: string; service: string }>();
  const appNavigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const styles = useStyles2(getStyles);
  const ds = usePluginDatasources();
  const { from, to, fromMs, toMs } = useTimeRange();
  const { caps } = useCapabilities();
  const metrics = getMetricNames(caps);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [percentile, setPercentile] = useState<string>('0.95');
  const [sdkLanguage, setSdkLanguage] = useState<string>('');
  const [environments, setEnvironments] = useState<string[]>([]);
  const envFilter = searchParams.get('environment') ?? '';
  const [operations, setOperations] = useState<OperationSummary[]>([]);
  const [opsLoading, setOpsLoading] = useState(true);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [opsSortField, setOpsSortField] = useState<keyof OperationSummary>('rate');
  const [opsSortDir, setOpsSortDir] = useState<'asc' | 'desc'>('desc');
  const [connected, setConnected] = useState<import('../api/client').ConnectedServicesResponse | null>(null);

  // Fetch SDK language and available environments
  useEffect(() => {
    const fetchSDK = async () => {
      try {
        const svcs = await getServices(fromMs, toMs, 60, false);
        const match = svcs.find((s) => s.name === service && s.namespace === namespace);
        if (match?.sdkLanguage) {
          setSdkLanguage(match.sdkLanguage);
        }
        // Collect unique environments across all services (for filter dropdown)
        const envSet = new Set<string>();
        for (const s of svcs) {
          if (s.environment) {
            envSet.add(s.environment);
          }
        }
        setEnvironments([...envSet].sort());
      } catch {
        // ignore — badge and environments are optional
      }
    };
    fetchSDK();
  }, [service, namespace, fromMs, toMs]);

  // Fetch operations
  useEffect(() => {
    const fetchOps = async () => {
      try {
        setOpsLoading(true);
        const ops = await getOperations(namespace, service, fromMs, toMs);
        setOperations(ops);
      } catch (e) {
        setOpsError(e instanceof Error ? e.message : 'Failed to load operations');
      } finally {
        setOpsLoading(false);
      }
    };
    fetchOps();
  }, [service, namespace, fromMs, toMs]);

  // Fetch connected services (inbound/outbound)
  useEffect(() => {
    const fetchConnected = async () => {
      try {
        const { getConnectedServices } = await import('../api/client');
        const data = await getConnectedServices(namespace, service, fromMs, toMs);
        setConnected(data);
      } catch {
        // connected services are optional
      }
    };
    fetchConnected();
  }, [service, namespace, fromMs, toMs]);

  const percentileLabel = PERCENTILE_OPTIONS.find((o) => o.value === percentile)?.label ?? 'P95';

  // Scenes for RED panels — rebuild when percentile or capabilities change
  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });
    let svcFilter = `service_name="${service}", service_namespace="${namespace}"`;
    if (envFilter) {
      svcFilter += `, deployment_environment="${envFilter}"`;
    }
    const durationUnit = metrics.durationUnit === 's' ? 's' : 'ms';

    const durationQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `histogram_quantile(${percentile}, sum by (le) (rate(${metrics.durationBucket}{${svcFilter}, span_kind="SPAN_KIND_SERVER"}[$__rate_interval])))`,
          legendFormat: percentileLabel,
        },
      ],
    });

    const errorQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `sum(rate(${metrics.callsMetric}{${svcFilter}, span_kind="SPAN_KIND_SERVER", status_code="STATUS_CODE_ERROR"}[$__rate_interval])) / sum(rate(${metrics.callsMetric}{${svcFilter}, span_kind="SPAN_KIND_SERVER"}[$__rate_interval])) * 100`,
          legendFormat: 'Error %',
        },
      ],
    });

    const rateQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `sum(rate(${metrics.callsMetric}{${svcFilter}, span_kind="SPAN_KIND_SERVER"}[$__rate_interval]))`,
          legendFormat: 'Rate',
        },
      ],
    });

    const tempoUrl = buildTempoExploreUrl(ds.tracesUid, service, { namespace });
    const lokiUrl = buildLokiExploreUrl(ds.logsUid, service, { namespace });
    const mimirUrl = buildMimirExploreUrl(
      ds.metricsUid,
      `sum(rate(${metrics.callsMetric}{service_name="${service}", service_namespace="${namespace}", span_kind="SPAN_KIND_SERVER"}[5m]))`
    );

    return new EmbeddedScene({
      $timeRange: timeRange,
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'row',
        children: [
          new SceneFlexItem({
            body: PanelBuilders.timeseries()
              .setTitle('Duration')
              .setData(durationQuery)
              .setUnit(durationUnit)
              .setLinks([
                { title: 'Traces', url: tempoUrl, targetBlank: false },
                { title: 'Logs', url: lokiUrl, targetBlank: false },
              ])
              .build(),
          }),
          new SceneFlexItem({
            body: PanelBuilders.timeseries()
              .setTitle('Errors')
              .setData(errorQuery)
              .setUnit('percent')
              .setLinks([
                { title: 'Traces', url: tempoUrl, targetBlank: false },
                { title: 'Logs', url: lokiUrl, targetBlank: false },
              ])
              .build(),
          }),
          new SceneFlexItem({
            body: PanelBuilders.timeseries()
              .setTitle('Rate')
              .setData(rateQuery)
              .setUnit('reqps')
              .setLinks([
                { title: 'Explore', url: mimirUrl, targetBlank: false },
              ])
              .build(),
          }),
        ],
      }),
    });
  }, [service, namespace, envFilter, percentile, percentileLabel, from, to, ds, metrics]);

  // Duration distribution histogram
  const durationDistScene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });
    let svcFilter = `service_name="${service}", service_namespace="${namespace}"`;
    if (envFilter) {
      svcFilter += `, deployment_environment="${envFilter}"`;
    }

    const histQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `sum by (le) (increase(${metrics.durationBucket}{${svcFilter}, span_kind="SPAN_KIND_SERVER"}[$__range]))`,
          format: 'heatmap',
          legendFormat: '{{le}}',
        },
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      body: new SceneFlexLayout({
        direction: 'row',
        children: [
          new SceneFlexItem({
            minHeight: 200,
            body: PanelBuilders.histogram()
              .setTitle('Duration Distribution')
              .setData(histQuery)
              .setUnit(metrics.durationUnit === 's' ? 's' : 'ms')
              .build(),
          }),
        ],
      }),
    });
  }, [service, namespace, envFilter, from, to, ds, metrics]);

  const sortedOps = useMemo(() => {
    return [...operations].sort((a, b) => {
      const av = a[opsSortField];
      const bv = b[opsSortField];
      if (typeof av === 'string' && typeof bv === 'string') {
        return opsSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return opsSortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [operations, opsSortField, opsSortDir]);

  const toggleOpsSort = useCallback((field: keyof OperationSummary) => {
    setOpsSortField((prev) => {
      if (prev === field) {
        setOpsSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setOpsSortDir('desc');
      return field;
    });
  }, []);

  return (
    <PluginPage>
      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <LinkButton
              variant="secondary"
              size="sm"
              icon="arrow-left"
              fill="text"
              onClick={() => appNavigate('services')}
            >
              Services
            </LinkButton>
            <h2 className={styles.title}>
              {namespace}/{service}
            </h2>
            {sdkLanguage && SDK_BADGES[sdkLanguage.toLowerCase()] && (
              <span
                className={styles.sdkBadge}
                style={{ backgroundColor: SDK_BADGES[sdkLanguage.toLowerCase()].bg }}
              >
                {SDK_BADGES[sdkLanguage.toLowerCase()].label}
              </span>
            )}
          </div>
          <div className={styles.headerLinks}>
            {activeTab === 'overview' && (
              <>
                <label className={styles.controlLabel}>Percentile:</label>
                <Select
                  options={PERCENTILE_OPTIONS}
                  value={percentile}
                  onChange={(v) => setPercentile(v.value ?? '0.95')}
                  width={10}
                />
              </>
            )}
            {environments.length > 1 && (
              <Select
                options={[
                  { label: 'All environments', value: '' },
                  ...environments.map((e) => ({ label: e, value: e })),
                ]}
                value={envFilter}
                onChange={(v) => {
                  const next = new URLSearchParams(searchParams);
                  if (v.value) {
                    next.set('environment', v.value);
                  } else {
                    next.delete('environment');
                  }
                  setSearchParams(next, { replace: true });
                }}
                width={20}
                placeholder="Environment"
              />
            )}
            {caps?.tempo?.available !== false && (
              <LinkButton variant="secondary" size="sm" icon="compass" href={buildTempoExploreUrl(ds.tracesUid, service, { namespace })}>
                Traces
              </LinkButton>
            )}
            {caps?.loki?.available !== false && (
              <LinkButton variant="secondary" size="sm" icon="document-info" href={buildLokiExploreUrl(ds.logsUid, service, { namespace })}>
                Logs
              </LinkButton>
            )}
          </div>
        </div>

        {/* Tabs — hide when required datasource is unavailable */}
        <TabsBar>
          <Tab label="Overview" active={activeTab === 'overview'} onChangeTab={() => setActiveTab('overview')} />
          {caps?.serviceGraph?.detected !== false && (
            <Tab label="Dependencies" active={activeTab === 'dependencies'} onChangeTab={() => setActiveTab('dependencies')} />
          )}
          {caps?.tempo?.available !== false && (
            <Tab label="Traces" active={activeTab === 'traces'} onChangeTab={() => setActiveTab('traces')} />
          )}
          {caps?.loki?.available !== false && (
            <Tab label="Logs" active={activeTab === 'logs'} onChangeTab={() => setActiveTab('logs')} />
          )}
          {caps?.serviceGraph?.detected !== false && (
            <Tab label="Service Map" active={activeTab === 'service-map'} onChangeTab={() => setActiveTab('service-map')} />
          )}
        </TabsBar>

        {/* Tab content */}
        <div className={styles.tabContent}>
          {activeTab === 'overview' && (
            <>
              {/* RED panels */}
              <scene.Component model={scene} />

              {/* Duration distribution */}
              <durationDistScene.Component model={durationDistScene} />

              {/* Operations table */}
              <div className={styles.operationsSection}>
                <h3 className={styles.sectionTitle}>Operations</h3>
                {opsError && <Alert severity="error" title="Error">{opsError}</Alert>}
                {opsLoading && <LoadingPlaceholder text="Loading operations..." />}
                {!opsLoading && operations.length === 0 && (
                  <Alert severity="info" title="No operations found">
                    No span operations found for this service.
                  </Alert>
                )}
                {!opsLoading && operations.length > 0 && (
                  <table className={styles.opsTable}>
                    <thead>
                      <tr>
                        <OpsHeader field="spanName" label="Operation" sortField={opsSortField} sortDir={opsSortDir} onSort={toggleOpsSort} />
                        <OpsHeader field="spanKind" label="Kind" sortField={opsSortField} sortDir={opsSortDir} onSort={toggleOpsSort} />
                        <OpsHeader field="rate" label="Rate" sortField={opsSortField} sortDir={opsSortDir} onSort={toggleOpsSort} />
                        <OpsHeader field="errorRate" label="Error %" sortField={opsSortField} sortDir={opsSortDir} onSort={toggleOpsSort} />
                        <OpsHeader field="p50Duration" label="P50" sortField={opsSortField} sortDir={opsSortDir} onSort={toggleOpsSort} />
                        <OpsHeader field="p95Duration" label="P95" sortField={opsSortField} sortDir={opsSortDir} onSort={toggleOpsSort} />
                        <OpsHeader field="p99Duration" label="P99" sortField={opsSortField} sortDir={opsSortDir} onSort={toggleOpsSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedOps.map((op) => (
                        <tr key={`${op.spanName}-${op.spanKind}`}>
                          <td className={styles.opNameCell}>{op.spanName}</td>
                          <td className={styles.opKindCell}>{op.spanKind}</td>
                          <td className={styles.opNumCell}>{op.rate.toFixed(2)} req/s</td>
                          <td className={op.errorRate > 0 ? styles.opErrorCell : styles.opNumCell}>
                            {op.errorRate.toFixed(1)}%
                          </td>
                          <td className={styles.opNumCell}>{formatDuration(op.p50Duration, op.durationUnit)}</td>
                          <td className={styles.opNumCell}>{formatDuration(op.p95Duration, op.durationUnit)}</td>
                          <td className={styles.opNumCell}>{formatDuration(op.p99Duration, op.durationUnit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Connected services (inbound/outbound) */}
              {connected && (connected.inbound.length > 0 || connected.outbound.length > 0) && (
                <div className={styles.operationsSection}>
                  <h3 className={styles.sectionTitle}>Connected Services</h3>
                  <div className={styles.connectedGrid}>
                    {connected.inbound.length > 0 && (
                      <div>
                        <h4 className={styles.connectedSubtitle}>
                          <Icon name="arrow-down" /> Inbound ({connected.inbound.length})
                        </h4>
                        <table className={styles.opsTable}>
                          <thead>
                            <tr>
                              <th>Service</th>
                              <th>Rate</th>
                              <th>Error %</th>
                              <th>P95</th>
                            </tr>
                          </thead>
                          <tbody>
                            {connected.inbound.map((s) => (
                              <tr key={s.name}>
                                <td className={styles.opNameCell}>{s.name}</td>
                                <td className={styles.opNumCell}>{s.rate.toFixed(2)} req/s</td>
                                <td className={s.errorRate > 0 ? styles.opErrorCell : styles.opNumCell}>
                                  {s.errorRate.toFixed(1)}%
                                </td>
                                <td className={styles.opNumCell}>{formatDuration(s.p95Duration, s.durationUnit)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {connected.outbound.length > 0 && (
                      <div>
                        <h4 className={styles.connectedSubtitle}>
                          <Icon name="arrow-up" /> Outbound ({connected.outbound.length})
                        </h4>
                        <table className={styles.opsTable}>
                          <thead>
                            <tr>
                              <th>Service</th>
                              <th>Rate</th>
                              <th>Error %</th>
                              <th>P95</th>
                            </tr>
                          </thead>
                          <tbody>
                            {connected.outbound.map((s) => (
                              <tr key={s.name}>
                                <td className={styles.opNameCell}>{s.name}</td>
                                <td className={styles.opNumCell}>{s.rate.toFixed(2)} req/s</td>
                                <td className={s.errorRate > 0 ? styles.opErrorCell : styles.opNumCell}>
                                  {s.errorRate.toFixed(1)}%
                                </td>
                                <td className={styles.opNumCell}>{formatDuration(s.p95Duration, s.durationUnit)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === 'traces' && (
            <TracesTab service={service} namespace={namespace} tracesUid={ds.tracesUid} />
          )}

          {activeTab === 'dependencies' && (
            <DependenciesTab service={service} namespace={namespace} fromMs={fromMs} toMs={toMs} />
          )}

          {activeTab === 'logs' && (
            <LogsTab service={service} namespace={namespace} logsUid={ds.logsUid} />
          )}

          {activeTab === 'service-map' && (
            <ServiceMapTab service={service} namespace={namespace} fromMs={fromMs} toMs={toMs} />
          )}
        </div>
      </div>
    </PluginPage>
  );
}

function OpsHeader({
  field,
  label,
  sortField,
  sortDir,
  onSort,
}: {
  field: keyof OperationSummary;
  label: string;
  sortField: keyof OperationSummary;
  sortDir: 'asc' | 'desc';
  onSort: (f: keyof OperationSummary) => void;
}) {
  const styles = useStyles2(getStyles);
  return (
    <th className={styles.sortableHeader} onClick={() => onSort(field)}>
      {label} {sortField === field && <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />}
    </th>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
  `,
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: ${theme.spacing(1)};
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
  `,
  titleRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
  `,
  title: css`
    margin: 0;
    font-size: ${theme.typography.h2.fontSize};
  `,
  sdkBadge: css`
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightBold};
    color: white;
    letter-spacing: 0.5px;
  `,
  headerLinks: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  tabContent: css`
    margin-top: ${theme.spacing(2)};
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  `,
  controlLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  operationsSection: css`
    margin-top: ${theme.spacing(3)};
  `,
  sectionTitle: css`
    margin-bottom: ${theme.spacing(1.5)};
    font-size: ${theme.typography.h4.fontSize};
  `,
  connectedGrid: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${theme.spacing(3)};
    @media (max-width: 768px) {
      grid-template-columns: 1fr;
    }
  `,
  connectedSubtitle: css`
    font-size: ${theme.typography.body.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  opsTable: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    th:nth-child(1) { width: 30%; }
    th:nth-child(2) { width: 10%; }
    th:nth-child(n+3) { width: 12%; text-align: right; }
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
    }
    tr:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  sortableHeader: css`
    cursor: pointer;
    user-select: none;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  opNameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  opKindCell: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
  opNumCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,
  opErrorCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
});

export default ServiceOverview;
