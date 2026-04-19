import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, Tab, TabsBar, Icon, LinkButton, Select, LoadingPlaceholder, Alert } from '@grafana/ui';
import { GrafanaTheme2, SelectableValue, FieldType, LoadingState, toDataFrame } from '@grafana/data';
import { css } from '@emotion/css';
import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  SceneTimePicker,
  SceneTimeRange,
  SceneRefreshPicker,
  SceneDataNode,
  PanelBuilders,
  EmbeddedScene,
  VizPanel,
} from '@grafana/scenes';
import { buildTempoExploreUrl, buildLokiExploreUrl, buildMimirExploreUrl } from '../utils/explore';
import { getOperations, getServices, OperationSummary } from '../api/client';

type TabId = 'overview' | 'traces' | 'logs' | 'service-map';

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
  const styles = useStyles2(getStyles);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [percentile, setPercentile] = useState<string>('0.95');
  const [sdkLanguage, setSdkLanguage] = useState<string>('');
  const [operations, setOperations] = useState<OperationSummary[]>([]);
  const [opsLoading, setOpsLoading] = useState(true);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [opsSortField, setOpsSortField] = useState<keyof OperationSummary>('rate');
  const [opsSortDir, setOpsSortDir] = useState<'asc' | 'desc'>('desc');

  // Fetch SDK language from services endpoint
  useEffect(() => {
    const fetchSDK = async () => {
      try {
        const now = Date.now();
        const svcs = await getServices(now - 3600000, now, 60, false);
        const match = svcs.find((s) => s.name === service && s.namespace === namespace);
        if (match?.sdkLanguage) {
          setSdkLanguage(match.sdkLanguage);
        }
      } catch {
        // ignore — badge is optional
      }
    };
    fetchSDK();
  }, [service, namespace]);

  // Fetch operations
  useEffect(() => {
    const fetchOps = async () => {
      try {
        setOpsLoading(true);
        const now = Date.now();
        const ops = await getOperations(namespace, service, now - 3600000, now);
        setOperations(ops);
      } catch (e) {
        setOpsError(e instanceof Error ? e.message : 'Failed to load operations');
      } finally {
        setOpsLoading(false);
      }
    };
    fetchOps();
  }, [service, namespace]);

  const percentileLabel = PERCENTILE_OPTIONS.find((o) => o.value === percentile)?.label ?? 'P95';

  // Scenes for RED panels — rebuild when percentile changes
  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from: 'now-30m', to: 'now' });
    const svcFilter = `service_name="${service}", service_namespace="${namespace}"`;

    const durationQuery = new SceneQueryRunner({
      datasource: { uid: 'mimir', type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `histogram_quantile(${percentile}, sum by (le) (rate(traces_span_metrics_duration_milliseconds_bucket{${svcFilter}, span_kind="SPAN_KIND_SERVER"}[$__rate_interval])))`,
          legendFormat: percentileLabel,
        },
      ],
    });

    const errorQuery = new SceneQueryRunner({
      datasource: { uid: 'mimir', type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `sum(rate(traces_span_metrics_calls_total{${svcFilter}, span_kind="SPAN_KIND_SERVER", status_code="STATUS_CODE_ERROR"}[$__rate_interval])) / sum(rate(traces_span_metrics_calls_total{${svcFilter}, span_kind="SPAN_KIND_SERVER"}[$__rate_interval])) * 100`,
          legendFormat: 'Error %',
        },
      ],
    });

    const rateQuery = new SceneQueryRunner({
      datasource: { uid: 'mimir', type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `sum(rate(traces_span_metrics_calls_total{${svcFilter}, span_kind="SPAN_KIND_SERVER"}[$__rate_interval]))`,
          legendFormat: 'Rate',
        },
      ],
    });

    const tempoUrl = buildTempoExploreUrl('tempo', service);
    const lokiUrl = buildLokiExploreUrl('loki', service);
    const mimirUrl = buildMimirExploreUrl('mimir', service);

    return new EmbeddedScene({
      $timeRange: timeRange,
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'row',
        children: [
          new SceneFlexItem({
            body: PanelBuilders.timeseries()
              .setTitle('Duration')
              .setData(durationQuery)
              .setUnit('ms')
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
  }, [service, namespace, percentile, percentileLabel]);

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
            <LinkButton variant="secondary" size="sm" icon="compass" href={buildTempoExploreUrl('tempo', service)}>
              Traces
            </LinkButton>
            <LinkButton variant="secondary" size="sm" icon="document-info" href={buildLokiExploreUrl('loki', service)}>
              Logs
            </LinkButton>
          </div>
        </div>

        {/* Tabs */}
        <TabsBar>
          <Tab label="Overview" active={activeTab === 'overview'} onChangeTab={() => setActiveTab('overview')} />
          <Tab label="Traces" active={activeTab === 'traces'} onChangeTab={() => setActiveTab('traces')} />
          <Tab label="Logs" active={activeTab === 'logs'} onChangeTab={() => setActiveTab('logs')} />
          <Tab label="Service Map" active={activeTab === 'service-map'} onChangeTab={() => setActiveTab('service-map')} />
        </TabsBar>

        {/* Tab content */}
        <div className={styles.tabContent}>
          {activeTab === 'overview' && (
            <>
              {/* Percentile selector for duration panel */}
              <div className={styles.panelControls}>
                <label className={styles.controlLabel}>Duration percentile:</label>
                <Select
                  options={PERCENTILE_OPTIONS}
                  value={percentile}
                  onChange={(v) => setPercentile(v.value ?? '0.95')}
                  width={12}
                />
              </div>

              {/* RED panels */}
              <scene.Component model={scene} />

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
            </>
          )}

          {activeTab === 'traces' && (
            <TracesTab service={service} namespace={namespace} />
          )}

          {activeTab === 'logs' && (
            <LogsTab service={service} namespace={namespace} />
          )}

          {activeTab === 'service-map' && (
            <ServiceMapTab service={service} namespace={namespace} />
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

function formatDuration(value: number, unit: string): string {
  if (unit === 'ms') {
    if (value < 1) {
      return '< 1ms';
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}s`;
    }
    return `${Math.round(value)}ms`;
  }
  if (value < 0.001) {
    return '< 1ms';
  }
  if (value < 1) {
    return `${Math.round(value * 1000)}ms`;
  }
  return `${value.toFixed(1)}s`;
}

/** Traces tab — embedded Tempo trace search via Scenes */
function TracesTab({ service, namespace }: { service: string; namespace: string }) {
  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });

    const traceQuery = new SceneQueryRunner({
      datasource: { uid: 'tempo', type: 'tempo' },
      queries: [
        {
          refId: 'A',
          queryType: 'traceql',
          query: `{resource.service.name="${service}" && span.kind=server}`,
          limit: 20,
        },
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            minHeight: 400,
            body: PanelBuilders.table()
              .setTitle(`Traces — ${service}`)
              .setData(traceQuery)
              .build(),
          }),
        ],
      }),
    });
  }, [service, namespace]);

  return <scene.Component model={scene} />;
}

/** Logs tab — embedded Loki log viewer via Scenes */
function LogsTab({ service, namespace }: { service: string; namespace: string }) {
  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });

    const logQuery = new SceneQueryRunner({
      datasource: { uid: 'loki', type: 'loki' },
      queries: [
        {
          refId: 'A',
          expr: `{service_name="${service}"} | logfmt`,
        },
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            minHeight: 400,
            body: PanelBuilders.logs()
              .setTitle(`Logs — ${service}`)
              .setData(logQuery)
              .build(),
          }),
        ],
      }),
    });
  }, [service, namespace]);

  return <scene.Component model={scene} />;
}

/** Service Map tab — per-service neighborhood map */
function ServiceMapTab({ service, namespace }: { service: string; namespace: string }) {
  const [mapData, setMapData] = useState<import('../api/client').ServiceMapResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const now = Date.now();
        const { getServiceMap } = await import('../api/client');
        const data = await getServiceMap(now - 3600000, now, service, namespace);
        setMapData(data);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [service, namespace]);

  const scene = useMemo(() => {
    if (!mapData || mapData.nodes.length === 0) {
      return null;
    }

    const nodesFrame = toDataFrame({
      name: 'nodes',
      fields: [
        { name: 'id', type: FieldType.string, values: mapData.nodes.map((n: any) => n.id) },
        { name: 'title', type: FieldType.string, values: mapData.nodes.map((n: any) => n.title) },
        { name: 'mainStat', type: FieldType.string, values: mapData.nodes.map((n: any) => n.mainStat ?? '') },
        { name: 'secondaryStat', type: FieldType.string, values: mapData.nodes.map((n: any) => n.secondaryStat ?? '') },
        { name: 'arc__errors', type: FieldType.number, values: mapData.nodes.map((n: any) => n.arc__errors), config: { color: { fixedColor: 'red', mode: 'fixed' } } },
        { name: 'arc__ok', type: FieldType.number, values: mapData.nodes.map((n: any) => n.arc__ok), config: { color: { fixedColor: 'green', mode: 'fixed' } } },
      ],
    });

    const edgesFrame = toDataFrame({
      name: 'edges',
      fields: [
        { name: 'id', type: FieldType.string, values: mapData.edges.map((e: any) => e.id) },
        { name: 'source', type: FieldType.string, values: mapData.edges.map((e: any) => e.source) },
        { name: 'target', type: FieldType.string, values: mapData.edges.map((e: any) => e.target) },
        { name: 'mainStat', type: FieldType.string, values: mapData.edges.map((e: any) => e.mainStat ?? '') },
        { name: 'secondaryStat', type: FieldType.string, values: mapData.edges.map((e: any) => e.secondaryStat ?? '') },
      ],
    });

    nodesFrame.meta = { preferredVisualisationType: 'nodeGraph' };

    const dataNode = new SceneDataNode({
      data: {
        series: [nodesFrame, edgesFrame],
        state: LoadingState.Done,
        timeRange: { from: new Date(), to: new Date(), raw: { from: 'now-1h', to: 'now' } } as any,
      },
    });

    return new EmbeddedScene({
      $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            minHeight: 400,
            body: new VizPanel({
              title: `Service Map — ${service}`,
              pluginId: 'nodeGraph',
              $data: dataNode,
              options: {},
              fieldConfig: { defaults: {}, overrides: [] },
            }),
          }),
        ],
      }),
    });
  }, [mapData, service]);

  if (loading) {
    return <LoadingPlaceholder text="Loading service map..." />;
  }

  if (!scene) {
    return (
      <Alert severity="info" title="No service map data">
        No service graph data found for {service}.
      </Alert>
    );
  }

  return <scene.Component model={scene} />;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    padding: ${theme.spacing(1)} ${theme.spacing(2)};
  `,
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: ${theme.spacing(1)};
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
    gap: ${theme.spacing(1)};
  `,
  tabContent: css`
    margin-top: ${theme.spacing(2)};
  `,
  panelControls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(1)};
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
  opsTable: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(2)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(2)};
      border-bottom: 1px solid ${theme.colors.border.weak};
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
