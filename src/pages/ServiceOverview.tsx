import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, Tab, TabsBar, Icon, LinkButton, Select, LoadingPlaceholder, Alert, Badge } from '@grafana/ui';
import { GrafanaTheme2, SelectableValue, PageLayoutType } from '@grafana/data';
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
import { DashboardCursorSync, TooltipDisplayMode } from '@grafana/schema';
import { HeatmapColorMode } from '@grafana/schema/dist/esm/raw/composable/heatmap/panelcfg/x/HeatmapPanelCfg_types.gen';
import { buildTempoExploreUrl, buildLokiExploreUrl, buildMimirExploreUrl } from '../utils/explore';
import { getOperations, getServices, getServiceMap, OperationSummary, ServiceMapResponse } from '../api/client';
import { formatDuration } from '../utils/format';
import { usePluginDatasources, useHasEnvironmentOverrides } from '../utils/datasources';
import { useTimeRange } from '../utils/timeRange';
import { useCapabilities, getMetricNames } from '../utils/capabilities';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { sanitizeLabelValue } from '../utils/sanitize';
import { useFetch } from '../utils/useFetch';
import { otel } from '../otelconfig';
import { TracesTab } from './tabs/TracesTab';
import { LogsTab } from './tabs/LogsTab';
import { DependenciesTab } from './tabs/DependenciesTab';
import { ServerTab } from './tabs/ServerTab';
import { FrontendTab } from './tabs/FrontendTab';
import { RuntimeTab } from './tabs/RuntimeTab';
import { ServiceGraph, type ServiceGraphNode, type ServiceGraphEdge } from '../components/ServiceGraph';

type TabId = 'overview' | 'server' | 'frontend' | 'runtime' | 'dependencies' | 'traces' | 'logs';
const VALID_TABS: TabId[] = ['overview', 'server', 'frontend', 'runtime', 'dependencies', 'traces', 'logs'];

const PERCENTILE_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'P50', value: '0.50' },
  { label: 'P90', value: '0.90' },
  { label: 'P95', value: '0.95' },
  { label: 'P99', value: '0.99' },
];

const FRAMEWORK_BADGES: Record<string, { label: string; bg: string }> = {
  Ktor: { label: 'Ktor', bg: '#7B68EE' },
  'Spring Boot': { label: 'Spring', bg: '#6DB33F' },
  'Node.js': { label: 'Node.js', bg: '#68A063' },
};

