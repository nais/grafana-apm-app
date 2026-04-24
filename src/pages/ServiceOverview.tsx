import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, Tab, TabsBar, LinkButton, Combobox, Alert } from '@grafana/ui';
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { css } from '@emotion/css';
import { buildTempoExploreUrl, buildLokiExploreUrl } from '../utils/explore';
import { FrameworkBadge } from '../components/FrameworkBadge';
import { PageHeader } from '../components/PageHeader';
import {
  getOperations,
  getServices,
  getServiceMap,
  getConnectedServices,
  OperationSummary,
  ServiceMapResponse,
  ConnectedServicesResponse,
} from '../api/client';
import { usePluginDatasources, useHasEnvironmentOverrides } from '../utils/datasources';
import { useTimeRange } from '../utils/timeRange';
import { useCapabilities, getMetricNames } from '../utils/capabilities';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { extractEnvironmentOptions } from '../utils/options';
import { useFetch } from '../utils/useFetch';
import { toGraphData } from '../components/ServiceGraph';
import { buildServiceScene } from './buildServiceScene';
import { OverviewTab } from './tabs/OverviewTab';
import { TracesTab } from './tabs/TracesTab';
import { LogsTab } from './tabs/LogsTab';
import { DependenciesTab } from './tabs/DependenciesTab';
import { ServerTab } from './tabs/ServerTab';
import { FrontendTab } from './tabs/FrontendTab';
import { RuntimeTab } from './tabs/RuntimeTab';

type TabId = 'overview' | 'server' | 'frontend' | 'runtime' | 'dependencies' | 'traces' | 'logs';
const VALID_TABS: TabId[] = ['overview', 'server', 'frontend', 'runtime', 'dependencies', 'traces', 'logs'];

const PERCENTILE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'P50', value: '0.50' },
  { label: 'P90', value: '0.90' },
  { label: 'P95', value: '0.95' },
  { label: 'P99', value: '0.99' },
];

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
  // Stable primitive refs for Scenes useMemo — avoids re-creating the entire
  // EmbeddedScene (and flashing panels) when object references change but
  // the underlying string values haven't.
  const metricsUid = ds.metricsUid;
  const tracesUid = ds.tracesUid;
  const logsUid = ds.logsUid;
  const callsMetric = metrics.callsMetric;
  const durationBucket = metrics.durationBucket;
  const durationUnit = metrics.durationUnit;
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

  // Track which tabs have been visited so we keep them mounted.
  // The setState-in-effect pattern is intentional: visitedTabs is a monotonically
  // growing set that prevents re-mounting expensive tab components when switching tabs.
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(new Set(['overview']));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisitedTabs((prev) => {
      if (prev.has(activeTab)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  // Fetch service list (for SDK badge + environment list)
  const { data: serviceList } = useFetch(() => getServices(fromMs, toMs, 60, false), [fromMs, toMs]);
  const framework = useMemo(() => {
    const match = serviceList?.find((s) => s.name === service && s.namespace === namespace);
    return match?.framework ?? '';
  }, [serviceList, service, namespace]);
  const envOptions = useMemo(() => extractEnvironmentOptions(serviceList ?? []), [serviceList]);

  // Fetch operations
  const {
    data: rawOperations,
    loading: opsLoading,
    error: opsError,
  } = useFetch<OperationSummary[]>(
    () => getOperations(namespace, service, fromMs, toMs),
    [service, namespace, fromMs, toMs]
  );
  const operations = useMemo(() => rawOperations ?? [], [rawOperations]);

  // Fetch service map for overview graph
  const { data: mapData } = useFetch<ServiceMapResponse>(
    () => getServiceMap(fromMs, toMs, service, namespace, envFilter),
    [service, namespace, envFilter, fromMs, toMs]
  );
  const { graphNodes, graphEdges } = useMemo(() => toGraphData(mapData), [mapData]);

  // Fetch connected services (inbound/outbound)
  const { data: connected } = useFetch<ConnectedServicesResponse>(
    () => getConnectedServices(namespace, service, fromMs, toMs, envFilter || undefined),
    [service, namespace, fromMs, toMs, envFilter]
  );

  const percentileLabel = PERCENTILE_OPTIONS.find((o) => o.value === percentile)?.label ?? 'P95';

  // Determine if this service has SERVER spans (for query filter strategy).
  // If true (or unknown), use SERVER filter for clean inbound metrics.
  // If false, omit span_kind filter to show Consumer/Producer/Client activity.
  const hasServerSpans = useMemo(() => {
    if (!serviceList) {
      return true; // safe default while loading
    }
    const matches = serviceList.filter(
      (s) => s.name === service && s.namespace === namespace && (!envFilter || s.environment === envFilter)
    );
    return matches.length === 0 || matches.some((s) => s.hasServerSpans);
  }, [serviceList, service, namespace, envFilter]);

  // Scenes for RED panels — rebuild only when actual values change (not object refs)
  const scene = useMemo(
    () =>
      buildServiceScene({
        service,
        namespace,
        envFilter,
        percentile,
        percentileLabel,
        from,
        to,
        metricsUid,
        tracesUid,
        logsUid,
        callsMetric,
        durationBucket,
        durationUnit,
        hasServerSpans,
      }),
    [
      service,
      namespace,
      envFilter,
      percentile,
      percentileLabel,
      from,
      to,
      metricsUid,
      tracesUid,
      logsUid,
      callsMetric,
      durationBucket,
      durationUnit,
      hasServerSpans,
    ]
  );

  const onNavigateService = useCallback(
    (name: string) => {
      appNavigate(`services/_/${encodeURIComponent(name)}`);
    },
    [appNavigate]
  );

  // Service detail pages always use Canvas layout (no plugin-level header)
  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        <PageHeader
          title={
            <>
              {namespace ? `${namespace}/` : ''}
              {service}
            </>
          }
          backLabel="Services"
          onBack={() => appNavigate('services')}
          after={framework ? <FrameworkBadge framework={framework} /> : undefined}
          controls={
            <>
              {activeTab === 'overview' && (
                <>
                  <label className={styles.controlLabel}>Percentile:</label>
                  <Combobox
                    options={PERCENTILE_OPTIONS}
                    value={percentile}
                    onChange={(v) => setPercentile(v.value ?? '0.95')}
                    width={10}
                  />
                </>
              )}
              {envOptions.length > 1 && (
                <Combobox
                  options={[{ label: 'All environments', value: '' }, ...envOptions]}
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
            </>
          }
        />

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
            <OverviewTab
              scene={scene}
              operations={operations}
              opsLoading={opsLoading}
              opsError={opsError ?? null}
              graphNodes={graphNodes}
              graphEdges={graphEdges}
              connected={connected ?? undefined}
              service={service}
              onViewAllOperations={() => setActiveTab('server')}
              onNavigateService={onNavigateService}
            />
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
                environment={envFilter || undefined}
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
              <RuntimeTab service={service} namespace={namespace} environment={envFilter} fromMs={fromMs} toMs={toMs} />
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
              <LogsTab service={service} namespace={namespace} logsUid={ds.logsUid} from={from} to={to} />
            </div>
          )}
        </div>
      </div>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 0;
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
});

export default ServiceOverview;