function ServiceOverview() {
  const { namespace: rawNamespace = '', service = '' } = useParams<{ namespace: string; service: string }>();
  // '_' is a placeholder for services with no namespace
  const namespace = rawNamespace === '_' ? '' : rawNamespace;
  const appNavigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const styles = useStyles2(getStyles);
  const envFilter = sanitizeParam(searchParams.get('environment') ?? '');
  const ds = usePluginDatasources(envFilter || undefined);
  const hasEnvOverrides = useHasEnvironmentOverrides();
  const { from, to, fromMs, toMs } = useTimeRange();
  const { caps } = useCapabilities();
  const metrics = getMetricNames(caps);
  const tabParam = searchParams.get('tab') ?? '';
  const activeTab: TabId = VALID_TABS.includes(tabParam as TabId) ? (tabParam as TabId) : 'overview';
  const setActiveTab = useCallback(
    (tab: TabId) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (tab === 'overview') {
          next.delete('tab');
        } else {
          next.set('tab', tab);
        }
        return next;
      });
    },
    [setSearchParams]
  );

  // Read trace filter params (set when navigating from endpoint → traces)
  const traceSpan = searchParams.get('traceSpan') ?? '';
  const traceStatus = searchParams.get('traceStatus') ?? '';

  const onViewTraces = useCallback(
    (spanName: string, status?: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', 'traces');
        if (spanName) {
          next.set('traceSpan', spanName);
        } else {
          next.delete('traceSpan');
        }
        if (status) {
          next.set('traceStatus', status);
        } else {
          next.delete('traceStatus');
        }
        return next;
      });
    },
    [setSearchParams]
  );
  const [percentile, setPercentile] = useState<string>('0.95');
  const [framework, setFramework] = useState<string>('');
  const [environments, setEnvironments] = useState<string[]>([]);
  const [operations, setOperations] = useState<OperationSummary[]>([]);
  const [opsLoading, setOpsLoading] = useState(true);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [connected, setConnected] = useState<import('../api/client').ConnectedServicesResponse | null>(null);

  // Track which tabs have been visited so we keep them mounted
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(new Set(['overview']));
  useEffect(() => {
    setVisitedTabs((prev) => {
      if (prev.has(activeTab)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  // Fetch SDK language and available environments
  useEffect(() => {
    const fetchSDK = async () => {
      try {
        const svcs = await getServices(fromMs, toMs, 60, false);
        const match = svcs.find((s) => s.name === service && s.namespace === namespace);
        if (match?.framework) {
          setFramework(match.framework);
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

  // Fetch service map for overview graph
  const { data: mapData } = useFetch<ServiceMapResponse>(
    () => getServiceMap(fromMs, toMs, service, namespace),
    [service, namespace, fromMs, toMs]
  );
  const { graphNodes, graphEdges } = useMemo(() => {
    if (!mapData) {
      return { graphNodes: [] as ServiceGraphNode[], graphEdges: [] as ServiceGraphEdge[] };
    }
    return {
      graphNodes: mapData.nodes.map((n) => ({
        id: n.id,
        title: n.title,
        mainStat: n.mainStat,
        secondaryStat: n.secondaryStat,
        errorRate: n.errorRate ?? 0,
        nodeType: n.nodeType,
      })),
      graphEdges: mapData.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        mainStat: e.mainStat,
        secondaryStat: e.secondaryStat,
      })),
    };
  }, [mapData]);

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
    let svcFilter = `${otel.labels.serviceName}="${sanitizeLabelValue(service)}", ${otel.labels.serviceNamespace}="${sanitizeLabelValue(namespace)}"`;
    if (envFilter) {
      svcFilter += `, ${otel.labels.deploymentEnv}="${sanitizeLabelValue(envFilter)}"`;
    }
    const durationUnit = metrics.durationUnit === 's' ? 's' : 'ms';

    const durationQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      minInterval: '5m',
      queries: [
        {
          refId: 'A',
          expr: `histogram_quantile(${percentile}, sum by (${otel.labels.le}) (rate(${metrics.durationBucket}{${svcFilter}, ${otel.labels.spanKind}="${otel.spanKinds.server}"}[$__rate_interval])))`,
          legendFormat: percentileLabel,
        },
      ],
    });

    const errorQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      minInterval: '5m',
      queries: [
        {
          refId: 'A',
          expr: `sum(rate(${metrics.callsMetric}{${svcFilter}, ${otel.labels.spanKind}="${otel.spanKinds.server}", ${otel.labels.statusCode}="${otel.statusCodes.error}"}[$__rate_interval])) / sum(rate(${metrics.callsMetric}{${svcFilter}, ${otel.labels.spanKind}="${otel.spanKinds.server}"}[$__rate_interval])) * 100`,
          legendFormat: 'Error %',
        },
      ],
    });

    const rateQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      minInterval: '5m',
      queries: [
        {
          refId: 'A',
          expr: `sum(rate(${metrics.callsMetric}{${svcFilter}, ${otel.labels.spanKind}="${otel.spanKinds.server}"}[$__rate_interval]))`,
          legendFormat: 'Rate',
        },
      ],
    });

    const tempoUrl = buildTempoExploreUrl(ds.tracesUid, service, { namespace });
    const lokiUrl = buildLokiExploreUrl(ds.logsUid, service, { namespace });
    const mimirUrl = buildMimirExploreUrl(
      ds.metricsUid,
      `sum(rate(${metrics.callsMetric}{${otel.labels.serviceName}="${service}", ${otel.labels.serviceNamespace}="${namespace}", ${otel.labels.spanKind}="${otel.spanKinds.server}"}[5m]))`
    );

    const heatmapQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      minInterval: '5m',
      queries: [
        {
          refId: 'A',
          expr: `sum by (${otel.labels.le}) (increase(${metrics.durationBucket}{${svcFilter}, ${otel.labels.spanKind}="${otel.spanKinds.server}"}[$__rate_interval]))`,
          format: 'heatmap',
          legendFormat: '{{le}}',
        },
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            body: new SceneFlexLayout({
              direction: 'row',
              children: [
                new SceneFlexItem({
                  height: 300,
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
                  height: 300,
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
                  height: 300,
                  body: PanelBuilders.timeseries()
                    .setTitle('Rate')
                    .setData(rateQuery)
                    .setUnit('reqps')
                    .setLinks([{ title: 'Explore', url: mimirUrl, targetBlank: false }])
                    .build(),
                }),
              ],
            }),
          }),
          new SceneFlexItem({
            height: 220,
            body: PanelBuilders.heatmap()
              .setTitle('Duration Distribution')
              .setData(heatmapQuery)
              .setOption('calculate', false)
              .setOption('yAxis', {
                unit: metrics.durationUnit === 's' ? 's' : 'ms',
              })
              .setOption('color', {
                mode: HeatmapColorMode.Scheme,
                scheme: 'Oranges',
                steps: 128,
              })
              .setOption('cellGap', 1)
              .setOption('tooltip', { mode: TooltipDisplayMode.Single, yHistogram: true })
              .build(),
          }),
        ],
      }),
    });
  }, [service, namespace, envFilter, percentile, percentileLabel, from, to, ds, metrics]);

  const MAX_OVERVIEW_OPS = 5;

  // Top operations for the overview: top N by rate + any with errors not already shown
  const overviewOps = useMemo(() => {
    const byRate = [...operations].sort((a, b) => b.rate - a.rate);
    const topN = byRate.slice(0, MAX_OVERVIEW_OPS);
    const topKeys = new Set(topN.map((o) => `${o.spanName}|${o.spanKind}`));
    const erroring = operations
      .filter((o) => o.errorRate > 0 && !topKeys.has(`${o.spanName}|${o.spanKind}`))
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, MAX_OVERVIEW_OPS);
    return [...topN, ...erroring];
  }, [operations]);

  const hiddenCount = operations.length - overviewOps.length;

  // Service detail pages always use Canvas layout (no plugin-level header)
  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <LinkButton variant="secondary" size="sm" icon="arrow-left" onClick={() => appNavigate('services')}>
              Services
            </LinkButton>
            <h2 className={styles.title}>
              {namespace ? `${namespace}/` : ''}
              {service}
            </h2>
            {framework && FRAMEWORK_BADGES[framework] && (
              <span className={styles.sdkBadge} style={{ backgroundColor: FRAMEWORK_BADGES[framework].bg }}>
                {FRAMEWORK_BADGES[framework].label}
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
              <LinkButton
                variant="secondary"
                size="sm"
                icon="compass"
                href={buildTempoExploreUrl(ds.tracesUid, service, { namespace })}
              >
                Traces
              </LinkButton>
            )}
            {caps?.loki?.available !== false && (
              <LinkButton
                variant="secondary"
                size="sm"
                icon="document-info"
                href={buildLokiExploreUrl(ds.logsUid, service, { namespace })}
              >
                Logs
              </LinkButton>
            )}
          </div>
        </div>

        {/* Tabs — hide when required datasource is unavailable */}
        <TabsBar>
          <Tab label="Overview" active={activeTab === 'overview'} onChangeTab={() => setActiveTab('overview')} />
          <Tab label="Server" active={activeTab === 'server'} onChangeTab={() => setActiveTab('server')} />
          <Tab label="Frontend" active={activeTab === 'frontend'} onChangeTab={() => setActiveTab('frontend')} />
          <Tab label="Runtime" active={activeTab === 'runtime'} onChangeTab={() => setActiveTab('runtime')} />
          {caps?.serviceGraph?.detected !== false && (
            <Tab
              label="Dependencies"
              active={activeTab === 'dependencies'}
              onChangeTab={() => setActiveTab('dependencies')}
            />
          )}
          {caps?.tempo?.available !== false && (
            <Tab label="Traces" active={activeTab === 'traces'} onChangeTab={() => setActiveTab('traces')} />
          )}
          {caps?.loki?.available !== false && (
            <Tab label="Logs" active={activeTab === 'logs'} onChangeTab={() => setActiveTab('logs')} />
          )}
        </TabsBar>

        {/* Info banner when viewing without environment filter and env overrides are configured */}
        {!envFilter && hasEnvOverrides && (activeTab === 'traces' || activeTab === 'logs') && (
          <Alert severity="info" title="Default datasource" style={{ marginTop: 8, marginBottom: 0 }}>
            Traces and logs are shown from the default datasource. Select an environment to view data from the
            environment-specific datasource.
          </Alert>
        )}

        {/* Tab content — keep visited tabs mounted to avoid re-fetching */}
        <div className={styles.tabContent}>
          <div style={{ display: activeTab === 'overview' ? undefined : 'none' }}>
            <>
              {/* RED panels + Duration distribution (single scene for shared time range) */}
              <div style={{ marginBottom: 16 }}>
                <scene.Component model={scene} />
              </div>

              {/* Operations table */}
              <div className={styles.operationsSection}>
                <h3 className={styles.sectionTitle}>Operations</h3>
                {opsError && (
                  <Alert severity="error" title="Error">
                    {opsError}
                  </Alert>
                )}
                {opsLoading && <LoadingPlaceholder text="Loading operations..." />}
                {!opsLoading && operations.length === 0 && (
                  <Alert severity="info" title="No operations found">
                    No span operations found for this service.
                  </Alert>
                )}
                {!opsLoading && operations.length > 0 && (
                  <>
                    <table className={styles.opsTable}>
                      <thead>
                        <tr>
                          <th>Operation</th>
                          <th>Kind</th>
                          <th style={{ textAlign: 'right' }}>Rate</th>
                          <th style={{ textAlign: 'right' }}>Error %</th>
                          <th style={{ textAlign: 'right' }}>P50</th>
                          <th style={{ textAlign: 'right' }}>P95</th>
                          <th style={{ textAlign: 'right' }}>P99</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overviewOps.map((op) => (
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
                    <button className={styles.viewAllLink} onClick={() => setActiveTab('server')}>
                      {hiddenCount > 0
                        ? `View all ${operations.length} operations on Server tab →`
                        : 'View details on Server tab →'}
                    </button>
                  </>
                )}
              </div>

              {/* Service topology graph */}
              {graphNodes.length > 0 && (
                <div className={styles.operationsSection}>
                  <h3 className={styles.sectionTitle}>Service Topology</h3>
                  <div style={{ height: 350, borderRadius: 4, overflow: 'hidden' }}>
                    <ServiceGraph nodes={graphNodes} edges={graphEdges} focusNode={service} direction="RIGHT" />
                  </div>
                </div>
              )}

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
                              <th>Type</th>
                              <th>Rate</th>
                              <th>Error %</th>
                              <th>P95</th>
                            </tr>
                          </thead>
                          <tbody>
                            {connected.inbound.map((s) => (
                              <tr
                                key={s.name + (s.connectionType ?? '')}
                                className={s.connectionType ? undefined : styles.clickableRow}
                                onClick={
                                  s.connectionType
                                    ? undefined
                                    : () => {
                                        appNavigate(`dependencies/${encodeURIComponent(s.name)}`);
                                      }
                                }
                              >
                                <td className={s.connectionType ? undefined : styles.linkCell}>{s.name}</td>
                                <td>
                                  <ConnectionTypeBadge type={s.connectionType} />
                                </td>
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
                              <th>Type</th>
                              <th>Rate</th>
                              <th>Error %</th>
                              <th>P95</th>
                            </tr>
                          </thead>
                          <tbody>
                            {connected.outbound.map((s) => (
                              <tr
                                key={s.name + (s.connectionType ?? '')}
                                className={s.connectionType ? undefined : styles.clickableRow}
                                onClick={
                                  s.connectionType
                                    ? undefined
                                    : () => {
                                        appNavigate(`dependencies/${encodeURIComponent(s.name)}`);
                                      }
                                }
                              >
                                <td className={s.connectionType ? undefined : styles.linkCell}>{s.name}</td>
                                <td>
                                  <ConnectionTypeBadge type={s.connectionType} />
                                </td>
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
          </div>

          {visitedTabs.has('traces') && (
            <div
              style={{
                display: activeTab === 'traces' ? 'flex' : 'none',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
              }}
            >
              <TracesTab
                key={`${traceSpan}|${traceStatus}`}
                service={service}
                namespace={namespace}
                tracesUid={ds.tracesUid}
                from={from}
                to={to}
                initialSpan={traceSpan}
                initialStatus={traceStatus}
              />
            </div>
          )}

          {visitedTabs.has('server') && (
            <div style={{ display: activeTab === 'server' ? undefined : 'none' }}>
              <ServerTab
                service={service}
                namespace={namespace}
                fromMs={fromMs}
                toMs={toMs}
                onViewTraces={onViewTraces}
              />
            </div>
          )}

          {visitedTabs.has('frontend') && (
            <div style={{ display: activeTab === 'frontend' ? undefined : 'none' }}>
              <FrontendTab service={service} namespace={namespace} environment={envFilter} />
            </div>
          )}

          {visitedTabs.has('runtime') && (
            <div style={{ display: activeTab === 'runtime' ? undefined : 'none' }}>
              <RuntimeTab service={service} namespace={namespace} fromMs={fromMs} toMs={toMs} />
            </div>
          )}

          {visitedTabs.has('dependencies') && (
            <div style={{ display: activeTab === 'dependencies' ? undefined : 'none' }}>
              <DependenciesTab
                service={service}
                namespace={namespace}
                fromMs={fromMs}
                toMs={toMs}
                environment={envFilter || undefined}
              />
            </div>
          )}

          {visitedTabs.has('logs') && (
            <div
              style={{
                display: activeTab === 'logs' ? 'flex' : 'none',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
              }}
            >
              <LogsTab service={service} namespace={namespace} logsUid={ds.logsUid} />
            </div>
          )}
        </div>
      </div>
    </PluginPage>
  );
}

const CONNECTION_TYPE_LABELS: Record<
  string,
  { text: string; color: 'blue' | 'green' | 'orange' | 'red' | 'purple'; icon?: string }
> = {
  database: { text: 'Database', color: 'purple', icon: 'database' },
  messaging_system: { text: 'Messaging', color: 'orange', icon: 'envelope' },
  virtual_node: { text: 'External', color: 'blue', icon: 'cloud' },
};

function ConnectionTypeBadge({ type }: { type?: string }) {
  if (!type) {
    return null;
  }
  const info = CONNECTION_TYPE_LABELS[type];
  if (!info) {
    return null;
  }
  return <Badge text={info.text} color={info.color} icon={info.icon as any} />;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 0;
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
    flex-wrap: wrap;
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
  viewAllLink: css`
    display: block;
    margin-top: ${theme.spacing(1.5)};
    padding: 0;
    background: none;
    border: none;
    color: ${theme.colors.text.link};
    font-size: ${theme.typography.bodySmall.fontSize};
    cursor: pointer;
    &:hover {
      text-decoration: underline;
    }
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
  clickableRow: css`
    cursor: pointer;
    &:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  linkCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${theme.colors.text.link};
  `,
  opsTable: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    th:nth-child(1) {
      width: 30%;
    }
    th:nth-child(2) {
      width: 10%;
    }
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
    }
    th:nth-child(n + 3) {
      width: 12%;
      text-align: right;
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
